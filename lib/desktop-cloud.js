'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const SUSPENDED = 'desktop_suspended_pairing';
const SUSPENDED_QUEUE = 'desktop_suspended_queue';
const PAUSED_SESSION = 'desktop_paused_session:';

function openDesktopCloud(db, dataDir, officialOrigin) {
  const get = key => db.prepare('SELECT value FROM app_meta WHERE key=?').get(key)?.value;
  const put = (key, value) => db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?)').run(key, value);
  const remove = key => db.prepare('DELETE FROM app_meta WHERE key=?').run(key);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  // Nothing may start pulling, pushing or resuming a former LAN pairing on
  // upgrade. Move it intact out of the active slots until the owner decides.
  transaction(() => {
    const raw = get('upstream_pairing');
    if (!raw) return;
    const pair = JSON.parse(raw);
    if (URL.parse(pair.url)?.origin === officialOrigin) return;
    const queue = get('upstream_queue') || '{}';
    const pending = Object.keys(JSON.parse(queue)).length;
    put(SUSPENDED, JSON.stringify({ pair, pending, recoveryId: randomUUID() }));
    put(SUSPENDED_QUEUE, queue);
    put('desktop_inactive_mirror:' + pair.localUserId, '1');
    // Old local sessions were dormant while the legacy mirror was selected.
    // Suspending that mirror must not revive them or bypass the login screen.
    db.prepare("INSERT INTO app_meta(key,value) SELECT ? || token_hash,'1' FROM sessions WHERE expires_at>?")
      .run(PAUSED_SESSION, Date.now());
    remove('upstream_queue');
    remove('upstream_pairing');
  });

  function legacyConnection() {
    const raw = get(SUSPENDED);
    if (!raw) return null;
    const { pair, pending } = JSON.parse(raw);
    return { username: pair.user.username, pending };
  }

  function disconnectLegacy() {
    return transaction(() => {
      const raw = get(SUSPENDED);
      if (!raw) return null; // Idempotent after a lost HTTP reply.
      const { pair, recoveryId } = JSON.parse(raw);
      const state = {}, revisions = {};
      const rows = db.prepare('SELECT namespace, value_json, revision FROM user_state WHERE user_id=?').all(pair.localUserId);
      for (const row of rows) {
        state[row.namespace] = JSON.parse(row.value_json);
        revisions[row.namespace] = Number(row.revision);
      }
      const recovery = {
        version: 1, savedAt: new Date().toISOString(), server: pair.url,
        account: { username: pair.user.username, localUserId: pair.localUserId, upstreamUserId: pair.user.id },
        state, revisions, pending: JSON.parse(get(SUSPENDED_QUEUE) || '{}'),
      };
      const folder = path.join(dataDir, 'recovery');
      const name = 'legacy-sync-' + recoveryId + '.json';
      const target = path.join(folder, name), temp = target + '.' + randomUUID() + '.tmp';
      try {
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        fs.writeFileSync(temp, JSON.stringify(recovery), { mode: 0o600, flag: 'wx', flush: true });
        fs.renameSync(temp, target);
        const fd = fs.openSync(folder, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch (error) {
        try { fs.rmSync(temp, { force: true }); } catch {}
        throw Object.assign(new Error('未能保存本机恢复副本。请检查可用空间与写入权限后重试。', { cause: error }), { status: 503 });
      }
      // Keep the shadow user, all state rows, conflict copies and device data.
      // Only its old authentication and active/suspended connection go away.
      db.prepare('DELETE FROM sessions WHERE user_id=? OR EXISTS (SELECT 1 FROM app_meta WHERE key=? || sessions.token_hash)')
        .run(pair.localUserId, PAUSED_SESSION);
      db.prepare('DELETE FROM app_meta WHERE substr(key,1,?)=?').run(PAUSED_SESSION.length, PAUSED_SESSION);
      remove(SUSPENDED_QUEUE);
      remove(SUSPENDED);
      // Some early versions reused a real local user for the mirror. That
      // user may sign in again with its own credentials after disconnection.
      if (!db.prepare("SELECT 1 FROM users WHERE id=? AND password_hash LIKE 'mirror$%'").get(pair.localUserId)) {
        remove('desktop_inactive_mirror:' + pair.localUserId);
      }
      return name;
    });
  }

  const hasLocal = db.prepare(`SELECT 1 AS available FROM users u
    WHERE u.password_hash NOT LIKE 'mirror$%' AND
      (EXISTS(SELECT 1 FROM password_credentials p WHERE p.user_id=u.id AND p.password_hash LIKE 'scrypt$%')
      OR EXISTS(SELECT 1 FROM auth_identities i WHERE i.user_id=u.id AND i.provider='google-desktop')) LIMIT 1`);
  const inactive = db.prepare(`SELECT 1 FROM users WHERE id=? AND (password_hash LIKE 'mirror$%'
    OR EXISTS (SELECT 1 FROM app_meta WHERE key='desktop_inactive_mirror:' || users.id))`);
  return {
    officialOrigin, legacyConnection, disconnectLegacy, hasLocalAccount: () => Boolean(hasLocal.get()),
    inactiveAccount: id => Boolean(inactive.get(id)), pausedSession: hash => Boolean(get(PAUSED_SESSION + hash)),
  };
}

module.exports = { openDesktopCloud };
