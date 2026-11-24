'use strict';

// Exercise the public one-reservation callback and the existing worker together
// without contacting WeChat or opening a production database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openStorage } = require('../lib/storage');
const { createWechatMini } = require('../lib/wechat-mini');
const { createMiniRoutes } = require('../lib/mini-routes');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mini-wake-'));
  const store = openStorage(dir);
  const a = store.createUser('a', 'a', 'fixture').id, b = store.createUser('b', 'b', 'fixture').id;
  const db = new DatabaseSync(store.databasePath);
  const minute = 60000;
  let at = Date.now(), tokenFailure = false, receiptLost = false, sendGate;
  const words = new Map(), scanned = [], deliveries = [];
  const mini = createWechatMini({ db, now: () => at,
    env: { WORDPAPER_MINI_APP_ID: 'fixture-app', WORDPAPER_MINI_APP_SECRET: 'fixture-secret',
      WORDPAPER_MINI_TEMPLATE_ID: 'fixture-template', WORDPAPER_MINI_TEMPLATE_FIELDS: '{"count":"number1"}' },
    getSchedules(id) { scanned.push(id); return words.get(id) || []; },
    fetchImpl: async (url, request) => {
      if (new URL(url).pathname.endsWith('/stable_token')) {
        if (tokenFailure) throw Error('token endpoint unavailable');
        return { ok: true, json: async () => ({ access_token: 'fixture', expires_in: 120 }) };
      }
      const { touser } = JSON.parse(request.body);
      deliveries.push(touser);
      if (sendGate) await sendGate.promise;
      if (receiptLost) throw Error('send acknowledgement lost');
      return { ok: true, json: async () => ({ errcode: 0 }) };
    },
  });
  const route = createMiniRoutes({ mini, mirroring: () => false, devtools: false,
    json: (res, status, data) => Object.assign(res, { status, data }) });
  async function wake(id, cap, auth) {
    const res = {};
    await route({ method: 'POST', headers: { 'x-wordpaper-account': String(id),
      authorization: auth || 'WordPaper-Job ' + cap } }, res, new URL('https://example.invalid/api/mini/reminder/wake'));
    return res.status;
  }
  const job = id => db.prepare('SELECT job_id,state,attempt_at,attempts FROM mini_reminders WHERE user_id=?').get(id);
  function reserve(id, delay = minute) {
    const due = at + delay;
    words.set(id, [{ id: 'sample', due, round: String(due) }]);
    mini.reserveReminder(id, { templateId: 'fixture-template', accepted: true });
    return job(id).job_id;
  }
  try {
    for (const id of [a, b]) db.prepare('INSERT INTO mini_bindings VALUES (?,?,?)').run(id, 'fixture-app', 'recipient-' + id);
    const aCap = reserve(a), bCap = reserve(b);
    assert.ok(!JSON.stringify(mini.reminder(a)).includes(aCap));
    scanned.length = 0;
    assert.equal(await wake(a, '', 'Bearer user-session-token'), 401);
    assert.equal(await wake('0', aCap), 401);
    assert.equal(await wake(a, bCap), 202);
    assert.equal(await wake(a, aCap), 202);
    assert.deepEqual(scanned, []); // wrong token/account or future job causes no schedule read
    at += minute;
    tokenFailure = true;
    await Promise.all([wake(a, aCap), wake(a, aCap)]);
    assert.equal(job(a).attempts, 1);
    assert.ok(job(a).attempt_at > at);
    assert.equal(job(b).attempts, 0);
    assert.deepEqual(deliveries, []);
    scanned.length = 0;
    await wake(a, aCap);
    assert.deepEqual(scanned, [], 'backoff enforced in callback');
    at = job(a).attempt_at; tokenFailure = false;
    await Promise.all([wake(a, aCap), wake(a, aCap)]);
    assert.deepEqual(deliveries, ['recipient-' + a]);
    assert.ok(scanned.every(id => id === a));
    assert.equal(job(b).state, 'scheduled');
    await wake(a, aCap);
    assert.equal(deliveries.length, 1);
    mini.cancelReminder(b);
    await wake(b, bCap);
    assert.equal(deliveries.length, 1);

    const newCap = reserve(b);
    at += minute;
    await wake(b, bCap);
    assert.equal(deliveries.length, 1, 'superseded capability cannot dispatch replacement');
    sendGate = Promise.withResolvers();
    const send = wake(b, newCap);
    while (deliveries.length < 2) await new Promise(resolve => setImmediate(resolve));
    const repeat = Promise.all([wake(b, newCap), mini.runDue()]);
    sendGate.resolve();
    await Promise.all([send, repeat]); sendGate = null;
    assert.deepEqual(deliveries, ['recipient-' + a, 'recipient-' + b]);
    assert.equal(job(b).state, 'sent');

    const changed = reserve(b);
    words.get(b)[0].round = 'superseded-round';
    at += minute;
    await wake(b, changed);
    assert.equal(job(b).state, 'completed');
    assert.equal(deliveries.length, 2);
    const unknown = reserve(b, 2 * minute);
    at += 2 * minute; receiptLost = true;
    await wake(b, unknown);
    assert.equal(job(b).state, 'unknown');
    await wake(b, unknown);
    assert.equal(deliveries.length, 3);
    console.log('PASS scoped reminder wake: private capability, account isolation, grant, due and retry gates, shared claim and uncertain delivery');
  } finally { db.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
main().catch(err => { console.error(err); process.exitCode = 1; });
