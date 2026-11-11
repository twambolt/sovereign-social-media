const esc = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function inline(text) {
  let t = esc(text);
  t = t.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, (m, alt, url) => `<img src="${url}" alt="${alt}" loading="lazy">`);
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (m, label, url) =>
    `<a href="${url}" rel="noopener noreferrer"${url.startsWith('http') ? ' target="_blank"' : ''}>${label}</a>`
  );
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
  return t;
}

export function renderMarkdown(src) {
  const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  let para = [];
  let list = null;
  let inCode = false;
  let codeBuf = [];

  const flushPara = () => {
    if (para.length) {
      html.push(`<p>${inline(para.join(' '))}</p>`);
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      html.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`);
      list = null;
    }
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushPara();
      flushList();
      if (inCode) {
        html.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
        codeBuf = [];
        inCode = false;
      } else {
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      flushPara();
      flushList();
      const lvl = h[1].length;
      html.push(`<h${lvl}>${inline(h[2].trim())}</h${lvl}>`);
      continue;
    }
    const li = line.match(/^\s*(?:([-*+])|(\d+)\.)\s+(.*)$/);
    if (li) {
      flushPara();
      const tag = li[2] ? 'ol' : 'ul';
      if (!list || list.tag !== tag) {
        flushList();
        list = { tag, items: [] };
      }
      list.items.push(li[3]);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushPara();
      flushList();
      html.push(`<blockquote><p>${inline(line.replace(/^\s*>\s?/, ''))}</p></blockquote>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      flushPara();
      flushList();
      html.push('<hr>');
      continue;
    }
    if (line.trim() === '') {
      flushPara();
      flushList();
      continue;
    }
    para.push(line.trim());
  }
  flushPara();
  flushList();
  if (inCode) html.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`);
  return html.join('\n');
}
