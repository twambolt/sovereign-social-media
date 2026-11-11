export function defaultSettings() {
  return {
    mode: 'algorithm',
    weights: { freshness: 1.0, engagement: 0.6, interest: 0.8 },
    interests: [],
  };
}

export function parseSettings(json) {
  const d = defaultSettings();
  let parsed = {};
  try { parsed = JSON.parse(json || '{}'); } catch { /* fall back to defaults */ }
  const weights = { ...d.weights, ...(parsed.weights || {}) };
  for (const k of Object.keys(weights)) {
    const n = Number(weights[k]);
    weights[k] = Number.isFinite(n) ? Math.min(10, Math.max(0, n)) : d.weights[k];
  }
  const interests = Array.isArray(parsed.interests)
    ? parsed.interests.map((s) => String(s).trim().toLowerCase()).filter(Boolean).slice(0, 20)
    : d.interests;
  return {
    mode: parsed.mode === 'chrono' ? 'chrono' : 'algorithm',
    weights,
    interests,
  };
}

export function normalizeTags(raw) {
  return String(raw || '')
    .split(',')
    .map((t) => t.trim().toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24))
    .filter(Boolean)
    .slice(0, 8)
    .join(',');
}

export function postTags(post) {
  return String(post.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
}

export function scoreFeed(posts, settings, now = Date.now()) {
  if (settings.mode === 'chrono') {
    return [...posts].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  }
  const w = settings.weights;
  const maxLikes = posts.reduce((m, p) => Math.max(m, p.likes || 0), 0);
  return posts
    .map((p) => {
      const ageHours = Math.max(0, (now - new Date(p.created_at).getTime()) / 3.6e6);
      const freshness = Math.exp(-ageHours / 48);
      const engagement = maxLikes > 0 ? (p.likes || 0) / maxLikes : 0;
      const ptags = postTags(p);
      const interests = settings.interests || [];
      const overlap = ptags.filter((t) => interests.includes(t)).length;
      const interest = interests.length ? Math.min(1, overlap / Math.min(3, interests.length)) : 0;
      const score = w.freshness * freshness + w.engagement * engagement + w.interest * interest;
      return { ...p, score };
    })
    .sort((a, b) => b.score - a.score || (a.created_at < b.created_at ? 1 : -1));
}
