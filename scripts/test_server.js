#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitFor(url, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('server exited early:\n' + output.join(''));
    try {
      const response = await fetch(url + '/healthz');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('server did not become ready:\n' + output.join(''));
}

async function startServer(port, dataDir, extraEnv) {
  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', WORDPAPER_MODE: 'public',
      WORDPAPER_DATA_DIR: dataDir, NODE_ENV: 'test',
    }, extraEnv || {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base, child, output);
  return { child, base, output };
}

async function stopServer(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not stop')), 7000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function register(base, username, password) {
  const response = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: base },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  return { cookie: setCookie.split(';')[0], csrf: body.csrfToken, user: body.user };
}

async function state(base, account) {
  const response = await fetch(base + '/api/state', { headers: { Cookie: account.cookie } });
  assert.equal(response.status, 200);
  return response.json();
}

async function putState(base, account, namespace, value, expectedRevision) {
  const response = await fetch(base + '/api/state/' + namespace, {
    method: 'PUT',
    headers: {
      Cookie: account.cookie, Origin: base, 'X-CSRF-Token': account.csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ value, expectedRevision }),
  });
  return { status: response.status, body: await response.json() };
}

function rawStatus(port, requestPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: requestPath }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
  });
}

(async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-server-test-'));
  const port = await freePort();
  let running;
  try {
    running = await startServer(port, dataDir);
    const { base } = running;

    const unauthenticated = await fetch(base + '/api/state');
    assert.equal(unauthenticated.status, 401);
    const providers = await (await fetch(base + '/api/auth/providers')).json();
    assert.deepEqual(providers, {
      email: { enabled: true, registrationEnabled: true }, google: { enabled: false }, github: { enabled: false }, wechat: { enabled: false },
      paired: null, pairingAllowed: false,
    });

    const alice = await register(base, 'server_alice', 'correct horse alice');
    const bob = await register(base, 'server_bob', 'correct horse bob');
    const aliceReminder = [{ id: 'a', text: 'Alice private' }];
    const bobReminder = [{ id: 'b', text: 'Bob private' }];

    const missingCsrf = await fetch(base + '/api/state/reminders', {
      method: 'PUT', headers: { Cookie: alice.cookie, Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: aliceReminder, expectedRevision: 0 }),
    });
    assert.equal(missingCsrf.status, 403);
    const wrongOrigin = await fetch(base + '/api/state/reminders', {
      method: 'PUT', headers: {
        Cookie: alice.cookie, Origin: 'https://attacker.example', 'X-CSRF-Token': alice.csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ value: aliceReminder, expectedRevision: 0 }),
    });
    assert.equal(wrongOrigin.status, 403);

    assert.equal((await putState(base, alice, 'reminders', aliceReminder, 0)).status, 200);
    assert.deepEqual((await state(base, bob)).state, {});
    assert.equal((await putState(base, bob, 'reminders', bobReminder, 0)).status, 200);
    assert.deepEqual((await state(base, alice)).state.reminders, aliceReminder);
    assert.deepEqual((await state(base, bob)).state.reminders, bobReminder);

    const conflict = await putState(base, alice, 'reminders', [{ id: 'stale' }], 0);
    assert.equal(conflict.status, 409);
    assert.deepEqual(conflict.body.value, aliceReminder);

    for (const sensitivePath of ['/companion-state.json', '/companion-config.json', '/custom-words.json', '/.git/config']) {
      assert.equal(await rawStatus(port, sensitivePath), 404, sensitivePath);
    }
    assert.equal(await rawStatus(port, '/../../../etc/hosts'), 404);
    assert.equal(await rawStatus(port, '/%2e%2e/%2e%2e/etc/hosts'), 404);

    const companion = await fetch(base + '/companion/start', {
      method: 'POST', headers: { Cookie: alice.cookie, Origin: base },
    });
    assert.equal(companion.status, 404);

    const db = new DatabaseSync(path.join(dataDir, 'wordpaper.sqlite'));
    const storedUser = db.prepare('SELECT password_hash FROM users WHERE username_key = ?').get('server_alice');
    const storedCredential = db.prepare('SELECT password_hash FROM password_credentials WHERE user_id = ?').get(alice.user.id);
    const storedSession = db.prepare('SELECT token_hash FROM sessions WHERE user_id = ? LIMIT 1').get(alice.user.id);
    assert.match(storedUser.password_hash, /^scrypt\$/);
    assert.match(storedCredential.password_hash, /^scrypt\$/);
    assert.ok(!storedUser.password_hash.includes('correct horse alice'));
    assert.ok(!storedSession.token_hash.includes(alice.cookie.split('=')[1]));
    db.close();

    await stopServer(running.child);
    running = await startServer(port, dataDir);
    assert.deepEqual((await state(running.base, alice)).state.reminders, aliceReminder);
    assert.deepEqual((await state(running.base, bob)).state.reminders, bobReminder);

    await stopServer(running.child);
    running = await startServer(port, dataDir, {
      NODE_ENV: 'production', TRUST_PROXY: '1',
      WORDPAPER_PUBLIC_ORIGIN: 'https://wordpaper.example.test',
    });
    const secureResponse = await fetch(running.base + '/api/auth/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json', Origin: 'https://wordpaper.example.test',
        'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'wordpaper.example.test',
      },
      body: JSON.stringify({ username: 'secure_cookie_user', password: 'correct secure password' }),
    });
    assert.equal(secureResponse.status, 201);
    const secureCookie = secureResponse.headers.get('set-cookie');
    assert.match(secureCookie, /^__Host-wp_session=/);
    assert.match(secureCookie, /; Secure/);

    const proxyRateStatuses = [];
    for (let attempt = 0; attempt < 31; attempt += 1) {
      const rateResponse = await fetch(running.base + '/api/auth/register', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json', Origin: 'https://wordpaper.example.test',
          'X-Forwarded-Proto': `http, https`,
          'X-Forwarded-Host': `attacker.example, wordpaper.example.test`,
          'X-Forwarded-For': `203.0.113.${attempt}, 198.51.100.77`,
        },
        body: JSON.stringify({ email: 'not-an-email', password: 'correct secure password' }),
      });
      proxyRateStatuses.push(rateResponse.status);
    }
    assert.equal(proxyRateStatuses.filter(status => status === 400).length, 30);
    assert.equal(proxyRateStatuses.at(-1), 429, 'spoofed leftmost X-Forwarded-For bypassed rate limiting');

    await stopServer(running.child);
    running = await startServer(port, dataDir, {
      NODE_ENV: 'test', TRUST_PROXY: '0', WORDPAPER_PUBLIC_ORIGIN: '',
      WORDPAPER_MODE: 'local', WORDPAPER_COMPANION_ENABLED: '1',
    });
    const localOwner = await register(running.base, 'local_companion_owner', 'correct local owner');
    const localOther = await register(running.base, 'local_companion_other', 'correct local other');
    const ownerSync = await fetch(running.base + '/pet-sync.php', {
      method: 'POST',
      headers: { Cookie: localOwner.cookie, Origin: running.base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ library: 'gre', knownWords: [] }),
    });
    assert.equal(ownerSync.status, 200, 'first account should drive the local companion even while it is stopped');
    // 同机多账号共享:第二个账号也能看到并驱动这台 Mac 的伴侣(桌面是物理共享资源),
    // 但服务端学习数据仍按账号各自独立(由上面的 A/B 隔离断言覆盖)。
    const otherStatus = await fetch(running.base + '/status.json', { headers: { Cookie: localOther.cookie } });
    assert.equal(otherStatus.status, 200);
    assert.equal((await otherStatus.json()).available, true, 'same-machine second account shares the device companion');
    const otherSync = await fetch(running.base + '/pet-sync.php', {
      method: 'POST',
      headers: { Cookie: localOther.cookie, Origin: running.base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ library: 'cet4', knownWords: [] }),
    });
    assert.equal(otherSync.status, 200, 'same-machine second account can sync its own context to the companion');

    console.log('PASS server persistence, A/B state isolation, same-machine companion sharing, conflict/CSRF checks, auth hashing, secure proxy cookie, static containment, and public single-port mode');
  } finally {
    if (running) await stopServer(running.child).catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
