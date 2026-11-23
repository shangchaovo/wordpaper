#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const activity = require('../js/learning-activity');
const { freePort, startApp, stopApp, startMockProvider, startFlow, callback, cookieValue } = require('./test_oauth');

function request(app, method, route, body, account) {
  const headers = { Origin: app.base };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (account) {
    headers.Cookie = account.cookie;
    headers['X-CSRF-Token'] = account.csrfToken;
  }
  return fetch(app.base + route, { method, headers, body: JSON.stringify(body) });
}

async function signIn(app, route, username, expectedStatus) {
  const response = await request(app, 'POST', '/api/auth/' + route, { username, password: 'a test-only password' });
  assert.equal(response.status, expectedStatus);
  return { ...await response.json(), cookie: cookieValue(response, 'wp_session') };
}

async function read(app, account) {
  const response = await request(app, 'GET', '/api/state', undefined, account);
  assert.equal(response.status, 200);
  return response.json();
}

function write(app, account, namespace, expectedRevision, value) {
  return request(app, 'PUT', '/api/state/' + namespace, { expectedRevision, value }, account);
}

async function testConcurrentState(apps, account) {
  for (const expectedRevision of [0, 1]) {
    const writes = await Promise.all(apps.map((app, i) => write(app, account, 'reminders', expectedRevision,
      [{ id: 'same-reminder', text: 'variant-' + i + '-' + expectedRevision, done: false, time: '' }])));
    assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
    const conflict = await writes.find(result => result.status === 409).json();
    const saved = await read(apps[1], account);
    assert.equal(saved.revisions.reminders, expectedRevision + 1);
    assert.deepEqual(conflict.value, saved.state.reminders);
  }
  const now = Date.now(), day = activity.dayKey(now);
  const event = (id, canceled = false) => ({ days: { [day]: { [id]: { kind: 'review', at: now, canceled } } } });
  const writes = await Promise.all(apps.map((app, i) => write(app, account, 'learningActivity', 0, event('device' + i))));
  assert.deepEqual(writes.map(result => result.status), [200, 200]);
  const undoAndReplay = await Promise.all([
    write(apps[0], account, 'learningActivity', 0, event('device0', true)),
    write(apps[1], account, 'learningActivity', 0, event('device0')),
  ]);
  assert.deepEqual(undoAndReplay.map(result => result.status), [200, 200]);
  const saved = (await read(apps[0], account)).state.learningActivity;
  assert.deepEqual(Object.keys(saved.days[day]), ['device0', 'device1']);
  assert.equal(activity.totals(saved, day, 0).total, 1);
}

async function testDevice(apps, account, db) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const start = await request(apps[0], 'POST', '/api/device/start', { challenge, provider: 'email' });
  assert.equal(start.status, 200);
  const { userCode, deviceCode } = await start.json();
  const approvals = await Promise.all(apps.map(app => request(app, 'POST', '/api/device/approve', { userCode }, account)));
  assert.deepEqual(approvals.map(result => result.status).sort(), [200, 409]);
  // Session insertion fails after the valid grant is found inside the transaction.
  await db.query('REVOKE INSERT ON wordpaper.sessions FROM wordpaper_runtime');
  try {
    assert.equal((await request(apps[0], 'POST', '/api/device/token', { deviceCode, verifier })).status, 503);
  } finally { await db.query('GRANT INSERT ON wordpaper.sessions TO wordpaper_runtime'); }
  const replies = await Promise.all(apps.map(app => request(app, 'POST', '/api/device/token', { deviceCode, verifier })));
  assert.deepEqual(replies.map(result => result.status).sort(), [200, 410]);
  assert.deepEqual((await read(apps[1], await replies.find(result => result.ok).json())).state, (await read(apps[0], account)).state);
}

async function testGoogle(apps, db, account) {
  // Represents an already-migrated binding. The callback providers are isolated fixtures.
  await db.query(`INSERT INTO wordpaper.auth_identities
    (provider, provider_subject, user_id, email_verified, created_at, updated_at)
    VALUES ('google', 'google-subject-a', $1, 1, $2, $2)`, [account.user.id, Date.now()]);
  for (const code of ['google-code-a', 'google-code-b']) {
    const flows = await Promise.all(apps.map(app => startFlow(app.base, 'google', '/')));
    const replies = await Promise.all(apps.map((app, i) => callback(app.base, 'google', flows[i], code)));
    const users = [];
    for (const res of replies) {
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      const session = await fetch(apps[0].base + '/api/session', { headers: { Cookie: cookieValue(res, 'wp_session') } });
      assert.equal(session.status, 200);
      users.push((await session.json()).user.id);
    }
    assert.equal(users[0], users[1]);
    if (code === 'google-code-a') assert.equal(users[0], account.user.id);
    else assert.notEqual(users[0], account.user.id);
    const replay = await callback(apps[0].base, 'google', flows[0], code);
    assert.match(replay.headers.get('location'), /authError=oauth_expired/);
  }
}

