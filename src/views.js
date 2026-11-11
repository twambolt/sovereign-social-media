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

function layout({ title, siteName, user, csrf, body }) {
  let nav = '';
  if (user) {
    const links = [`<span class="who">@${esc(user.handle || user.sub)}</span>`];
    if (user.status === 'approved') {
      links.unshift('<a href="/home">Home</a>', '<a href="/photos">Photos</a>', '<a href="/writings">Writings</a>');
      if (user.role === 'owner') links.push('<a href="/admin">Admin</a>');
    }
    links.push(`<form method="post" action="/logout" class="inline"><input type="hidden" name="csrf" value="${esc(csrf)}"><button class="linkbtn" type="submit">Sign out</button></form>`);
    nav = `<nav class="nav">${links.join('')}</nav>`;
  }
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · ${esc(siteName)}</title>
<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">${esc(siteName)}</a>
  ${nav}
</header>
<main class="main">
${body}
</main>
<footer class="footer">${esc(siteName)} — members only</footer>
</body>
</html>`;
}

function page(ctx, title, body) {
  return layout({ title, siteName: ctx.siteName, user: ctx.user, csrf: ctx.csrf, body });
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
  <p class="muted">This site is private. Sign in with Instagram or Substack to request access — the owner reviews every request.</p>
  ${err}
  <div class="btnrow">${buttons}</div>
  ${disabledNote}
</section>`);
}

export function gatePage(ctx) {
  const u = ctx.user;
  if (u.status === 'pending') {
    return page(ctx, 'Request received', `
<section class="card">
  <h1>Request received</h1>
  <p>Thanks, <strong>@${esc(u.handle || u.sub)}</strong> — your request to join <strong>${esc(ctx.siteName)}</strong> is waiting for the owner's approval.</p>
  <p class="muted">You'll be able to see photos and writings once approved. You can close this page and come back later.</p>
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
  return page(ctx, 'Home', `
<section class="card">
  <h1>Hello, ${esc(ctx.user.name || ctx.user.handle || ctx.user.sub)}</h1>
  <p class="muted">Welcome to ${esc(ctx.siteName)}. You have access to:</p>
  <div class="cards">
    <a class="tile" href="/photos"><span class="tile-num">${nPhotos}</span><span class="tile-label">Photos</span></a>
    <a class="tile" href="/writings"><span class="tile-num">${nWritings}</span><span class="tile-label">Writings</span></a>
  </div>
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
  <td>${esc(u.handle || u.sub)}</td>
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
