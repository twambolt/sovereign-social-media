# sovereign-social-media

A personal, **approval-gated** website for sharing photos and writings. Visitors sign in
with **Instagram** or **Substack**; every new sign-in creates a *pending* request that only
you (the owner) can approve or deny from the admin panel. Until approved, nobody can see
any content — they only see a "request received" page.

Zero npm dependencies. Runs on Node.js >= 22.5 (uses the built-in `node:http` server and
`node:sqlite`), so it's cheap to host on any small VPS and easy to audit.

## How it works

```
visitor hits /            → landing page with "Continue with Instagram / Substack"
visitor picks a provider  → OAuth2 authorization-code flow (PKCE where supported)
callback                  → identity stored as a PENDING user, session created
/gate                     → "your request is waiting for approval"
owner opens /admin        → sees who asked (handle, name, email, provider, time)
owner approves            → user status = approved → /home, /photos, /writings, /media/*
```

You are the owner if your `provider:subject` (or email) is listed in `OWNER_IDS` /
`OWNER_EMAILS`. The owner account is auto-approved and gets `/admin`.

## Quick start

```bash
cp .env.example .env
# edit .env (at minimum: PUBLIC_URL, OWNER_IDS, INSTAGRAM_CLIENT_ID/SECRET)
npm start          # http://127.0.0.1:3000
```

Run the end-to-end test (uses a mock provider, no external network):

```bash
npm run smoke
```

## Configuration (`.env`)

| Variable | Required | Notes |
|---|---|---|
| `PUBLIC_URL` | yes | Public base URL, e.g. `https://photos.example.com`. Used for OAuth redirect URIs. |
| `OWNER_IDS` | yes | Comma-separated `provider:subject`, e.g. `instagram:1784xxxxxxxxx,substack:123456789` |
| `OWNER_EMAILS` | no | Comma-separated emails that also identify the owner |
| `SITE_NAME`, `SITE_TAGLINE` | no | Branding on the landing page |
| `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` | for Instagram login | From a Meta app (below) |
| `SUBSTACK_CLIENT_ID` / `SUBSTACK_CLIENT_SECRET` | optional | If empty, a client is auto-registered via dynamic client registration (below) |
| `SUBSTACK_SCOPE` | no | Defaults to `openid profile email offline_access` |
| `MAX_UPLOAD_MB` | no | Photo upload limit, default 10 |
| `SESSION_DAYS` | no | Session lifetime, default 30 |
| `MOCK_OAUTH=1` | dev only | Enables `/login/mock?as=name`; refused when `NODE_ENV=production` |

`AUTH_SECRET` is auto-generated into `data/.auth_secret` (mode 0600) on first run if not set.

## Instagram login setup

Meta retired the old Basic Display API; the current flow is **Instagram API with
Instagram Login** ("Business Login"):

1. Create an app at <https://developers.facebook.com/apps> (type: Consumer is fine for
   Instagram Login; Business if you also want Facebook Login).
2. Add the **Instagram** product → "API setup with Instagram login". Copy the **Instagram
   App ID** and **Instagram App Secret** into `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET`.
3. Under the Instagram Login settings, add your redirect URI:
   `https://your-domain/auth/callback/instagram` (or `http://127.0.0.1:3000/...` for local dev).
4. The app requests only the `instagram_business_basic` scope and reads `id` + `username`.

Caveat: since Meta's 2025 changes, **only Creator/Business Instagram accounts can connect
through the official API** — personal accounts are rejected by Meta. Switching an account to
Creator/Business is free and instant in Instagram settings. For a small approval-gated site you
can also add trusted people as "testers" in the Meta dashboard, or submit for app review.

## Substack login setup

Substack has **no public developer program**, but it does run a live OAuth 2.0 authorization
server. This app uses it as follows (all discovered from
`https://substack.com/.well-known/oauth-authorization-server`):

- Dynamic Client Registration (RFC 7591) at `https://mcp.substack.com/oauth/register`
  (the resulting `client_id` is persisted in `data/site.db`).
- Authorization at `https://substack.com/oauth/auth` with **PKCE (S256)**.
- Token exchange at `https://mcp.substack.com/oauth/token`.
- Identity from `https://substack.com/oauth/me`.

If you are granted first-party client credentials, set `SUBSTACK_CLIENT_ID` /
`SUBSTACK_CLIENT_SECRET` instead and registration is skipped.

Caveat: this is an undocumented surface and Substack can change or restrict it at any time.
The code degrades gracefully (login just shows an error on the landing page). Note that with
DCR-registered clients, Substack currently narrows the granted scope, so the handle shown in
the admin panel may be the `sub` claim rather than an @handle. Instagram is the fully
supported path.

## Running in production

- Set `PUBLIC_URL=https://your-domain` and put the app behind a reverse proxy (Caddy/nginx)
  that terminates TLS. The app sends `Secure` cookies and HSTS when it sees HTTPS.
- `HOST=127.0.0.1` is fine — the proxy forwards to the local port.
- Example systemd unit:

  ```ini
  [Service]
  WorkingDirectory=/opt/gatehouse
  Environment=NODE_ENV=production
  EnvironmentFile=/opt/gatehouse/.env
  ExecStart=/usr/bin/node src/server.js
  Restart=always
  ```

## Data & backups

Everything lives in `data/` (gitignored): `site.db` (SQLite: users, sessions, OAuth states,
clients, photos, writings), `uploads/` (photo files), `.auth_secret`. Back up the whole
`data/` directory; `sqlite3 data/site.db ".backup backup.db"` for a consistent copy.

## Security notes

- Sessions: random 256-bit token in an `HttpOnly; SameSite=Lax` cookie; only its SHA-256 is stored.
- CSRF: per-session token required on every POST, plus same-origin check; OAuth `state` is single-use and expires in 10 minutes; PKCE (S256) used for Substack.
- All HTML is escaped; the Markdown renderer only allows `http(s)`/`mailto` links.
- Uploaded photos are magic-byte sniffed (jpg/png/gif/webp), stored under random names, and served only to approved members with `nosniff`.
- CSP (`script-src 'none'`, `frame-ancestors 'none'`), rate limits on login/callback/media routes.
- No passwords anywhere — identity comes only from the OAuth providers.

## Project layout

```
src/config.js      env loading + config
src/db.js          SQLite schema + store
src/security.js    tokens, HMAC, CSRF, rate limiting
src/providers.js   Instagram / Substack / mock OAuth providers
src/markdown.js    tiny safe Markdown renderer
src/multipart.js   multipart/form-data parser (photo uploads)
src/views.js       HTML pages
src/server.js      HTTP server, routing, gate + admin
scripts/smoke.mjs  end-to-end test (39 checks) via mock provider
public/            stylesheet + favicon
```

## Ideas for later

- Email notification to you on each new access request (needs an SMTP/API key).
- Per-photo / per-writing visibility (the "who gets to see what" part, taken further).
- Invite links that skip approval, expiring invites.
- Webhooks or a JSON API for members.