async function run() {
  const uri = new URL(process.env.WORDPAPER_TEST_DATABASE_URL);
  assert.ok(['127.0.0.1', '[::1]', 'localhost'].includes(uri.hostname));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-pg-backend-'));
  const db = new Client({ connectionString: uri.href });
  const apps = [];
  const apiRole = 'wp_test_' + crypto.randomBytes(8).toString('hex');
  const password = crypto.randomBytes(24).toString('hex');
  let mock, runtimeCreated = false;
  try {
    const missingCredentials = spawnSync(process.execPath, ['server.js'], {
      cwd: path.resolve(__dirname, '..'), timeout: 5000, encoding: 'utf8',
      env: { ...process.env, WORDPAPER_MODE: 'public', WORDPAPER_STORAGE_BACKEND: 'postgres',
        WORDPAPER_DATABASE_URL: '', WORDPAPER_DATA_DIR: directory },
    });
    assert.equal(missingCredentials.status, 1);
    assert.match(missingCredentials.stderr, /缺少 WORDPAPER_DATABASE_URL/);
    assert.equal(fs.existsSync(path.join(directory, 'wordpaper.sqlite')), false);
    await db.connect();
    const tables = await db.query("SELECT to_regnamespace('wordpaper') AS schema");
    assert.equal(tables.rows[0].schema, null, 'use a new, disposable PostgreSQL test database');
    const migrations = path.join(__dirname, '../supabase/migrations');
    for (const name of fs.readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
      await db.query(fs.readFileSync(path.join(migrations, name), 'utf8'));
    }
    await db.query(`CREATE ROLE ${apiRole} LOGIN PASSWORD '${password}' IN ROLE wordpaper_runtime`);
    runtimeCreated = true;
    const privileges = await db.query(`SELECT
      has_schema_privilege($1, 'wordpaper', 'CREATE') AS ddl,
      has_table_privilege($1, 'wordpaper.users', 'TRUNCATE') AS truncate,
      has_sequence_privilege($1, 'wordpaper.users_id_seq', 'UPDATE') AS reset_sequence`, [apiRole]);
    assert.deepEqual(privileges.rows[0], { ddl: false, truncate: false, reset_sequence: false });
    const mockPort = await freePort();
    mock = await startMockProvider(mockPort, []);
    uri.username = apiRole;
    uri.password = password;
    const start = async i => startApp(await freePort(), path.join(directory, String(i)), 'http://127.0.0.1:' + mockPort, {
      WORDPAPER_STORAGE_BACKEND: 'postgres', WORDPAPER_DATABASE_URL: uri.href,
      WORDPAPER_MODEL_KEY_BASE64: Buffer.alloc(32, 1).toString('base64'),
    });
    apps.push(await start(0));
    apps.push(await start(1));
    const [a, b] = apps;
    const health = await (await fetch(a.base + '/healthz')).json();
    assert.equal(health.database, 'postgres');
    assert.equal(health.schemaVersion, 2);
    assert.ok(health.version);
    const account = await signIn(a, 'register', 'postgres_user', 201);
    assert.equal(typeof account.user.id, 'number');
    await signIn(b, 'register', 'postgres_user', 409);
    await testConcurrentState(apps, account);
    const other = await signIn(b, 'register', 'other_user', 201);
    assert.deepEqual((await read(a, other)).state, {});
    await testGoogle(apps, db, account);
    await testDevice(apps, account, db);
    const baseline = await read(a, account);

    // Disable only this disposable runtime login and interrupt its open connections.
    await db.query(`ALTER ROLE ${apiRole} NOLOGIN`);
    await db.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename=$1 AND datname=current_database()', [apiRole]);
    assert.equal((await write(b, account, 'reminders', baseline.revisions.reminders, [])).status, 503);
    assert.equal((await fetch(a.base + '/healthz')).status, 503);
    assert.equal((await fetch(a.base + '/healthz')).status, 503);
    await db.query(`ALTER ROLE ${apiRole} LOGIN`);
    assert.equal((await fetch(a.base + '/healthz')).status, 200);
    assert.deepEqual((await read(b, account)).state, baseline.state);
    await stopApp(a.child);
    apps[0] = await start(0);
    const restored = await signIn(apps[0], 'login', 'postgres_user', 200);
    assert.equal(restored.user.id, account.user.id);
    assert.deepEqual((await read(apps[0], restored)).state, baseline.state);
    for (const replica of ['0', '1']) assert.equal(fs.existsSync(path.join(directory, replica, 'wordpaper.sqlite')), false);
    // Advance the disposable bucket to its final allowed attempt. A request on
    // the other replica observes the same count, then a new window permits login.
    assert.equal((await db.query('UPDATE wordpaper.auth_rate_limits SET attempts=29')).rowCount, 1);
    await signIn(apps[0], 'login', 'postgres_user', 200);
    await signIn(b, 'login', 'postgres_user', 429);
    await db.query("UPDATE wordpaper.auth_rate_limits SET expires_at=statement_timestamp() - interval '1 second'");
    await signIn(b, 'login', 'postgres_user', 200);
    console.log('PASS shared auth rate limits, restricted PostgreSQL role, two HTTP replicas, revision races, learning undo/replay, Google identity, single-use device grants, database outage/recovery, restart');
  } finally {
    await Promise.all(apps.map(app => stopApp(app.child)));
    if (mock) await new Promise(resolve => mock.close(resolve));
    try { if (runtimeCreated) await db.query(`DROP ROLE ${apiRole}`); } finally { await db.end(); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
