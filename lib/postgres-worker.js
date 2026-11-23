'use strict';

const { workerData } = require('node:worker_threads');

const { connection, port } = workerData;
let client;
let connectionError;

function createClient() {
  const { Client, types } = require('pg');
  types.setTypeParser(types.builtins.INT8, value => {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value;
  });
  client = new Client({
    ...connection,
    application_name: 'wordpaper',
    connectionTimeoutMillis: 12000,
    query_timeout: 11000,
  });
  client.on('error', error => { connectionError = error; });
  client.on('end', () => { connectionError ||= Object.assign(new Error(), { code: 'DB_DISCONNECTED' }); });
  return client;
}

async function run(operation, sql, params) {
  if (operation === 'connect') {
    await createClient().connect();
    // Set these after connecting because poolers do not all forward startup
    // options. A Supabase connection must use session, not transaction pooling.
    await client.query(`SET search_path = wordpaper, pg_catalog;
      SET lock_timeout = 7000;
      SET statement_timeout = 9000;
      SET idle_in_transaction_session_timeout = 15000`);
    return;
  }
  if (operation === 'close') { await client.end(); return; }
  if (connectionError) throw connectionError;
  if (operation === 'begin' || operation === 'beginUserState') {
    try {
      // BEGIN IMMEDIATE in SQLite excludes any other transaction of the same
      // kind. Acquire a database-scoped lock shared by WordPaper replicas.
      if (operation === 'begin') {
        await client.query('BEGIN; SELECT pg_advisory_xact_lock(5582726507006881)');
      } else {
        // The account exists even before its first namespace write. Lock it so
        // replicas serialize read/merge/write without blocking other learners.
        await client.query('BEGIN');
        await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', params);
      }
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    }
    return;
  }
  const result = await client.query(sql, params);
  if (operation === 'get') return result.rows[0];
  if (operation === 'all') return result.rows;
  if (operation === 'run') return { changes: result.rowCount || 0, lastInsertRowid: result.rows[0]?.id };
}

port.on('message', async ({ operation, sql, params, wake }) => {
  try {
    const value = await run(operation, sql, params);
    port.postMessage({ ok: true, value });
  } catch (error) {
    const code = error?.message === 'Query read timeout' ? 'DB_TIMEOUT'
      : typeof error?.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'DB_REQUEST_FAILED';
    const disconnected = Boolean(connectionError) || /^(08|57P0[123]|ECONN|EPIPE|ETIMEDOUT|DB_DISCONNECTED)/.test(code)
      || /connection (?:terminated|closed)/i.test(error?.message || '');
    port.postMessage({ ok: false, code, disconnected });
  } finally {
    Atomics.store(wake, 0, 1);
    Atomics.notify(wake, 0);
  }
});
