import { renderMarkdown } from './markdown.js';

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
};

const fmtDateTime = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

function layout({ title, siteName, user, csrf, body, headExtra = '' }) {
  let nav = '';
  if (user) {
    const links = [`<span class="who">@${esc(user.handle || user.sub)}</span>`];
    if (user.status === 'approved') {
      links.unshift(
        '<a href="/home">Home</a>',
        '<a href="/feed">Feed</a>',
        '<a href="/hubs">Hubs</a>',
        '<a href="/subscriptions">Subscriptions</a>',
        user.hub_slug ? `<a href="/u/${encodeURIComponent(user.hub_slug)}">My hub</a>` : '<a href="/onboarding">Create hub</a>',
        '<a href="/photos">Photos</a>',
        '<a href="/writings">Writings</a>'
      );
      if (user.role === 'owner') links.push('<a href="/admin">Admin</a>');
    }
    links.push(`<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="linkbtn" type="submit">Sign out</button></form>`);
    nav = `<nav class="nav">${links.join('')}</nav>`;
  } else {
    nav = '<nav class="nav"><a href="/hubs">Hubs</a></nav>';
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(siteName)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${headExtra}
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">${esc(siteName)}</a>
  ${nav}
</header>
<main class="main">
${body}
</main>
<footer class="footer">${esc(siteName)} — hubs are public, feeds are members only</footer>
</body>
</html>`;
}

function page(ctx, title, body, headExtra = '') {
  return layout({ title, siteName: ctx.siteName, user: ctx.user, csrf: ctx.csrf, body, headExtra });
}

export function landingPage(ctx, providers, error) {
  const buttons = providers
    .filter((p) => p.enabled)
    .map((p) => `<a class="btn" href="/login/${p.id}">Continue with ${esc(p.label)}</a>`)
    .join('');
  const disabledNote = providers.every((p) => !p.enabled)
    ? '<p class="muted">Sign-in is not configured yet — set up Instagram or Substack credentials (see README).</p>'
    : '';
  const err = error ? `<p class="error">${esc(error)}</p>` : '';
  return page(ctx, 'Welcome', `
<section class="hero">
  <h1>${esc(ctx.siteName)}</h1>
  <p class="tagline">${esc(ctx.siteTagline)}</p>
  <p class="muted">A members-only corner of the internet where everyone gets a public hub with a link tree. Sign in with Instagram or Substack to request access — the owner reviews every request.</p>
  ${err}
  <div class="btnrow">${buttons}</div>
  ${disabledNote}
  <p class="muted" style="margin-top:2rem"><a href="/hubs">Browse public hubs →</a></p>
</section>`);
}

export function gatePage(ctx) {
  const u = ctx.user;
  if (u.status === 'pending') {
    return page(ctx, 'Request received', `
<section class="card">
  <h1>Request received</h1>
  <p>Thanks, <strong>@${esc(u.handle || u.sub)}</strong> — your request to join <strong>${esc(ctx.siteName)}</strong> is waiting for the owner's approval.</p>
  <p class="muted">Once approved you'll set up your own hub with links to your sites and start posting to your RSS feed.</p>
</section>`);
  }
  return page(ctx, 'Access declined', `
<section class="card">
  <h1>Access declined</h1>
  <p>Your request to join <strong>${esc(ctx.siteName)}</strong> was declined. If you think that's a mistake, please reach out to the owner directly.</p>
</section>`);
}

export function homePage(ctx) {
  const nPhotos = ctx.counts.photos;
  const nWritings = ctx.counts.writings;
  const nudge = ctx.user.hub_slug
    ? `<p><a class="btn" href="/u/${encodeURIComponent(ctx.user.hub_slug)}">View my public hub →</a></p>`
    : `<p class="ok">Next step: <a href="/onboarding">create your hub</a> (your public link tree) — it takes a minute.</p>`;
  return page(ctx, 'Home', `
<section class="card">
  <h1>Hello, ${esc(ctx.user.name || ctx.user.handle || ctx.user.sub)}</h1>
  <p class="muted">Welcome to ${esc(ctx.siteName)}. You have access to:</p>
  <div class="cards">
    <a class="tile" href="/feed"><span class="tile-num">∞</span><span class="tile-label">Subscriptions feed</span></a>
    <a class="tile" href="/hubs"><span class="tile-num">@</span><span class="tile-label">Public hubs</span></a>
    <a class="tile" href="/photos"><span class="tile-num">${nPhotos}</span><span class="tile-label">Photos</span></a>
    <a class="tile" href="/writings"><span class="tile-num">${nWritings}</span><span class="tile-label">Writings</span></a>
  </div>
  ${nudge}
</section>`);
}

export function hubsPage({ hubs, ...ctx }) {
  const list = hubs.length
    ? `<ul class="wlist">${hubs.map((h) => `<li><a href="/u/${encodeURIComponent(h.hub_slug)}">@${esc(h.hub_slug)}</a> — ${esc(h.name || h.handle)}${h.bio ? ` <span class="muted">· ${esc(h.bio)}</span>` : ''}</li>`).join('')}</ul>`
    : '<p class="muted">No public hubs yet.</p>';
  return page(ctx, 'Hubs', `<h1>Public hubs</h1><p class="muted">Every approved member can run a hub: a public page with their link tree, posts and an RSS feed.</p>${list}`);
}

const postCard = (p, ctx) => `
<article class="post" id="post-${p.id}">
  <header class="post-head">
    ${p.hub_slug ? `<a href="/u/${encodeURIComponent(p.hub_slug)}">@${esc(p.hub_slug)}</a>` : `<span>@${esc(p.handle || 'unknown')}</span>`}
    <span class="muted"> · ${fmtDateTime(p.created_at)}</span>
  </header>
  <div class="body">${renderMarkdown(p.body)}</div>
  ${p.image ? `<img class="post-img" src="/media/post/${encodeURIComponent(p.image)}" alt="" loading="lazy">` : ''}
  ${p.tags ? `<p class="tags">${String(p.tags).split(',').filter(Boolean).map((t) => `<span class="tag">#${esc(t)}</span>`).join(' ')}</p>` : ''}
  <footer class="post-foot">
    ${ctx.canInteract ? `
    <form method="post" action="/posts/${p.id}/like" class="inline">
      <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
      <button class="small like ${p.liked ? 'liked' : ''}" type="submit">♥ ${p.likes}</button>
    </form>` : `<span class="muted">♥ ${p.likes}</span>`}
    ${(ctx.canInteract && (p.author_id === ctx.user?.id || ctx.user?.role === 'owner')) ? `
    <form method="post" action="/posts/${p.id}/delete" class="inline">
      <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
      <button class="small danger" type="submit">Delete</button>
    </form>` : ''}
  </footer>
</article>`;

export function hubPage({ hub, posts, links, following, canInteract, ...ctx }) {
  const rssHref = `/u/${encodeURIComponent(hub.hub_slug)}/feed.xml`;
  const headExtra = `<link rel="alternate" type="application/rss+xml" title="@${esc(hub.hub_slug)} RSS" href="${esc(rssHref)}">`;
  const linkTree = links.length
    ? `<div class="linktree">${links.map((l) => `<a class="linkcard" href="${esc(l.url)}" target="_blank" rel="noopener noreferrer"><span>${esc(l.title)}</span><span class="muted">${esc(l.url)}</span></a>`).join('')}</div>`
    : (canInteract && ctx.user?.id === hub.id ? '<p class="muted">No links yet — <a href="/hub/edit">add your link tree</a>.</p>' : '');
  const subBtn = canInteract && ctx.user.id !== hub.id
    ? `<form method="post" action="/subscriptions/${hub.id}/${following ? 'unfollow' : 'follow'}" class="inline">
        <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
        <button class="small" type="submit">${following ? 'Unsubscribe' : 'Subscribe'}</button>
      </form>`
    : '';
  const postsHtml = posts.length
    ? posts.map((p) => postCard({ ...p, author_id: hub.id }, { ...ctx, canInteract })).join('')
    : '<p class="muted">No posts yet.</p>';
  return page(ctx, `@${hub.hub_slug}`, `
<section class="card hub">
  ${hub.avatar ? `<img class="avatar" src="${esc(hub.avatar)}" alt="">` : ''}
  <h1>${esc(hub.name || hub.handle || hub.hub_slug)}</h1>
  <p class="muted">@${esc(hub.hub_slug)} · <a href="${esc(rssHref)}">RSS feed</a> · ${ctx.followers ?? 0} subscriber(s)</p>
  ${hub.bio ? `<p>${esc(hub.bio)}</p>` : ''}
  ${subBtn}
  ${linkTree}
</section>
<h2>Posts</h2>
${postsHtml}`, headExtra);
}

export function onboardingPage(ctx, error = '') {
  const err = error ? `<p class="error">${esc(error)}</p>` : '';
  return page(ctx, 'Create your hub', `
<section class="card">
  <h1>Create your hub</h1>
  <p class="muted">Pick a public handle for your hub. Your hub is a public page with your bio, a link tree to your sites, and your posts (also on RSS at <code>/u/&lt;handle&gt;/feed.xml</code>).</p>
  ${err}
  <form method="post" action="/onboarding" class="form">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <label>Hub handle (letters, numbers, dashes; becomes /u/handle)
      <input type="text" name="slug" required maxlength="32" pattern="[a-z0-9][a-z0-9-]{1,31}" placeholder="my-hub">
    </label>
    <label>Display name <input type="text" name="name" maxlength="80" value="${esc(ctx.user.name)}"></label>
    <label>Bio <textarea name="bio" rows="3" maxlength="300" placeholder="What is this hub about?"></textarea></label>
    <button type="submit">Create hub</button>
  </form>
</section>`);
}

export function hubEditPage({ links, flash = '', error = '', ...ctx }) {
  const u = ctx.user;
  const flashHtml = flash ? `<p class="ok">${esc(flash)}</p>` : '';
  const errHtml = error ? `<p class="error">${esc(error)}</p>` : '';
  const linksHtml = links.length
    ? `<ul class="alist">${links.map((l, i) => `<li>
        <a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.title)}</a> <span class="muted">${esc(l.url)}</span>
        <form method="post" action="/hub/links/${l.id}/move" class="inline"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="dir" value="-1"><button class="small" ${i === 0 ? 'disabled' : ''}>↑</button></form>
        <form method="post" action="/hub/links/${l.id}/move" class="inline"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><input type="hidden" name="dir" value="1"><button class="small" ${i === links.length - 1 ? 'disabled' : ''}>↓</button></form>
        <form method="post" action="/hub/links/${l.id}/delete" class="inline"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><button class="small danger">Delete</button></form>
      </li>`).join('')}</ul>`
    : '<p class="muted">No links yet.</p>';
  return page(ctx, 'Edit hub', `
<h1>Edit your hub</h1>
<p class="muted">Public page: <a href="/u/${encodeURIComponent(u.hub_slug)}">/u/${esc(u.hub_slug)}</a> · RSS: <a href="/u/${encodeURIComponent(u.hub_slug)}/feed.xml">/u/${esc(u.hub_slug)}/feed.xml</a> · <a href="/feed/settings">feed algorithm settings</a></p>
${flashHtml}${errHtml}
<section class="card">
  <h2>Profile</h2>
  <form method="post" action="/hub/edit" class="form">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <label>Display name <input type="text" name="name" maxlength="80" value="${esc(u.name)}"></label>
    <label>Bio <textarea name="bio" rows="3" maxlength="300">${esc(u.bio)}</textarea></label>
    <label>Avatar URL (optional, http/https) <input type="text" name="avatar" maxlength="500" value="${esc(u.avatar)}"></label>
    <button type="submit">Save</button>
  </form>
</section>
<section class="card">
  <h2>Link tree</h2>
  ${linksHtml}
  <form method="post" action="/hub/links/new" class="form">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <label>Link title <input type="text" name="title" required maxlength="100" placeholder="My blog"></label>
    <label>URL (must start with https://) <input type="text" name="url" required maxlength="500" placeholder="https://example.com"></label>
    <button type="submit">Add link</button>
  </form>
</section>`);
}

export function subscriptionsPage({ hubs, followingIds, ...ctx }) {
  const rows = hubs.length
    ? hubs.map((h) => {
        const following = followingIds.has(h.id);
        return `<tr>
          <td><a href="/u/${encodeURIComponent(h.hub_slug)}">@${esc(h.hub_slug)}</a></td>
          <td>${esc(h.name || h.handle)}</td>
          <td class="muted">${esc(h.bio)}</td>
          <td>${ctx.user.id === h.id ? '<span class="muted">you</span>' : `<form method="post" action="/subscriptions/${h.id}/${following ? 'unfollow' : 'follow'}" class="inline"><input type="hidden" name="csrf" value="${esc(ctx.csrf)}"><button class="small">${following ? 'Unsubscribe' : 'Subscribe'}</button></form>`}</td>
        </tr>`;
      }).join('')
    : '';
  return page(ctx, 'Subscriptions', `
<h1>Subscriptions</h1>
<p class="muted">Subscribe to hubs — their posts land in your <a href="/feed">feed</a> and you can also add their RSS (<code>/u/&lt;handle&gt;/feed.xml</code>) to any reader.</p>
${rows ? `<table class="table"><thead><tr><th>Hub</th><th>Name</th><th>Bio</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No hubs yet — check back after members onboard.</p>'}`);
}

export function feedPage({ posts, followingCount, ...ctx }) {
  const list = posts.length
    ? posts.map((p) => postCard(p, ctx)).join('')
    : `<p class="muted">Nothing here yet. <a href="/subscriptions">Subscribe to some hubs</a> — posts from hubs you follow appear here, ranked by <a href="/feed/settings">your feed algorithm</a>.</p>`;
  return page(ctx, 'Feed', `
<h1>Your feed</h1>
<p class="muted">${followingCount} subscription(s) · ranking: <a href="/feed/settings">${esc(ctx.settings.mode === 'chrono' ? 'chronological' : 'your custom algorithm')}</a></p>
<section class="card">
  <h2>New post</h2>
  <form method="post" action="/posts/new" enctype="multipart/form-data" class="form">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <label>What's on your mind? (Markdown ok)
      <textarea name="body" rows="4" required maxlength="2000" placeholder="Share something… it also goes to your hub's RSS feed"></textarea>
    </label>
    <label>Tags (comma-separated, used by feed algorithms) <input type="text" name="tags" maxlength="200" placeholder="tech, photos"></label>
    <label>Image (optional) <input type="file" name="image" accept="image/*"></label>
    <button type="submit">Post</button>
  </form>
</section>
${list}`);
}

export function feedSettingsPage({ settings, flash = '', ...ctx }) {
  const w = settings.weights;
  const flashHtml = flash ? `<p class="ok">${esc(flash)}</p>` : '';
  const sel = (mode) => (settings.mode === mode ? 'selected' : '');
  return page(ctx, 'Feed algorithm', `
<h1>Feed algorithm</h1>
<p class="muted">Tune how your subscriptions feed ranks posts — RedNote-style: blend freshness, engagement and your interests.</p>
${flashHtml}
<section class="card">
  <form method="post" action="/feed/settings" class="form">
    <input type="hidden" name="csrf" value="${esc(ctx.csrf)}">
    <label>Mode
      <select name="mode">
        <option value="algorithm" ${sel('algorithm')}>Custom algorithm (weights below)</option>
        <option value="chrono" ${sel('chrono')}>Chronological</option>
      </select>
    </label>
    <label>Freshness weight (newer posts score higher; decays over ~2 days)
      <input type="number" name="w_freshness" min="0" max="10" step="0.1" value="${w.freshness}">
    </label>
    <label>Engagement weight (likes)
      <input type="number" name="w_engagement" min="0" max="10" step="0.1" value="${w.engagement}">
    </label>
    <label>Interest weight (match with your tags)
      <input type="number" name="w_interest" min="0" max="10" step="0.1" value="${w.interest}">
    </label>
    <label>Your interests (comma-separated tags)
      <input type="text" name="interests" maxlength="300" value="${esc(settings.interests.join(', '))}" placeholder="tech, photography, travel">
    </label>
    <button type="submit">Save</button>
  </form>
</section>`);
}

export function photosPage(ctx) {
  const grid = ctx.photos.length
    ? `<div class="grid">${ctx.photos.map((p) => `
      <a class="cell" href="/photos/${p.id}">
        <img src="/media/${encodeURIComponent(p.filename)}" alt="${esc(p.caption)}" loading="lazy">
        ${p.caption ? `<span class="cap">${esc(p.caption)}</span>` : ''}
      </a>`).join('')}
    </div>`
    : '<p class="muted">No photos yet.</p>';
  return page(ctx, 'Photos', `<h1>Photos</h1>${grid}`);
}

export function photoPage(ctx) {
  const p = ctx.photo;
  return page(ctx, p.caption || 'Photo', `
<p><a href="/photos" class="back">← all photos</a></p>
<figure class="full">
  <img src="/media/${encodeURIComponent(p.filename)}" alt="${esc(p.caption)}">
  ${p.caption ? `<figcaption>${esc(p.caption)}</figcaption>` : ''}
  <p class="muted">${fmtDate(p.created_at)}</p>
</figure>`);
}

export function writingsPage(ctx) {
  const list = ctx.writings.length
    ? `<ul class="wlist">${ctx.writings.map((w) => `<li><a href="/writings/${encodeURIComponent(w.slug)}">${esc(w.title)}</a> <span class="muted">${fmtDate(w.created_at)}</span></li>`).join('')}</ul>`
    : '<p class="muted">No writings yet.</p>';
  return page(ctx, 'Writings', `<h1>Writings</h1>${list}`);
}

export function writingPage(ctx) {
  const w = ctx.writing;
  return page(ctx, w.title, `
<p><a href="/writings" class="back">← all writings</a></p>
<article class="writing">
  <h1>${esc(w.title)}</h1>
  <p class="muted">${fmtDate(w.created_at)}</p>
  <div class="body">${renderMarkdown(w.body)}</div>
</article>`);
}

const userRow = (u, csrf) => `
<tr>
  <td>${esc(u.handle || u.sub)}${u.hub_slug ? ` · <a href="/u/${encodeURIComponent(u.hub_slug)}">@${esc(u.hub_slug)}</a>` : ''}</td>
  <td>${esc(u.name)}</td>
  <td>${esc(u.email)}</td>
  <td>${esc(u.provider)}</td>
  <td><span class="badge ${esc(u.status)}">${esc(u.status)}</span>${u.role === 'owner' ? ' <span class="badge owner">owner</span>' : ''}</td>
  <td class="muted">${fmtDate(u.created_at)}</td>
  <td>
    <form method="post" action="/admin/users/${u.id}/decide" class="inline">
      <input type="hidden" name="csrf" value="${esc(csrf)}">
      ${u.status !== 'approved' ? '<button name="action" value="approve" class="small">Approve</button>' : ''}
      ${u.status !== 'denied' ? '<button name="action" value="deny" class="small">Deny</button>' : ''}
      ${u.status === 'approved' ? '<button name="action" value="revoke" class="small danger">Revoke</button>' : ''}
    </form>
  </td>
</tr>`;

export function adminPage(ctx) {
  const csrf = ctx.csrf;
  const flash = ctx.flash ? `<p class="ok">${esc(ctx.flash)}</p>` : '';
  const pending = ctx.pending.length
    ? `<table class="table"><thead><tr><th>Handle</th><th>Name</th><th>Email</th><th>Provider</th><th>Status</th><th>Requested</th><th></th></tr></thead><tbody>${ctx.pending.map((u) => userRow(u, csrf)).join('')}</tbody></table>`
    : '<p class="muted">No pending requests.</p>';
  const users = `<table class="table"><thead><tr><th>Handle</th><th>Name</th><th>Email</th><th>Provider</th><th>Status</th><th>Joined</th><th></th></tr></thead><tbody>${ctx.users.map((u) => userRow(u, csrf)).join('')}</tbody></table>`;
  const writings = ctx.writings.length
    ? `<ul class="alist">${ctx.writings.map((w) => `<li><a href="/writings/${encodeURIComponent(w.slug)}">${esc(w.title)}</a> <span class="muted">${fmtDate(w.created_at)}</span>
        <form method="post" action="/admin/writings/${w.id}/delete" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="small danger">Delete</button></form></li>`).join('')}</ul>`
    : '<p class="muted">No writings yet.</p>';
  const photos = ctx.photos.length
    ? `<div class="grid admin-grid">${ctx.photos.map((p) => `<div class="cell">
        <img src="/media/${encodeURIComponent(p.filename)}" alt="${esc(p.caption)}" loading="lazy">
        <form method="post" action="/admin/photos/${p.id}/delete" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="small danger">Delete</button></form>
      </div>`).join('')}</div>`
    : '<p class="muted">No photos yet.</p>';

  return page(ctx, 'Admin', `
<h1>Admin</h1>
${flash}
<p class="muted">${ctx.counts.members} approved member(s) · ${ctx.counts.photos} photo(s) · ${ctx.counts.writings} writing(s)</p>

<section class="card">
  <h2>Pending requests</h2>
  ${pending}
</section>

<section class="card">
  <h2>Members</h2>
  ${users}
</section>

<section class="card">
  <h2>New writing</h2>
  <form method="post" action="/admin/writings/new" class="form">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <label>Title <input type="text" name="title" required maxlength="200"></label>
    <label>Body (Markdown) <textarea name="body" rows="10" required></textarea></label>
    <button type="submit">Publish</button>
  </form>
  <h2>Writings</h2>
  ${writings}
</section>

<section class="card">
  <h2>New photo</h2>
  <form method="post" action="/admin/photos/new" enctype="multipart/form-data" class="form">
    <input type="hidden" name="csrf" value="${esc(csrf)}">
    <label>File (jpg, png, webp, gif — max ${ctx.maxUploadMb} MB) <input type="file" name="file" accept="image/*" required></label>
    <label>Caption <input type="text" name="caption" maxlength="500"></label>
    <button type="submit">Upload</button>
  </form>
  <h2>Photos</h2>
  ${photos}
</section>`);
}

export function errorPage(ctx, status, msg) {
  return page(ctx, `Error ${status}`, `<section class="card"><h1>${status}</h1><p>${esc(msg)}</p><p><a href="/">Back to start</a></p></section>`);
}
