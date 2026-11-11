import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildConfig, isOwnerIdentity } from './config.js';
import { openDb, createStore } from './db.js';
import { randomToken, sha256hex, safeEqual, parseCookies, csrfFor, makeRateLimiter, clientIp } from './security.js';
import { parseMultipart, multipartBoundary } from './multipart.js';
import { makeProviders } from './providers.js';
import { scoreFeed, parseSettings, normalizeTags, defaultSettings } from './feed.js';
import { rssFeed, postToRssItem } from './rss.js';
import * as views from './views.js';

const MIME_STATIC = {
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

const IMAGE_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const RESERVED_SLUGS = new Set([
  'admin', 'u', 'feed', 'rss', 'login', 'logout', 'auth', 'media', 'photos', 'writings',
  'home', 'gate', 'onboarding', 'hub', 'hubs', 'subscriptions', 'posts', 'healthz',
  'style.css', 'theme.css', 'favicon.svg', 'app.js', 'settings', 'privacy', 'me',
]);

const DEFAULT_ACCENT = '#e8c07d';

const LIGHT_PALETTE = `:root {
  --bg: #f6f5f2;
  --panel: #ffffff;
  --panel-2: #efede8;
  --text: #1d1c22;
  --muted: #6b6878;
  --line: #ddd9d0;
}`;

function validAccent(s) {
  return /^#[0-9a-fA-F]{6}$/.test(String(s || '').trim());
}

function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (buf.length > 6 && (buf.toString('latin1', 0, 6) === 'GIF89a' || buf.toString('latin1', 0, 6) === 'GIF87a')) return '.gif';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return '.webp';
  return null;
}

function slugify(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return s || 'post';
}

