import { Hono } from "hono";
import { createHash, randomBytes, randomInt } from "node:crypto";
import {
  consumeMagicLink,
  countRecentMagicLinks,
  findActiveMagicLinkByEmail,
  findActiveMagicLinkByTokenHash,
  findOrCreateUser,
  getUserById,
  incrementMagicLinkAttempts,
  insertMagicLink,
  markUserLogin,
} from "./db";
import { sendMagicLinkEmail } from "./email";
import { mintJwt, verifyJwt } from "./jwt";
import type { Context, Next } from "hono";

const TEN_MINUTES = 10 * 60 * 1000;
const FIFTEEN_MINUTES = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 5;
const MAX_VERIFY_ATTEMPTS = 5;

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

  const deepLink = `belovik://auth?token=${encodeURIComponent(jwt)}`;
  return c.html(`<!doctype html>
<html><head><meta charset="utf-8"><title>Беловик — вход</title>
<meta http-equiv="refresh" content="0; url=${deepLink}">
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#F4F1EC;color:#15171A;padding:48px 16px;text-align:center;}
  .card{max-width:480px;margin:0 auto;background:#FCFAF6;border-radius:16px;padding:32px;border:1px solid rgba(21,23,26,.06);}
  code{display:block;word-break:break-all;font-family:ui-monospace,Menlo,monospace;background:#ECEFEA;border-radius:12px;padding:16px;font-size:12px;margin-top:16px;}
</style></head>
<body><div class="card">
  <h1>Открываем Беловик…</h1>
  <p>Если приложение не открылось автоматически, скопируйте токен и вставьте его в окно входа:</p>
  <code>${jwt}</code>
</div></body></html>`);
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
