'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { openStorage } = require('../lib/storage');
const { createMiniLearning } = require('../lib/mini-learning');
const { createMiniSentence } = require('../lib/mini-sentence');
const { createMiniRoutes } = require('../lib/mini-routes');

// Desktop unlinks while the phone is waiting for the AI response or still
// uploading a request. The former session must not credit the study goal or
// write generated text, even if the same account has already paired again.
async function revokeDuringRequests(storage, learning, userId, entry) {
  const mini = storage.createWechatMini({ devtools: true, getSchedules: id => learning.schedules(id) });
  function pair() {
    const login = mini.loginDevtools(randomUUID().replaceAll('-', '').repeat(2), '127.0.0.1');
    const preview = mini.previewPair(login.loginTicket, mini.createPairCode(userId).code, '127.0.0.1');
    return mini.confirmPair(preview.confirmationToken).token;
  }
  const old = pair();
  const slowInput = Promise.withResolvers(), slowGrade = Promise.withResolvers(), slowExample = Promise.withResolvers();
  const started = Promise.withResolvers();
  let calls = 0;
  function working(promise) { if (++calls === 3) started.resolve(); return promise; }
  const sentence = createMiniSentence({ storage, learning, complete: () => working(slowGrade.promise) });
  const examples = storage.createMiniExamples(() => working(slowExample.promise));
  const raw = { ...entry, phonetic: entry.ipa };
  const voices = { example(id, wordId, access) { return examples.ensure(id, entry.library, raw, access); } };
  const route = createMiniRoutes({
    mini, learning, sentence, voices, mirroring: () => false, devtools: false,
    readJson: req => req.body || working(slowInput.promise),
    json: (res, status, data) => Object.assign(res, { status, data }),
  });
  async function call(method, action, body) {
    const res = {};
    await route({ method, headers: { authorization: 'Bearer ' + old }, body }, res, new URL('https://local.invalid/api/mini/' + action));
    return res;
  }
  const body = { id: entry.id, text: 'We watched the tide.', eventId: 'unlink-in-flight' };
  const before = learning.snapshot(userId);
  const pending = [call('PUT', 'goal'), call('POST', 'sentence', body), call('POST', 'example', { id: entry.id })];
  await started.promise;
  mini.unlink(userId);
  const fresh = pair();
  slowInput.resolve({ target: 97, metric: 'total' });
  slowGrade.resolve({ text: '{"score":5,"used":true,"fixed":"We watched the tide.","feedback":"表达自然。"}' });
  slowExample.resolve({ text: '{"en":"We watched the tide sweep across the shore.","zh":"我们看着潮水涌过海岸。"}', model: 'fixture' });
  const responses = await Promise.all(pending);
  assert.deepEqual(responses.map(r => r.status), [401, 401, 401]);
  assert.equal(examples.get(userId, entry.library, raw), null);
  assert.equal(learning.getSentenceResult(userId, body.eventId, entry.id, body.text), null);
  const after = learning.snapshot(userId);
  assert.deepEqual(after.counts, before.counts);
  assert.equal(after.target, before.target);
  assert.equal(mini.authenticate(fresh).userId, userId);
  mini.unlink(userId);
}


function mergeDelta(base, change) {
  assert.equal(change.baseToken, base.syncToken);
  const rows = new Map(base.words.map(w => [w.id, w]));
  const moved = new Set(change.positions.map(p => p.id));
  for (const w of change.upserts) rows.set(w.id, w);
  const words = base.words.filter(w => !moved.has(w.id) && !change.removed.includes(w.id));
  for (const pos of change.positions) words.splice(pos.index, 0, rows.get(pos.id));
  const { delta, baseToken, upserts, removed, positions, ...fields } = change;
  return { ...base, ...fields, words };
}

