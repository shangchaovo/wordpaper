'use strict';

const { MessageChannel, Worker, receiveMessageOnPort } = require('node:worker_threads');
const { performance } = require('node:perf_hooks');

const STARTUP_TIMEOUT = 15000;
const STATEMENT_TIMEOUT = 12000;
const TRANSACTION_TIMEOUT = 60000;

function parseConnection(databaseUrl) {
  let url;
  try { url = new URL(databaseUrl); }
  catch { throw new Error('Invalid PostgreSQL database URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 || url.hash) {
    throw new Error('Invalid PostgreSQL database URL');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const localTest = process.env.NODE_ENV === 'test' && (host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host));
  const modes = url.searchParams.getAll('sslmode');
  const mode = modes[0];
  if (modes.length > 1 || (mode && !['require', 'verify-ca', 'verify-full'].includes(mode) && !(localTest && mode === 'disable'))) {
    throw new Error('PostgreSQL connections require verified TLS');
  }
  if (host.endsWith('.pooler.supabase.com') && url.port === '6543') {
    throw new Error('Use the Supabase session pooler on port 5432');
  }
  return {
    host,
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl: localTest && (!mode || mode === 'disable') ? false : { rejectUnauthorized: true },
  };
}

function dbError(code, unavailable = false) {
  const messages = {
    '23505': 'PostgreSQL unique constraint failed',
    MODULE_NOT_FOUND: 'PostgreSQL driver is unavailable; install the production dependencies',
  };
  if (unavailable || ['57014', '55P03', '42501', '42P01'].includes(code)) {
    return Object.assign(new Error('账号数据库暂不可用，请稍后重试。'), { code, status: 503 });
  }
  return Object.assign(new Error(messages[code] || 'PostgreSQL request failed'), { code });
}

// The public server shares synchronous storage transactions with the local App.
// Its database socket lives in a worker so a bounded wait never polls the main
// event loop or runs another request inside an unfinished transaction.
function openPostgres(databaseUrl) {
  const connection = parseConnection(databaseUrl);
  let worker, port;
  let closed = false;
  let transactionDeadline = 0;
  let transactionLost = false;

  function disconnect() {
    if (transactionDeadline) transactionLost = true;
    transactionDeadline = 0;
    port?.close();
    if (worker) void worker.terminate();
    worker = null;
    port = null;
  }

  function exchange(operation, sql, params, timeout) {
    const start = performance.now();
    const deadline = transactionDeadline ? Math.min(start + timeout, transactionDeadline) : start + timeout;
    function timedOut() { disconnect(); throw dbError('DB_TIMEOUT', true); }
    if (deadline <= start) timedOut();
    const wake = new Int32Array(new SharedArrayBuffer(4));
    port.postMessage({ operation, sql, params, wake });
    for (;;) {
      const packet = receiveMessageOnPort(port);
      if (packet) {
        if (packet.message.ok) return packet.message.value;
        if (packet.message.code === 'DB_TIMEOUT') timedOut();
        if (packet.message.disconnected) disconnect();
        throw dbError(packet.message.code, operation === 'connect' || packet.message.disconnected);
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) timedOut();
      const state = Atomics.load(wake, 0);
      // A ready signal means the reply was posted. A short bounded wait also
      // covers the port being visible just after the inter-thread notification.
      Atomics.wait(wake, 0, state, state ? Math.min(remaining, 2) : remaining);
    }
  }

  function connect() {
    const { port1, port2 } = new MessageChannel();
    port = port1;
    worker = new Worker(require.resolve('./postgres-worker'), {
      workerData: { connection, port: port2 }, transferList: [port2],
    });
    worker.on('error', () => {});
    worker.unref();
    port.unref();
    try { exchange('connect', undefined, undefined, STARTUP_TIMEOUT); }
    catch (error) { disconnect(); throw error; }
  }

  function call(operation, sql, params) {
    if (closed) throw dbError('DB_CLOSED', true);
    if (transactionLost) throw dbError('DB_TRANSACTION_LOST', true);
    // A fresh request can reconnect. Replaying an interrupted statement here
    // would duplicate a write when its commit acknowledgement was lost.
    if (!worker) connect();
    return exchange(operation, sql, params, STATEMENT_TIMEOUT);
  }

  connect();
  return {
    get isTransaction() { return transactionDeadline !== 0 || transactionLost; },
    beginUserState(userId) {
      call('beginUserState', undefined, [userId]);
      transactionDeadline = performance.now() + TRANSACTION_TIMEOUT;
    },
    prepare(sql) {
      let param = 0;
      const text = sql.replace(/\?/g, () => `$${++param}`);
      return {
        get: (...args) => call('get', text, args),
        all: (...args) => call('all', text, args),
        run: (...args) => call('run', text, args),
      };
    },
    exec(sql) {
      const control = sql.trim().replace(/;$/, '').toUpperCase();
      if (control === 'ROLLBACK' && transactionLost) { transactionLost = false; return; }
      const takesLock = control === 'BEGIN IMMEDIATE';
      call(takesLock ? 'begin' : 'exec', sql);
      if (takesLock || control === 'BEGIN' || control === 'START TRANSACTION') transactionDeadline = performance.now() + TRANSACTION_TIMEOUT;
      if (control === 'COMMIT' || control === 'END' || control === 'ROLLBACK') transactionDeadline = 0;
    },
    close() {
      if (closed) return;
      try { if (worker) exchange('close', undefined, undefined, STATEMENT_TIMEOUT); }
      finally { closed = true; disconnect(); }
    },
  };
}

module.exports = { openPostgres };
