'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWechatMini } = require('../lib/wechat-mini');

const minute = 60000;
const fail = status => e => e.status === status;
const val = x => ({ ok: true, json: async () => x });

async function exercise(connect, name) {
  let db = connect();
  const postgres = name === 'Postgres';
  let ts = Date.UTC(2026, 10, 24, 10);
  const account = username => Number(db.prepare("INSERT INTO users(username,username_key,password_hash,created_at) VALUES(?,?,'test',?) RETURNING id")
    .get(username, username, ts).id);
  const a = account('alice@example.com');
  const b = account('bert@example.com');
  const c = account('charlie@example.com');
  const entries = new Map();
  const sent = [];
  let sendCode = 0;
  let tokenRequests = 0;
  const options = {
    postgres, now: () => ts, getSchedules: userId => [...(entries.get(userId) || [])],
    env: { WORDPAPER_MINI_APP_ID: 'wx-real-test-id', WORDPAPER_MINI_APP_SECRET: 'private-test-value',
      WORDPAPER_MINI_TEMPLATE_ID: 'review-template', WORDPAPER_MINI_TEMPLATE_FIELDS: '{"count":"number3","title":"thing1","time":"time2"}' },
    fetchImpl: async (url, req) => {
      const endpoint = new URL(url);
      assert.equal(endpoint.hostname, 'api.weixin.qq.com');
      if (endpoint.pathname === '/sns/jscode2session') {
        assert.equal(endpoint.searchParams.get('secret'), 'private-test-value');
        const code = endpoint.searchParams.get('js_code');
        return val(code === 'bad' ? { errcode: 40029 } : { openid: 'openid-' + code, session_key: 'must-remain-private' });
      }
      const body = JSON.parse(req.body);
      if (endpoint.pathname === '/cgi-bin/stable_token') { tokenRequests++; return val({ access_token: 'fixture-token', expires_in: 7200 }); }
      assert.equal(endpoint.pathname, '/cgi-bin/message/subscribe/send');
      assert.equal(endpoint.searchParams.get('access_token'), 'fixture-token');
      sent.push(body);
      if (sendCode === 'lost') throw new Error('connection lost after dispatch');
      return val({ errcode: sendCode });
    },
  };
  const make = () => createWechatMini({ db, ...options });
  try {
    let api = make();
    assert.equal(api.config().templateId, 'review-template');
    assert.throws(() => api.loginDevtools('0'.repeat(64), 'local'), fail(404));
    await assert.rejects(api.login('bad', '1'), fail(401));
    const login = await api.login('wechat-a', '1');
    assert.equal(JSON.stringify(login).includes('openid'), false);
    const stale = api.createPairCode(a).code;
    const replaced = api.createPairCode(a);
    assert.match(replaced.code, /^\d{6}$/);
    assert.equal(replaced.expiresAt - ts, 5 * minute);
    if (stale !== replaced.code) assert.throws(() => api.previewPair(login.loginTicket, stale, '1'), fail(400));
    const preview = api.previewPair(login.loginTicket, replaced.code, '1');
    assert.deepEqual(preview.account, { label: 'a***e@example.com' });
    assert.throws(() => api.previewPair(login.loginTicket, replaced.code, '1'), fail(401));
    const otherTicket = (await api.login('wechat-other', '2')).loginTicket;
    const racingConfirmation = api.previewPair(otherTicket, replaced.code, '2');
    const linked = api.confirmPair(preview.confirmationToken);
    assert.equal(linked.account.id, a);
    assert.equal(api.authenticate(linked.token).userId, a);
    assert.throws(() => api.confirmPair(preview.confirmationToken), fail(401));
    assert.throws(() => api.confirmPair(racingConfirmation.confirmationToken), fail(401));
    assert.throws(() => api.createPairCode(a), fail(409));
    const signedIn = await api.login('wechat-a', '1');
    assert.equal(signedIn.account.id, a);
    assert.ok(signedIn.token !== linked.token);
    const bCode = api.createPairCode(b);
    const bLogin = await api.login('wechat-b', '2');
    const bConfirmed = api.confirmPair(api.previewPair(bLogin.loginTicket, bCode.code, '2').confirmationToken);
    assert.equal(api.authenticate(bConfirmed.token).userId, b);
    const expires = api.createPairCode(c);
    ts += 5 * minute + 1;
    const cTicket = (await api.login('wechat-c', '3')).loginTicket;
    assert.throws(() => api.previewPair(cTicket, expires.code, '3'), fail(400));
    for (let i = 0; i < 7; i++) assert.throws(() => api.previewPair(cTicket, 'bad000', '3'), fail(400));
    for (let i = 0; i < 7; i++) assert.throws(() => api.previewPair(cTicket, expires.code, '3'), fail(400));
    assert.throws(() => api.previewPair(cTicket, expires.code, '3'), fail(429));

    const grant = (scheduled, extra) => ({ templateId: 'review-template', at: scheduled, expectedDueAt: scheduled,
      timezone: 'Asia/Shanghai', accepted: true, ...extra });
    const add = (due) => entries.set(a, [
      { id: 'already-overdue', round: 1, due: ts - 10 },
      { id: 'apple', round: 2, due }, { id: 'pear', round: 3, due },
    ]);
    let due = ts + minute;
    add(due);
    assert.equal(api.reminder(a).nextDueAt, due);
    assert.equal(api.reminder(b).nextDueAt, null);
    assert.throws(() => api.reserveReminder(a, grant(due, { expectedDueAt: due + 1 })), fail(409));
    assert.throws(() => api.reserveReminder(a, grant(due, { accepted: false })), fail(400));
    assert.throws(() => api.reserveReminder(a, grant(due, { templateId: 'other' })), fail(400));
    assert.equal(api.reserveReminder(a, grant(due)).count, 2);
    assert.equal(api.cancelReminder(a).status, 'cancelled');
    ts = due;
    await api.runDue();
    assert.equal(sent.length, 0);

    due = ts + minute;
    add(due);
    api.reserveReminder(a, grant(due));
    entries.get(a)[2].round++; // Reviewed on desktop; same due time belongs to a different round.
    db.close(); db = connect(); api = make();
    assert.equal(api.reminder(a).status, 'scheduled');
    assert.equal(api.authenticate(linked.token).userId, a);
    ts = due;
    const wakeId = db.prepare('SELECT job_id FROM mini_reminders WHERE user_id=?').get(a).job_id;
    await Promise.all([api.wakeReminder(String(a), 'WordPaper-Job ' + wakeId), api.runDue(), api.runDue()]);
    assert.equal(sent.length, 1);
    assert.equal(tokenRequests, 1);
    assert.equal(sent[0].touser, 'openid-wechat-a');
    assert.equal(sent[0].data.number3.value, '1');
    assert.equal(sent[0].data.time2.value, '2026-11-24 18:07');
    assert.equal(sent[0].page, 'pages/today/index?from=reminder');
    assert.equal(api.reminder(a).status, 'sent');
    await api.runDue(); assert.equal(sent.length, 1);

    due = ts + minute; add(due);
    api.reserveReminder(a, grant(due));
    entries.get(a).splice(1);
    ts = due; await api.runDue();
    assert.equal(api.reminder(a).status, 'completed'); assert.equal(sent.length, 1);
    for (const [code, expected] of [[43101, 'needs_authorization'], ['lost', 'unknown']]) {
      due = ts + minute; add(due);
      api.reserveReminder(a, grant(due));
      sendCode = code;
      ts = due; await api.runDue();
      assert.equal(api.reminder(a).status, expected);
      const sentBefore = sent.length;
      await api.runDue(); assert.equal(sent.length, sentBefore);
    }
    due = ts + minute; add(due);
    api.reserveReminder(a, grant(due));
    ts = due; sendCode = 40014;
    await api.runDue(); assert.equal(api.reminder(a).status, 'scheduled');
    ts += minute; sendCode = 0;
    await api.runDue(); assert.equal(api.reminder(a).status, 'sent');

    due = ts + minute; add(due);
    api.reserveReminder(a, grant(due));
    assert.deepEqual(api.unlink(a), { linked: false });
    assert.throws(() => api.authenticate(linked.token), fail(401));
    assert.throws(() => api.authenticate(signedIn.token), fail(401));
    assert.ok((await api.login('wechat-a', '1')).loginTicket);
    assert.equal(api.authenticate(bConfirmed.token).userId, b);
    ts = due;
    const sentBefore = sent.length; await api.runDue(); assert.equal(sent.length, sentBefore);

    // First authorize before learning. Another desktop can later add the first
    // batch, or an earlier one; the worker always preserves a batch already due.
    entries.set(b, []);
    const intent = api.setReminderEnabled(b, true);
    assert.equal(intent.enabled, true); assert.equal(intent.hasGrant, false);
    assert.equal(intent.status, 'needs_authorization');
    const optIn = { templateId: 'review-template', accepted: true, timezone: 'Asia/Shanghai' };
    const waiting = api.reserveReminder(b, optIn);
    assert.equal(waiting.status, 'waiting'); assert.ok(waiting.hasGrant); assert.equal(waiting.at, null);
    const earlier = ts + minute;
    const later = ts + 5 * minute;
    const backlog = { id: 'backlog', due: ts - 1, round: 1 };
    const laterWord = { id: 'later', due: later, round: 1 };
    const earlierWord = { id: 'earlier', due: earlier, round: 1 };
    entries.set(b, [backlog, laterWord]);
    await api.runDue(); assert.equal(api.reminder(b).at, later);
    entries.get(b).push(earlierWord);
    api.afterLearning(b); assert.equal(api.reminder(b).at, earlier);
    entries.set(b, [backlog, laterWord]); // Undo before deadline moves to the next valid batch.
    api.afterLearning(b); assert.equal(api.reminder(b).at, later);
    entries.get(b).push(earlierWord); await api.runDue();
    ts = earlier; api.afterLearning(b);
    assert.equal(api.reminder(b).at, earlier);
    await api.runDue();
    assert.equal(api.reminder(b).status, 'sent');
    assert.equal(api.reminder(b).enabled, true);
    assert.equal(api.reminder(b).hasGrant, false);
    assert.equal(sent.at(-1).data.number3.value, '1');
    const afterOne = sent.length;
    ts = later; await api.runDue(); assert.equal(sent.length, afterOne);
    assert.equal(api.cancelReminder(b).enabled, false);

    const continuous = createWechatMini({ db, ...options, env: { ...options.env, WORDPAPER_MINI_TEMPLATE_MODE: 'longterm' } });
    const first = ts + minute;
    const second = first + minute;
    entries.set(b, [{ id: 'first', due: first, round: 'r1' }, { id: 'second', due: second, round: 'r2' }]);
    const granted = continuous.reserveReminder(b, optIn);
    assert.equal(granted.mode, 'longterm'); assert.equal(granted.at, first);
    ts = first; await continuous.runDue();
    assert.ok(continuous.reminder(b).hasGrant);
    await continuous.runDue(); assert.equal(continuous.reminder(b).at, second);
    ts = second;
    await continuous.runDue(); await continuous.runDue();
    assert.equal(sent.length, afterOne + 2);
    assert.equal(continuous.cancelReminder(b).hasGrant, false);
    assert.equal(continuous.reminder(b).enabled, false);

    const disabled = createWechatMini({ ...options, env: {}, db });
    assert.throws(() => disabled.createPairCode(c), fail(503));
    const dev = createWechatMini({ ...options, db, env: {}, devtools: true,
      fetchImpl: () => { throw Error('本地调试不能访问微信网络'); } });
    const secret = crypto.randomBytes(32).toString('hex');
    assert.throws(() => dev.loginDevtools('short', '127'), fail(400));
    await assert.rejects(dev.login('anything', '127'), fail(503));
    const oldTicket = dev.loginDevtools(secret, '127').loginTicket;
    const devTicket = dev.loginDevtools(secret, '127').loginTicket;
    const devCode = dev.createPairCode(c).code;
    assert.throws(() => dev.previewPair(oldTicket, devCode, '127'), fail(401));
    const local = dev.confirmPair(dev.previewPair(devTicket, devCode, '127').confirmationToken);
    assert.equal(dev.authenticate(local.token).userId, c);
    assert.throws(() => api.authenticate(local.token), fail(401));
    assert.throws(() => dev.authenticate(bConfirmed.token), fail(401));
    assert.equal(dev.loginDevtools(secret, '127').account.id, c);
    assert.equal(dev.config().templateId, '');
    await dev.runDue();
    console.log('PASS ' + name + ' — pairing, account isolation, revocation, durable schedules, concurrent delivery and local device mode');
  } finally { db.close(); }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-mini-'));
  try {
    const store = require('../lib/storage').openStorage(dir); store.close();
    const { DatabaseSync } = require('node:sqlite');
    await exercise(() => {
      const db = new DatabaseSync(path.join(dir, 'wordpaper.sqlite'));
      db.exec('PRAGMA foreign_keys=ON');
      return db;
    }, 'SQLite');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  if (process.env.WORDPAPER_TEST_DATABASE_URL) await postgresTest();
}

async function postgresTest() {
  const source = new URL(process.env.WORDPAPER_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(source.hostname), 'disposable local cluster required');
  const database = 'wp_mini_' + crypto.randomBytes(8).toString('hex');
  const { Client } = require('pg');
  const admin = new Client({ connectionString: source.href });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE ' + database);
    const target = new URL(source);
    target.pathname = '/' + database;
    const owner = new Client({ connectionString: target.href }); await owner.connect();
    try {
      const migrations = path.join(__dirname, '../supabase/migrations');
      for (const file of fs.readdirSync(migrations).filter(f => f.endsWith('.sql')).sort()) {
        await owner.query(fs.readFileSync(path.join(migrations, file), 'utf8'));
      }
    } finally { await owner.end(); }
    await exercise(() => {
      const db = require('../lib/postgres-storage').openPostgres(target.href);
      db.exec('SET ROLE wordpaper_runtime');
      return db;
    }, 'Postgres');
  } finally {
    await admin.query('DROP DATABASE IF EXISTS ' + database);
    await admin.end();
  }
}

main().catch(e => { console.error(e); process.exitCode = 1; });
