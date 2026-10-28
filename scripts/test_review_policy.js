#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { openStorage } = require('../lib/storage');
const policy = require('../js/srs-policy'), activity = require('../js/learning-activity');
const { reconcile } = require('../lib/review-policy-store');
const now = Date.now(), word = { word: 'remember', meaning: '记得' }, key = 'remember|记得';
const clone = value => JSON.parse(JSON.stringify(value));
function record(stage, due = now) { return { word, stage, due, learnedAt: due ? due - policy.INTERVALS_MIN[stage] * 60000 : now - 100000000, reviewCount: 5, failCount: 1, events: [] }; }

assert.deepEqual(policy.INTERVALS_MIN.map(i => policy.graceMs(i * 60000) / 60000), [11, 33, 293, 782, 1563, 2344, 4688, 9375]);
for (let stage = 0; stage < 8; stage++) {
  const item = record(stage), deadline = now + policy.graceMs(policy.INTERVALS_MIN[stage] * 60000);
  assert.equal(policy.applyItem(item, deadline - 1), null, 'no early demotion');
  assert.ok(policy.applyItem(item, deadline));
  assert.equal(item.stage, Math.max(0, stage - 1));
  assert.equal(item.due, now, 'overdue work remains due now');
  assert.equal(item.failCount, 1); assert.equal(item.reviewCount, 5);
  const snapshot = clone(item);
  assert.equal(policy.applyItem(item, deadline + 365 * 86400000), null, 'one missed schedule cannot cascade');
  assert.deepEqual(item, snapshot);
}
assert.equal(policy.status(record(8, null)), null, 'mastered words have no demotion');
const fuzzy = record(4); policy.scheduled(fuzzy, now, 1440);
assert.equal(policy.status(fuzzy).grace, 782 * 60000, 'use actual shortened interval');
const almost = record(1), threshold = policy.status(almost).deadline;
assert.equal(policy.status(almost, now - 1).warning, false);
assert.equal(policy.status(almost, now).warning, true);
assert.equal(policy.status(almost, threshold - 60000).urgent, true);
const legacy = { cet4: { groups: { old: { words: [word], stage: 4, due: now - 200 * 86400000, learnedAt: now - 210 * 86400000 } } } };
assert.ok(policy.apply(legacy, now).length);
assert.equal(legacy.cet4.words[key].stage, 3, 'legacy grouped records retain their schedule and get one demotion');
assert.equal(policy.apply(legacy, now).length, 0, 'group migration cannot recreate or demote again');

let clock = now, persisted = { ielts: { words: { [key]: record(3, now - 40 * 3600000) } } };
class TestDate extends Date { static now() { return clock; } }
const window = { SrsPolicy: policy, Store: { getReview: () => clone(persisted), saveReview: v => { persisted = clone(v); } } };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../js/review.js'), 'utf8'), { window, Date: TestDate });
const result = window.Review.reviewWord('ielts', word, 'remembered', { activityId: 'answer' });
assert.equal(result.item.stage, 3, 'late stage 3 first drops to 2, then success recovers stage 3');
assert.equal(result.item.due, now + 1440 * 60000);
assert.ok(!result.item.overdue);
assert.equal(result.item.events.filter(e => e.type === 'overdue-demotion').length, 1);
window.Review.undoReview('ielts', word);
assert.equal(persisted.ielts.words[key].stage, 2, 'undo cannot restore the overdue stage');
assert.equal(persisted.ielts.words[key].overdue.fromStage, 3);
const passAgain = window.Review.reviewWord('ielts', word, 'fuzzy');
assert.equal(passAgain.item.due, now + 270 * 60000);
assert.equal(passAgain.item.stage, 2);
clock = passAgain.item.due + policy.graceMs(270 * 60000);
assert.ok(policy.applyItem(persisted.ielts.words[key], clock), 'a new missed schedule may demote once again');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-policy-'));
let storage;
try {
  storage = openStorage(dir);
  const a = storage.createUser('A', 'a', 'test'), b = storage.createUser('B', 'b', 'test');
  const old = { ielts: { words: { [key]: record(6, now - 200 * 86400000), floor: record(0, now - 200 * 86400000), done: record(8, null) } } };
  storage.putState(a.id, 'review', old, 0);
  storage.setMeta('upstream_pairing', JSON.stringify({ localUserId: a.id }));
  const db = new DatabaseSync(path.join(dir, 'wordpaper.sqlite'));
  const changed = reconcile(db, a.id, now);
  assert.equal(changed.all.ielts.words[key].stage, 5);
  assert.equal(changed.all.ielts.words.floor.stage, 0);
  assert.equal(changed.all.ielts.words.done.stage, 8);
  assert.equal(reconcile(db, a.id, now + 10000000).changes.length, 0);
  db.close();
  const saved = storage.getState(a.id);
  assert.equal(saved.revisions.review, 2);
  assert.equal(JSON.parse(storage.metaGet('upstream_queue')).review.baseRevision, 1);
  assert.equal(storage.putState(a.id, 'review', old, 1).conflict, true, 'old page cannot overwrite a demotion');
  assert.equal(storage.getState(b.id).state.review, undefined);
  storage.close(); storage = openStorage(dir);
  assert.equal(storage.getState(a.id).state.review.ielts.words[key].stage, 5);
  assert.equal(storage.getState(a.id).revisions.review, 2, 'restart/read does not rewrite unchanged schedules');
  const ev = { action: 'review', activityId: 'detail', at: now, library: 'ielts', word, nextDue: now + 3600000 };
  const log = activity.record({}, ev);
  const canceled = activity.record(log, { action: 'review', activityId: 'detail', at: now, canceled: true });
  assert.equal(activity.wordsForDay(log, activity.dayKey(now))[0].nextDue, ev.nextDue);
  assert.equal(activity.wordsForDay(canceled, activity.dayKey(now)).length, 0);
  assert.equal(activity.wordsForDay(activity.merge(log, canceled), activity.dayKey(now)).length, 0);
  console.log('PASS overdue policy: model thresholds, all stages, exact boundary, warning, floor/mastered, legacy one-step migration, rescheduling/undo, no false practice, account/restart/revision/queue and word log');
} finally { storage?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
