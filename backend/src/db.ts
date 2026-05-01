import { Database } from "bun:sqlite";

// SQLite is sufficient for auth at our scale (single-instance backend, low
// write volume). Mounted as a docker volume so data survives redeploys.
// DB_PATH defaults to local file in dev; in container we mount /data.
const DB_PATH = process.env.DB_PATH ?? "./data/wispr.db";

export const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL COLLATE NOCASE,
    password_hash TEXT,
    created_at INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS magic_links (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL COLLATE NOCASE,
    code_hash TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_magic_links_email ON magic_links(email);
  CREATE INDEX IF NOT EXISTS idx_magic_links_expires ON magic_links(expires_at);
`);

// Migrate existing v0.3.0 deployments that have a users table without
// password_hash. SQLite has no `ADD COLUMN IF NOT EXISTS`, so introspect
// first. Idempotent: safe to run on every boot.
{
  const cols = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "password_hash")) {
    db.exec("ALTER TABLE users ADD COLUMN password_hash TEXT");
  }
}

export type User = {
  id: string;
  email: string;
  password_hash: string | null;
  created_at: number;
  last_login_at: number | null;
};

export type MagicLink = {
  id: string;
  email: string;
  code_hash: string;
  token_hash: string;
  expires_at: number;
  consumed_at: number | null;
  attempts: number;
  created_at: number;
};

export function findOrCreateUser(email: string): User {
  const normalized = email.trim().toLowerCase();
  const existing = db
    .query("SELECT * FROM users WHERE email = ?")
    .get(normalized) as User | null;
  if (existing) return existing;

  const id = crypto.randomUUID();
  const now = Date.now();
  db.run(
    "INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)",
    [id, normalized, now]
  );
  return {
    id,
    email: normalized,
    password_hash: null,
    created_at: now,
    last_login_at: null,
  };
}

export function findUserByEmail(email: string): User | null {
  return db
    .query("SELECT * FROM users WHERE email = ?")
    .get(email.trim().toLowerCase()) as User | null;
}

export function setUserPasswordHash(userId: string, hash: string): void {
  db.run("UPDATE users SET password_hash = ? WHERE id = ?", [hash, userId]);
}

export function markUserLogin(userId: string): void {
  db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [Date.now(), userId]);
}

export function getUserById(id: string): User | null {
  return db.query("SELECT * FROM users WHERE id = ?").get(id) as User | null;
}

export function insertMagicLink(row: MagicLink): void {
  db.run(
    `INSERT INTO magic_links (id, email, code_hash, token_hash, expires_at, consumed_at, attempts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.email, row.code_hash, row.token_hash, row.expires_at, row.consumed_at, row.attempts, row.created_at]
  );
}

export function findActiveMagicLinkByEmail(email: string): MagicLink | null {
  return db
    .query(
      `SELECT * FROM magic_links
       WHERE email = ? AND consumed_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(email.toLowerCase(), Date.now()) as MagicLink | null;
}

export function findActiveMagicLinkByTokenHash(tokenHash: string): MagicLink | null {
  return db
    .query(
      `SELECT * FROM magic_links
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`
    )
    .get(tokenHash, Date.now()) as MagicLink | null;
}

export function consumeMagicLink(id: string): void {
  db.run("UPDATE magic_links SET consumed_at = ? WHERE id = ?", [Date.now(), id]);
}

export function incrementMagicLinkAttempts(id: string): number {
  db.run("UPDATE magic_links SET attempts = attempts + 1 WHERE id = ?", [id]);
  const row = db
    .query("SELECT attempts FROM magic_links WHERE id = ?")
    .get(id) as { attempts: number } | null;
  return row?.attempts ?? 0;
}

// Rate limit: count magic-link requests for an email in the last `windowMs`.
export function countRecentMagicLinks(email: string, windowMs: number): number {
  const since = Date.now() - windowMs;
  const row = db
    .query("SELECT COUNT(*) as n FROM magic_links WHERE email = ? AND created_at > ?")
    .get(email.toLowerCase(), since) as { n: number };
  return row.n;
}
