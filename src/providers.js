import crypto from 'node:crypto';

const UA = { 'user-agent': 'gatehouse/0.1 (personal site login)' };

const SUBSTACK_METADATA_URL = 'https://substack.com/.well-known/oauth-authorization-server';
const DEFAULT_SUBSTACK_SCOPE = 'openid profile email offline_access';

let substackMetaCache = { meta: null, fetchedAt: 0 };

async function fetchSubstackMeta(force = false) {
  const now = Date.now();
  if (!force && substackMetaCache.meta && now - substackMetaCache.fetchedAt < 60 * 60 * 1000) {
    return substackMetaCache.meta;
  }
  const r = await fetch(SUBSTACK_METADATA_URL, { headers: UA });
  if (!r.ok) throw new Error(`substack metadata fetch failed: HTTP ${r.status}`);
  const meta = await r.json();
  substackMetaCache = { meta, fetchedAt: now };
  return meta;
}

function pkceChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

async function httpJson(url, opts, what) {
  const r = await fetch(url, { ...opts, headers: { ...UA, ...(opts.headers || {}) } });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-json */ }
  if (!r.ok) {
    const msg = json?.error_description || json?.error || text.slice(0, 200) || `HTTP ${r.status}`;
    throw new Error(`${what} failed: ${msg}`);
  }
  return json ?? {};
}

export function makeProviders(config, store) {
  const redirectUri = (id) => `${config.publicUrl}/auth/callback/${id}`;

  const instagram = {
    id: 'instagram',
    label: 'Instagram',
    enabled: Boolean(config.instagram.clientId),
    usesPkce: false,
    authUrl({ state }) {
      const u = new URL('https://www.instagram.com/oauth/authorize');
      u.searchParams.set('client_id', config.instagram.clientId);
      u.searchParams.set('redirect_uri', redirectUri('instagram'));
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('scope', 'instagram_business_basic');
      u.searchParams.set('state', state);
      return u.toString();
    },
    async exchange({ code, verifier }) {
      const body = new URLSearchParams({
        client_id: config.instagram.clientId,
        client_secret: config.instagram.clientSecret,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri('instagram'),
        code,
      });
      if (verifier) body.set('code_verifier', verifier);
      const j = await httpJson('https://api.instagram.com/oauth/access_token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      }, 'instagram token exchange');
      return j.access_token;
    },
    async profile(accessToken) {
      const u = new URL('https://graph.instagram.com/me');
      u.searchParams.set('fields', 'id,username');
      u.searchParams.set('access_token', accessToken);
      const j = await httpJson(u.toString(), {}, 'instagram profile');
      if (!j.id) throw new Error('instagram profile missing id');
      return {
        sub: String(j.id),
        handle: j.username || '',
        name: j.username || '',
        email: '',
        avatar: '',
      };
    },
  };

  const substack = {
    id: 'substack',
    label: 'Substack',
    enabled: true,
    usesPkce: true,
    async client(force = false) {
      if (config.substack.clientId) {
        const meta = await fetchSubstackMeta();
        return { clientId: config.substack.clientId, clientSecret: config.substack.clientSecret, meta, static: true };
      }
      const row = store.getClient('substack');
      if (row && !force) {
        let meta;
        try { meta = JSON.parse(row.meta); } catch { meta = await fetchSubstackMeta(); }
        if (meta.authorization_endpoint) {
          return { clientId: row.client_id, clientSecret: row.client_secret, registrationAccessToken: row.registration_access_token, meta, static: false };
        }
      }
      const meta = await fetchSubstackMeta(true);
      const reg = await httpJson(meta.registration_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          redirect_uris: [redirectUri('substack')],
          client_name: `${config.siteName} (gatehouse)`,
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: config.substack.scope || DEFAULT_SUBSTACK_SCOPE,
        }),
      }, 'substack client registration');
      const client = {
        clientId: reg.client_id,
        clientSecret: reg.client_secret || '',
        registrationAccessToken: reg.registration_access_token || '',
        meta: {
          authorization_endpoint: meta.authorization_endpoint,
          token_endpoint: meta.token_endpoint,
          userinfo_endpoint: meta.userinfo_endpoint,
          granted_scope: reg.scope || '',
        },
        static: false,
      };
      store.saveClient('substack', client);
      return client;
    },
    async authUrl({ state, verifier }) {
      const client = await substack.client();
      const u = new URL(client.meta.authorization_endpoint);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('client_id', client.clientId);
      u.searchParams.set('redirect_uri', redirectUri('substack'));
      u.searchParams.set('scope', config.substack.scope || client.meta.granted_scope || DEFAULT_SUBSTACK_SCOPE);
      u.searchParams.set('state', state);
      u.searchParams.set('code_challenge', pkceChallenge(verifier));
      u.searchParams.set('code_challenge_method', 'S256');
      return u.toString();
    },
    async exchange({ code, verifier }) {
      const client = await substack.client();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri('substack'),
        client_id: client.clientId,
      });
      if (verifier) body.set('code_verifier', verifier);
      const headers = { 'content-type': 'application/x-www-form-urlencoded' };
      if (client.clientSecret) {
        headers.authorization = 'Basic ' + Buffer.from(`${client.clientId}:${client.clientSecret}`).toString('base64');
      }
      const j = await httpJson(client.meta.token_endpoint, { method: 'POST', headers, body }, 'substack token exchange');
      return j.access_token;
    },
    async profile(accessToken) {
      const client = await substack.client();
      const j = await httpJson(client.meta.userinfo_endpoint, {
        headers: { authorization: `Bearer ${accessToken}` },
      }, 'substack userinfo');
      const sub = j.sub || j.id || j.user_id;
      if (!sub) throw new Error('substack userinfo returned no subject');
      const email = j.email || '';
      const handle = j.preferred_username || j.username || (email ? email.split('@')[0] : String(sub));
      return {
        sub: String(sub),
        handle,
        name: j.name || handle,
        email,
        avatar: j.picture || '',
      };
    },
  };

  const mock = {
    id: 'mock',
    label: 'Mock (dev only)',
    enabled: config.mockOAuth,
    usesPkce: true,
    authUrl({ state }) {
      return `${config.publicUrl}/auth/callback/mock?code=mock-code&state=${encodeURIComponent(state)}`;
    },
    async exchange() {
      return 'mock-access-token';
    },
    async profile(_token, stateRow) {
      const as = (stateRow?.data || 'user').slice(0, 64);
      return {
        sub: as,
        handle: as,
        name: `Mock ${as}`,
        email: `${as}@example.com`,
        avatar: '',
      };
    },
  };

  return { instagram, substack, mock };
}
