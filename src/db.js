import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'site.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      sub TEXT NOT NULL,
      handle TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      avatar TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied')),
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner')),
      created_at TEXT NOT NULL,
      decided_at TEXT,
      UNIQUE (provider, sub)
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      verifier TEXT NOT NULL DEFAULT '',
      data TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS oauth_clients (
      provider TEXT PRIMARY KEY,
      client_id TEXT NOT NULL,
      client_secret TEXT NOT NULL DEFAULT '',
      registration_access_token TEXT NOT NULL DEFAULT '',
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      caption TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS writings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

export function createStore(db) {
  const q = {
    userByKey: db.prepare('SELECT * FROM users WHERE provider = ? AND sub = ?'),
    insertUser: db.prepare('INSERT INTO users (provider, sub, handle, name, email, avatar, status, role, created_at) VALUES (?,?,?,?,?,?,?,?,?)'),
    updateProfile: db.prepare('UPDATE users SET handle = ?, name = ?, email = ?, avatar = ? WHERE id = ?'),
    promoteOwner: db.prepare("UPDATE users SET role = 'owner', status = 'approved' WHERE id = ?"),
    decideUser: db.prepare('UPDATE users SET status = ?, decided_at = ? WHERE id = ?'),
    listUsers: db.prepare('SELECT * FROM users ORDER BY created_at DESC'),
    listPending: db.prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY created_at ASC"),
    insertSession: db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?,?,?,?)'),
    sessionByToken: db.prepare('SELECT s.token_hash, s.expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?'),
    deleteSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    deleteSessionsOfUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    insertState: db.prepare('INSERT INTO oauth_states (state, provider, verifier, data, expires_at) VALUES (?,?,?,?,?)'),
    stateByKey: db.prepare('SELECT * FROM oauth_states WHERE state = ?'),
    markStateUsed: db.prepare('UPDATE oauth_states SET used = 1 WHERE state = ?'),
    cleanupStates: db.prepare("DELETE FROM oauth_states WHERE expires_at < ? OR used = 1"),
    clientByProvider: db.prepare('SELECT * FROM oauth_clients WHERE provider = ?'),
    upsertClient: db.prepare('INSERT INTO oauth_clients (provider, client_id, client_secret, registration_access_token, meta, created_at) VALUES (?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET client_id=excluded.client_id, client_secret=excluded.client_secret, registration_access_token=excluded.registration_access_token, meta=excluded.meta'),
    insertPhoto: db.prepare('INSERT INTO photos (filename, caption, created_at) VALUES (?,?,?)'),
    listPhotos: db.prepare('SELECT * FROM photos ORDER BY created_at DESC, id DESC'),
    photoById: db.prepare('SELECT * FROM photos WHERE id = ?'),
    deletePhoto: db.prepare('DELETE FROM photos WHERE id = ?'),
    insertWriting: db.prepare('INSERT INTO writings (slug, title, body, created_at, updated_at) VALUES (?,?,?,?,?)'),
    listWritings: db.prepare('SELECT * FROM writings ORDER BY created_at DESC, id DESC'),
    writingBySlug: db.prepare('SELECT * FROM writings WHERE slug = ?'),
    writingById: db.prepare('SELECT * FROM writings WHERE id = ?'),
    deleteWriting: db.prepare('DELETE FROM writings WHERE id = ?'),
    slugExists: db.prepare('SELECT 1 FROM writings WHERE slug = ?'),
    countApproved: db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = 'approved'"),
    countPhotos: db.prepare('SELECT COUNT(*) AS n FROM photos'),
    countWritings: db.prepare('SELECT COUNT(*) AS n FROM writings'),
  };
  const now = () => new Date().toISOString();
  return {
    db,
    getUserByKey: (provider, sub) => q.userByKey.get(provider, sub),
    createUser: (u) => {
      const r = q.insertUser.run(u.provider, u.sub, u.handle, u.name, u.email, u.avatar, u.status, u.role, now());
      return q.userByKey.get(u.provider, u.sub) ?? { id: Number(r.lastInsertRowid), ...u };
    },
    updateProfile: (id, p) => q.updateProfile.run(p.handle, p.name, p.email, p.avatar, id),
    promoteOwner: (id) => q.promoteOwner.run(id),
    decideUser: (id, status) => q.decideUser.run(status, now(), id),
    listUsers: () => q.listUsers.all(),
    listPending: () => q.listPending.all(),
    createSession: (tokenHash, userId, expiresAt) => q.insertSession.run(tokenHash, userId, now(), expiresAt),
    getSession: (tokenHash) => {
      const row = q.sessionByToken.get(tokenHash);
      if (!row) return null;
      if (row.expires_at < now()) return null;
      return row;
    },
    deleteSession: (tokenHash) => q.deleteSession.run(tokenHash),
    deleteSessionsOfUser: (userId) => q.deleteSessionsOfUser.run(userId),
    createState: (s) => q.insertState.run(s.state, s.provider, s.verifier, s.data, s.expiresAt),
    getState: (state) => q.stateByKey.get(state),
    markStateUsed: (state) => q.markStateUsed.run(state),
    cleanupStates: () => q.cleanupStates.run(now()),
    getClient: (provider) => q.clientByProvider.get(provider),
    saveClient: (provider, c) => q.upsertClient.run(provider, c.clientId, c.clientSecret || '', c.registrationAccessToken || '', JSON.stringify(c.meta || {}), now()),
    addPhoto: (filename, caption) => q.insertPhoto.run(filename, caption, now()),
    listPhotos: () => q.listPhotos.all(),
    getPhoto: (id) => q.photoById.get(id),
    deletePhoto: (id) => q.deletePhoto.run(id),
    addWriting: (slug, title, body) => q.insertWriting.run(slug, title, body, now(), now()),
    listWritings: () => q.listWritings.all(),
    getWritingBySlug: (slug) => q.writingBySlug.get(slug),
    getWritingById: (id) => q.writingById.get(id),
    deleteWriting: (id) => q.deleteWriting.run(id),
    slugExists: (slug) => !!q.slugExists.get(slug),
    countApproved: () => q.countApproved.get().n,
    countPhotos: () => q.countPhotos.get().n,
    countWritings: () => q.countWritings.get().n,
  };
}
