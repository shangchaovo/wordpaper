'use strict';

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const learningActivity = require('../js/learning-activity');
const reviewPolicyStore = require('./review-policy-store');
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch {
  throw new Error('当前 Node.js 不支持 node:sqlite；请使用 Node 22.23.2+ 或 Node 24。');
}

const STATE_NAMESPACES = new Set([
  'settings',
  'uiTheme',
  'customWords',
  'knownWords',
  'reminders',
  'engine',
  'review',
  'seeded',
  'moduleLayout',
  'hiddenModules',
  'petMemoryCursor',
  'petSyncCursor',
  'dragHint',
  'dailyPlan',
  'learningActivity',
]);

function openStorage(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, 'wordpaper.sqlite');
  const db = new DatabaseSync(databasePath);

  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL,
      username_key TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      allow_legacy_import INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS password_credentials (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_state (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      namespace TEXT NOT NULL,
      value_json TEXT NOT NULL CHECK(json_valid(value_json)),
      revision INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, namespace)
    );

    CREATE TABLE IF NOT EXISTS auth_identities (
      provider TEXT NOT NULL,
      provider_subject TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email TEXT,
      email_verified INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, provider_subject)
    );

    CREATE INDEX IF NOT EXISTS auth_identities_user_id ON auth_identities(user_id);

    CREATE TABLE IF NOT EXISTS email_verifications (
      email_key TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS email_verifications_expires_at ON email_verifications(expires_at);

    CREATE TABLE IF NOT EXISTS oauth_flows (
      state_hash TEXT PRIMARY KEY,
      binding_hash TEXT NOT NULL,
      provider TEXT NOT NULL,
      code_verifier TEXT,
      initiating_session_hash TEXT,
      redirect_uri TEXT NOT NULL,
      next_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS oauth_flows_expires_at ON oauth_flows(expires_at);

    CREATE TABLE IF NOT EXISTS device_flows (
      device_hash TEXT PRIMARY KEY,
      user_code TEXT NOT NULL UNIQUE,
      challenge TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS app_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const userColumns = db.prepare('PRAGMA table_info(users)').all().map(row => row.name);
  if (!userColumns.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map(row => row.name);
  if (!sessionColumns.includes('allow_legacy_import')) {
    db.exec('ALTER TABLE sessions ADD COLUMN allow_legacy_import INTEGER NOT NULL DEFAULT 0');
  }
  if (!sessionColumns.includes('authenticated_at')) {
    db.exec('ALTER TABLE sessions ADD COLUMN authenticated_at INTEGER NOT NULL DEFAULT 0');
  }
  const oauthFlowColumns = db.prepare('PRAGMA table_info(oauth_flows)').all().map(row => row.name);
  if (!oauthFlowColumns.includes('redirect_uri')) {
    db.exec("ALTER TABLE oauth_flows ADD COLUMN redirect_uri TEXT NOT NULL DEFAULT ''");
  }
  if (!oauthFlowColumns.includes('initiating_session_hash')) {
    db.exec('ALTER TABLE oauth_flows ADD COLUMN initiating_session_hash TEXT');
  }
  if (!oauthFlowColumns.includes('purpose')) {
    db.exec("ALTER TABLE oauth_flows ADD COLUMN purpose TEXT NOT NULL DEFAULT 'login'");
  }
  if (!oauthFlowColumns.includes('expected_subject')) {
    db.exec("ALTER TABLE oauth_flows ADD COLUMN expected_subject TEXT NOT NULL DEFAULT ''");
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS auth_identity_per_user ON auth_identities(user_id, provider)');
  db.exec(`
    INSERT OR IGNORE INTO password_credentials (user_id, password_hash, created_at, updated_at)
    SELECT id, password_hash, created_at, created_at FROM users
    WHERE password_hash LIKE 'scrypt$%'
  `);

  try { fs.chmodSync(databasePath, 0o600); } catch {}

  const statements = {
    createUser: db.prepare('INSERT INTO users (username, username_key, password_hash, created_at) VALUES (?, ?, ?, ?)'),
    passwordInsert: db.prepare('INSERT INTO password_credentials (user_id, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)'),
    userByKey: db.prepare(`
      SELECT u.id, u.username, u.role, p.password_hash, u.created_at
      FROM users u LEFT JOIN password_credentials p ON p.user_id = u.id
      WHERE u.username_key = ?
    `),
    userById: db.prepare('SELECT id, username, role, created_at FROM users WHERE id = ?'),
    listUsers: db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id'),
    setUserRole: db.prepare('UPDATE users SET role = ? WHERE id = ?'),
    setUserPassword: db.prepare('UPDATE password_credentials SET password_hash = ?, updated_at = ? WHERE user_id = ?'),
    setUserPasswordLegacy: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    metaGet: db.prepare('SELECT value FROM app_meta WHERE key = ?'),
    metaSet: db.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
    identityBySubject: db.prepare(`
      SELECT i.provider, i.provider_subject, i.email, i.email_verified, i.display_name,
             u.id AS user_id, u.username
      FROM auth_identities i JOIN users u ON u.id = i.user_id
      WHERE i.provider = ? AND i.provider_subject = ?
    `),
    identityInsert: db.prepare(`
      INSERT INTO auth_identities
        (provider, provider_subject, user_id, email, email_verified, display_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    emailVerificationByEmail: db.prepare(`
      SELECT email_key, code_hash, attempts, created_at, expires_at
      FROM email_verifications WHERE email_key = ?
    `),
    emailVerificationUpsert: db.prepare(`
      INSERT INTO email_verifications
        (email_key, code_hash, attempts, created_at, expires_at)
      VALUES (?, ?, 0, ?, ?)
      ON CONFLICT(email_key) DO UPDATE SET
        code_hash = excluded.code_hash,
        attempts = 0,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `),
    emailVerificationIncrement: db.prepare(`
      UPDATE email_verifications SET attempts = attempts + 1 WHERE email_key = ?
    `),
    emailVerificationDelete: db.prepare('DELETE FROM email_verifications WHERE email_key = ?'),
    emailVerificationDeleteClaim: db.prepare('DELETE FROM email_verifications WHERE email_key = ? AND code_hash = ?'),
    emailVerificationsDeleteExpired: db.prepare('DELETE FROM email_verifications WHERE expires_at <= ?'),
    oauthFlowInsert: db.prepare(`
      INSERT INTO oauth_flows
        (state_hash, binding_hash, provider, code_verifier, initiating_session_hash, redirect_uri, next_path, created_at, expires_at, purpose, expected_subject)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    oauthFlowByState: db.prepare(`
      SELECT state_hash, binding_hash, provider, code_verifier, initiating_session_hash, redirect_uri, next_path, expires_at, purpose, expected_subject
      FROM oauth_flows WHERE state_hash = ?
    `),
    oauthFlowDelete: db.prepare('DELETE FROM oauth_flows WHERE state_hash = ?'),
    oauthFlowsDeleteExpired: db.prepare('DELETE FROM oauth_flows WHERE expires_at <= ?'),
    sessionInsert: db.prepare('INSERT INTO sessions (token_hash, user_id, csrf_token, allow_legacy_import, created_at, expires_at, authenticated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    sessionByHash: db.prepare(`
      SELECT s.token_hash, s.csrf_token, s.allow_legacy_import, s.expires_at, s.authenticated_at, u.id AS user_id, u.username
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
    `),
    sessionDelete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
    sessionsDeleteExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
    stateAll: db.prepare('SELECT namespace, value_json, revision, updated_at FROM user_state WHERE user_id = ?'),
    stateOne: db.prepare('SELECT value_json, revision, updated_at FROM user_state WHERE user_id = ? AND namespace = ?'),
    stateInsert: db.prepare('INSERT INTO user_state (user_id, namespace, value_json, revision, updated_at) VALUES (?, ?, ?, 1, ?)'),
    stateUpdate: db.prepare('UPDATE user_state SET value_json = ?, revision = ?, updated_at = ? WHERE user_id = ? AND namespace = ?'),
    metaGet: db.prepare('SELECT value FROM app_meta WHERE key = ?'),
    metaInsert: db.prepare('INSERT OR IGNORE INTO app_meta (key, value) VALUES (?, ?)'),
    metaSet: db.prepare('INSERT OR REPLACE INTO app_meta (key, value) VALUES (?, ?)'),
    metaDelete: db.prepare('DELETE FROM app_meta WHERE key = ?'),
    stateReplace: db.prepare('INSERT OR REPLACE INTO user_state (user_id, namespace, value_json, revision, updated_at) VALUES (?, ?, ?, ?, ?)'),
  };

  function assertNamespace(namespace) {
    if (!STATE_NAMESPACES.has(namespace)) {
      const error = new Error('unknown state namespace');
      error.code = 'INVALID_NAMESPACE';
      throw error;
    }
  }

  function createUser(username, usernameKey, passwordHash) {
    const now = Date.now();
    db.exec('BEGIN IMMEDIATE');
    try {
      // Keep the legacy users.password_hash copy during the compatibility
      // migration, while password_credentials is the authoritative capability.
      const info = statements.createUser.run(username, usernameKey, passwordHash, now);
      const userId = Number(info.lastInsertRowid);
      statements.passwordInsert.run(userId, passwordHash, now, now);
      db.exec('COMMIT');
      return { id: userId, username };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function findUserByKey(usernameKey) {
    return statements.userByKey.get(usernameKey) || null;
  }

  function findUserById(id) {
    return statements.userById.get(Number(id)) || null;
  }

  function listUsers() {
    return statements.listUsers.all();
  }

  function setUserRole(id, role) {
    statements.setUserRole.run(String(role), Number(id));
    return findUserById(id);
  }

  /* 密码同时写 users 与 password_credentials:登录走后者(LEFT JOIN 优先),
   * 但旧数据/迁移路径仍可能读 users.password_hash,两处必须一致。 */
  function setUserPassword(id, passwordHash) {
    const now = Date.now();
    statements.setUserPassword.run(passwordHash, now, Number(id));
    statements.setUserPasswordLegacy.run(passwordHash, Number(id));
    return true;
  }

  function getMeta(key) {
    const row = statements.metaGet.get(String(key));
    return row ? row.value : null;
  }

  function setMeta(key, value) {
    statements.metaSet.run(String(key), String(value));
  }

  function cleanIdentityText(value, maxLength) {
    return String(value || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, maxLength);
  }

  function findOrCreateFederatedUser(provider, providerSubject, profile) {
    const normalizedProvider = cleanIdentityText(provider, 24).toLowerCase();
    const subject = cleanIdentityText(providerSubject, 255);
    if (!['google', 'wechat'].includes(normalizedProvider) || !subject) {
      throw new Error('invalid federated identity');
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = statements.identityBySubject.get(normalizedProvider, subject);
      if (existing) {
        db.exec('COMMIT');
        return {
          user: { id: Number(existing.user_id), username: existing.username },
          created: false,
        };
      }

      const fallback = normalizedProvider === 'wechat' ? '微信用户' : 'Google 用户';
      const base = cleanIdentityText(profile && profile.displayName, 28) || fallback;
      const username = base.slice(0, 32);
      // Provider-controlled display names must never reserve an email or
      // legacy username. Keep the login key in a separate internal namespace.
      // A detached identity may register again; the old user's login key must
      // not reserve that identity forever after a replacement or unlink.
      const usernameKey = `federated:${normalizedProvider}:${randomUUID()}`;

      const now = Date.now();
      // The legacy column remains NOT NULL for in-place migration, but the
      // absence of password_credentials is what makes this provider-only.
      const info = statements.createUser.run(username, usernameKey, '', now);
      const userId = Number(info.lastInsertRowid);
      const email = cleanIdentityText(profile && profile.email, 320) || null;
      const displayName = cleanIdentityText(profile && profile.displayName, 120) || null;
      statements.identityInsert.run(
        normalizedProvider, subject, userId, email,
        profile && profile.emailVerified ? 1 : 0,
        displayName, now, now,
      );
      db.exec('COMMIT');
      return { user: { id: userId, username }, created: true };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function accountCredentials(userId) {
    return {
      passwordHash: db.prepare('SELECT password_hash FROM password_credentials WHERE user_id = ?').get(userId)?.password_hash || '',
      identities: db.prepare('SELECT provider, provider_subject, email, display_name FROM auth_identities WHERE user_id = ? ORDER BY provider').all(userId),
    };
  }

  function identityError(code) {
    const error = new Error(code);
    error.code = code;
    error.status = 409;
    return error;
  }

  function bindIdentity(userId, provider, subject, profile, expectedSubject, sessionHash) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const credentials = accountCredentials(userId);
      const current = credentials.identities.find(row => row.provider === provider);
      if ((current?.provider_subject || '') !== expectedSubject) throw identityError('binding_changed');
      const owner = statements.identityBySubject.get(provider, subject);
      if (owner && Number(owner.user_id) !== userId) throw identityError('identity_in_use');
      db.prepare('DELETE FROM auth_identities WHERE user_id = ? AND provider = ?').run(userId, provider);
      const now = Date.now();
      statements.identityInsert.run(provider, subject, userId,
        cleanIdentityText(profile.email, 320) || null, profile.emailVerified ? 1 : 0,
        cleanIdentityText(profile.displayName, 120) || null, now, now);
      if (current && current.provider_subject !== subject) revokeOtherSessions(userId, sessionHash);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function unlinkIdentity(userId, provider, sessionHash, enabledProviders) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const credentials = accountCredentials(userId);
      if (!credentials.identities.some(row => row.provider === provider)) throw identityError('binding_changed');
      const hasAlternative = credentials.passwordHash || credentials.identities.some(row => row.provider !== provider && enabledProviders.includes(row.provider));
      if (!hasAlternative) throw identityError('last_login_method');
      db.prepare('DELETE FROM auth_identities WHERE user_id = ? AND provider = ?').run(userId, provider);
      revokeOtherSessions(userId, sessionHash);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function revokeOtherSessions(userId, keepHash) {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, keepHash);
  }

  function markSessionAuthenticated(sessionHash) {
    db.prepare('UPDATE sessions SET authenticated_at = ? WHERE token_hash = ?').run(Date.now(), sessionHash);
  }

  function createDeviceFlow(deviceHash, userCode, challenge, expiresAt) {
    db.prepare('DELETE FROM device_flows WHERE expires_at <= ?').run(Date.now());
    db.prepare('INSERT INTO device_flows (device_hash, user_code, challenge, expires_at) VALUES (?, ?, ?, ?)').run(deviceHash, userCode, challenge, expiresAt);
  }

  function approveDeviceFlow(userCode, userId) {
    return db.prepare('UPDATE device_flows SET user_id = ? WHERE user_code = ? AND user_id IS NULL AND expires_at > ?').run(userId, userCode, Date.now()).changes === 1;
  }

  function consumeDeviceFlow(deviceHash, challenge) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare('SELECT * FROM device_flows WHERE device_hash = ? AND challenge = ? AND expires_at > ?').get(deviceHash, challenge, Date.now());
      if (row?.user_id) db.prepare('DELETE FROM device_flows WHERE device_hash = ?').run(deviceHash);
      db.exec('COMMIT');
      return row ? { userId: row.user_id ? Number(row.user_id) : null } : null;
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  function claimEmailVerification(emailKey, codeHash, expiresAt, cooldownMs) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const row = statements.emailVerificationByEmail.get(emailKey);
      const active = row && Number(row.expires_at) > now;
      // Five wrong guesses lock this email until the code expires. Keep the
      // row as a tombstone so requesting a new code cannot reset the counter.
      const cooldown = active && Number(row.attempts) >= 5
        ? Number(row.expires_at) - now
        : active
          ? Math.max(0, Number(cooldownMs) - (now - Number(row.created_at)))
          : 0;
      if (cooldown > 0) {
        db.exec('COMMIT');
        return { claimed: false, retryAfterMs: cooldown };
      }
      statements.emailVerificationUpsert.run(emailKey, codeHash, now, expiresAt);
      db.exec('COMMIT');
      return { claimed: true, retryAfterMs: 0 };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function releaseEmailVerification(emailKey, codeHash) {
    statements.emailVerificationDeleteClaim.run(emailKey, codeHash);
  }

  function consumeEmailVerification(emailKey, codeHash) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = statements.emailVerificationByEmail.get(emailKey);
      if (!row || Number(row.expires_at) <= Date.now()) {
        if (row) statements.emailVerificationDelete.run(emailKey);
        db.exec('COMMIT');
        return false;
      }
      if (Number(row.attempts) >= 5) {
        db.exec('COMMIT');
        return false;
      }
      if (row.code_hash !== codeHash) {
        statements.emailVerificationIncrement.run(emailKey);
        db.exec('COMMIT');
        return false;
      }
      statements.emailVerificationDelete.run(emailKey);
      db.exec('COMMIT');
      return true;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function deleteExpiredEmailVerifications() {
    statements.emailVerificationsDeleteExpired.run(Date.now());
  }

  function createOAuthFlow(stateHash, bindingHash, provider, codeVerifier, initiatingSessionHash, redirectUri, nextPath, expiresAt, purpose = 'login', expectedSubject = '') {
    const now = Date.now();
    statements.oauthFlowInsert.run(
      stateHash, bindingHash, provider, codeVerifier || null, initiatingSessionHash || null,
      redirectUri, nextPath, now, expiresAt, purpose, expectedSubject,
    );
  }

  function consumeOAuthFlow(stateHash, bindingHash, provider) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = statements.oauthFlowByState.get(stateHash);
      const matches = row && row.binding_hash === bindingHash && row.provider === provider;
      if (row && (matches || Number(row.expires_at) <= Date.now())) {
        statements.oauthFlowDelete.run(stateHash);
      }
      db.exec('COMMIT');
      if (!matches || Number(row.expires_at) <= Date.now()) return null;
      return {
        provider: row.provider,
        codeVerifier: row.code_verifier || '',
        initiatingSessionHash: row.initiating_session_hash || '',
        redirectUri: row.redirect_uri,
        nextPath: row.next_path,
        purpose: row.purpose,
        expectedSubject: row.expected_subject,
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function deleteExpiredOAuthFlows() {
    statements.oauthFlowsDeleteExpired.run(Date.now());
  }

  function createSession(tokenHash, userId, csrfToken, expiresAt, allowLegacyImport) {
    const now = Date.now();
    statements.sessionInsert.run(tokenHash, userId, csrfToken, allowLegacyImport ? 1 : 0, now, expiresAt, now);
  }

  function findSession(tokenHash) {
    const row = statements.sessionByHash.get(tokenHash);
    if (!row) return null;
    if (Number(row.expires_at) <= Date.now()) {
      statements.sessionDelete.run(tokenHash);
      return null;
    }
    return {
      tokenHash: row.token_hash,
      csrfToken: row.csrf_token,
      allowLegacyImport: Boolean(row.allow_legacy_import),
      expiresAt: Number(row.expires_at),
      authenticatedAt: Number(row.authenticated_at),
      user: { id: Number(row.user_id), username: row.username },
    };
  }

  function deleteSession(tokenHash) {
    statements.sessionDelete.run(tokenHash);
  }

  function deleteExpiredSessions() {
    statements.sessionsDeleteExpired.run(Date.now());
  }

  function getState(userId) {
    reviewPolicyStore.reconcile(db, userId);
    const state = {};
    const revisions = {};
    const updatedAt = {};
    for (const row of statements.stateAll.all(userId)) {
      if (!STATE_NAMESPACES.has(row.namespace)) continue;
      try {
        state[row.namespace] = JSON.parse(row.value_json);
        revisions[row.namespace] = Number(row.revision);
        updatedAt[row.namespace] = Number(row.updated_at);
      } catch {}
    }
    return { state, revisions, updatedAt };
  }

  function putState(userId, namespace, value, expectedRevision, queueForUpstream = false) {
    assertNamespace(namespace);
    let serialized = JSON.stringify(value);
    if (serialized === undefined) {
      const error = new Error('state value must be JSON serializable');
      error.code = 'INVALID_STATE';
      throw error;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      const current = statements.stateOne.get(userId, namespace);
      const currentRevision = current ? Number(current.revision) : 0;
      if (namespace === 'learningActivity') {
        value = learningActivity.merge(current ? JSON.parse(current.value_json) : null, value);
        serialized = JSON.stringify(value);
      } else if (currentRevision !== expectedRevision) {
        db.exec('ROLLBACK');
        return {
          conflict: true,
          revision: currentRevision,
          value: current ? JSON.parse(current.value_json) : null,
        };
      }

      const now = Date.now();
      const revision = currentRevision + 1;
      if (current) statements.stateUpdate.run(serialized, revision, now, userId, namespace);
      else statements.stateInsert.run(userId, namespace, serialized, now);
      if (queueForUpstream) {
        const queue = JSON.parse(metaGet('upstream_queue') || '{}');
        queue[namespace] = { value, baseRevision: queue[namespace] ? queue[namespace].baseRevision : expectedRevision };
        metaSet('upstream_queue', JSON.stringify(queue));
      }
      db.exec('COMMIT');
      return { conflict: false, revision, updatedAt: now, ...(namespace === 'learningActivity' ? { value } : {}) };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function reconcileReviews() {
    for (const row of db.prepare("SELECT user_id FROM user_state WHERE namespace='review'").all()) reviewPolicyStore.reconcile(db, row.user_id);
  }

  function claimCompanionOwner(userId) {
    const key = 'companion_owner_user_id';
    statements.metaInsert.run(key, String(userId));
    const row = statements.metaGet.get(key);
    return Boolean(row && row.value === String(userId));
  }

  // 主账号镜像(卫星模式)使用的通用元数据读写。
  function metaGet(key) {
    const row = statements.metaGet.get(key);
    return row ? row.value : null;
  }
  function metaSet(key, value) { statements.metaSet.run(key, String(value)); }
  function metaDelete(key) { statements.metaDelete.run(key); }

  // 镜像写入:以上游 revision 为准整体覆盖,不走 optimistic concurrency。
  function replaceState(userId, namespace, value, revision) {
    assertNamespace(namespace);
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('state value must be JSON serializable');
    statements.stateReplace.run(userId, namespace, serialized, Math.max(0, Number(revision) || 0), Date.now());
  }

  // The companion is another SQLite writer. Queue checks and acknowledgement
  // must share a transaction with state writes so native answers cannot vanish
  // between a cloud response and a local cache replacement.
  function settleQueuedState(userId, namespace, sent, result) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const queue = JSON.parse(metaGet('upstream_queue') || '{}');
      if (namespace === 'learningActivity') {
        const current = statements.stateOne.get(userId, namespace);
        const received = result.value || sent.value;
        const merged = learningActivity.merge(received, queue[namespace]?.value || (current && JSON.parse(current.value_json)));
        replaceState(userId, namespace, merged, result.revision);
        if (result.conflict || JSON.stringify(merged) !== JSON.stringify(received)) queue[namespace] = { value: merged, baseRevision: result.revision };
        else delete queue[namespace];
      } else if (result.conflict) {
        if (queue[namespace]) metaSet('upstream_conflict:' + namespace, JSON.stringify({ ...queue[namespace], savedAt: Date.now() }));
        replaceState(userId, namespace, result.value, result.revision);
        delete queue[namespace];
      } else if (JSON.stringify(queue[namespace]) === JSON.stringify(sent)) {
        replaceState(userId, namespace, sent.value, result.revision);
        delete queue[namespace];
      } else if (queue[namespace]) queue[namespace].baseRevision = result.revision;
      if (Object.keys(queue).length) metaSet('upstream_queue', JSON.stringify(queue));
      else metaDelete('upstream_queue');
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  function replaceUnqueuedState(userId, namespace, value, revision) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const queue = JSON.parse(metaGet('upstream_queue') || '{}');
      const current = statements.stateOne.get(userId, namespace);
      if (!queue[namespace] && (!current || Number(current.revision) <= revision)) replaceState(userId, namespace, value, revision);
      db.exec('COMMIT');
    } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  }

  // 断开主账号时用:整棵删除本机影子账号及其全部数据(上游不受影响)。
  function deleteUser(userId) {
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  }

  function companionAvailableForUser(userId) {
    const row = statements.metaGet.get('companion_owner_user_id');
    return !row || row.value === String(userId);
  }

  function close() {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    db.close();
  }

  return {
    databasePath,
    reconcileReviews,
    createUser,
    findUserByKey,
    findUserById,
    listUsers,
    setUserRole,
    setUserPassword,
    getMeta,
    setMeta,
    findOrCreateFederatedUser,
    accountCredentials,
    bindIdentity,
    unlinkIdentity,
    markSessionAuthenticated,
    createDeviceFlow,
    approveDeviceFlow,
    consumeDeviceFlow,
    claimEmailVerification,
    releaseEmailVerification,
    consumeEmailVerification,
    deleteExpiredEmailVerifications,
    createOAuthFlow,
    consumeOAuthFlow,
    deleteExpiredOAuthFlows,
    createSession,
    findSession,
    deleteSession,
    deleteExpiredSessions,
    getState,
    putState,
    replaceState,
    replaceUnqueuedState,
    settleQueuedState,
    deleteUser,
    metaGet,
    metaSet,
    metaDelete,
    claimCompanionOwner,
    companionAvailableForUser,
    close,
  };
}

module.exports = { openStorage, STATE_NAMESPACES };
