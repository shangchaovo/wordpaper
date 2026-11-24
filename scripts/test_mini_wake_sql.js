'use strict';

// A throwaway loopback PostgreSQL database runs the actual migrations and wake
// function. Only extension installation, the cron registry and the HTTP I/O are
// replaced. The HTTP counter is nontransactional, just like an outbound request.
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
    CREATE SCHEMA wordpaper_ops_http;
    CREATE TYPE wordpaper_ops_http.http_header AS (field varchar, value varchar);
    CREATE FUNCTION wordpaper_ops_http.http_header(varchar,varchar)
      RETURNS wordpaper_ops_http.http_header LANGUAGE SQL AS $$ SELECT ROW($1,$2)::wordpaper_ops_http.http_header $$;
    CREATE TYPE wordpaper_ops_http.http_request AS
      (method varchar, uri varchar, headers wordpaper_ops_http.http_header[], content_type varchar, content varchar);
    CREATE TYPE wordpaper_ops_http.http_response AS
      (status integer, content_type varchar, headers wordpaper_ops_http.http_header[], content varchar);
    CREATE SEQUENCE public.outbound_calls;
    CREATE TABLE public.test_requests (id bigint PRIMARY KEY, method text, uri text, headers jsonb,
      content_type text, body text, timeout_ms text, connect_timeout_ms text);
    CREATE FUNCTION wordpaper_ops_http.http(request wordpaper_ops_http.http_request)
      RETURNS wordpaper_ops_http.http_response LANGUAGE plpgsql AS $$
      DECLARE
        request_id bigint := nextval('public.outbound_calls');
        behavior text := current_setting('wordpaper_fixture.behavior',true);
      BEGIN
        INSERT INTO public.test_requests VALUES (request_id, request.method, request.uri,
          (SELECT jsonb_object_agg(h.field,h.value) FROM unnest(request.headers) h),
          request.content_type,request.content,current_setting('http.curlopt_timeout_ms',true),
          current_setting('http.curlopt_connecttimeout_ms',true));
        IF behavior = 'timeout' THEN RAISE EXCEPTION 'fixture timeout'; END IF;
        IF behavior = 'wait' THEN PERFORM pg_advisory_xact_lock(2646, 9); END IF;
        RETURN ROW(CASE WHEN behavior='unavailable' THEN 503 ELSE 204 END, NULL, NULL, NULL)::wordpaper_ops_http.http_response;
      END $$;
    CREATE TABLE public.fixture_extensions(extname text PRIMARY KEY, extnamespace oid NOT NULL, extversion text NOT NULL);`);
  await db.query(read('supabase/migrations/20261124000100_wechat_mini.sql')
    .replaceAll('TO wordpaper_runtime;', 'TO CURRENT_USER;'));
  const install = read('supabase/ops/install_mini_reminder_wakeup.sql')
    .replace('CREATE EXTENSION IF NOT EXISTS pg_cron;', '-- cron.schedule fixture installed')
    .replaceAll('pg_catalog.pg_extension', 'public.fixture_extensions')
    .replace('CREATE EXTENSION IF NOT EXISTS http WITH SCHEMA wordpaper_ops_http;',
      "INSERT INTO public.fixture_extensions VALUES ('http','wordpaper_ops_http'::regnamespace,'1.6') ON CONFLICT DO NOTHING;");
  await db.query("INSERT INTO public.fixture_extensions VALUES ('http','public'::regnamespace,'1.6')");
  await assert.rejects(db.query(install), /schema|wordpaper_ops_http|private/i);
  await db.query('ROLLBACK');
  await db.query("DELETE FROM public.fixture_extensions WHERE extname='http'");
  await db.query(install);
  const foreignKeys = await db.query(`SELECT count(*)::int AS n FROM pg_catalog.pg_constraint
    WHERE conrelid='wordpaper_ops.mini_reminder_wakes'::regclass AND contype='f'`);
  assert.equal(foreignKeys.rows[0].n, 0, 'retry bookkeeping is independent of application rows');
  await db.query(install);
  const jobs = (await db.query('SELECT * FROM cron.job')).rows;
  assert.deepEqual(jobs, [{ name: 'wordpaper-mini-reminder-wake', interval: '* * * * *', command: 'SELECT wordpaper_ops.wake_due_mini_reminders()' }]);
  assert.ok(!(await db.query("SELECT has_schema_privilege('pg_monitor','wordpaper_ops_http','USAGE') AS allowed")).rows[0].allowed);
  assert.ok(!(await db.query("SELECT has_function_privilege('pg_monitor','wordpaper_ops.wake_due_mini_reminders()', 'EXECUTE') AS allowed")).rows[0].allowed);

  async function wake(client = db) {
    return (await client.query('SELECT wordpaper_ops.wake_due_mini_reminders() AS n')).rows[0].n;
  }
  async function calls() {
    const {rows} = await db.query('SELECT CASE WHEN is_called THEN last_value ELSE 0 END AS n FROM public.outbound_calls');
    return Number(rows[0].n);
  }
  const setBehavior = value => db.query("SELECT set_config('wordpaper_fixture.behavior',$1,false)", [value]);
  async function seed(id, job) {
    await db.query(`INSERT INTO wordpaper.users VALUES ($1)`, [id]);
    await db.query(`INSERT INTO wordpaper.mini_bindings VALUES ($1,$2,$3)`, [id, app, 'fixture-' + id]);
    await db.query(`INSERT INTO wordpaper.mini_reminder_prefs VALUES ($1,1,1,'template','once','UTC',0,0)`, [id]);
    await db.query(`INSERT INTO wordpaper.mini_reminders VALUES ($1,$2,'template',1,'UTC',$3,'scheduled',1,0)`,
      [id, job, JSON.stringify([{ id: 'fixture-word-' + id, due: 1, round: 'fixture-round' }])]);
  }
  assert.equal(await wake(), 0);
  assert.equal(await calls(), 0, 'empty installation contacts no receiver');
  const cap = callback();
  for (let i = 1; i <= 11; i++) await seed(i, i === 1 ? cap : callback());
  await db.query(`UPDATE wordpaper.mini_reminder_prefs SET enabled=0 WHERE user_id=2;
    UPDATE wordpaper.mini_reminder_prefs SET has_grant=0 WHERE user_id=3;
    UPDATE wordpaper.mini_reminder_prefs SET template_id='another' WHERE user_id=4;
    UPDATE wordpaper.mini_reminders SET state='sending' WHERE user_id=5;
    UPDATE wordpaper.mini_reminders SET at_ms=9000000000000 WHERE user_id=6;
    UPDATE wordpaper.mini_reminders SET attempt_at=9000000000000 WHERE user_id=7;
    UPDATE wordpaper.mini_bindings SET app_id='different-app' WHERE user_id=8;
    UPDATE wordpaper.mini_reminders SET words='[]' WHERE user_id=9;
    UPDATE wordpaper.mini_reminders SET words='' WHERE user_id=10`);
  // Stop the HTTP stub at a known instant. While that request is in flight,
  // another cron run skips it and the server can lock/update its source rows.
  await peer.query('SELECT pg_advisory_lock(2646, 9)');
  await setBehavior('wait');
  const pending = wake().then(n => ({ n }), error => ({ error }));
  try {
    const deadline = Date.now() + 5000;
    for (;;) {
      const {rows} = await peer.query(`SELECT EXISTS(SELECT FROM pg_locks WHERE pid=$1 AND
        locktype='advisory' AND classid=2646 AND objid=9 AND NOT granted) AS waiting`, [db.processID]);
      if (rows[0].waiting) break;
      if (Date.now() > deadline) throw Error('wake function did not reach synchronous HTTP fixture');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(await wake(peer), 0);
    await peer.query('BEGIN');
    try {
      await peer.query("SET LOCAL lock_timeout='600ms'");
      await peer.query(`SELECT FROM wordpaper.users WHERE id=1 FOR UPDATE;
        SELECT FROM wordpaper.mini_bindings WHERE user_id=1 FOR UPDATE;
        SELECT FROM wordpaper.mini_reminder_prefs WHERE user_id=1 FOR UPDATE;
        SELECT FROM wordpaper.mini_reminders WHERE user_id=1 FOR UPDATE;
        UPDATE wordpaper.users SET id=id WHERE id=1;
        UPDATE wordpaper.mini_bindings SET openid=openid WHERE user_id=1;
        UPDATE wordpaper.mini_reminders SET state='sent' WHERE user_id=1;
        UPDATE wordpaper.mini_reminder_prefs SET has_grant=0 WHERE user_id=11`);
      await peer.query('COMMIT');
    } catch (error) { await peer.query('ROLLBACK'); throw error; }
  } finally {
    await peer.query('SELECT pg_advisory_unlock(2646, 9)');
  }
  const first = await pending;
  if (first.error) throw first.error;
  assert.equal(first.n, 1);
  assert.equal(await calls(), 1, 'the next account revoked its grant during the first HTTPS call and is skipped');
  const [request] = (await db.query(`SELECT method,uri,headers,content_type,body,timeout_ms,connect_timeout_ms
    FROM public.test_requests ORDER BY id`)).rows;
  assert.deepEqual(request, { method: 'POST', uri: endpoint,
    headers: { Authorization: 'WordPaper-Job ' + cap, 'X-WordPaper-Account': '1' },
    content_type: 'application/json', body: '{}', timeout_ms: '4000', connect_timeout_ms: '2000' });
  assert.equal(await wake(), 0);
  const receipt = async () => (await db.query(`SELECT deliveries, next_wake_ms - floor(extract(epoch FROM now())*1000)::bigint AS delay,
    encode(job_digest,'hex') AS digest FROM wordpaper_ops.mini_reminder_wakes WHERE user_id=1`)).rows[0];
  const expedite = () => db.query('UPDATE wordpaper_ops.mini_reminder_wakes SET next_wake_ms=0 WHERE user_id=1');

  const replacement = callback();
  await db.query("UPDATE wordpaper.mini_reminders SET job_id=$1, state='scheduled' WHERE user_id=1", [replacement]);
  await setBehavior('timeout');
  assert.equal(await wake(), 1);
  assert.equal(await calls(), 2);
  const timeout = await receipt();
  assert.equal(timeout.deliveries, 1);
  assert.ok(timeout.delay > 175000 && timeout.delay <= 180000);
  assert.equal(timeout.digest, require('node:crypto').createHash('sha256').update(replacement).digest('hex'));
  assert.equal(await wake(), 0, 'a timed-out request retains backoff');
  await setBehavior('unavailable');
  for (let i = 2; i <= 12; i++) {
    await expedite();
    assert.equal(await wake(), 1);
    const backoff = await receipt();
    assert.equal(backoff.deliveries, i);
    const expected = Math.min(3600000, 180000 * 2 ** (i - 1));
    assert.ok(backoff.delay <= expected && backoff.delay > expected - 5000);
    assert.equal(await wake(), 0, '503 does not immediately wake the service again');
  }
  await expedite();
  assert.equal(await wake(), 0);
  assert.equal(await calls(), 13, 'a broken receiver stops after twelve deliveries of the replacement reservation');

  // Drift after installation is detected before making any outbound call.
  await db.query('GRANT USAGE ON SCHEMA wordpaper_ops_http TO PUBLIC');
  await assert.rejects(db.query('SELECT wordpaper_ops.check_wake_http_privileges()'), /privilege|ACL|permission|access|private/i);
  await db.query('REVOKE USAGE ON SCHEMA wordpaper_ops_http FROM PUBLIC');
  await db.query('SELECT wordpaper_ops.check_wake_http_privileges()');
  await db.query('DELETE FROM wordpaper.mini_bindings WHERE user_id=1');
  assert.equal(await wake(), 0);
  for (let i = 20; i < 30; i++) await seed(i, callback());
  await setBehavior('');
  assert.equal(await wake(), 8);
  assert.equal(await wake(), 2);
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
  console.log('PASS PostgreSQL wake scheduler: private synchronous HTTP, unlocked receiver, single scheduler, due checks, timeout/503 backoff, replacement, hard cap and batches; mocked HTTP and cron');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