function testConditionalSnapshots(storage, userId, otherId) {
  let at = Date.UTC(2026, 10, 10, 2), builds = 0;
  const learn = createMiniLearning({ ...storage, miniLearningTransaction(...args) {
    builds++;
    return storage.miniLearningTransaction(...args);
  } }, { clock: () => at });
  const options = { library: 'custom', timezoneOffset: -480 };
  const check = prev => learn.snapshot(userId, { ...options, since: prev.syncToken });
  const write = (ns, value) => storage.putState(userId, ns, value, storage.getRevisions(userId)[ns] || 0);
  write('settings', { library: 'custom', uiTheme: 'anime' });
  write('customWords', Array.from({ length: 35 }, (_, i) => ({ word: 'fixture' + i, meaning: '词' + i })));
  const initial = learn.snapshot(userId, options), firstBuild = builds;
  at++;
  assert.deepEqual(check(initial), { unchanged: true, now: at, validUntil: initial.validUntil, syncToken: initial.syncToken });
  write('settings', { library: 'custom', uiTheme: 'anime', wallpaperOpacity: 0.42 });
  write('reminders', { enabled: false });
  assert.ok(check(initial).unchanged);
  assert.equal(builds, firstBuild, 'unchanged polls and wallpaper edits avoid the review transaction');
  assert.ok(learn.snapshot(otherId, { ...options, since: initial.syncToken }).words, 'tokens are account scoped');
  assert.ok(learn.snapshot(userId, { ...options, timezoneOffset: 0, since: initial.syncToken }).words, 'tokens are timezone scoped');
  assert.ok(learn.snapshot(userId, { library: 'cet4', since: initial.syncToken }).words, 'tokens are library scoped');

  const word = initial.words[12];
  const change = learn.mutate(userId, { ...options, since: initial.syncToken, action: 'learn', round: word.round, id: word.id, eventId: 'delta_test_learn' });
  assert.equal(change.delta, true);
  assert.equal(change.upserts.length, 2, 'one newly learned and one replacement recommendation');
  assert.equal(change.positions[0].index, 0);
  assert.equal(change.positions[0].id, word.id);
  let full = learn.snapshot(userId, options);
  assert.deepEqual(mergeDelta(initial, change), full);
  assert.equal(full.validUntil, at + 20 * 60000);
  assert.ok(check(full).unchanged);
  const next = learn.goal(userId, { ...options, target: 21, metric: 'recite', since: full.syncToken });
  assert.equal(next.delta, true); assert.equal(next.upserts.length, 0);
  assert.deepEqual(mergeDelta(full, next), learn.snapshot(userId, options));

  full = learn.snapshot(userId, options);
  write('uiTheme', 'editorial');
  const theme = check(full);
  assert.equal(theme.theme, 'editorial');
  assert.deepEqual(mergeDelta(full, theme), learn.snapshot(userId, options));
  full = learn.snapshot(userId, options);
  let rev = storage.getRevisions(userId).customWords;
  const list = storage.miniLearningTransaction(userId, tx => tx.get('customWords', []));
  const edited = list.filter(w => w.word !== 'fixture1').map(w => w.word === 'fixture2' ? { ...w, examples: [{ en: 'Test sentence.', zh: '测试。' }] } : w);
  assert.equal(storage.putState(userId, 'customWords', edited, rev).conflict, false);
  const imported = check(full);
  assert.ok(imported.removed.length);
  assert.ok(imported.upserts.some(w => w.example === 'Test sentence.'));
  assert.deepEqual(mergeDelta(full, imported), learn.snapshot(userId, options));

  full = learn.snapshot(userId, options);
  at = full.validUntil - 1;
  assert.ok(check(full).unchanged);
  at++;
  let timed = check(full);
  assert.equal(timed.delta, true);
  assert.equal(timed.dueCount, 1);
  assert.deepEqual(mergeDelta(full, timed), learn.snapshot(userId, options));
  full = learn.snapshot(userId, options);
  const grade = learn.mutate(userId, { ...options, since: full.syncToken, action: 'grade', grade: 'remembered',
    round: full.words[0].round, id: word.id, eventId: 'delta_test_grade' });
  assert.equal(grade.upserts[0].stage, 1);
  full = learn.snapshot(userId, options);
  at = full.validUntil;
  full = learn.snapshot(userId, options);
  assert.equal(full.dueCount, 1);
  at = full.validUntil;
  timed = check(full);
  assert.equal(timed.upserts[0].stage, 0, 'grace deadline invalidates the learned stage');
  full = learn.snapshot(userId, options);
  at = full.validUntil;
  const tomorrow = check(full);
  assert.equal(tomorrow.day, '2026-11-11');
  assert.equal(tomorrow.counts.total, 0);
  assert.deepEqual(mergeDelta(full, tomorrow), learn.snapshot(userId, options));
}

