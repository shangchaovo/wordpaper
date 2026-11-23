'use strict';
const policy = require('../js/srs-policy');

// The server and companion share this transaction. Polling or concurrent
// readers cannot demote the same missed review twice, or overwrite an answer.
function reconcile(db, userId, now = Date.now()) {
  // Older SQLite wrappers expose only exec/prepare. A savepoint works both
  // inside their caller's transaction and as their outermost transaction.
  const useSavepoint = db.isTransaction !== false;
  if (useSavepoint) db.exec('SAVEPOINT review_policy');
  else if (db.beginUserState) db.beginUserState(userId);
  else db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare("SELECT value_json, revision FROM user_state WHERE user_id=? AND namespace='review'").get(userId);
    const value = row ? JSON.parse(row.value_json) : null;
    const all = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const changes = policy.apply(all, now);
    if (changes.length) {
      db.prepare("UPDATE user_state SET value_json=?, revision=revision+1, updated_at=? WHERE user_id=? AND namespace='review'")
        .run(JSON.stringify(all), now, userId);
      const paired = db.prepare("SELECT value FROM app_meta WHERE key='upstream_pairing'").get();
      if (paired && Number(JSON.parse(paired.value).localUserId) === Number(userId)) {
        const queued = db.prepare("SELECT value FROM app_meta WHERE key='upstream_queue'").get();
        const queue = queued ? JSON.parse(queued.value) : {};
        const entry = queue.review || { baseRevision: Number(row.revision), baseValue: JSON.parse(row.value_json) };
        queue.review = { ...entry, value: all };
        db.prepare("INSERT INTO app_meta(key,value) VALUES('upstream_queue',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(queue));
      }
    }
    db.exec(useSavepoint ? 'RELEASE review_policy' : 'COMMIT');
    return { all, changes };
  } catch (error) {
    try {
      db.exec(useSavepoint ? 'ROLLBACK TO review_policy; RELEASE review_policy' : 'ROLLBACK');
    } catch {}
    throw error;
  }
}
module.exports = { reconcile };
