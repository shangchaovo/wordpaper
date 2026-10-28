'use strict';
const policy = require('../js/srs-policy');

// The server and companion share this transaction. Polling or concurrent
// readers cannot demote the same missed review twice, or overwrite an answer.
function reconcile(db, userId, now = Date.now()) {
  db.exec('SAVEPOINT review_policy');
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
        queue.review = { value: all, baseRevision: queue.review ? queue.review.baseRevision : Number(row.revision) };
        db.prepare("INSERT OR REPLACE INTO app_meta(key,value) VALUES('upstream_queue',?)").run(JSON.stringify(queue));
      }
    }
    db.exec('RELEASE review_policy');
    return { all, changes };
  } catch (error) {
    try { db.exec('ROLLBACK TO review_policy; RELEASE review_policy'); } catch {}
    throw error;
  }
}
module.exports = { reconcile };