function testOfflineSchedule(storage, userId) {
  const start = Date.UTC(2026, 10, 10, 23, 50), minute = 60000;
  let receivedAt = start;
  const learning = createMiniLearning(storage, { clock: () => receivedAt });
  const options = { library: 'ielts', timezoneOffset: 0 };
  const word = learning.snapshot(userId, options).words[0];
  const submit = (id, action, round, minutes, extra) => learning.mutate(userId, {
    ...options, id: word.id, action, round, eventId: id, occurredAt: start + minutes * minute, ...extra,
  });
  receivedAt = start + 100 * minute;
  let snap = submit('late_learn', 'learn', 'new', 0);
  let row = snap.words.find(w => w.id === word.id);
  assert.equal(row.due, start + 20 * minute);
  assert.equal(snap.dueCount, 1, 'the first offline review is already due on reconnect');
  assert.equal(snap.counts.recite, 0, 'yesterday’s practice stays on yesterday');
  assert.equal(storage.miniLearningTransaction(userId, tx => tx.get('learningActivity').days['2026-11-10']['mini:late_learn'].at), start);
  const firstRound = row.round;
  snap = submit('late_grade', 'grade', row.round, 21, { grade: 'remembered' });
  row = snap.words.find(w => w.id === word.id);
  assert.equal(row.due, start + 81 * minute);
  assert.equal(row.stage, 1); assert.equal(snap.dueCount, 1); assert.equal(snap.counts.recite, 1);
  assert.equal(submit('late_grade', 'grade', firstRound, 21, { grade: 'remembered' }).counts.recite, 1);
  assert.throws(() => submit('competing_grade', 'grade', firstRound, 21, { grade: 'remembered' }), { code: 'stale_round' });

  receivedAt = start + 120 * minute;
  const demoted = learning.word(userId, word.id);
  assert.equal(demoted.stage, 0, 'another device already applied the missed-grace demotion');
  snap = submit('before_grace', 'grade', row.round, 82, { grade: 'remembered' });
  row = snap.words.find(w => w.id === word.id);
  assert.equal(row.stage, 2, 'an answer given in time uses the old stage');
  assert.equal(row.due, start + (82 + 540) * minute);
  assert.equal(snap.counts.recite, 2);
  snap = submit('late_undo', 'undo', row.round, 119, { undoId: row.undoId });
  row = snap.words.find(w => w.id === word.id);
  assert.equal(row.stage, 0, 'restoring the old schedule reapplies overdue policy as of now');
  assert.equal(row.due, start + 81 * minute);
  assert.equal(snap.counts.recite, 1);
  assert.throws(() => submit('after_undo', 'grade', demoted.round, 82, { grade: 'remembered' }), { code: 'stale_round' });
  receivedAt += 200 * minute;
  snap = submit('grade_after_grace', 'grade', row.round, 125, { grade: 'remembered' });
  row = snap.words.find(w => w.id === word.id);
  assert.equal(row.due, start + 185 * minute);
  assert.equal(row.stage, 0, 'newly scheduled review also catches up through its grace period on arrival');
  assert.equal(snap.counts.recite, 2);
}

