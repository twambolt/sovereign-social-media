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
      hub_slug TEXT UNIQUE,
      bio TEXT NOT NULL DEFAULT '',
      settings_json TEXT NOT NULL DEFAULT '{}',
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
    CREATE TABLE IF NOT EXISTS hub_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      image TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS likes (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (post_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS follows (
      follower_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      followee_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (follower_id, followee_id)
    );
  `);
  for (const col of ['hub_slug TEXT UNIQUE', "bio TEXT NOT NULL DEFAULT ''", "settings_json TEXT NOT NULL DEFAULT '{}'"]) {
    try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch { /* already exists */ }
  }
  return db;
}

export function createStore(db) {
  const q = {
    userByKey: db.prepare('SELECT * FROM users WHERE provider = ? AND sub = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userBySlug: db.prepare('SELECT * FROM users WHERE hub_slug = ?'),
    insertUser: db.prepare('INSERT INTO users (provider, sub, handle, name, email, avatar, status, role, created_at) VALUES (?,?,?,?,?,?,?,?,?)'),
    updateProfile: db.prepare('UPDATE users SET handle = ?, name = ?, email = ?, avatar = ? WHERE id = ?'),
    promoteOwner: db.prepare("UPDATE users SET role = 'owner', status = 'approved' WHERE id = ?"),
    decideUser: db.prepare('UPDATE users SET status = ?, decided_at = ? WHERE id = ?'),
    listUsers: db.prepare('SELECT * FROM users ORDER BY created_at DESC'),
    listPending: db.prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY created_at ASC"),
    listHubs: db.prepare("SELECT id, hub_slug, handle, name, bio, avatar FROM users WHERE status = 'approved' AND hub_slug IS NOT NULL ORDER BY hub_slug ASC"),
    setHub: db.prepare('UPDATE users SET hub_slug = ?, name = ?, bio = ? WHERE id = ?'),
    updateHubProfile: db.prepare('UPDATE users SET name = ?, bio = ?, avatar = ? WHERE id = ?'),
    getSettings: db.prepare('SELECT settings_json FROM users WHERE id = ?'),
    setSettings: db.prepare('UPDATE users SET settings_json = ? WHERE id = ?'),
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
    maxLinkPos: db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM hub_links WHERE user_id = ?'),
    insertLink: db.prepare('INSERT INTO hub_links (user_id, title, url, position, created_at) VALUES (?,?,?,?,?)'),
    listLinks: db.prepare('SELECT * FROM hub_links WHERE user_id = ? ORDER BY position ASC, id ASC'),
    linkById: db.prepare('SELECT * FROM hub_links WHERE id = ?'),
    deleteLink: db.prepare('DELETE FROM hub_links WHERE id = ?'),
    linkAt: db.prepare('SELECT * FROM hub_links WHERE user_id = ? AND position = ?'),
    setLinkPos: db.prepare('UPDATE hub_links SET position = ? WHERE id = ?'),
    insertPost: db.prepare('INSERT INTO posts (user_id, body, tags, image, created_at) VALUES (?,?,?,?,?)'),
    postById: db.prepare('SELECT * FROM posts WHERE id = ?'),
    listPostsByUser: db.prepare('SELECT * FROM posts WHERE user_id = ? ORDER BY created_at DESC, id DESC'),
    listRecentPosts: db.prepare("SELECT p.*, u.hub_slug, u.name, u.handle FROM posts p JOIN users u ON u.id = p.user_id WHERE u.status = 'approved' AND u.hub_slug IS NOT NULL ORDER BY p.created_at DESC, p.id DESC LIMIT ?"),
    feedCandidates: db.prepare("SELECT p.*, u.id AS author_id, u.hub_slug, u.name, u.handle, u.avatar FROM posts p JOIN follows f ON f.followee_id = p.user_id JOIN users u ON u.id = p.user_id WHERE f.follower_id = ? AND p.user_id != ?"),
    deletePost: db.prepare('DELETE FROM posts WHERE id = ?'),
    likeCount: db.prepare('SELECT COUNT(*) AS n FROM likes WHERE post_id = ?'),
    hasLiked: db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?'),
    insertLike: db.prepare('INSERT INTO likes (post_id, user_id, created_at) VALUES (?,?,?)'),
    deleteLike: db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?'),
    follow: db.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id, created_at) VALUES (?,?,?)'),
    unfollow: db.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?'),
    isFollowing: db.prepare('SELECT 1 FROM follows WHERE follower_id = ? AND followee_id = ?'),
    followingIds: db.prepare('SELECT followee_id FROM follows WHERE follower_id = ?'),
    followerCount: db.prepare('SELECT COUNT(*) AS n FROM follows WHERE followee_id = ?'),
  };
  const now = () => new Date().toISOString();
  return {
    db,
    getUserByKey: (provider, sub) => q.userByKey.get(provider, sub),
    getUserById: (id) => q.userById.get(id),
    getUserBySlug: (slug) => q.userBySlug.get(slug),
    createUser: (u) => {
      const r = q.insertUser.run(u.provider, u.sub, u.handle, u.name, u.email, u.avatar, u.status, u.role, now());
      return q.userByKey.get(u.provider, u.sub) ?? { id: Number(r.lastInsertRowid), ...u };
    },
    updateProfile: (id, p) => q.updateProfile.run(p.handle, p.name, p.email, p.avatar, id),
    promoteOwner: (id) => q.promoteOwner.run(id),
    decideUser: (id, status) => q.decideUser.run(status, now(), id),
    listUsers: () => q.listUsers.all(),
    listPending: () => q.listPending.all(),
    listHubs: () => q.listHubs.all(),
    setHub: (id, slug, name, bio) => q.setHub.run(slug, name, bio, id),
    updateHubProfile: (id, p) => q.updateHubProfile.run(p.name, p.bio, p.avatar, id),
    getSettings: (id) => q.getSettings.get(id)?.settings_json || '{}',
    setSettings: (id, json) => q.setSettings.run(json, id),
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
    addLink: (userId, title, url) => {
      const pos = q.maxLinkPos.get(userId).m + 1;
      q.insertLink.run(userId, title, url, pos, now());
    },
    listLinks: (userId) => q.listLinks.all(userId),
    getLink: (id) => q.linkById.get(id),
    deleteLink: (id) => q.deleteLink.run(id),
    moveLink: (id, userId, dir) => {
      const link = q.linkById.get(id);
      if (!link || link.user_id !== userId) return;
      const other = q.linkAt.get(userId, link.position + dir);
      if (!other) return;
      q.setLinkPos.run(other.position, link.id);
      q.setLinkPos.run(link.position, other.id);
    },
    addPost: (userId, body, tags, image) => {
      const r = q.insertPost.run(userId, body, tags, image, now());
      return q.postById.get(Number(r.lastInsertRowid));
    },
    getPost: (id) => q.postById.get(id),
    listPostsByUser: (userId) => q.listPostsByUser.all(userId),
    listRecentPosts: (limit = 50) => q.listRecentPosts.all(limit),
    feedCandidates: (followerId) => q.feedCandidates.all(followerId, followerId),
    deletePost: (id) => q.deletePost.run(id),
    likeCount: (postId) => q.likeCount.get(postId).n,
    hasLiked: (postId, userId) => !!q.hasLiked.get(postId, userId),
    toggleLike: (postId, userId) => {
      if (q.hasLiked.get(postId, userId)) q.deleteLike.run(postId, userId);
      else q.insertLike.run(postId, userId, now());
    },
    follow: (followerId, followeeId) => q.follow.run(followerId, followeeId, now()),
    unfollow: (followerId, followeeId) => q.unfollow.run(followerId, followeeId),
    isFollowing: (followerId, followeeId) => !!q.isFollowing.get(followerId, followeeId),
    followingIds: (followerId) => q.followingIds.all(followerId).map((r) => r.followee_id),
    followerCount: (userId) => q.followerCount.get(userId).n,
  };
}
