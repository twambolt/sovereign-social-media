# sovereign-social-media

A members-only social platform where every approved member gets a **public hub** — a page
with their bio, a **link tree** to their public sites, and their **posts** (also published as
**RSS**). Visitors sign in with **Instagram** or **Substack**; the owner approves each request.
Approved members onboard themselves by building and customizing their own hub.

Zero npm dependencies. Runs on Node.js >= 22.5 (built-in `node:http` + `node:sqlite`), so it's
cheap to host on any small VPS and easy to audit.

**Privacy-first:** no analytics, ads, trackers or third-party calls (only the OAuth provider during
login); IPs are used in-memory for rate limiting only and never persisted; members can export or
delete all their data from `/me`; hubs can be flipped to members-only. See [Privacy](#privacy).

**Dev and non-dev friendly:** everything user-facing — site name, tagline, accent color, dark/light
theme — is editable from the admin UI with no code; only OAuth secrets live in `.env`.

## Concepts

| Concept | Visibility | Notes |
|---|---|---|
| Hub page `/u/<handle>` | **public** (or members-only per hub) | Bio, avatar, ordered link tree, posts. RSS at `/u/<handle>/feed.xml` |
| Hub directory `/hubs` | **public** | All approved members' public hubs |
| Global RSS `/rss.xml` | **public** | Latest posts across all hubs |
| Subscriptions feed `/feed` | members only | Posts from hubs you follow, ranked by **your** algorithm |
| Feed algorithm `/feed/settings` | members only | Tune freshness / engagement / interest weights + interest tags (RedNote-style) |
| Gallery `/photos`, `/writings` | members only | Owner-managed photos and Markdown writings |
| Admin `/admin` | owner only | Approve / deny / revoke access requests; manage gallery; site settings |
| Account `/me`, privacy `/privacy` | members / public | Data export, account deletion, privacy policy |

## How it works

```
visitor hits /            → landing with "Continue with Instagram / Substack" (+ public hub directory)
sign-in (OAuth2 + state, PKCE for Substack) → identity stored as PENDING, session created
/gate                     → "your request is waiting for approval"
owner opens /admin        → sees who asked (handle, name, email, provider, time) → Approve
approved member           → /onboarding: pick hub handle, display name, bio
                          → /hub/edit: customize profile, manage link tree (add / reorder / delete), public/private
member posts              → appears on their hub, their RSS feed, and subscribers' /feed
member subscribes         → /subscriptions: follow hubs (in-app) or copy /u/<handle>/feed.xml into any reader
member tailors feed       → /feed/settings: mode (algorithm | chrono), weights, interest tags
```

You are the owner if your `provider:subject` (or email) is listed in `OWNER_IDS` /
`OWNER_EMAILS`. The owner account is auto-approved and gets `/admin`.

### The feed algorithm

Each member has their own ranking settings (`users.settings_json`):

- `mode`: `algorithm` or `chrono` (plain newest-first).
- `weights.freshness` — `exp(-ageHours / 48)`, decays over ~2 days.
- `weights.engagement` — likes on a post, normalized by the most-liked post in the feed.
- `weights.interest` — overlap between the post's `#tags` and your saved interest tags.

Score = `w_freshness·freshness + w_engagement·engagement + w_interest·interest`, sorted
descending. Change the weights any time — the feed re-ranks immediately.

## Quick start

```bash
cp .env.example .env
# edit .env (at minimum: PUBLIC_URL, OWNER_IDS, INSTAGRAM_CLIENT_ID/SECRET)
npm start          # http://127.0.0.1:3000
```

Run the end-to-end test (uses a mock provider, no external network — 92 checks covering the
approval gate, onboarding, hubs, link trees, posts, RSS, subscriptions, feed ranking, privacy
controls and admin customization):

```bash
npm run smoke
```

## Configuration (`.env`)

| Variable | Required | Notes |
|---|---|---|
| `PUBLIC_URL` | yes | Public base URL, e.g. `https://hub.example.com`. Used for OAuth redirect URIs and RSS links. |
| `OWNER_IDS` | yes | Comma-separated `provider:subject`, e.g. `instagram:1784xxxxxxxxx,substack:123456789` |
| `OWNER_EMAILS` | no | Comma-separated emails that also identify the owner |
| `SITE_NAME`, `SITE_TAGLINE` | no | Defaults — overridable live from `/admin` without code |
| `INSTAGRAM_CLIENT_ID` / `INSTAGRAM_CLIENT_SECRET` | for Instagram login | From a Meta app (below) |
| `SUBSTACK_CLIENT_ID` / `SUBSTACK_CLIENT_SECRET` | optional | If empty, a client is auto-registered via dynamic client registration (below) |
| `SUBSTACK_SCOPE` | no | Defaults to `openid profile email offline_access` |
| `MAX_UPLOAD_MB` | no | Upload limit, default 10 |
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

## Privacy

- **No trackers:** no analytics, ads, cookies beyond the session, third-party scripts/fonts/CDNs.
  The only outbound call is to Instagram/Substack during login. Outbound links use `rel="noopener noreferrer"`.
- **Data minimization:** we store only the OAuth identity (provider id + handle, plus name/email/avatar
  if granted), your content, and a SHA-256-hashed session token. No passwords exist. IPs are used
  in-memory for rate limiting and never written anywhere.
- **Public vs private:** hubs are public by default (that's the point — a link tree), but any hub can be
  switched to **members-only** in hub settings; then `/u/<handle>` and its RSS 404 for anonymous visitors.
  Feeds, subscriptions, gallery and admin are always members-only.
- **Your controls** (`/me`): export everything we hold about you as JSON (`/me/export`), or delete your
  account — posts, links, likes, follows and sessions are all removed immediately. There's a public
  `/privacy` page explaining all of this.
- **Retention:** OAuth states are single-use, expire in 10 minutes; sessions expire (default 30 days).

## Customizing without code

As the owner, open **`/admin` → Site settings**: site name, tagline, accent color (color picker) and
dark/light theme. Changes apply instantly via a generated `/theme.css` (keeps the strict CSP intact —
no inline styles). Hub owners customize their own hub (bio, avatar, link tree, public/private) from
`/hub/edit`, and their feed algorithm from `/feed/settings`. Only the OAuth client secrets
(`INSTAGRAM_CLIENT_ID/SECRET`, optional `SUBSTACK_CLIENT_ID/SECRET`) and `PUBLIC_URL`/`OWNER_IDS` live
in `.env` — those are the only things a developer needs to touch.

## Running in production

- Set `PUBLIC_URL=https://your-domain` and put the app behind a reverse proxy (Caddy/nginx)
  that terminates TLS. The app sends `Secure` cookies and HSTS when it sees HTTPS.
- `HOST=127.0.0.1` is fine — the proxy forwards to the local port.
- Example systemd unit:

  ```ini
  [Service]
  WorkingDirectory=/opt/sovereign-social-media
  Environment=NODE_ENV=production
  EnvironmentFile=/opt/sovereign-social-media/.env
  ExecStart=/usr/bin/node src/server.js
  Restart=always
  ```

## Data & backups

Everything lives in `data/` (gitignored): `site.db` (SQLite: users, sessions, OAuth states,
clients, gallery, hub links, posts, likes, follows, site settings), `uploads/` (gallery photos +
post images), `.auth_secret`. Back up the whole `data/` directory; `sqlite3 data/site.db ".backup backup.db"`
for a consistent copy.

## Security notes

- Sessions: random 256-bit token in an `HttpOnly; SameSite=Lax` cookie; only its SHA-256 is stored.
- CSRF: per-session token required on every POST, plus same-origin check; OAuth `state` is single-use and expires in 10 minutes; PKCE (S256) used for Substack.
- Hub pages and public RSS are public **by design** (they are the shareable surface); feeds, gallery, admin and all mutations require an approved session. Members-only hubs 404 for anonymous visitors.
- Link-tree URLs must be `http(s)`; all HTML is escaped; the Markdown renderer only allows `http(s)`/`mailto` links.
- Uploads are magic-byte sniffed (jpg/png/gif/webp), stored under random names; gallery media is members-only (`/media/...`), post images are public (`/media/post/...`).
- CSP (`script-src 'none'`, `frame-ancestors 'none'`), rate limits on login/callback/media/RSS routes.
- No passwords anywhere — identity comes only from the OAuth providers.

## Project layout

```
src/config.js      env loading + config
src/db.js          SQLite schema + store (users, sessions, links, posts, likes, follows, site settings)
src/security.js    tokens, HMAC, CSRF, rate limiting
src/providers.js   Instagram / Substack / mock OAuth providers
src/feed.js        feed settings + scoring (tailorable algorithm)
src/rss.js         RSS 2.0 builder
src/markdown.js    tiny safe Markdown renderer
src/multipart.js   multipart/form-data parser (uploads)
src/views.js       HTML pages
src/server.js      HTTP server, routing, gate + hubs + admin
public/            stylesheet + favicon
scripts/smoke.mjs  end-to-end test (92 checks) via mock provider
```

## Ideas for later

- Email notification to you on each new access request (needs an SMTP/API key).
- Webfinger / ActivityPub so hubs can be followed from Mastodon etc.
- Per-post or per-hub visibility (the "who gets to see what" part, taken further).
- Invite links that skip approval, expiring invites.
- Feed "for you" discovery tab (posts from non-subscribed hubs, ranked by your interests).