// Opt-in benchmark on an isolated test account using the shipped vocabulary.
// node scripts/test_mini_learning.js --bench
function benchmark(storage, userId) {
  const at = Date.now(), learn = createMiniLearning(storage, { clock: () => at });
  const source = require('../data/words_ielts.json').slice(0, 2000), words = {};
  for (const [i, word] of source.entries()) {
    words[word.word + '|' + (word.meaning || '')] = { word, stage: 1, due: at + i * 1000,
      learnedAt: at - 3600000, scheduledAt: at - 3600000, scheduledIntervalMs: 3600000, reviewCount: 1 };
  }
  storage.putState(userId, 'review', { ielts: { words } }, storage.getRevisions(userId).review || 0);
  const options = { library: 'ielts', timezoneOffset: 0 };
  const full = learn.snapshot(userId, options);
  function measure(times, fn) {
    const timings = [];
    let bytes;
    for (let i = 0; i < times; i++) {
      const start = performance.now();
      bytes = Buffer.byteLength(JSON.stringify(fn()));
      timings.push(performance.now() - start);
    }
    const sorted = timings.sort((a, b) => a - b);
    return { calls: times, bytes, medianMs: Number(sorted[Math.floor(times / 2)].toFixed(3)) };
  }
  const fullRead = measure(15, () => learn.snapshot(userId, options));
  const poll = measure(150, () => learn.snapshot(userId, { ...options, since: full.syncToken }));
  const row = full.words[0];
  const grade = measure(1, () => learn.mutate(userId, { ...options, since: full.syncToken, id: row.id,
    round: row.round, action: 'grade', grade: 'remembered', eventId: 'bench_grade' }));
  console.log(JSON.stringify({ backend: storage.databasePath === 'supabase-postgres' ? 'PostgreSQL' : 'SQLite',
    snapshotWords: full.words.length, fullRead, unchangedPoll: poll, gradeDelta: grade }));
}

