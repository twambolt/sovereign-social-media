import crypto from 'node:crypto';

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256hex = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmacHex = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function csrfFor(secret, sessionToken) {
  return hmacHex(secret, 'csrf:' + sessionToken);
}

export function makeRateLimiter({ windowMs = 10 * 60 * 1000, max = 20 } = {}) {
  const hits = new Map();
  return function allowed(key) {
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || rec.resetAt < now) {
      rec = { count: 0, resetAt: now + windowMs };
      hits.set(key, rec);
    }
    rec.count += 1;
    if (hits.size > 10000) {
      for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
    }
    return rec.count <= max;
  };
}

export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || 'unknown';
}
