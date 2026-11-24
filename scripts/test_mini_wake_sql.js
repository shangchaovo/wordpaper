'use strict';

// Uses a disposable loopback PostgreSQL database. pg_net and pg_cron are
// replaced only at their installation/IO boundaries; no network requests leave
// PostgreSQL. The application DDL, queue/consent reads, locks and retries are real.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const app = 'wx16d8cd2cc7c3c566';
const endpoint = 'https://wordpaper-api.onrender.com/api/mini/reminder/wake';
const callback = () => randomBytes(32).toString('base64url');

async function test(db, peer) {
  await db.query(`
    CREATE SCHEMA wordpaper;
    CREATE TABLE wordpaper.users (id bigint PRIMARY KEY);
    CREATE SCHEMA cron;
    CREATE TABLE cron.job (name text PRIMARY KEY, interval text, command text);
    CREATE FUNCTION cron.schedule(text,text,text) RETURNS void LANGUAGE SQL AS $$
      INSERT INTO cron.job VALUES ($1,$2,$3)
      ON CONFLICT(name) DO UPDATE SET interval=excluded.interval, command=excluded.command $$;
    CREATE SCHEMA net;
    GRANT USAGE ON SCHEMA net TO PUBLIC, pg_monitor;
    CREATE FUNCTION net.fixture_version() RETURNS integer LANGUAGE SQL SECURITY DEFINER AS $$ SELECT 1 $$;
    CREATE TABLE net._http_response(id bigint);
    CREATE TABLE net.http_request_queue(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, url text, headers jsonb, body jsonb, timeout_ms integer);
    GRANT ALL ON net.http_request_queue,net._http_response TO PUBLIC;
    CREATE FUNCTION net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer)
      RETURNS bigint LANGUAGE SQL AS $$
      INSERT INTO net.http_request_queue(url,body,headers,timeout_ms)
        VALUES ($1,$2,$3,$4) RETURNING id $$;
    CREATE TABLE public.fixture_extensions(extname text PRIMARY KEY);`);
  await db.query(read('supabase/migrations/20261124000100_wechat_mini.sql')
    .replaceAll('TO wordpaper_runtime;', 'TO CURRENT_USER;'));
  const install = read('supabase/ops/install_mini_reminder_wakeup.sql')
    .replace('CREATE EXTENSION IF NOT EXISTS pg_cron;', '-- cron.schedule fixture installed')
    .replace('pg_catalog.pg_extension WHERE extname=', 'public.fixture_extensions WHERE extname=')
    .replace('CREATE EXTENSION pg_net WITH SCHEMA extensions;', "INSERT INTO public.fixture_extensions VALUES ('pg_net');");
  await db.query(install);
  await db.query(install);
  const jobs = (await db.query('SELECT * FROM cron.job')).rows;
  assert.deepEqual(jobs, [{ name: 'wordpaper-mini-reminder-wake', interval: '* * * * *', command: 'SELECT wordpaper_ops.wake_due_mini_reminders()' }]);
  assert.ok(!(await db.query("SELECT has_schema_privilege('pg_monitor','net','USAGE') AS allowed")).rows[0].allowed);
  assert.ok(!(await db.query("SELECT has_function_privilege('pg_monitor','wordpaper_ops.wake_due_mini_reminders()', 'EXECUTE') AS allowed")).rows[0].allowed);

  async function wake(client = db) {
    return (await client.query('SELECT wordpaper_ops.wake_due_mini_reminders() AS n')).rows[0].n;
  }
  async function seed(id, job) {
    await db.query(`INSERT INTO wordpaper.users VALUES ($1)`, [id]);
    await db.query(`INSERT INTO wordpaper.mini_bindings VALUES ($1,$2,$3)`, [id, app, 'fixture-' + id]);
    await db.query(`INSERT INTO wordpaper.mini_reminder_prefs VALUES ($1,1,1,'template','once','UTC',0,0)`, [id]);
    await db.query(`INSERT INTO wordpaper.mini_reminders VALUES ($1,$2,'template',1,'UTC',$3,'scheduled',1,0)`,
      [id, job, JSON.stringify([{ id: 'fixture-word-' + id, due: 1, round: 'fixture-round' }])]);
  }
  const queue = async () => (await db.query('SELECT url,headers,body,timeout_ms FROM net.http_request_queue ORDER BY id')).rows;
  assert.equal(await wake(), 0);
  const cap = callback();
  for (let i = 1; i <= 10; i++) await seed(i, i === 1 ? cap : callback());
  await db.query(`UPDATE wordpaper.mini_reminder_prefs SET enabled=0 WHERE user_id=2;
    UPDATE wordpaper.mini_reminder_prefs SET has_grant=0 WHERE user_id=3;
    UPDATE wordpaper.mini_reminder_prefs SET template_id='another' WHERE user_id=4;
    UPDATE wordpaper.mini_reminders SET state='sending' WHERE user_id=5;
    UPDATE wordpaper.mini_reminders SET at_ms=9000000000000 WHERE user_id=6;
    UPDATE wordpaper.mini_reminders SET attempt_at=9000000000000 WHERE user_id=7;
    UPDATE wordpaper.mini_bindings SET app_id='different-app' WHERE user_id=8;
    UPDATE wordpaper.mini_reminders SET words='[]' WHERE user_id=9;
    UPDATE wordpaper.mini_reminders SET words='' WHERE user_id=10`);
  await db.query('BEGIN');
  assert.equal(await wake(), 1);
  assert.equal(await wake(peer), 0, 'concurrent cron leaves the in-flight batch intact');
  await db.query('ROLLBACK');
  assert.equal((await queue()).length, 0, 'HTTP queue and retry ledger roll back together');
  assert.equal(await wake(), 1);
  const [request] = await queue();
  assert.deepEqual(request, { url: endpoint, headers: { 'Authorization': 'WordPaper-Job ' + cap,
    'X-WordPaper-Account': '1', 'Content-Type': 'application/json' }, body: {}, timeout_ms: 90000 });
  assert.equal(await wake(), 0, 'cold-start lease survives a second job check');
  const receipt = (await db.query(`SELECT next_wake_ms - floor(extract(epoch FROM now())*1000)::bigint AS delay,
    encode(job_digest, 'hex') AS digest FROM wordpaper_ops.mini_reminder_wakes`)).rows[0];
  assert.ok(receipt.delay > 175000 && receipt.delay <= 180000);
  assert.equal(receipt.digest, require('node:crypto').createHash('sha256').update(cap).digest('hex'));
  for (let i = 1; i < 12; i++) {
    await db.query('UPDATE wordpaper_ops.mini_reminder_wakes SET next_wake_ms=0');
    assert.equal(await wake(), 1);
  }
  await db.query('UPDATE wordpaper_ops.mini_reminder_wakes SET next_wake_ms=0');
  assert.equal(await wake(), 0, 'permanent receiver failure exhausts the one reservation');
  const replacement = callback();
  await db.query('UPDATE wordpaper.mini_reminders SET job_id=$1 WHERE user_id=1', [replacement]);
  // A later extension ACL change, including a single exposed header column,
  // must prevent new queue entries. Reinstallation does not relax shared ACLs.
  await db.query('GRANT SELECT(headers) ON net.http_request_queue TO PUBLIC');
  await assert.rejects(wake(), /queue privileges/);
  await assert.rejects(db.query(install), /queue privileges/);
  await db.query('ROLLBACK');
  await db.query('REVOKE SELECT(headers) ON net.http_request_queue FROM PUBLIC');
  await db.query('GRANT USAGE ON SCHEMA net TO pg_monitor');
  await assert.rejects(wake(), /privileged routines/);
  await assert.rejects(db.query(install), /privileged routines/);
  await db.query('ROLLBACK');
  assert.ok((await db.query("SELECT has_schema_privilege('pg_monitor','net','USAGE') AS allowed")).rows[0].allowed);
  await db.query('REVOKE USAGE ON SCHEMA net FROM pg_monitor');
  assert.equal(await wake(), 1);
  assert.equal((await queue()).at(-1).headers.Authorization, 'WordPaper-Job ' + replacement);
  await db.query('DELETE FROM wordpaper.mini_bindings WHERE user_id=1');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM wordpaper_ops.mini_reminder_wakes')).rows[0].n, 0);
  assert.equal(await wake(), 0);
  for (let i = 20; i <= 43; i++) await seed(i, callback());
  assert.equal(await wake(), 20);
  assert.equal(await wake(), 4);
  assert.equal(await wake(), 0);
}

async function main() {
  const url = new URL(process.env.WORDPAPER_TEST_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'isolated loopback test database required');
  const database = 'wp_mini_wake_' + randomBytes(8).toString('hex');
  const admin = new Client({ connectionString: url.href });
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE ' + database);
    url.pathname = '/' + database;
    const db = new Client({ connectionString: url.href }), peer = new Client({ connectionString: url.href });
    try {
      await Promise.all([db.connect(), peer.connect()]);
      await test(db, peer);
    } finally { await Promise.all([db.end(), peer.end()]); }
  } finally {
    try { await admin.query('DROP DATABASE IF EXISTS ' + database); } finally { await admin.end(); }
  }
  console.log('PASS PostgreSQL wake scheduler: grants, due batches, transaction races, backoff, hard cap, replacement and private queue; mocked network and cron');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
