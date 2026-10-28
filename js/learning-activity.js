/* Shared by the browser and companion: one completed action = one practice.
 * Event IDs survive replay; cancellation is a tombstone so a stale device
 * cannot restore an undone answer. Keep the most recent 90 calendar days. */
(function (root) {
  'use strict';
  function dayKey(at) {
    const d = new Date(at == null ? Date.now() : at);
    if (!Number.isFinite(d.getTime())) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function merge(a, b, now) {
    const cutoff = new Date(now == null ? Date.now() : now);
    const tomorrow = new Date(cutoff); tomorrow.setDate(tomorrow.getDate() + 1);
    cutoff.setDate(cutoff.getDate() - 89);
    // A cloud server can still be on yesterday in the learner's time zone.
    const first = dayKey(cutoff), last = dayKey(tomorrow), days = {};
    for (const source of [a, b]) {
      for (const [day, events] of Object.entries(source?.days || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day < first || day > last) continue;
        for (const [id, event] of Object.entries(events || {})) {
          if (!id || id.length > 600 || !['learn', 'quiz', 'review', 'sentence'].includes(event?.kind)) continue;
          const bucket = days[day] || (days[day] = Object.create(null));
          const previous = bucket[id] || {};
          bucket[id] = { ...previous, kind: event.kind, ...(event.canceled || previous.canceled ? { canceled: true } : {}) };
          if (Number(event.at) > 0) bucket[id].at = Number(event.at);
          if (typeof event.library === 'string') bucket[id].library = event.library;
          if (event.word && typeof event.word.word === 'string') bucket[id].word = { word: event.word.word, meaning: String(event.word.meaning || '') };
          if (event.nextDue === null || Number(event.nextDue) > 0) bucket[id].nextDue = event.nextDue === null ? null : Number(event.nextDue);
        }
      }
    }
    const sorted = {};
    for (const day of Object.keys(days).sort()) {
      sorted[day] = Object.fromEntries(Object.entries(days[day]).sort(([a], [b]) => a.localeCompare(b)));
    }
    return { days: sorted };
  }
  function eventId(event, stream) {
    if (event.activityId) return String(event.activityId);
    if (stream && Number.isSafeInteger(Number(event.id)) && Number(event.id) > 0) return 'pet:' + stream + ':' + event.id;
    return JSON.stringify([stream || 'legacy', event.id || '', event.action || 'learn', event.library,
      event.word?.word, event.word?.meaning || '', Number(event.at)]);
  }
  function record(activity, event, stream, now) {
    const kind = event?.action, at = Number(event?.at);
    if (!['learn', 'quiz', 'review', 'sentence'].includes(kind) || !Number.isFinite(at) || at <= 0) return merge(activity, null, now);
    return merge(activity, { days: { [dayKey(at)]: { [eventId(event, stream)]: { kind, at, library: event.library, word: event.word,
      nextDue: event.nextDue, ...(event.canceled ? { canceled: true } : {}) } } } }, now);
  }
  function wordsForDay(activity, day) {
    const words = new Map();
    for (const event of Object.values(activity?.days?.[day] || {})) {
      if (event.canceled || !event.word?.word || !event.library) continue;
      const key = JSON.stringify([event.library, event.word.word, event.word.meaning]);
      const row = words.get(key) || { library: event.library, word: event.word, recite: 0, sentence: 0, lastAt: 0 };
      if (event.kind === 'sentence') row.sentence++; else row.recite++;
      if (Number(event.at) >= row.lastAt) { row.lastAt = Number(event.at); if ('nextDue' in event) row.nextDue = event.nextDue; }
      words.set(key, row);
    }
    return [...words.values()].sort((a, b) => b.lastAt - a.lastAt || a.word.word.localeCompare(b.word.word));
  }
  function totals(activity, day, legacyLearned) {
    const counts = { recite: Math.max(0, Math.floor(Number(legacyLearned) || 0)), sentence: 0, review: 0, total: 0 };
    for (const event of Object.values(activity?.days?.[day] || {})) {
      if (event.canceled) continue;
      if (event.kind === 'sentence') counts.sentence++;
      else { counts.recite++; if (event.kind === 'review') counts.review++; }
    }
    counts.total = counts.recite + counts.sentence;
    return counts;
  }
  function plan(value) {
    const p = value && typeof value === 'object' ? value : {};
    return Object.assign({}, p, {
      dailyGoal: Math.max(1, Math.min(1000, Math.floor(Number(p.dailyGoal) || 10))),
      metric: ['total', 'recite', 'sentence'].includes(p.metric) ? p.metric : 'total',
      learnedByDay: p.learnedByDay || {}, checkins: p.checkins || {},
    });
  }
  const api = { dayKey, merge, record, eventId, totals, plan, wordsForDay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LearningActivity = api;
})(typeof window !== 'undefined' ? window : globalThis);