async function test(databaseUrl = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mini-learning-'));
  const storage = openStorage(dir, { databaseUrl, modelKey: Buffer.alloc(32, 4) });
  let a, b, syncUser, lateUser;
  try {
    let now = Date.now();
    const originalNow = now, clock = () => now, minute = 60000;
    const learn = createMiniLearning(storage, { clock });
    const id = randomUUID().slice(0, 10);
    a = storage.createUser('mini' + id, 'mini' + id, 'test');
    b = storage.createUser('miniother' + id, 'miniother' + id, 'test');
    syncUser = storage.createUser('minisync' + id, 'minisync' + id, 'test');
    lateUser = storage.createUser('minilate' + id, 'minilate' + id, 'test');
    testOfflineSchedule(storage, lateUser.id);
    testConditionalSnapshots(storage, syncUser.id, b.id);
    if (process.argv.includes('--bench')) benchmark(storage, syncUser.id);
    const empty = learn.snapshot(a.id);
    assert.equal(empty.theme, 'liquid');
    assert.deepEqual([empty.metric, empty.target, empty.counts.total, empty.dueCount], ['total', 10, 0, 0]);
    assert.ok(empty.words.every(w => w.kind === 'new'));
    assert.ok(empty.words.some(w => w.word === 'academic' && w.example));
    const p1 = learn.catalog(a.id, { library: 'ielts', limit: 24, kind: 'new' });
    const p2 = learn.catalog(a.id, { library: 'ielts', limit: 24, offset: p1.nextOffset });
    assert.ok(p1.total > 100 && p2.words.length === 24);
    const result = learn.catalog(a.id, { library: 'ielts', query: p2.words[0].word });
    assert.ok(result.words.some(row => row.id === p2.words[0].id));
    assert.equal(learn.word(a.id, p2.words[0].id).id, p2.words[0].id);
    const target = { word: 'tide', phonetic: '/taɪd/', pos: 'n.', meaning: '潮汐', examples: [{ en: 'The tide is high.', zh: '潮水很高。' }] };
    const second = { word: 'tide', phonetic: '', meaning: '趋势' };
    storage.putState(a.id, 'customWords', [target, second], 0);
    storage.putState(a.id, 'settings', { library: 'custom', uiTheme: 'darkliquid' }, 0);
    storage.putState(a.id, 'knownWords', { custom: ['tide\u0000'] }, 0);
    const first = learn.snapshot(a.id).words[0];
    assert.equal(first.translation, '潮水很高。');
    assert.equal(learn.snapshot(a.id).words.length, 1);
    assert.equal(learn.word(b.id, first.id), null);
    const action = { eventId: 'one', action: 'learn', id: first.id, round: first.round, timezoneOffset: -480 };
    let snap = learn.mutate(a.id, action);
    assert.equal(snap.counts.recite, 1);
    assert.equal(learn.catalog(a.id, { library: 'custom', kind: 'new' }).total, 0);
    assert.equal(learn.catalog(a.id, { library: 'custom', query: '潮汐', kind: 'future' }).words[0].id, first.id);
    let w = snap.words.find(x => x.id === first.id);
    assert.equal(w.due, now + 20 * minute);
    assert.equal(learn.mutate(a.id, action).counts.total, 1);
    assert.throws(() => learn.mutate(a.id, { ...action, eventId: 'two' }), { code: 'stale_round' });
    const pass = { ...action, round: w.round, action: 'grade', grade: 'remembered', eventId: 'grade1' };
    assert.throws(() => learn.mutate(a.id, pass), { code: 'not_due' });
    assert.throws(() => learn.mutate(a.id, { ...pass, occurredAt: now + 1200000 }), { code: 'invalid_event_time' });
    now = w.due;
    assert.throws(() => learn.mutate(a.id, { ...pass, occurredAt: now - 5000 }), { code: 'not_due' });
    const old = storage.getState(a.id);
    snap = learn.mutate(a.id, pass);
    assert.equal(snap.counts.recite, 2);
    assert.ok(storage.putState(a.id, 'review', old.state.review, old.revisions.review).conflict, 'stale desktop write cannot advance the same round');
    // Legacy browsers may publish the rejected notebook practice before or
    // after their conflicting review PUT, and from another calendar day.
    for (const before of [true, false]) {
      const notebookId = 'notebook:' + (before ? 'a' : 'b').repeat(32);
      const local = JSON.parse(JSON.stringify(old.state.review));
      const other = local.custom.words['tide|潮汐'];
      other.lastUndo = { snapshot: JSON.parse(JSON.stringify(other)), at: now, activityId: notebookId };
      const calendar = new Date(now - 86400000).toISOString().slice(0, 10);
      const separate = { days: { [calendar]: { [notebookId]: { at: now, kind: 'review' } } } };
      if (before) storage.putState(a.id, 'learningActivity', separate, 0);
      assert.ok(storage.putState(a.id, 'review', local, old.revisions.review).conflict);
      if (!before) storage.putState(a.id, 'learningActivity', separate, 0);
      const event = storage.getState(a.id).state.learningActivity.days[calendar][notebookId];
      assert.equal(event.canceled, true);
    }
    assert.equal(storage.miniLearningTransaction(a.id, () => learn.schedules(a.id))[0].due, now + 60 * minute);
    assert.throws(() => learn.mutate(a.id, { ...pass, eventId: 'grade2' }), { code: 'stale_round' });
    w = learn.word(a.id, first.id);
    assert.equal(w.stage, 1); assert.equal(w.due, now + 60 * minute);
    assert.equal(learn.schedules(a.id)[0].round, w.round);
    const undo = { ...action, action: 'undo', round: w.round, undoId: w.undoId, eventId: 'undo1' };
    assert.equal(learn.mutate(a.id, undo).counts.recite, 1);
    assert.equal(learn.mutate(a.id, undo).counts.recite, 1);
    assert.throws(() => learn.mutate(a.id, { ...pass, eventId: 'delayed' }), { code: 'stale_round' });
    w = learn.word(a.id, first.id);
    snap = learn.mutate(a.id, { ...pass, grade: 'fuzzy', round: w.round, eventId: 'fuzzy' });
    assert.equal(snap.words[0].due, now + 20 * minute);
    assert.equal(learn.goal(a.id, { metric: 'sentence', target: 3 }).target, 3);
    assert.throws(() => learn.goal(a.id, { metric: 'total', target: 0 }), { code: 'invalid_goal' });
    const tmp = storage.getState(a.id);
    const priorDue = learn.word(a.id, first.id).due;
    const body = { id: first.id, text: 'I can see the tide.', eventId: 'my-sentence', timezoneOffset: -480 };
    let calls = 0;
    const valid = '{"score":4,"used":true,"fixed":"I can see the tide.","feedback":"表达自然。","example":"The tide is rising."}';
    const complete = async () => { calls++; await new Promise(r => setTimeout(r, 20)); return { text: 'JSON ' + valid }; };
    const missing = createMiniSentence({ storage, learning: learn, complete });
    await assert.rejects(missing.submit(a.id, body), { code: 'model_not_configured' });
    storage.models.save(a.id, { baseUrl: 'https://example.org', protocol: 'openai', model: 'test', apiKey: 'test-fixture' });
    const malformed = createMiniSentence({ storage, learning: learn, complete: async () => ({ text: '{"score":6}' }) });
    await assert.rejects(malformed.submit(a.id, body), { code: 'invalid_grading' });
    assert.equal(learn.snapshot(a.id).counts.sentence, 0);
    const service = createMiniSentence({ storage, learning: learn, complete });
    const replica = createMiniSentence({ storage, learning: learn, complete });
    const [answer, replay, otherReplica] = await Promise.all([service.submit(a.id, body), service.submit(a.id, body), replica.submit(a.id, body)]);
    assert.deepEqual(answer, replay); assert.deepEqual(otherReplica, answer); assert.equal(calls, 1);
    assert.deepEqual(await replica.submit(a.id, body), answer); assert.equal(calls, 1);
    await assert.rejects(service.submit(a.id, { ...body, text: 'Unrelated sentence.' }), { code: 'event_reused' });
    assert.equal(learn.snapshot(a.id).counts.sentence, 1);
    assert.equal(learn.word(a.id, first.id).due, priorDue);
    assert.equal(storage.getState(a.id).revisions.review, tmp.revisions.review);
    assert.equal(learn.snapshot(b.id).counts.total, 0);
    await revokeDuringRequests(storage, learn, a.id, first);
    const row = storage.getState(a.id).state.review.custom.words['tide|潮汐'];
    now = row.due;
    w = learn.word(a.id, first.id);
    snap = learn.mutate(a.id, { ...pass, round: w.round, eventId: 'advance2' });
    now = snap.words[0].due + 34 * minute;
    w = learn.word(a.id, first.id);
    assert.equal(w.stage, 0);
    assert.deepEqual(learn.word(a.id, first.id), w);
    now = originalNow + 8 * 86400000;
    assert.throws(() => learn.mutate(a.id, { ...pass, round: w.round, occurredAt: originalNow, eventId: 'past' }), { code: 'invalid_event_time' });
    console.log('PASS mini conditional snapshots, exact word delta replay, due/grace/day boundaries, mini learning, same-round conflict, tombstone undo, clocks, word isolation, goals and idempotent sentence grading (' + (databaseUrl ? 'PostgreSQL' : 'SQLite') + ')');
  } finally {
    if (lateUser) storage.deleteUser(lateUser.id);
    if (syncUser) storage.deleteUser(syncUser.id);
    if (a) storage.deleteUser(a.id);
    if (b) storage.deleteUser(b.id);
    storage.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  await test();
  const url = process.env.WORDPAPER_TEST_DATABASE_URL;
  if (url) {
    assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(new URL(url).hostname));
    await test(url);
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
