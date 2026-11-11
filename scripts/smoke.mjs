import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gatehouse-smoke-'));
process.env.DATA_DIR = path.join(tmp, 'data');
process.env.NODE_ENV = 'test';
process.env.MOCK_OAUTH = '1';
process.env.SITE_NAME = 'Test Site';
process.env.SITE_TAGLINE = 'Smoke test tagline';
process.env.OWNER_IDS = 'mock:owner';
process.env.INSTAGRAM_CLIENT_ID = 'dummy-ig-id';
process.env.INSTAGRAM_CLIENT_SECRET = 'dummy-ig-secret';
process.env.SUBSTACK_CLIENT_ID = 'dummy-ss-id';
process.env.SUBSTACK_CLIENT_SECRET = 'dummy-ss-secret';

const { startServer } = await import('../src/server.js');
const { server, port } = await startServer({ port: 0, publicUrl: '' });
const base = `http://127.0.0.1:${port}`;

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : extra ? ' — ' + extra : ''}`);
}

function jar() {
  const cookies = new Map();
  return {
    async fetch(url, opts = {}) {
      const u = url.startsWith('http') ? url : base + url;
      const headers = { ...(opts.headers || {}) };
      if (cookies.size) headers.cookie = [...cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
      if (opts.body && typeof opts.body === 'string' && !headers['content-type']) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      if (opts.body) headers.origin = base;
      const r = await fetch(u, { ...opts, headers, redirect: 'manual' });
      const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
      for (const sc of setCookies) {
        const pair = sc.split(';')[0];
        const i = pair.indexOf('=');
        const k = pair.slice(0, i).trim();
        const v = pair.slice(i + 1).trim();
        if (v) cookies.set(k, v);
        else cookies.delete(k);
      }
      return r;
    },
  };
}

async function follow(j, res, max = 5) {
  let r = res;
  for (let i = 0; i < max && [301, 302, 303, 307, 308].includes(r.status); i++) {
    r = await j.fetch(r.headers.get('location'));
  }
  return r;
}

const csrfOf = (html) => html.match(/name="csrf" value="([^"]+)"/)?.[1] || '';

function multipart(fields, files) {
  const boundary = '----smoke' + Math.random().toString(16).slice(2);
  const parts = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  for (const [k, f] of Object.entries(files)) {
    parts.push(Buffer.concat([
      Buffer.from(`--${boundary}\r\ncontent-disposition: form-data; name="${k}"; filename="${f.filename}"\r\ncontent-type: ${f.contentType}\r\n\r\n`),
      f.data,
      Buffer.from('\r\n'),
    ]));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

try {
  const anon = jar();

  // 1. Landing page
  let r = await anon.fetch('/');
  let body = await r.text();
  check('landing 200', r.status === 200, `status=${r.status}`);
  check('landing has Instagram button', body.includes('Continue with Instagram'));
  check('landing has Substack button', body.includes('Continue with Substack'));
  check('landing has mock button (dev)', body.includes('Continue with Mock'));
  check('landing has CSP header', (r.headers.get('content-security-policy') || '').includes("default-src 'self'"));
  check('landing has nosniff', r.headers.get('x-content-type-options') === 'nosniff');

  // 2. Gated content redirects anonymous users
  r = await anon.fetch('/photos');
  check('anon /photos redirects', r.status === 303 && r.headers.get('location') === '/', `status=${r.status} loc=${r.headers.get('location')}`);
  r = await anon.fetch('/writings');
  check('anon /writings redirects', r.status === 303);
  r = await anon.fetch('/admin');
  check('anon /admin redirects', r.status === 303);

  // 3. Member login via mock -> pending
  const member = jar();
  r = await member.fetch('/login/mock?as=alice');
  check('mock login redirects to callback', (r.status === 302 || r.status === 303) && (r.headers.get('location') || '').includes('/auth/callback/mock'), `status=${r.status}`);
  r = await member.fetch(r.headers.get('location'));
  check('callback redirects to /gate', r.status === 303 && r.headers.get('location') === '/gate', `status=${r.status} loc=${r.headers.get('location')}`);
  r = await member.fetch('/gate');
  body = await r.text();
  check('member sees pending page', r.status === 200 && body.includes('waiting'), `status=${r.status}`);
  r = await member.fetch('/photos');
  check('pending member blocked from /photos', r.status === 303 && r.headers.get('location') === '/gate');

  // 4. Owner login via mock -> approved, admin access
  const owner = jar();
  r = await owner.fetch('/login/mock?as=owner');
  r = await follow(owner, r);
  check('owner approved straight to /home', r.status === 200 && (await r.text()).includes('Hello'), `status=${r.status}`);
  r = await owner.fetch('/home');
  body = await r.text();
  check('owner home renders', r.status === 200 && body.includes('Hello'));
  r = await owner.fetch('/admin');
  const adminHtml = await r.text();
  check('owner sees admin with pending alice', r.status === 200 && adminHtml.includes('alice') && adminHtml.includes('Pending requests'));

  // 5. Owner approves alice
  let csrfOwner = csrfOf(adminHtml);
  check('csrf token present on admin page', Boolean(csrfOwner));
  const aliceId = adminHtml.match(/action="\/admin\/users\/(\d+)\/decide"/)?.[1];
  check('alice user id found in admin', Boolean(aliceId));
  r = await owner.fetch(`/admin/users/${aliceId}/decide`, { method: 'POST', body: `action=approve&csrf=${encodeURIComponent(csrfOwner)}` });
  check('approve returns redirect', r.status === 303, `status=${r.status}`);
  r = await member.fetch('/gate');
  check('approved member redirected to /home', r.status === 303 && r.headers.get('location') === '/home');
  r = await member.fetch('/photos');
  check('approved member can see /photos', r.status === 200);

  // 6. Owner publishes a writing (with XSS attempt in body)
  r = await owner.fetch('/admin/writings/new', {
    method: 'POST',
    body: `title=${encodeURIComponent('Hello World')}&body=${encodeURIComponent('# Hi\n\n**bold** and <script>alert(1)</script> plus [a link](https://example.com)')}&csrf=${encodeURIComponent(csrfOwner)}`,
  });
  check('create writing redirects', r.status === 303, `status=${r.status}`);
  r = await member.fetch('/writings');
  body = await r.text();
  check('writing listed', body.includes('Hello World'));
  r = await member.fetch('/writings/hello-world');
  body = await r.text();
  check('writing rendered with markdown', body.includes('<strong>bold</strong>'));
  check('writing link rendered', body.includes('href="https://example.com"'));
  check('XSS escaped in writing', !body.includes('<script>alert(1)</script>'));

  // 7. Owner uploads a photo; member can view media; anon cannot
  const mp = multipart({ csrf: csrfOwner, caption: 'Test caption' }, { file: { filename: 'dot.png', contentType: 'image/png', data: PNG_1PX } });
  r = await owner.fetch('/admin/photos/new', { method: 'POST', headers: { 'content-type': mp.contentType }, body: mp.body });
  check('photo upload redirects', r.status === 303, `status=${r.status}`);
  r = await member.fetch('/photos');
  body = await r.text();
  check('photo caption listed', body.includes('Test caption'));
  const mediaName = body.match(/\/media\/([A-Za-z0-9._-]+)/)?.[1];
  check('media url found', Boolean(mediaName));
  r = await member.fetch(`/media/${mediaName}`);
  check('approved member gets media 200 image/png', r.status === 200 && r.headers.get('content-type') === 'image/png', `status=${r.status} ct=${r.headers.get('content-type')}`);
  r = await anon.fetch(`/media/${mediaName}`);
  check('anon media blocked', r.status === 303);
  r = await member.fetch('/media/%2E%2E%2Fsite.db');
  check('path traversal blocked', r.status === 400 || r.status === 403 || r.status === 404, `status=${r.status}`);

  // 8. CSRF enforcement
  r = await owner.fetch('/admin/writings/new', { method: 'POST', body: 'title=Nope&body=nope' });
  check('POST without csrf rejected 403', r.status === 403, `status=${r.status}`);

  // 9. Deny flow for a second user
  const eve = jar();
  r = await eve.fetch('/login/mock?as=eve');
  r = await follow(eve, r);
  r = await eve.fetch('/gate');
  check('eve pending', r.status === 200 && (await r.text()).includes('waiting'));
  r = await owner.fetch('/admin');
  const admin2 = await r.text();
  const eveId = admin2.match(/action="\/admin\/users\/(\d+)\/decide"/)?.[1];
  r = await owner.fetch(`/admin/users/${eveId}/decide`, { method: 'POST', body: `action=deny&csrf=${encodeURIComponent(csrfOf(admin2))}` });
  check('deny returns redirect', r.status === 303);
  r = await eve.fetch('/gate');
  check('eve sees declined', r.status === 200 && (await r.text()).includes('declined'));

  // 10. Logout
  r = await member.fetch('/home');
  const csrfMember = csrfOf(await r.text());
  r = await member.fetch('/logout', { method: 'POST', body: `csrf=${encodeURIComponent(csrfMember)}` });
  check('logout redirects', r.status === 303);
  r = await member.fetch('/home');
  check('after logout /home redirects to /', r.status === 303 && r.headers.get('location') === '/');

  // 11. healthz
  r = await anon.fetch('/healthz');
  check('healthz ok', r.status === 200);

  // 12. Hub platform: onboarding, link tree, posts, RSS, subscriptions, feed algorithm
  const postIdFor = (html, text) =>
    html.split('<article').find((s) => s.includes(text))?.match(/id="post-(\d+)"/)?.[1];

  // re-login alice (previous step logged her out)
  r = await member.fetch('/login/mock?as=alice');
  r = await follow(member, r);
  check('alice re-login lands on /home', r.status === 200 && (await r.text()).includes('Hello'));

  // owner onboarding -> hub
  r = await owner.fetch('/onboarding');
  check('owner onboarding form 200', r.status === 200, `status=${r.status}`);
  csrfOwner = csrfOf(await r.text());
  r = await owner.fetch('/onboarding', { method: 'POST', body: `slug=owner-hub&name=Owner&bio=My public hub&csrf=${encodeURIComponent(csrfOwner)}` });
  check('onboarding creates hub', r.status === 303 && (r.headers.get('location') || '').startsWith('/hub/edit'), `status=${r.status} loc=${r.headers.get('location')}`);

  // public hub page (anonymous)
  r = await anon.fetch('/u/owner-hub');
  body = await r.text();
  check('public hub page 200 for anon', r.status === 200 && body.includes('My public hub') && body.includes('@owner-hub'));
  check('hub page advertises rss', body.includes('application/rss+xml'));

  // link tree: add good link, reject javascript: link
  r = await owner.fetch('/hub/edit');
  csrfOwner = csrfOf(await r.text());
  r = await owner.fetch('/hub/links/new', { method: 'POST', body: `title=My Blog&url=${encodeURIComponent('https://blog.example.com')}&csrf=${encodeURIComponent(csrfOwner)}` });
  check('link added', r.status === 303);
  r = await owner.fetch('/hub/links/new', { method: 'POST', body: `title=evil&url=${encodeURIComponent('javascript:alert(1)')}&csrf=${encodeURIComponent(csrfOwner)}` });
  check('javascript: url rejected', r.status === 303 && (r.headers.get('location') || '').includes('error='));
  r = await anon.fetch('/u/owner-hub');
  body = await r.text();
  check('hub renders link tree', body.includes('My Blog') && body.includes('https://blog.example.com'));
  check('no javascript: url rendered', !body.includes('javascript:'));

  // owner posts: beta (older) then alpha (newer), then one with an image
  r = await owner.fetch('/feed');
  csrfOwner = csrfOf(await r.text());
  r = await owner.fetch('/posts/new', { method: 'POST', body: `body=${encodeURIComponent('beta post about news')}&tags=news&csrf=${encodeURIComponent(csrfOwner)}` });
  check('post beta created', r.status === 303, `status=${r.status}`);
  r = await owner.fetch('/posts/new', { method: 'POST', body: `body=${encodeURIComponent('alpha post about tech')}&tags=tech&csrf=${encodeURIComponent(csrfOwner)}` });
  check('post alpha created', r.status === 303);
  const mpPost = multipart({ csrf: csrfOwner, body: 'photo post', tags: 'photos' }, { image: { filename: 'p.png', contentType: 'image/png', data: PNG_1PX } });
  r = await owner.fetch('/posts/new', { method: 'POST', headers: { 'content-type': mpPost.contentType }, body: mpPost.body });
  check('image post created', r.status === 303, `status=${r.status}`);

  // RSS: hub feed + global feed, public
  r = await anon.fetch('/u/owner-hub/feed.xml');
  body = await r.text();
  check('hub rss 200 xml', r.status === 200 && (r.headers.get('content-type') || '').includes('rss+xml'));
  check('hub rss contains posts', body.includes('beta post about news') && body.includes('alpha post about tech'));
  r = await anon.fetch('/rss.xml');
  body = await r.text();
  check('global rss contains posts', r.status === 200 && body.includes('alpha post about tech'));

  // post image served publicly
  r = await anon.fetch('/u/owner-hub');
  body = await r.text();
  const postImg = body.match(/\/media\/post\/([A-Za-z0-9._-]+)/)?.[1];
  check('hub shows post image', Boolean(postImg));
  if (postImg) {
    r = await anon.fetch(`/media/post/${postImg}`);
    check('post image public 200 image/png', r.status === 200 && r.headers.get('content-type') === 'image/png', `status=${r.status}`);
  }

  // alice onboarding + subscribe to owner hub
  r = await member.fetch('/onboarding');
  const csrfA = csrfOf(await r.text());
  check('alice onboarding 200', r.status === 200);
  r = await member.fetch('/onboarding', { method: 'POST', body: `slug=alice-hub&name=Alice&bio=hi&csrf=${encodeURIComponent(csrfA)}` });
  check('alice hub created', r.status === 303);
  r = await member.fetch('/subscriptions');
  body = await r.text();
  check('subscriptions lists owner hub', body.includes('owner-hub'));
  const ownerId = body.match(/action="\/subscriptions\/(\d+)\/follow"/)?.[1];
  check('owner id found', Boolean(ownerId));
  r = await member.fetch(`/subscriptions/${ownerId}/follow`, { method: 'POST', body: `csrf=${encodeURIComponent(csrfOf(body))}` });
  check('alice follows owner', r.status === 303);

  // feed shows subscribed posts
  r = await member.fetch('/feed');
  body = await r.text();
  check('feed shows subscribed posts', body.includes('beta post about news') && body.includes('alpha post about tech'));

  // tailor algorithm: interest weight only, interests=news -> beta first
  r = await member.fetch('/feed/settings');
  const csrfF = csrfOf(await r.text());
  r = await member.fetch('/feed/settings', { method: 'POST', body: `mode=algorithm&w_freshness=0&w_engagement=0&w_interest=1&interests=news&csrf=${encodeURIComponent(csrfF)}` });
  check('feed settings saved', r.status === 303);
  r = await member.fetch('/feed');
  body = await r.text();
  check('interest tailoring reorders feed', body.indexOf('beta post about news') !== -1 && body.indexOf('beta post about news') < body.indexOf('alpha post about tech'));

  // chrono mode -> alpha (newer) first
  r = await member.fetch('/feed/settings', { method: 'POST', body: `mode=chrono&w_freshness=1&w_engagement=0.6&w_interest=0.8&interests=&csrf=${encodeURIComponent(csrfF)}` });
  check('chrono settings saved', r.status === 303);
  r = await member.fetch('/feed');
  body = await r.text();
  check('chrono mode newest first', body.indexOf('alpha post about tech') !== -1 && body.indexOf('alpha post about tech') < body.indexOf('beta post about news'));

  // like beta; engagement-only ranking -> beta first
  const betaId = postIdFor(body, 'beta post about news');
  check('beta post id found', Boolean(betaId));
  r = await member.fetch(`/posts/${betaId}/like`, { method: 'POST', body: `csrf=${encodeURIComponent(csrfF)}` });
  check('like toggles', r.status === 303, `status=${r.status}`);
  r = await member.fetch('/feed/settings', { method: 'POST', body: `mode=algorithm&w_freshness=0&w_engagement=1&w_interest=0&interests=&csrf=${encodeURIComponent(csrfF)}` });
  r = await member.fetch('/feed');
  body = await r.text();
  check('engagement weight reorders feed', body.indexOf('beta post about news') !== -1 && body.indexOf('beta post about news') < body.indexOf('alpha post about tech'));

  // public hubs directory
  r = await anon.fetch('/hubs');
  body = await r.text();
  check('public hubs directory lists hubs', r.status === 200 && body.includes('owner-hub') && body.includes('alice-hub'));

  // negatives
  r = await anon.fetch('/feed');
  check('anon /feed redirects', r.status === 303);
  r = await anon.fetch('/onboarding');
  check('anon /onboarding redirects', r.status === 303);
  r = await anon.fetch('/posts/new', { method: 'POST', body: 'body=x&csrf=x' });
  check('anon post rejected', r.status === 303);
  const mallory = jar();
  r = await mallory.fetch('/login/mock?as=mallory');
  r = await follow(mallory, r);
  r = await mallory.fetch('/feed');
  check('pending user feed -> /gate', r.status === 303 && r.headers.get('location') === '/gate');
  r = await owner.fetch('/onboarding');
  check('onboarding redirects when hub exists', r.status === 303 && r.headers.get('location') === '/hub/edit');

  // 13. Privacy + no-code customization
  r = await anon.fetch('/privacy');
  check('privacy page public 200', r.status === 200 && (await r.text()).includes('No analytics'));
  r = await anon.fetch('/theme.css');
  body = await r.text();
  check('theme.css default accent', r.status === 200 && (r.headers.get('content-type') || '').includes('text/css') && body.includes('--accent: #e8c07d'));

  // owner rebrands the site from /admin (no code)
  r = await owner.fetch('/admin');
  csrfOwner = csrfOf(await r.text());
  r = await owner.fetch('/admin/site', { method: 'POST', body: `site_name=Renamed Site&site_tagline=New tagline&accent_color=%23ff0000&theme=light&csrf=${encodeURIComponent(csrfOwner)}` });
  check('admin site settings saved', r.status === 303, `status=${r.status}`);
  r = await anon.fetch('/');
  body = await r.text();
  check('landing shows new site name', body.includes('Renamed Site') && body.includes('New tagline'));
  r = await anon.fetch('/theme.css');
  body = await r.text();
  check('theme.css has new accent + light palette', body.includes('--accent: #ff0000') && body.includes('--bg: #f6f5f2'));
  // restore dark/defaults for the rest of the test
  r = await owner.fetch('/admin/site', { method: 'POST', body: `site_name=Test Site&site_tagline=Smoke test tagline&accent_color=%23e8c07d&theme=dark&csrf=${encodeURIComponent(csrfOwner)}` });
  check('site settings restored', r.status === 303);

  // members-only hub toggle
  r = await owner.fetch('/hub/edit');
  csrfOwner = csrfOf(await r.text());
  r = await owner.fetch('/hub/edit', { method: 'POST', body: `name=Owner&bio=My public hub&avatar=&csrf=${encodeURIComponent(csrfOwner)}` });
  check('hub set members-only', r.status === 303);
  r = await anon.fetch('/u/owner-hub');
  check('anon cannot see members-only hub', r.status === 404, `status=${r.status}`);
  r = await anon.fetch('/u/owner-hub/feed.xml');
  check('anon cannot read members-only rss', r.status === 404, `status=${r.status}`);
  r = await member.fetch('/u/owner-hub');
  check('approved member sees members-only hub', r.status === 200);
  r = await owner.fetch('/hub/edit', { method: 'POST', body: `name=Owner&bio=My public hub&avatar=&hub_public=1&csrf=${encodeURIComponent(csrfOwner)}` });
  r = await anon.fetch('/u/owner-hub');
  check('hub public again', r.status === 200);

  // account page + data export
  r = await member.fetch('/me');
  body = await r.text();
  check('account page 200 with hub', r.status === 200 && body.includes('alice-hub'));
  r = await member.fetch('/me/export');
  body = await r.text();
  check('data export json', r.status === 200 && (r.headers.get('content-type') || '').includes('json') && body.includes('"provider": "mock"') && body.includes('alice-hub'));

  // owner cannot self-delete
  r = await owner.fetch('/me/delete', { method: 'POST', body: `csrf=${encodeURIComponent(csrfOwner)}` });
  check('owner self-delete blocked', r.status === 403, `status=${r.status}`);

  // pending user deletes own account, then re-registers as new pending
  r = await mallory.fetch('/me/delete', { method: 'POST', body: `csrf=${encodeURIComponent(csrfOf(await mallory.fetch('/me').then((x) => x.text())))}` });
  check('mallory deletes account', r.status === 303, `status=${r.status}`);
  r = await mallory.fetch('/gate');
  check('after delete, session gone', r.status === 303 && r.headers.get('location') === '/');
  r = await mallory.fetch('/login/mock?as=mallory');
  r = await follow(mallory, r);
  r = await mallory.fetch('/gate');
  check('re-register creates fresh pending user', r.status === 200 && (await r.text()).includes('waiting'));
} finally {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
