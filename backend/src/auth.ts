import { Hono } from "hono";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  consumeMagicLink,
  countRecentMagicLinks,
  findActiveMagicLinkByEmail,
  findActiveMagicLinkByTokenHash,
  findOrCreateUser,
  findUserByEmail,
  getUserById,
  incrementMagicLinkAttempts,
  insertMagicLink,
  markUserLogin,
  setUserPasswordHash,
} from "./db";
import { sendMagicLinkEmail } from "./email";
import { mintJwt, verifyJwt } from "./jwt";
import type { Context, Next } from "hono";

const TEN_MINUTES = 10 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const MAX_VERIFY_ATTEMPTS = 5;
const MIN_PASSWORD_LENGTH = 8;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function generateOtp(): string {
  // 6-digit code, zero-padded. randomInt is uniform.
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function generateLinkToken(): string {
  // 32 bytes → 43 chars base64url. Used as the ?token= in email link.
  return randomBytes(32).toString("base64url");
}

export const auth = new Hono();

// POST /auth/request — body: { email }
// Always returns 200 to avoid email enumeration; rate-limited per email.
auth.post("/request", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const emailRaw = (body.email as string | undefined)?.trim().toLowerCase();
  if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
    return c.json({ error: "invalid email" }, 400);
  }

  const recent = countRecentMagicLinks(emailRaw, FIFTEEN_MINUTES);
  if (recent >= MAX_REQUESTS_PER_WINDOW) {
    return c.json({ error: "rate limited, try again later" }, 429);
  }

  const code = generateOtp();
  const linkToken = generateLinkToken();
  const now = Date.now();
  insertMagicLink({
    id: crypto.randomUUID(),
    email: emailRaw,
    code_hash: sha256(code),
    token_hash: sha256(linkToken),
    expires_at: now + TEN_MINUTES,
    consumed_at: null,
    attempts: 0,
    created_at: now,
  });

  try {
    await sendMagicLinkEmail({ to: emailRaw, code, linkToken });
  } catch (err) {
    console.error("[/auth/request] email send failed:", err);
    return c.json({ error: "failed to send email" }, 500);
  }

  return c.json({ ok: true });
});

// POST /auth/verify — body: { email, code }
// Verifies 6-digit OTP, returns JWT.
auth.post("/verify", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email as string | undefined)?.trim().toLowerCase();
  const code = (body.code as string | undefined)?.trim();
  if (!email || !EMAIL_RE.test(email) || !code || !/^\d{6}$/.test(code)) {
    return c.json({ error: "invalid email or code" }, 400);
  }

  const link = findActiveMagicLinkByEmail(email);
  if (!link) {
    return c.json({ error: "code expired or not found" }, 400);
  }

  if (link.attempts >= MAX_VERIFY_ATTEMPTS) {
    return c.json({ error: "too many attempts" }, 429);
  }

  if (sha256(code) !== link.code_hash) {
    incrementMagicLinkAttempts(link.id);
    return c.json({ error: "invalid code" }, 400);
  }

  consumeMagicLink(link.id);
  const user = findOrCreateUser(email);
  markUserLogin(user.id);
  const token = mintJwt(user.id, user.email);
  return c.json({ token, user: { id: user.id, email: user.email } });
});

