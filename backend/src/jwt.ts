import { createHmac, timingSafeEqual } from "node:crypto";

// Hand-rolled HS256 — avoids pulling jose/jsonwebtoken for one helper.
// Token format: base64url(header).base64url(payload).base64url(sig)

const SECRET = process.env.AUTH_JWT_SECRET;
if (!SECRET || SECRET.length < 32) {
  console.warn(
    "[auth] AUTH_JWT_SECRET missing or shorter than 32 chars — set a strong secret in .env"
  );
}

// 30 days. Mobile/desktop apps stay logged in across restarts; we'll add
// refresh tokens later if we need to revoke server-side mid-session.
const TTL_SECONDS = 60 * 60 * 24 * 30;

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

export type JwtPayload = {
  sub: string;       // user id
  email: string;
  iat: number;
  exp: number;
};

export function mintJwt(userId: string, email: string): string {
  if (!SECRET) throw new Error("AUTH_JWT_SECRET not configured");
  const now = Math.floor(Date.now() / 1000);
  const payload: JwtPayload = {
    sub: userId,
    email,
    iat: now,
    exp: now + TTL_SECONDS,
  };
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string): JwtPayload | null {
  if (!SECRET) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = createHmac("sha256", SECRET).update(`${header}.${body}`).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString()) as JwtPayload;
    if (payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
