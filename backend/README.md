# А-ГОЛОС backend

Bun + Hono. Runs on the VPS, fronted by Caddy. Two responsibilities:

1. **`/transcribe`** — accepts audio, calls OpenAI for STT + cleanup, returns text.
2. **`/auth/*`** — email magic-link / OTP authentication, issues JWT.

## Local dev

```bash
bun install
cp .env.example .env   # fill in OPENAI_API_KEY, AUTH_JWT_SECRET
bun --hot index.ts
```

If `RESEND_API_KEY` is unset, the OTP code is logged to stdout instead of
sent — fine for local testing.

## Auth flow

```
POST /auth/request  { email }                  → 200 { ok: true }
POST /auth/verify   { email, code }            → 200 { token, user }
GET  /auth/verify-link?token=...                → HTML w/ deep link agolos://auth?token=JWT
GET  /auth/me        Authorization: Bearer JWT  → 200 { id, email }
```

Magic links and OTP codes share storage: each `/auth/request` mints both,
the email contains the 6-digit code (primary UX) and a link (one-click).
Codes expire in 10 min, max 5 verify attempts, max 5 requests per email
per 15 min.

`/transcribe` requires `Authorization: Bearer <jwt>`.

### Quick curl test

```bash
# 1. Request code (check container logs in dev mode)
curl -X POST http://localhost:8787/auth/request \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com"}'

# 2. Verify (use code from email/log)
curl -X POST http://localhost:8787/auth/verify \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","code":"123456"}'
# → { "token": "eyJhbGc...", "user": { ... } }

# 3. Use token
curl http://localhost:8787/auth/me \
  -H 'Authorization: Bearer eyJhbGc...'
```

## Production

```bash
docker compose up -d --build
```

SQLite DB lives in the named volume `wispr_data` (mounted at `/data`).
Survives `docker compose down`; nuke with `docker volume rm backend_wispr_data`
if you really need a fresh DB.
