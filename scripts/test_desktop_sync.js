#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { freePort, startMockProvider, startApp, stopApp, cookieValue, startFlow, callback } = require('./test_oauth');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const { openStorage } = require('../lib/storage');
const { normalizeUrl } = require('../lib/upstream');

(async () => {
  assert.throws(() => normalizeUrl('http://fd-public.example.com'), /https/);
  assert.equal(normalizeUrl('http://[fd00::1]:8770'), 'http://[fd00::1]:8770');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-desktop-sync-'));
  const mockPort = await freePort(), mockBase = `http://127.0.0.1:${mockPort}`;
  const mock = await startMockProvider(mockPort, []);
  const apps = [];
  try {
    for (const mode of ['public', 'local', 'local']) {
      apps.push(await startApp(await freePort(), path.join(root, String(apps.length)), mockBase, { WORDPAPER_MODE: mode, WORDPAPER_COMPANION_ENABLED: '0' }));
    }
    const [cloud, desk1, desk2] = apps;
    async function api(app, route, body, account, method) {
      const response = await fetch(app.base + route, {
        method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'manual',
        headers: { Origin: app.base, Cookie: account?.cookie || '', 'X-CSRF-Token': account?.csrfToken || '', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      return { response, ...result, cookie: cookieValue(response, 'wp_session') || account?.cookie, flow: cookieValue(response, 'wp_desktop_flow') };
    }
    async function authorize(start, code = 'google-code-a', provider = 'google') {
      const requested = new URL(start.verificationUrl);
      const flow = await startFlow(cloud.base, provider, requested.searchParams.get('next'));
      const response = await callback(cloud.base, provider, flow, code);
      const account = { cookie: cookieValue(response, 'wp_session') };
      Object.assign(account, await api(cloud, '/api/session', undefined, account));
      const approved = await api(cloud, '/api/device/approve', { userCode: start.userCode }, account);
      assert.equal(approved.response.status, 200, JSON.stringify(approved));
      return account;
    }
    async function connect(app, provider = 'google', old) {
      const start = await api(app, '/api/desktop/start', { url: cloud.base, provider }, old);
      assert.equal(start.response.status, 200, JSON.stringify(start));
      assert.ok(!JSON.stringify(start).includes('deviceCode'), 'desktop browser received the private device code');
      const pollAccount = { cookie: [start.flow, old?.cookie].filter(Boolean).join('; '), csrfToken: old?.csrfToken };
      assert.equal((await api(app, '/api/desktop/poll', {}, pollAccount)).pending, true);
      const account = await authorize(start, `${provider}-code-a`, provider);
      const done = await api(app, '/api/desktop/poll', {}, pollAccount);
      assert.equal(done.response.status, 200, JSON.stringify(done));
      assert.equal(done.ok, true);
      const local = await api(app, '/api/session', undefined, done);
      assert.equal(local.mirrored, true);
      return { local, account };
    }
    if (process.argv.includes('--browser')) {
      await new Promise((resolve, reject) => {
        const child = spawn('python3', ['scripts/test_desktop_sync_browser.py'], {
          cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
          env: { ...process.env, WORDPAPER_TEST_BASE_URL: desk1.base.replace('127.0.0.1', 'localhost'), WORDPAPER_TEST_CLOUD: cloud.base },
        });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`desktop browser test exited ${code}`)));
      });
      return;
    }
    const localExisting = await api(desk1, '/api/auth/register', { username: '谷歌用户', password: 'local-secret-password' });
    const first = await connect(desk1, 'google', localExisting);
    const second = await connect(desk2);
    assert.equal(first.account.user.id, second.account.user.id);
    assert.notEqual(first.local.user.id, localExisting.user.id, 'cloud reused a real local account');
    assert.equal((await api(desk1, '/api/state', undefined, localExisting)).response.status, 401, 'old local session accessed the cloud workspace');
    const value = [{ id: 'cloud', text: '网页与两台 App 的同一条提醒' }];
    const write = await api(desk1, '/api/state/reminders', { value, expectedRevision: 0 }, first.local, 'PUT');
    assert.equal(write.response.status, 200);
    assert.deepEqual((await api(desk2, '/api/state', undefined, second.local)).state.reminders, value);
    assert.deepEqual((await api(cloud, '/api/state', undefined, first.account)).state.reminders, value);
    // A native answer written while the workspace is closed must reach both
    // cloud and the other App. Exercise the real companion writer, no UI/TCC.
    const companionSource = fs.readFileSync(path.resolve(__dirname, '../companion.js'), 'utf8');
    const writer = vm.runInNewContext('(' + companionSource.slice(companionSource.indexOf('function writeReviewState('), companionSource.indexOf('/* 当前词库里所有到期词')) + ')', { console });
    const nativeDb = new DatabaseSync(path.join(root, '1', 'wordpaper.sqlite'));
    const review = { cet4: { words: { 'sync|同步': { word: { word: 'sync', meaning: '同步' }, stage: 1, due: Date.now() + 3600000 } } } };
    assert.equal(writer(nativeDb, first.local.user.id, review), true);
    nativeDb.close();
    const [read1, read2] = await Promise.all([api(desk1, '/api/state', undefined, first.local), api(desk1, '/api/state', undefined, first.local)]);
    assert.deepEqual(read1.state.review, review);
    assert.deepEqual(read2.state.review, review);
    assert.deepEqual((await api(desk2, '/api/state', undefined, second.local)).state.review, review);

    // A late acknowledgement of generation A preserves generation B. The
    // second process may have queued B while A was on the network.
    const localStorage = openStorage(path.join(root, '1'));
    const a = { value: { generation: 'a' }, baseRevision: 1 };
    localStorage.putState(first.local.user.id, 'review', a.value, 1, true);
    localStorage.putState(first.local.user.id, 'review', { generation: 'b' }, 2, true);
    localStorage.settleQueuedState(first.local.user.id, 'review', a, { revision: 2 });
    assert.deepEqual(localStorage.getState(first.local.user.id).state.review, { generation: 'b' });
    const b = JSON.parse(localStorage.metaGet('upstream_queue')).review;
    assert.equal(b.baseRevision, 2);
    localStorage.replaceUnqueuedState(first.local.user.id, 'review', { generation: 'stale' }, 2);
    assert.deepEqual(localStorage.getState(first.local.user.id).state.review, { generation: 'b' });
    // Restore the fixture to the actual cloud revision before continuing.
    localStorage.metaDelete('upstream_queue');
    localStorage.replaceState(first.local.user.id, 'review', review, 1);
    localStorage.close();
    assert.equal((await api(desk1, '/api/account', undefined, first.local)).accountUrl, cloud.base + '/#account');
    assert.equal((await api(cloud, '/api/desktop/start', { url: cloud.base, provider: 'google' })).response.status, 404);
    assert.equal((await api(desk1, '/api/device/start', { provider: 'google', challenge: 'x'.repeat(43) })).response.status, 404);

    // Possession of a displayed approval code is not enough to claim a session.
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const grant = await api(cloud, '/api/device/start', { provider: 'google', challenge });
    await authorize(grant);
    assert.equal((await api(cloud, '/api/device/token', { deviceCode: grant.deviceCode, verifier: 'x'.repeat(43) })).response.status, 410);
    const token = await api(cloud, '/api/device/token', { deviceCode: grant.deviceCode, verifier });
    assert.equal(token.response.status, 200);
    assert.ok(token.csrfToken);
    assert.equal((await api(cloud, '/api/device/token', { deviceCode: grant.deviceCode, verifier })).response.status, 410);

    const cancelled = await api(desk2, '/api/desktop/start', { url: cloud.base, provider: 'wechat' }, second.local);
    const cancelAccount = { ...second.local, cookie: second.local.cookie + '; ' + cancelled.flow };
    assert.equal((await api(desk2, '/api/desktop/cancel', {}, cancelAccount)).response.status, 200);
    assert.equal((await api(desk2, '/api/desktop/poll', {}, cancelAccount)).response.status, 410);
    // WeChat can independently authorize a desktop, using the same protocol.
    await connect(desk2, 'wechat', second.local);

    // Unpair removes only the cloud shadow; existing local data/account survives.
    assert.equal((await api(desk1, '/api/unpair', {}, first.local)).response.status, 200);
    const original = await api(desk1, '/api/auth/login', { username: '谷歌用户', password: 'local-secret-password' });
    assert.equal(original.user.id, localExisting.user.id);
    const db = new DatabaseSync(path.join(root, '0', 'wordpaper.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_flows WHERE user_id IS NOT NULL').get().n, 0);
    db.close();
    console.log('PASS desktop device approval, private verifier/replay/cancel guards, Google and WeChat, two Apps + web sync, local-account isolation and unpair preservation');
  } finally {
    for (const app of apps) await stopApp(app.child).catch(() => {});
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
