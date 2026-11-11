import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

export function buildConfig(env = process.env, rootDir = process.cwd()) {
  loadEnvFile(path.join(rootDir, '.env'));

  const dataDir = path.resolve(env.DATA_DIR || path.join(rootDir, 'data'));
  fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

  let authSecret = env.AUTH_SECRET;
  if (!authSecret) {
    const secretFile = path.join(dataDir, '.auth_secret');
    if (fs.existsSync(secretFile)) {
      authSecret = fs.readFileSync(secretFile, 'utf8').trim();
    } else {
      authSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(secretFile, authSecret + '\n', { mode: 0o600 });
      console.warn(`[config] generated a new AUTH_SECRET at ${secretFile} (mode 0600)`);
    }
  }

  const port = Number(env.PORT || 3000);
  const host = env.HOST || '127.0.0.1';
  const nodeEnv = env.NODE_ENV || 'development';
  const publicUrl = (env.PUBLIC_URL || `http://${host}:${port}`).replace(/\/+$/, '');
  const mockOAuth = env.MOCK_OAUTH === '1' && nodeEnv !== 'production';
  if (env.MOCK_OAUTH === '1' && nodeEnv === 'production') {
    throw new Error('MOCK_OAUTH must not be enabled in production');
  }

  const toSet = (s) => new Set((s || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));

  return {
    rootDir,
    dataDir,
    uploadsDir: path.join(dataDir, 'uploads'),
    authSecret,
    port,
    host,
    nodeEnv,
    publicUrl,
    mockOAuth,
    siteName: env.SITE_NAME || 'Sovereign Social Media',
    siteTagline: env.SITE_TAGLINE || 'A private corner of the internet.',
    ownerIds: toSet(env.OWNER_IDS),
    ownerEmails: toSet(env.OWNER_EMAILS),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 10) * 1024 * 1024,
    sessionDays: Number(env.SESSION_DAYS || 30),
    instagram: {
      clientId: env.INSTAGRAM_CLIENT_ID || '',
      clientSecret: env.INSTAGRAM_CLIENT_SECRET || '',
    },
    substack: {
      clientId: env.SUBSTACK_CLIENT_ID || '',
      clientSecret: env.SUBSTACK_CLIENT_SECRET || '',
      scope: env.SUBSTACK_SCOPE || '',
    },
  };
}

export function isOwnerIdentity(config, provider, sub, email) {
  if (config.ownerIds.has(`${provider}:${String(sub).toLowerCase()}`)) return true;
  if (email && config.ownerEmails.has(String(email).toLowerCase())) return true;
  return false;
}