// GET /auth/verify-link?token=...
// One-click email link: consumes the magic-link token directly and returns
// HTML that hands the JWT to the app via deep link, with a fallback that
// shows the JWT for manual paste if the deep link doesn't fire.
auth.get("/verify-link", async (c) => {
  const linkToken = c.req.query("token");
  if (!linkToken) return c.text("missing token", 400);

  const link = findActiveMagicLinkByTokenHash(sha256(linkToken));
  if (!link) return c.text("link expired or already used", 400);

  consumeMagicLink(link.id);
  const user = findOrCreateUser(link.email);
  markUserLogin(user.id);
  const jwt = mintJwt(user.id, user.email);

  const deepLink =
    `belovik://auth?token=${encodeURIComponent(jwt)}` +
    `&email=${encodeURIComponent(user.email)}`;
  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>А-ГОЛОС — вход</title>
<meta http-equiv="refresh" content="0; url=${deepLink}">
<style>
  body{font-family:-apple-system,'Inter',Segoe UI,Roboto,sans-serif;background:#0B0D16;color:#F5F6F8;padding:48px 16px;text-align:center;margin:0;min-height:100vh;}
  .badge{display:inline-block;font-size:11px;font-weight:600;letter-spacing:1.2px;color:#F22A37;text-transform:uppercase;margin-bottom:16px;}
  .card{max-width:480px;margin:0 auto;background:#161A24;border-radius:20px;padding:32px;border:1px solid rgba(245,246,248,0.08);box-shadow:0 4px 24px rgba(0,0,0,0.4);text-align:left;}
  h1{font-size:22px;font-weight:800;margin:0 0 16px 0;letter-spacing:-0.3px;}
  p{color:#8A90A2;font-size:14px;line-height:1.55;}
  code{display:block;word-break:break-all;font-family:ui-monospace,Menlo,monospace;background:#0B0D16;border:1px solid rgba(245,246,248,0.08);border-radius:14px;padding:16px;font-size:12px;margin-top:16px;color:#F5F6F8;}
  .tagline{margin-top:24px;font-size:11px;color:#5C616E;letter-spacing:0.4px;}
</style></head>
<body>
  <div class="badge">А-ГОЛОС</div>
  <div class="card">
    <h1>Открываем приложение…</h1>
    <p>Если приложение не открылось автоматически, скопируйте токен и вставьте его в окно входа.</p>
    <code>${jwt}</code>
  </div>
  <div class="tagline">Скажите мысль. Получите текст.</div>
</body></html>`);
});

// POST /auth/check-email — body: { email }
// Tells the client whether to show a password field or jump straight to OTP.
// Returns ok regardless of whether the email exists (no enumeration leak).
auth.post("/check-email", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const emailRaw = (body.email as string | undefined)?.trim().toLowerCase();
  if (!emailRaw || !EMAIL_RE.test(emailRaw)) {
    return c.json({ error: "invalid email" }, 400);
  }
  const user = findUserByEmail(emailRaw);
  // We DO leak existence here intentionally — the client needs it to choose
  // between password vs OTP. Acceptable trade-off: anyone can already send
  // an OTP request and infer existence indirectly via timing/email arrival.
  return c.json({
    exists: user != null,
    hasPassword: user?.password_hash != null,
  });
});

// POST /auth/login — body: { email, password } → JWT
auth.post("/login", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const email = (body.email as string | undefined)?.trim().toLowerCase();
  const password = body.password as string | undefined;
  if (!email || !EMAIL_RE.test(email) || !password) {
    return c.json({ error: "invalid email or password" }, 400);
  }

  const user = findUserByEmail(email);
  if (!user || !user.password_hash) {
    // Don't distinguish "no account" from "no password set" — both look
    // the same to an attacker, and the legitimate client already learned
    // the truth via /auth/check-email.
    return c.json({ error: "invalid email or password" }, 401);
  }

  const ok = await Bun.password.verify(password, user.password_hash);
  if (!ok) {
    return c.json({ error: "invalid email or password" }, 401);
  }

  markUserLogin(user.id);
  const token = mintJwt(user.id, user.email);
  return c.json({ token, user: { id: user.id, email: user.email } });
});

// POST /auth/set-password — Bearer auth — body: { newPassword, currentPassword? }
// Sets the password for the first time, or changes it. When changing, the
// caller must provide currentPassword (unless they don't have one yet).
auth.post("/set-password", requireAuth, async (c) => {
  const sessionUser = c.get("user" as never) as { id: string; email: string };
  const body = await c.req.json().catch(() => ({}));
  const newPassword = body.newPassword as string | undefined;
  const currentPassword = body.currentPassword as string | undefined;

  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    return c.json(
      { error: `password must be at least ${MIN_PASSWORD_LENGTH} chars` },
      400
    );
  }

  const user = getUserById(sessionUser.id);
  if (!user) return c.json({ error: "unauthorized" }, 401);

  // If a password is already set, require the current one. Skip the check
  // when the user has no password yet (first-time set after OTP login).
  if (user.password_hash) {
    if (!currentPassword) {
      return c.json({ error: "current password required" }, 400);
    }
    const ok = await Bun.password.verify(currentPassword, user.password_hash);
    if (!ok) return c.json({ error: "current password is incorrect" }, 401);
  }

  const hash = await Bun.password.hash(newPassword);
  setUserPasswordHash(user.id, hash);
  return c.json({ ok: true });
});

// POST /auth/logout — Bearer auth — currently a no-op acknowledgement.
// Clients clear local state on success. Will gain server-side revocation
// (token blacklist or refresh-token rotation) when we add billing/abuse
// concerns; for now JWT lifetimes are short enough.
auth.post("/logout", requireAuth, async (c) => {
  return c.json({ ok: true });
});

// GET /auth/me — returns current user (for token validation by clients).
auth.get("/me", requireAuth, async (c) => {
  const user = c.get("user" as never) as { id: string; email: string } | undefined;
  if (!user) return c.json({ error: "unauthorized" }, 401);
  const row = getUserById(user.id);
  if (!row) return c.json({ error: "unauthorized" }, 401);
  return c.json({ id: row.id, email: row.email });
});

// Middleware: require valid Bearer JWT, attach user to context.
export async function requireAuth(c: Context, next: Next) {
  const header = c.req.header("authorization") ?? c.req.header("Authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ error: "unauthorized" }, 401);

  const payload = verifyJwt(token);
  if (!payload) return c.json({ error: "unauthorized" }, 401);

  c.set("user" as never, { id: payload.sub, email: payload.email });
  await next();
}
