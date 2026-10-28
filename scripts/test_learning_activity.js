#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const activity = require('../js/learning-activity');
const { openStorage } = require('../lib/storage');

const now = Date.now(), day = activity.dayKey(now), word = { word: 'repeat', meaning: '重复' };
const event = (id, action = 'quiz', at = now) => ({ id, action, at, library: 'ielts', word, correct: false, score: 1 });
let value = {};
for (let i = 1; i <= 3; i++) value = activity.record(value, event(i), 'stream-a');
value = activity.record(value, event(4, 'sentence'), 'stream-a');
assert.deepEqual(activity.totals(value, day), { total: 4, recite: 3, sentence: 1, review: 0 });
assert.deepEqual(activity.record(JSON.parse(JSON.stringify(value)), event(1), 'stream-a'), value, 'replay after restart must not count twice');
value = activity.record(value, event(1), 'stream-b');
assert.equal(activity.totals(value, day).recite, 4, 'a new stream may reuse event sequence numbers');
const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
value = activity.record(value, event(5, 'review', yesterday.getTime()), 'browser');
assert.equal(activity.totals(value, day).total, 5, 'yesterday must not inflate today');
assert.equal(activity.totals(value, activity.dayKey(yesterday)).review, 1);
const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
assert.notEqual(activity.dayKey(midnight.getTime() - 1), activity.dayKey(midnight), 'local calendar rollover');
const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
assert.equal(activity.totals(activity.merge({}, { days: { [activity.dayKey(tomorrow)]: { timezone: { kind: 'quiz' } } } }), activity.dayKey(tomorrow)).total, 1, 'a learner ahead of the cloud timezone keeps their local day');
const canceled = activity.record(value, { ...event(1), canceled: true }, 'stream-a');
assert.equal(activity.totals(activity.merge(canceled, value), day).total, 4, 'stale replay must not restore an undone answer');
assert.equal(activity.totals(value, day, 7).recite, 11, 'keep legacy first-pass credits');
assert.equal(activity.plan({ dailyGoal: 25, checkins: { [day]: 1 } }).metric, 'total');
assert.equal(activity.plan({ dailyGoal: 3.8 }).dailyGoal, 3);
assert.equal(activity.plan({ dailyGoal: Infinity }).dailyGoal, 1000);
assert.equal(activity.plan({ dailyGoal: -3 }).dailyGoal, 1);
const ancient = new Date(now); ancient.setDate(ancient.getDate() - 90);
assert.deepEqual(activity.record({}, event(8, 'quiz', ancient.getTime())), { days: {} });
assert.deepEqual(activity.record({}, event(8, 'invalid')), { days: {} });
assert.equal(activity.totals(activity.record({}, { ...event(9), word: { word: 'long', meaning: '释义'.repeat(400) } }, 'native'), day).total, 1, 'long definitions must not truncate event identity');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-activity-'));
let storage;
try {
  storage = openStorage(dir);
  const userA = storage.createUser('A', 'a', 'test'), userB = storage.createUser('B', 'b', 'test');
  const a = activity.record({}, event(1), 'desktop'), b = activity.record({}, event(2, 'sentence'), 'browser');
  storage.putState(userA.id, 'learningActivity', a, 0);
  const merged = storage.putState(userA.id, 'learningActivity', b, 0);
  assert.equal(merged.conflict, false, 'concurrent activity writes must merge');
  assert.equal(activity.totals(merged.value, day).total, 2);
  assert.equal(storage.getState(userB.id).state.learningActivity, undefined, 'activities stay account scoped');
  storage.close(); storage = openStorage(dir);
  assert.equal(activity.totals(storage.getState(userA.id).state.learningActivity, day).total, 2, 'SQLite survives restart');

  // Exercise the actual native writer while there is no browser and far more
  // than the companion's 160-event replay capacity.
  storage.setMeta('upstream_pairing', JSON.stringify({ localUserId: userA.id }));
  const source = fs.readFileSync(path.join(__dirname, '../companion.js'), 'utf8');
  const persist = source.slice(source.indexOf('function persistLearningActivity('), source.indexOf('function readReviewState('));
  const writer = source.slice(source.indexOf('function writeReviewState('), source.indexOf('/* 当前词库里所有到期词'));
  const persistenceErrors = [];
  const context = { learningActivity: activity, state: { petMemoryStreamId: 'native' },
    console: { ...console, error: (...args) => persistenceErrors.push(args.join(' ')) },
    notePatrickStudy: () => {}, // The idle-clock integration has its own native/unit suite.
    reviewPolicyStore: require('../lib/review-policy-store'), srsPolicy: require('../js/srs-policy'),
    SRS_INTERVALS_MIN: require('../js/srs-policy').INTERVALS_MIN, wordKey: w => w.word + '|' + w.meaning,
    openSrsDb: () => new DatabaseSync(path.join(dir, 'wordpaper.sqlite')), activeUserId: () => userA.id };
  vm.createContext(context); vm.runInContext(persist + writer, context);
  for (let i = 0; i < 170; i++) context.persistLearningActivity(event(i + 10, i % 2 ? 'sentence' : 'quiz'));
  const native = storage.getState(userA.id).state.learningActivity;
  assert.equal(activity.totals(native, day).total, 172, 'closed-window actions survive event-buffer overflow');
  context.persistLearningActivity(event(10));
  assert.equal(activity.totals(storage.getState(userA.id).state.learningActivity, day).total, 172, 'native retry deduplicates');
  const queue = JSON.parse(storage.metaGet('upstream_queue')).learningActivity;
  assert.equal(queue.baseRevision, 2, 'offline events retain the first cloud revision');
  const remote = activity.record(native, event(999, 'sentence'), 'other-device');
  context.persistLearningActivity(event(1000));
  storage.settleQueuedState(userA.id, 'learningActivity', queue, { revision: 9, value: remote });
  assert.equal(activity.totals(storage.getState(userA.id).state.learningActivity, day).total, 174, 'late cloud acknowledgement retains both devices and newer native work');
  assert.equal(JSON.parse(storage.metaGet('upstream_queue')).learningActivity.baseRevision, 9);
  const pending = JSON.parse(storage.metaGet('upstream_queue')).learningActivity;
  storage.settleQueuedState(userA.id, 'learningActivity', pending, { revision: 10, value: pending.value });
  assert.equal(storage.metaGet('upstream_queue'), null, 'acknowledged activity clears its queue');
  assert.equal(storage.getState(userB.id).state.learningActivity, undefined);
  assert.deepEqual(persistenceErrors, [], 'native persistence must not swallow a missing dependency or write error');
  console.log('PASS daily activity: repeat/incorrect/sentence counts, replay/restart/date boundaries, undo, migration, account isolation, 170 native actions and concurrent cloud merge');
} finally {
  storage?.close(); fs.rmSync(dir, { recursive: true, force: true });
}
