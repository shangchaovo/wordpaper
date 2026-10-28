/* Shared overdue policy. See docs/REVIEW-POLICY.md for the model and limits.
 * Thresholds are product choices, not measurements of individual recall. */
(function (root) {
  'use strict';
  const INTERVALS_MIN = [20, 60, 540, 1440, 2880, 4320, 8640, 17280];
  const VERSION = 1, DUE_RECALL = 0.9, DEMOTE_RECALL = 0.85;
  const GRACE_RATIO = Math.log(DEMOTE_RECALL) / Math.log(DUE_RECALL) - 1;
  function intervalMs(item) {
    const nominal = INTERVALS_MIN[Math.max(0, Math.min(7, Number(item.stage) || 0))] * 60000;
    if (Number(item.scheduledIntervalMs) > 0) return Number(item.scheduledIntervalMs);
    const start = Number(item.lastSeenAt || item.learnedAt);
    const elapsed = Number(item.due) - start;
    return start > 0 && elapsed > 0 && elapsed <= nominal ? elapsed : nominal;
  }
  function graceMs(interval) { return Math.max(1, Math.ceil(interval / 60000 * GRACE_RATIO)) * 60000; }
  function status(item, now = Date.now()) {
    if (!item || Number(item.stage) >= INTERVALS_MIN.length || !(Number(item.due) > 0)) return null;
    const due = Number(item.due), prior = item.overdue;
    if (prior?.version === VERSION && prior.due === due && prior.toStage === Number(item.stage)) return { ...prior, demoted: prior.fromStage > prior.toStage, remaining: 0, handled: true };
    const interval = intervalMs(item), grace = graceMs(interval), deadline = due + grace;
    return { version: VERSION, due, interval, grace, deadline, fromStage: Number(item.stage) || 0,
      toStage: Math.max(0, (Number(item.stage) || 0) - 1), remaining: Math.max(0, deadline - now),
      warning: now >= due, urgent: now >= deadline - Math.min(86400000, Math.max(120000, grace / 4)),
      expired: now >= deadline, handled: false, demoted: false };
  }
  function applyItem(item, now = Date.now()) {
    const info = status(item, now);
    if (!info || info.handled || !info.expired) return null;
    item.stage = info.toStage;
    item.overdue = { version: VERSION, due: info.due, interval: info.interval, grace: info.grace,
      deadline: info.deadline, fromStage: info.fromStage, toStage: info.toStage, appliedAt: now };
    // Due stays in the past: a missed review is still actionable immediately.
    // One schedule gets one demotion, even after months offline or a restart.
    if (info.fromStage > info.toStage) {
      delete item.lastUndo;
      item.events = (Array.isArray(item.events) ? item.events : []).concat({ at: now, type: 'overdue-demotion',
        fromStage: info.fromStage, toStage: info.toStage, due: info.due, deadline: info.deadline, policyVersion: VERSION }).slice(-64);
    }
    return { ...item.overdue, word: item.word, demoted: info.fromStage > info.toStage };
  }
  function apply(all, now = Date.now()) {
    const changes = [];
    for (const [library, bucket] of Object.entries(all || {})) {
      if (!bucket || typeof bucket !== 'object' || Array.isArray(bucket)) continue;
      // Very old versions stored whole groups. Materialize the same per-word
      // records as Review.getLib before evaluating their original due times.
      for (const group of Object.values(bucket.groups || {})) {
        if (!Array.isArray(group?.words)) continue;
        for (const word of group.words) {
          if (!word || !word.word) continue;
          const key = String(word.word) + '|' + String(word.meaning || '');
          if (!bucket.words) bucket.words = {};
          if (bucket.words[key]) continue;
          const stage = Number(group.stage) || 0;
          bucket.words[key] = { word, learnedAt: group.learnedAt || now, stage, due: group.due || null,
            learnedCount: group.learnedCount || 1, reviewCount: Math.max(0, stage), successCount: Math.max(0, stage), failCount: 0,
            events: (Array.isArray(group.learnedLog) ? group.learnedLog : []).map(at => ({ at, type: 'legacy' })) };
          changes.push({ library, key, migrated: true });
        }
      }
      for (const [key, item] of Object.entries(bucket?.words || {})) {
        const change = applyItem(item, now);
        if (change) changes.push({ ...change, library, key });
      }
    }
    return changes;
  }
  function scheduled(item, now, minutes) {
    delete item.overdue;
    delete item.lastUndo;
    item.scheduledAt = now;
    item.scheduledIntervalMs = minutes == null ? null : minutes * 60000;
    item.due = minutes == null ? null : now + item.scheduledIntervalMs;
  }
  function duration(ms) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
    return [days ? days + ' 天' : '', hours ? hours + ' 小时' : '', !days && rest ? rest + ' 分钟' : ''].filter(Boolean).join(' ');
  }
  const api = { VERSION, INTERVALS_MIN, DUE_RECALL, DEMOTE_RECALL, GRACE_RATIO, graceMs, intervalMs, status, applyItem, apply, scheduled, duration };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SrsPolicy = api;
})(typeof window !== 'undefined' ? window : globalThis);