function validHttpUrl(s) {
  try {
    const u = new URL(String(s || ''));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function validSlug(s) {
  return /^[a-z0-9][a-z0-9-]{1,31}$/.test(String(s || '').toLowerCase()) && !RESERVED_SLUGS.has(String(s).toLowerCase());
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function startServer(overrides = {}) {
  const config = { ...buildConfig(), ...overrides };
  if (!config.publicUrl) config.publicUrl = `http://${config.host}:${config.port}`;
  config.publicUrl = config.publicUrl.replace(/\/+$/, '');
  const db = openDb(config.dataDir);
  const store = createStore(db);
  const providers = makeProviders(config, store);
  const providerList = [providers.instagram, providers.substack, providers.mock];

  const loginLimiter = makeRateLimiter({ windowMs: 10 * 60 * 1000, max: 20 });
  const postLimiter = makeRateLimiter({ windowMs: 10 * 60 * 1000, max: 120 });
  const mediaLimiter = makeRateLimiter({ windowMs: 10 * 60 * 1000, max: 240 });

  const isHttps = (req) =>
    config.publicUrl.startsWith('https://') || req.headers['x-forwarded-proto'] === 'https';

  function securityHeaders(req) {
    return {
      'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=(), microphone=(), geolocation=()',
      ...(isHttps(req) ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
    };
  }

  function send(req, res, status, body, headers = {}) {
    const h = { ...securityHeaders(req), ...headers };
    if (typeof body === 'string' && !h['content-type']) h['content-type'] = 'text/html; charset=utf-8';
    res.writeHead(status, h);
    res.end(body);
  }

  const html = (req, res, status, doc) =>
    send(req, res, status, doc, { 'cache-control': 'no-store' });

  const redirect = (req, res, location, status = 303) =>
    send(req, res, status, '', { location, 'cache-control': 'no-store' });

  function setSessionCookie(req, res, token, maxAgeSec) {
    const parts = [
      `sid=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSec}`,
    ];
    if (isHttps(req)) parts.push('Secure');
    res.setHeader('set-cookie', parts.join('; '));
  }

  function clearSessionCookie(req, res) {
    const parts = ['sid=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (isHttps(req)) parts.push('Secure');
    res.setHeader('set-cookie', parts.join('; '));
  }

  function getSession(req) {
    const cookies = parseCookies(req);
    const token = cookies.sid;
    if (!token) return null;
    const row = store.getSession(sha256hex(token));
    if (!row) return null;
    return { token, user: row };
  }

  function siteSettings() {
    const s = {};
    for (const row of store.listSiteSettings()) s[row.key] = row.value;
    return {
      name: s.site_name || config.siteName,
      tagline: s.site_tagline || config.siteTagline,
      accent: validAccent(s.accent_color) ? s.accent_color.trim() : DEFAULT_ACCENT,
      theme: s.theme === 'light' ? 'light' : 'dark',
    };
  }

  function themeCss() {
    const ss = siteSettings();
    let css = `:root { --accent: ${ss.accent}; }\n`;
    if (ss.theme === 'light') css += LIGHT_PALETTE + '\n';
    return css;
  }

  const viewCtx = (req, session) => {
    const ss = siteSettings();
    return {
      siteName: ss.name,
      siteTagline: ss.tagline,
      publicUrl: config.publicUrl,
      user: session?.user ?? null,
      csrf: session ? csrfFor(config.authSecret, session.token) : '',
    };
  };

  async function parseForm(req, maxBytes) {
    const ct = String(req.headers['content-type'] || '');
    const raw = await readBody(req, maxBytes);
    if (ct.startsWith('application/x-www-form-urlencoded')) {
      const params = new URLSearchParams(raw.toString('utf8'));
      const fields = {};
      for (const [k, v] of params) fields[k] = v;
      return { fields, files: {} };
    }
    if (ct.startsWith('multipart/form-data')) {
      const boundary = multipartBoundary(ct);
      if (!boundary) throw new Error('bad multipart content-type');
      return parseMultipart(raw, boundary);
    }
    throw new Error('unsupported content-type');
  }

  function checkCsrf(req, session, fields) {
    if (!session) return false;
    const expected = csrfFor(config.authSecret, session.token);
    const got = fields?.csrf || '';
    if (!got || !safeEqual(expected, got)) return false;
    const origin = req.headers.origin;
    if (origin && origin !== new URL(config.publicUrl).origin) return false;
    return true;
  }

  const deny = (req, res, msg = 'Forbidden', status = 403) =>
    html(req, res, status, views.errorPage(viewCtx(req, null), status, msg));

  function requireSession(req, res) {
    const session = getSession(req);
    if (!session) {
      redirect(req, res, '/');
      return null;
    }
    return session;
  }

  function requireApproved(req, res) {
    const session = requireSession(req, res);
    if (!session) return null;
    if (session.user.status !== 'approved') {
      redirect(req, res, '/gate');
      return null;
    }
    return session;
  }

  function requireOwner(req, res) {
    const session = requireApproved(req, res);
    if (!session) return null;
    if (session.user.role !== 'owner') {
      deny(req, res, 'Owner access only');
      return null;
    }
    return session;
  }

  const decoratePosts = (posts, session) =>
    posts.map((p) => ({
      ...p,
      likes: store.likeCount(p.id),
      liked: session ? store.hasLiked(p.id, session.user.id) : false,
    }));

  // ---------- handlers ----------

  async function hLanding(req, res, _m, url) {
    const session = getSession(req);
    if (session) {
      return session.user.status === 'approved' ? redirect(req, res, '/home') : redirect(req, res, '/gate');
    }
    html(req, res, 200, views.landingPage(viewCtx(req, null), providerList, url.searchParams.get('error') || ''));
  }

  async function hLogin(req, res, m, url) {
    if (!loginLimiter(clientIp(req))) return deny(req, res, 'Too many attempts, try again later', 429);
    const provider = providerList.find((p) => p.id === m[1]);
    if (!provider || !provider.enabled) return deny(req, res, 'Unknown or disabled sign-in provider', 404);
    store.cleanupStates();
    const state = randomToken(24);
    const verifier = randomToken(48);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    const data = provider.id === 'mock' ? String(url.searchParams.get('as') || 'user') : '';
    store.createState({ state, provider: provider.id, verifier, data, expiresAt });
    const authUrl = await provider.authUrl({ state, verifier });
    redirect(req, res, authUrl, 302);
  }

  async function hCallback(req, res, m, url) {
    if (!loginLimiter(clientIp(req))) return deny(req, res, 'Too many attempts, try again later', 429);
    const provider = providerList.find((p) => p.id === m[1]);
    if (!provider || !provider.enabled) return deny(req, res, 'Unknown or disabled sign-in provider', 404);
    if (url.searchParams.get('error')) {
      return redirect(req, res, `/?error=${encodeURIComponent(url.searchParams.get('error_description') || url.searchParams.get('error'))}`);
    }
    const state = url.searchParams.get('state') || '';
    const code = url.searchParams.get('code') || '';
    const row = store.getState(state);
    if (!row || row.provider !== provider.id || row.used || row.expires_at < new Date().toISOString() || !code) {
      return redirect(req, res, '/?error=' + encodeURIComponent('Sign-in session expired or invalid — please try again.'));
    }
    store.markStateUsed(state);
    let accessToken;
    try {
      accessToken = await provider.exchange({ code, verifier: row.verifier, redirectUri: `${config.publicUrl}/auth/callback/${provider.id}` });
    } catch (e) {
      console.error(`[auth] ${provider.id} token exchange failed:`, e.message);
      return redirect(req, res, '/?error=' + encodeURIComponent('Sign-in failed at the provider — please try again.'));
    }
    let profile;
    try {
      profile = await provider.profile(accessToken, row);
    } catch (e) {
      console.error(`[auth] ${provider.id} profile fetch failed:`, e.message);
      return redirect(req, res, '/?error=' + encodeURIComponent('Could not read your profile from the provider.'));
    }
    if (!profile || !profile.sub) {
      return redirect(req, res, '/?error=' + encodeURIComponent('Provider did not return an identity.'));
    }

    const owner = isOwnerIdentity(config, provider.id, profile.sub, profile.email);
    let user = store.getUserByKey(provider.id, profile.sub);
    if (!user) {
      user = store.createUser({
        provider: provider.id,
        sub: String(profile.sub),
        handle: profile.handle || '',
        name: profile.name || '',
        email: profile.email || '',
        avatar: profile.avatar || '',
        status: owner ? 'approved' : 'pending',
        role: owner ? 'owner' : 'member',
      });
      console.log(`[auth] new user #${user.id} ${provider.id}:${user.sub} (${user.handle}) -> ${user.status}`);
    } else {
      store.updateProfile(user.id, profile);
      if (owner && user.role !== 'owner') store.promoteOwner(user.id);
      user = store.getUserByKey(provider.id, profile.sub);
    }

    const token = randomToken(32);
    const expiresAt = new Date(Date.now() + config.sessionDays * 24 * 3600 * 1000).toISOString();
    store.createSession(sha256hex(token), user.id, expiresAt);
    setSessionCookie(req, res, token, config.sessionDays * 24 * 3600);
    redirect(req, res, '/gate');
  }

  async function hLogout(req, res, _m, _url, form) {
    const session = getSession(req);
    if (!session || !checkCsrf(req, session, form.fields)) return deny(req, res);
    store.deleteSession(sha256hex(session.token));
    clearSessionCookie(req, res);
    redirect(req, res, '/');
  }

  async function hGate(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    if (session.user.status === 'approved') return redirect(req, res, '/home');
    html(req, res, 200, views.gatePage(viewCtx(req, session)));
  }

  async function hHome(req, res) {
    const session = requireApproved(req, res);
    if (!session) return;
    html(req, res, 200, views.homePage({ ...viewCtx(req, session), counts: { photos: store.countPhotos(), writings: store.countWritings() } }));
  }

  // ---------- public hubs + RSS ----------

  async function hHubs(req, res) {
    html(req, res, 200, views.hubsPage({ ...viewCtx(req, getSession(req)), hubs: store.listHubs() }));
  }

  async function hHub(req, res, m) {
    const hub = store.getUserBySlug(m[1].toLowerCase());
    const session = getSession(req);
    const memberView = Boolean(session && session.user.status === 'approved');
    if (!hub || hub.status !== 'approved' || (!hub.hub_public && !memberView)) {
      return html(req, res, 404, views.errorPage(viewCtx(req, session), 404, 'Hub not found'));
    }
    const canInteract = memberView;
    const posts = decoratePosts(store.listPostsByUser(hub.id), session);
    html(req, res, 200, views.hubPage({
      ...viewCtx(req, session),
      hub,
      posts,
      links: store.listLinks(hub.id),
      following: canInteract ? store.isFollowing(session.user.id, hub.id) : false,
      followers: store.followerCount(hub.id),
      canInteract,
    }));
  }

  function hubRss(hub) {
    const posts = store.listPostsByUser(hub.id);
    return rssFeed({
      title: `${hub.name || hub.hub_slug} (@${hub.hub_slug})`,
      link: `${config.publicUrl}/u/${hub.hub_slug}`,
      description: hub.bio || `Posts from @${hub.hub_slug}`,
      items: posts.map((p) => postToRssItem(p, config.publicUrl, hub.hub_slug)),
    });
  }

  async function hHubRss(req, res, m) {
    if (!mediaLimiter(clientIp(req))) return deny(req, res, 'Slow down', 429);
    const hub = store.getUserBySlug(m[1].toLowerCase());
    const session = getSession(req);
    const memberView = Boolean(session && session.user.status === 'approved');
    if (!hub || hub.status !== 'approved' || (!hub.hub_public && !memberView)) return deny(req, res, 'Not found', 404);
    send(req, res, 200, hubRss(hub), {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=60',
    });
  }

  async function hAllRss(req, res) {
    if (!mediaLimiter(clientIp(req))) return deny(req, res, 'Slow down', 429);
    const posts = store.listRecentPosts(50);
    send(req, res, 200, rssFeed({
      title: `${config.siteName} — all posts`,
      link: config.publicUrl,
      description: `Latest posts across all hubs on ${config.siteName}`,
      items: posts.map((p) => postToRssItem(p, config.publicUrl, p.hub_slug)),
    }), {
      'content-type': 'application/rss+xml; charset=utf-8',
      'cache-control': 'public, max-age=60',
    });
  }

  // ---------- onboarding + hub editing (approved members) ----------

  async function hOnboarding(req, res, _m, url) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (session.user.hub_slug) return redirect(req, res, '/hub/edit');
    html(req, res, 200, views.onboardingPage(viewCtx(req, session), url.searchParams.get('error') || ''));
  }

  async function hOnboardingPost(req, res, _m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    if (session.user.hub_slug) return redirect(req, res, '/hub/edit');
    const slug = String(form.fields.slug || '').trim().toLowerCase();
    const name = String(form.fields.name || session.user.name || '').trim().slice(0, 80);
    const bio = String(form.fields.bio || '').trim().slice(0, 300);
    if (!validSlug(slug)) {
      return redirect(req, res, '/onboarding?error=' + encodeURIComponent('Handle must be 2-32 chars of lowercase letters, numbers and dashes, and not a reserved word.'));
    }
    if (store.getUserBySlug(slug)) {
      return redirect(req, res, '/onboarding?error=' + encodeURIComponent('That handle is taken — pick another.'));
    }
    store.setHub(session.user.id, slug, name, bio);
    console.log(`[hub] user #${session.user.id} created hub @${slug}`);
    redirect(req, res, '/hub/edit?msg=' + encodeURIComponent(`Hub @${slug} created — add your link tree`));
  }

  async function hHubEdit(req, res, _m, url) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!session.user.hub_slug) return redirect(req, res, '/onboarding');
    html(req, res, 200, views.hubEditPage({
      ...viewCtx(req, session),
      links: store.listLinks(session.user.id),
      flash: url.searchParams.get('msg') || '',
      error: url.searchParams.get('error') || '',
    }));
  }

  async function hHubEditPost(req, res, _m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    if (!session.user.hub_slug) return redirect(req, res, '/onboarding');
    const name = String(form.fields.name || '').trim().slice(0, 80);
    const bio = String(form.fields.bio || '').trim().slice(0, 300);
    const avatar = String(form.fields.avatar || '').trim().slice(0, 500);
    if (avatar && !validHttpUrl(avatar)) {
      return redirect(req, res, '/hub/edit?error=' + encodeURIComponent('Avatar must be an http(s) URL.'));
    }
    store.updateHubProfile(session.user.id, { name, bio, avatar });
    store.setHubPublic(session.user.id, form.fields.hub_public === '1');
    redirect(req, res, '/hub/edit?msg=' + encodeURIComponent('Hub saved'));
  }

  async function hLinkNew(req, res, _m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    if (!session.user.hub_slug) return redirect(req, res, '/onboarding');
    const title = String(form.fields.title || '').trim().slice(0, 100);
    const url = String(form.fields.url || '').trim().slice(0, 500);
    if (!title || !validHttpUrl(url)) {
      return redirect(req, res, '/hub/edit?error=' + encodeURIComponent('Link needs a title and an http(s) URL.'));
    }
    store.addLink(session.user.id, title, url);
    redirect(req, res, '/hub/edit?msg=' + encodeURIComponent('Link added'));
  }

  async function hLinkDelete(req, res, m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const link = store.getLink(Number(m[1]));
    if (link && link.user_id === session.user.id) store.deleteLink(link.id);
    redirect(req, res, '/hub/edit?msg=' + encodeURIComponent('Link removed'));
  }

  async function hLinkMove(req, res, m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const dir = Number(form.fields.dir) === 1 ? 1 : -1;
    store.moveLink(Number(m[1]), session.user.id, dir);
    redirect(req, res, '/hub/edit');
  }

  // ---------- subscriptions + feed ----------

  async function hSubscriptions(req, res) {
    const session = requireApproved(req, res);
    if (!session) return;
    html(req, res, 200, views.subscriptionsPage({
      ...viewCtx(req, session),
      hubs: store.listHubs(),
      followingIds: new Set(store.followingIds(session.user.id)),
    }));
  }

  async function hFollow(req, res, m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const target = store.getUserById(Number(m[1]));
    if (!target || !target.hub_slug || target.status !== 'approved') return deny(req, res, 'No such hub', 404);
    if (target.id === session.user.id) return deny(req, res, 'Cannot subscribe to yourself', 400);
    if (m[2] === 'follow') store.follow(session.user.id, target.id);
    else store.unfollow(session.user.id, target.id);
    redirect(req, res, '/subscriptions');
  }

  async function hFeed(req, res) {
    const session = requireApproved(req, res);
    if (!session) return;
    const settings = parseSettings(store.getSettings(session.user.id));
    const candidates = decoratePosts(store.feedCandidates(session.user.id), session);
    const posts = scoreFeed(candidates, settings);
    html(req, res, 200, views.feedPage({
      ...viewCtx(req, session),
      posts,
      followingCount: store.followingIds(session.user.id).length,
      settings,
      canInteract: true,
    }));
  }

  async function hFeedSettings(req, res, _m, url) {
    const session = requireApproved(req, res);
    if (!session) return;
    html(req, res, 200, views.feedSettingsPage({
      ...viewCtx(req, session),
      settings: parseSettings(store.getSettings(session.user.id)),
      flash: url.searchParams.get('msg') || '',
    }));
  }

  async function hFeedSettingsPost(req, res, _m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const current = parseSettings(store.getSettings(session.user.id));
    const settings = {
      mode: form.fields.mode === 'chrono' ? 'chrono' : 'algorithm',
      weights: {
        freshness: Number(form.fields.w_freshness ?? current.weights.freshness),
        engagement: Number(form.fields.w_engagement ?? current.weights.engagement),
        interest: Number(form.fields.w_interest ?? current.weights.interest),
      },
      interests: normalizeTags(form.fields.interests || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20),
    };
    store.setSettings(session.user.id, JSON.stringify(settings));
    redirect(req, res, '/feed/settings?msg=' + encodeURIComponent('Feed algorithm saved'));
  }

  async function hPostNew(req, res, _m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const body = String(form.fields.body || '').slice(0, 2000);
    if (!body.trim()) return redirect(req, res, '/feed?msg=' + encodeURIComponent('Post body is required'));
    const tags = normalizeTags(form.fields.tags);
    let image = '';
    const file = form.files?.image;
    if (file && file.filename && file.data?.length) {
      if (file.data.length > config.maxUploadBytes) return redirect(req, res, '/feed?msg=' + encodeURIComponent('Image too large'));
      const ext = sniffImage(file.data);
      if (!ext) return redirect(req, res, '/feed?msg=' + encodeURIComponent('Only JPG, PNG, GIF or WebP images are allowed'));
      image = randomToken(16) + ext;
      fs.writeFileSync(path.join(config.uploadsDir, image), file.data);
    }
    const post = store.addPost(session.user.id, body.trim(), tags, image);
    console.log(`[post] #${post.id} by user #${session.user.id}`);
    redirect(req, res, `/u/${encodeURIComponent(session.user.hub_slug || '')}#post-${post.id}`);
  }

  async function hPostLike(req, res, m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const post = store.getPost(Number(m[1]));
    if (!post) return deny(req, res, 'No such post', 404);
    store.toggleLike(post.id, session.user.id);
    redirect(req, res, req.headers.referer && req.headers.referer.startsWith(config.publicUrl) ? req.headers.referer : '/feed');
  }

  async function hPostDelete(req, res, m, _url, form) {
    const session = requireApproved(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const post = store.getPost(Number(m[1]));
    if (!post) return deny(req, res, 'No such post', 404);
    if (post.user_id !== session.user.id && session.user.role !== 'owner') return deny(req, res, 'Not allowed');
    if (post.image) {
      const f = path.join(config.uploadsDir, post.image);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    store.deletePost(post.id);
    redirect(req, res, '/feed?msg=' + encodeURIComponent('Post deleted'));
  }

  // ---------- gated gallery (owner-managed) ----------

  async function hPhotos(req, res) {
    const session = requireApproved(req, res);
    if (!session) return;
    html(req, res, 200, views.photosPage({ ...viewCtx(req, session), photos: store.listPhotos() }));
  }

  async function hPhoto(req, res, m) {
    const session = requireApproved(req, res);
    if (!session) return;
    const photo = store.getPhoto(Number(m[1]));
    if (!photo) return html(req, res, 404, views.errorPage(viewCtx(req, session), 404, 'Photo not found'));
    html(req, res, 200, views.photoPage({ ...viewCtx(req, session), photo }));
  }

  async function hWritings(req, res) {
    const session = requireApproved(req, res);
    if (!session) return;
    html(req, res, 200, views.writingsPage({ ...viewCtx(req, session), writings: store.listWritings() }));
  }

  async function hWriting(req, res, m) {
    const session = requireApproved(req, res);
    if (!session) return;
    const writing = store.getWritingBySlug(m[1]);
    if (!writing) return html(req, res, 404, views.errorPage(viewCtx(req, session), 404, 'Writing not found'));
    html(req, res, 200, views.writingPage({ ...viewCtx(req, session), writing }));
  }

  async function hMedia(req, res, m) {
    if (!mediaLimiter(clientIp(req))) return deny(req, res, 'Slow down', 429);
    const session = requireApproved(req, res);
    if (!session) return;
    return serveUpload(req, res, m[1], false);
  }

  async function hMediaPost(req, res, m) {
    if (!mediaLimiter(clientIp(req))) return deny(req, res, 'Slow down', 429);
    return serveUpload(req, res, m[1], true);
  }

  function serveUpload(req, res, name, publicRoute) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) return deny(req, res, 'Bad file name', 400);
    const file = path.join(config.uploadsDir, name);
    if (!file.startsWith(config.uploadsDir + path.sep)) return deny(req, res, 'Bad file name', 400);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return deny(req, res, 'Not found', 404);
    const ext = path.extname(name).toLowerCase();
    const type = IMAGE_TYPES[ext] || 'application/octet-stream';
    send(req, res, 200, fs.readFileSync(file), {
      'content-type': type,
      'cache-control': publicRoute ? 'public, max-age=3600' : 'private, max-age=300',
      'content-disposition': 'inline',
    });
  }

  // ---------- admin ----------

  async function hAdmin(req, res, _m, url) {
    const session = requireOwner(req, res);
    if (!session) return;
    html(req, res, 200, views.adminPage({
      ...viewCtx(req, session),
      site: siteSettings(),
      pending: store.listPending(),
      users: store.listUsers(),
      writings: store.listWritings(),
      photos: store.listPhotos(),
      counts: { members: store.countApproved(), photos: store.countPhotos(), writings: store.countWritings() },
      maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
      flash: url.searchParams.get('msg') || '',
    }));
  }

  async function hDecideUser(req, res, m, _url, form) {
    const session = requireOwner(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const id = Number(m[1]);
    const action = form.fields.action;
    const user = store.listUsers().find((u) => u.id === id);
    if (!user) return deny(req, res, 'No such user', 404);
    if (user.role === 'owner' && action !== 'approve') return deny(req, res, 'Cannot change the owner', 400);
    if (action === 'approve') store.decideUser(id, 'approved');
    else if (action === 'deny') store.decideUser(id, 'denied');
    else if (action === 'revoke') {
      store.decideUser(id, 'denied');
      store.deleteSessionsOfUser(id);
    } else return deny(req, res, 'Bad action', 400);
    console.log(`[admin] user #${id} (${user.handle || user.sub}) -> ${action} by #${session.user.id}`);
    redirect(req, res, `/admin?msg=${encodeURIComponent(`@${user.handle || user.sub} ${action}d`)}`);
  }

  async function hNewWriting(req, res, _m, _url, form) {
    const session = requireOwner(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const title = String(form.fields.title || '').trim().slice(0, 200);
    const body = String(form.fields.body || '');
    if (!title || !body.trim()) return redirect(req, res, '/admin?msg=' + encodeURIComponent('Title and body are required'));
    let slug = slugify(title);
    let n = 2;
    while (store.slugExists(slug)) slug = `${slugify(title)}-${n++}`;
    store.addWriting(slug, title, body);
    redirect(req, res, '/admin?msg=' + encodeURIComponent(`Published “${title.slice(0, 60)}”`));
  }

  async function hDeleteWriting(req, res, m, _url, form) {
    const session = requireOwner(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    store.deleteWriting(Number(m[1]));
    redirect(req, res, '/admin?msg=' + encodeURIComponent('Writing deleted'));
  }

  async function hNewPhoto(req, res, _m, _url, form) {
    const session = requireOwner(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res, 'Too many requests or bad token', 429);
    const file = form.files?.file;
    if (!file || !file.filename || !file.data?.length) return redirect(req, res, '/admin?msg=' + encodeURIComponent('A photo file is required'));
    if (file.data.length > config.maxUploadBytes) return redirect(req, res, '/admin?msg=' + encodeURIComponent('File too large'));
    const ext = sniffImage(file.data);
    if (!ext) return redirect(req, res, '/admin?msg=' + encodeURIComponent('Only JPG, PNG, GIF or WebP images are allowed'));
    const filename = randomToken(16) + ext;
    fs.writeFileSync(path.join(config.uploadsDir, filename), file.data);
    const caption = String(form.fields.caption || '').slice(0, 500);
    store.addPhoto(filename, caption);
    redirect(req, res, '/admin?msg=' + encodeURIComponent('Photo uploaded'));
  }

  async function hDeletePhoto(req, res, m, _url, form) {
    const session = requireOwner(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const photo = store.getPhoto(Number(m[1]));
    if (photo) {
      store.deletePhoto(photo.id);
      const file = path.join(config.uploadsDir, photo.filename);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
    redirect(req, res, '/admin?msg=' + encodeURIComponent('Photo deleted'));
  }

  // ---------- privacy + customization ----------

  async function hThemeCss(req, res) {
    send(req, res, 200, themeCss(), {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=60',
    });
  }

  async function hPrivacy(req, res) {
    html(req, res, 200, views.privacyPage(viewCtx(req, getSession(req))));
  }

  async function hMe(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    html(req, res, 200, views.mePage({
      ...viewCtx(req, session),
      stats: {
        posts: store.listPostsByUser(session.user.id).length,
        links: store.listLinks(session.user.id).length,
        following: store.followingIds(session.user.id).length,
        followers: store.followerCount(session.user.id),
      },
    }));
  }

  async function hMeExport(req, res) {
    const session = requireSession(req, res);
    if (!session) return;
    const data = store.exportUser(session.user.id);
    send(req, res, 200, JSON.stringify(data, null, 2), {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="my-data-${session.user.id}.json"`,
      'cache-control': 'no-store',
    });
  }

  async function hMeDelete(req, res, _m, _url, form) {
    const session = requireSession(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    if (session.user.role === 'owner') return deny(req, res, 'The owner account cannot be deleted here');
    const id = session.user.id;
    store.deleteUserCascade(id);
    clearSessionCookie(req, res);
    console.log(`[privacy] user #${id} deleted their account`);
    redirect(req, res, '/?msg=' + encodeURIComponent('Your account and data were deleted.'));
  }

  async function hAdminSite(req, res, _m, _url, form) {
    const session = requireOwner(req, res);
    if (!session) return;
    if (!postLimiter(clientIp(req)) || !checkCsrf(req, session, form.fields)) return deny(req, res);
    const name = String(form.fields.site_name || '').trim().slice(0, 80);
    const tagline = String(form.fields.site_tagline || '').trim().slice(0, 200);
    const accent = String(form.fields.accent_color || '').trim();
    const theme = form.fields.theme === 'light' ? 'light' : 'dark';
    if (name) store.setSiteSetting('site_name', name);
    store.setSiteSetting('site_tagline', tagline);
    if (validAccent(accent)) store.setSiteSetting('accent_color', accent.toLowerCase());
    store.setSiteSetting('theme', theme);
    redirect(req, res, '/admin?msg=' + encodeURIComponent('Site settings saved'));
  }

  // ---------- router ----------

  const routes = [
    ['GET', /^\/$/, hLanding],
    ['GET', /^\/login$/, (req, res) => redirect(req, res, '/')],
    ['GET', /^\/login\/([a-z]+)$/, hLogin],
    ['GET', /^\/auth\/callback\/([a-z]+)$/, hCallback],
    ['POST', /^\/logout$/, hLogout],
    ['GET', /^\/gate$/, hGate],
    ['GET', /^\/home$/, hHome],
    ['GET', /^\/hubs$/, hHubs],
    ['GET', /^\/u\/([a-z0-9-]+)$/, hHub],
    ['GET', /^\/u\/([a-z0-9-]+)\/feed\.xml$/, hHubRss],
    ['GET', /^\/rss\.xml$/, hAllRss],
    ['GET', /^\/theme\.css$/, hThemeCss],
    ['GET', /^\/privacy$/, hPrivacy],
    ['GET', /^\/me$/, hMe],
    ['GET', /^\/me\/export$/, hMeExport],
    ['POST', /^\/me\/delete$/, hMeDelete],
    ['GET', /^\/onboarding$/, hOnboarding],
    ['POST', /^\/onboarding$/, hOnboardingPost],
    ['GET', /^\/hub\/edit$/, hHubEdit],
    ['POST', /^\/hub\/edit$/, hHubEditPost],
    ['POST', /^\/hub\/links\/new$/, hLinkNew],
    ['POST', /^\/hub\/links\/(\d+)\/delete$/, hLinkDelete],
    ['POST', /^\/hub\/links\/(\d+)\/move$/, hLinkMove],
    ['GET', /^\/subscriptions$/, hSubscriptions],
    ['POST', /^\/subscriptions\/(\d+)\/(follow|unfollow)$/, hFollow],
    ['GET', /^\/feed$/, hFeed],
    ['GET', /^\/feed\/settings$/, hFeedSettings],
    ['POST', /^\/feed\/settings$/, hFeedSettingsPost],
    ['POST', /^\/posts\/new$/, hPostNew],
    ['POST', /^\/posts\/(\d+)\/like$/, hPostLike],
    ['POST', /^\/posts\/(\d+)\/delete$/, hPostDelete],
    ['GET', /^\/photos$/, hPhotos],
    ['GET', /^\/photos\/(\d+)$/, hPhoto],
    ['GET', /^\/writings$/, hWritings],
    ['GET', /^\/writings\/([a-z0-9-]+)$/, hWriting],
    ['GET', /^\/media\/post\/([^/]+)$/, hMediaPost],
    ['GET', /^\/media\/([^/]+)$/, hMedia],
    ['GET', /^\/admin$/, hAdmin],
    ['POST', /^\/admin\/site$/, hAdminSite],
    ['POST', /^\/admin\/users\/(\d+)\/decide$/, hDecideUser],
    ['POST', /^\/admin\/writings\/new$/, hNewWriting],
    ['POST', /^\/admin\/writings\/(\d+)\/delete$/, hDeleteWriting],
    ['POST', /^\/admin\/photos\/new$/, hNewPhoto],
    ['POST', /^\/admin\/photos\/(\d+)\/delete$/, hDeletePhoto],
    ['GET', /^\/healthz$/, (req, res) => send(req, res, 200, 'ok\n', { 'content-type': 'text/plain; charset=utf-8' })],
  ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;
    try {
      if (req.method === 'GET' && (pathname === '/style.css' || pathname === '/favicon.svg' || pathname === '/app.js')) {
        const file = path.join(config.rootDir, 'public', path.basename(pathname));
        if (fs.existsSync(file)) {
          return send(req, res, 200, fs.readFileSync(file), {
            'content-type': MIME_STATIC[path.extname(file)] || 'application/octet-stream',
            'cache-control': 'public, max-age=300',
          });
        }
        return deny(req, res, 'Not found', 404);
      }

      for (const [method, pattern, handler] of routes) {
        if (method !== req.method) continue;
        const m = pattern.exec(pathname);
        if (!m) continue;
        let form = null;
        if (req.method === 'POST') {
          const maxBytes = pathname === '/admin/photos/new' || pathname === '/posts/new' ? config.maxUploadBytes + 1024 * 1024 : 1024 * 1024;
          try {
            form = await parseForm(req, maxBytes);
          } catch (e) {
            return deny(req, res, e.message === 'payload too large' ? 'Payload too large' : 'Bad request', e.message === 'payload too large' ? 413 : 400);
          }
        }
        return await handler(req, res, m, url, form);
      }
      return html(req, res, 404, views.errorPage(viewCtx(req, getSession(req)), 404, 'Page not found'));
    } catch (e) {
      console.error('[server] unhandled error:', e);
      return html(req, res, 500, views.errorPage(viewCtx(req, null), 500, 'Something went wrong'));
    }
  });

  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  config.port = port;
  if (!overrides.publicUrl) config.publicUrl = `http://${config.host}:${port}`;
  console.log(`[server] ${config.siteName} listening on ${config.publicUrl} (${config.nodeEnv})`);
  return { server, config, store, providers, port };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startServer().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
