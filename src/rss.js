const xmlEsc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

export function rssFeed({ title, link, description, items }) {
  const itemsXml = items
    .map(
      (it) => `  <item>
    <title>${xmlEsc(it.title)}</title>
    <link>${xmlEsc(it.link)}</link>
    <guid isPermaLink="false">${xmlEsc(it.guid)}</guid>
    <pubDate>${xmlEsc(it.pubDate)}</pubDate>
    <description>${xmlEsc(it.description)}</description>
  </item>`
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>${xmlEsc(title)}</title>
  <link>${xmlEsc(link)}</link>
  <description>${xmlEsc(description)}</description>
  <lastBuildDate>${xmlEsc(new Date().toUTCString())}</lastBuildDate>
${itemsXml}
</channel>
</rss>
`;
}

export function postToRssItem(post, publicUrl, hubSlug) {
  const plain = String(post.body).replace(/\s+/g, ' ').trim();
  const title = plain.length > 80 ? plain.slice(0, 77) + '…' : plain || '(untitled post)';
  const link = `${publicUrl}/u/${encodeURIComponent(hubSlug)}#post-${post.id}`;
  return {
    title,
    link,
    guid: `post-${post.id}`,
    pubDate: new Date(post.created_at).toUTCString(),
    description: plain,
  };
}
