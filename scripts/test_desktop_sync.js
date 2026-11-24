#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { freePort, startMockProvider, startApp, stopApp, cookieValue, startFlow, callback } = require('./test_oauth');
const { DatabaseSync } = require('node:sqlite');
const vm = require('node:vm');
const { openStorage } = require('../lib/storage');
const { normalizeUrl } = require('../lib/upstream');

(async () => {
  assert.throws(() => normalizeUrl('http://fd-public.example.com'), /https/);
  assert.equal(normalizeUrl('http://[fd00::1]:8770'), 'http://[fd00::1]:8770');
  const { merge } = require('../js/state-merge');
  const a = { word: 'alpha', meaning: '甲' }, b = { word: 'beta', meaning: '乙' };
  const mergedWords = merge('customWords', [a, b], [b], [a, { ...b, meaning: '修改' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(mergedWords.value)), [{ ...b, meaning: '修改' }], 'an offline edit to B cannot revive deleted A');
  assert.equal(merge('customWords', [a], [], [{ ...a, meaning: '修改' }]).conflict, true, 'preserve delete / edit conflicts');
  const scheduled = { stage: 1, due: 1000 };
  const reviewAt = words => ({ cet4: { words } });
  assert.equal(merge('review', reviewAt({ a: scheduled }), reviewAt({ a: { ...scheduled, due: 0 } }),
    reviewAt({ a: { ...scheduled, stage: 2 } })).conflict, true, 'one word schedule stays atomic during an undo');
  assert.deepEqual(JSON.parse(JSON.stringify(merge('settings', { theme: 'x', font: 1 },
    { theme: 'y', font: 1 }, { theme: 'x', font: 2 }).value)), { theme: 'y', font: 2 });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-desktop-sync-'));
  const mockPort = await freePort(), mockBase = `http://127.0.0.1:${mockPort}`;
  const mock = await startMockProvider(mockPort, []);
  const preview = http.createServer((req, res) => {
    res.writeHead(405, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>WordPaper 预览</title>');
  });
  const apps = [];
  try {
    await new Promise((resolve, reject) => {
      preview.once('error', reject);
      preview.listen(0, '127.0.0.1', resolve);
    });
    const previewOrigin = `http://127.0.0.1:${preview.address().port}`;
    for (const mode of ['public', 'local', 'local']) {
      apps.push(await startApp(await freePort(), path.join(root, String(apps.length)), mockBase, { WORDPAPER_MODE: mode, WORDPAPER_COMPANION_ENABLED: '0' }));
    }
    const emailOnly = await startApp(await freePort(), path.join(root, 'email-only'), mockBase, {
      WORDPAPER_GOOGLE_CLIENT_SECRET: '', WORDPAPER_GITHUB_CLIENT_SECRET: '', WORDPAPER_WECHAT_APP_SECRET: '',
    });
    apps.push(emailOnly);
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
    // Upgrade an actual private pairing, including a pending native write, in
    // the same private data directory that the new official-only App reopens.
    const legacyDir = path.join(root, 'legacy-device');
    const legacyPort = await freePort();
    const desktopEnv = { WORDPAPER_MODE: 'local', WORDPAPER_COMPANION_ENABLED: '0' };
    const cloudEnv = { ...desktopEnv, WORDPAPER_DESKTOP_CLOUD: '1', WORDPAPER_TEST_DESKTOP_CLOUD_ORIGIN: cloud.base };
    const agingApp = await startApp(legacyPort, legacyDir, mockBase, desktopEnv);
    apps.push(agingApp);
    const legacyAccount = await api(emailOnly, '/api/auth/register', { username: 'legacy-test', password: 'only-for-the-fixture' });
    const reminder = [{ id: 'pending', text: '离线提醒', done: false, time: '' }];
    // Browsers on the legacy mirror can still hold an older standalone cookie.
    const dormant = process.argv.includes('--browser') ? null : await api(agingApp, '/api/auth/register', {
      username: 'old-local-owner', password: 'legacy-local-password',
    });
    const paired = await api(agingApp, '/api/pair', { url: emailOnly.base, identifier: 'legacy-test', password: 'only-for-the-fixture' });
    assert.equal(paired.response.status, 200);
    const oldDb = openStorage(legacyDir);
    oldDb.putState(paired.user.id, 'reminders', reminder, 0, true);
    oldDb.close();
    await stopApp(agingApp.child);
    const migrated = await startApp(legacyPort, legacyDir, mockBase, cloudEnv);
    apps.push(migrated);
    const discovery = () => api(migrated, '/api/auth/providers');
    assert.equal((await discovery()).paired, null);
    assert.equal((await discovery()).hasLocalAccount, Boolean(dormant));
    assert.deepEqual((await discovery()).legacyConnection, { username: 'legacy-test', pending: 1 });
    assert.equal((await api(migrated, '/api/session', undefined, paired)).response.status, 401);
    if (dormant) {
      assert.equal((await api(migrated, '/api/session', undefined, dormant)).response.status, 401);
      assert.equal((await fetch(migrated.base + '/', { headers: { Cookie: dormant.cookie }, redirect: 'manual' })).headers.get('location'), '/login.html');
    }
    assert.equal((await api(migrated, '/api/auth/resume', {})).response.status, 409);
    assert.equal((await api(migrated, '/api/unpair', {})).response.status, 409);
    assert.equal((await api(migrated, '/api/pair', { url: emailOnly.base })).response.status, 404);
    assert.equal((await api(migrated, '/api/desktop/start', { provider: 'google' })).response.status, 409);
    assert.equal((await api(migrated, '/api/desktop/disconnect-legacy', {})).response.status, 400);
    assert.equal((await fetch(migrated.base + '/api/desktop/disconnect-legacy', {
      method: 'POST', body: '{"confirmed":true}', headers: { 'Content-Type': 'application/json' },
    })).status, 403);
    assert.equal((await fetch(migrated.base + '/guest')).status, 200);
    assert.ok((await discovery()).legacyConnection);
    assert.equal(fs.existsSync(path.join(legacyDir, 'recovery')), false);
    if (process.argv.includes('--browser')) {
      const fresh = await startApp(await freePort(), path.join(root, 'fresh-browser'), mockBase, cloudEnv);
      apps.push(fresh);
      await new Promise((resolve, reject) => {
        const child = spawn('python3', ['scripts/test_desktop_sync_browser.py'], {
          cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
          env: {
            ...process.env, WORDPAPER_TEST_BASE_URL: fresh.base.replace('127.0.0.1', 'localhost'),
            WORDPAPER_TEST_LEGACY_BASE_URL: migrated.base.replace('127.0.0.1', 'localhost'),
            WORDPAPER_TEST_CLOUD: cloud.base, WORDPAPER_TEST_PREVIEW: previewOrigin,
          },
        });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`desktop browser test exited ${code}`)));
      });
      return;
    }
    await stopApp(migrated.child);
    const restarted = await startApp(legacyPort, legacyDir, mockBase, cloudEnv);
    apps.push(restarted);
    assert.deepEqual((await discovery()).legacyConnection, { username: 'legacy-test', pending: 1 });
    const denied = await fetch(migrated.base + '/api/desktop/disconnect-legacy', {
      method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: '{"confirmed":true}',
    });
    assert.equal(denied.status, 403);
    // A disk error cannot discard the queue or complete a user's consent.
    const recoveryDir = path.join(legacyDir, 'recovery');
    fs.writeFileSync(recoveryDir, 'temporary obstacle');
    assert.equal((await api(migrated, '/api/desktop/disconnect-legacy', { confirmed: true })).response.status, 503);
    assert.equal((await discovery()).legacyConnection.pending, 1);
    fs.unlinkSync(recoveryDir);
    const disconnected = await api(migrated, '/api/desktop/disconnect-legacy', { confirmed: true });
    assert.equal(disconnected.response.status, 200);
    assert.equal((await discovery()).legacyConnection, null);
    assert.equal((await api(migrated, '/api/session', undefined, paired)).response.status, 401);
    assert.equal((await api(migrated, '/api/session', undefined, dormant)).response.status, 401);
    const explicitLogin = await api(migrated, '/api/auth/login', { username: 'old-local-owner', password: 'legacy-local-password' });
    assert.equal(explicitLogin.user.id, dormant.user.id);
    assert.equal((await api(migrated, '/api/session', undefined, explicitLogin)).user.id, dormant.user.id);
    const nativeSource = fs.readFileSync(path.resolve(__dirname, '../companion.js'), 'utf8');
    const activeAccount = nativeSource.slice(nativeSource.indexOf('function activeUserId('), nativeSource.indexOf('let patrickIdleCache'));
    const cfg = { srsUserId: paired.user.id };
    const lookup = vm.runInNewContext('(' + activeAccount + ')', { CFG: cfg });
    const dbForNative = new DatabaseSync(path.join(legacyDir, 'wordpaper.sqlite'));
    assert.equal(lookup(dbForNative), null, 'old companion selection still opened the archived mirror');
    cfg.srsUserId = dormant.user.id;
    assert.equal(lookup(dbForNative), dormant.user.id, 'ordinary local companion account was hidden');
    dbForNative.close();
    const file = path.join(recoveryDir, disconnected.recoveryFile);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const archived = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(archived.pending.reminders.value, reminder);
    assert.deepEqual(archived.state.reminders, reminder);
    assert.ok(!JSON.stringify(archived).match(/wp_session|csrfToken|only-for-the-fixture/));
    assert.equal((await api(migrated, '/api/desktop/disconnect-legacy', { confirmed: true })).response.status, 200);
    assert.equal(fs.readdirSync(recoveryDir).length, 1);
    assert.equal((await api(migrated, '/api/desktop/start', { provider: 'google', url: emailOnly.base })).response.status, 400);
    assert.equal((await api(migrated, '/api/auth/register', { username: 'new', password: 'new-password123' })).response.status, 403);
    const official = await connect(migrated);
    assert.equal((await discovery()).paired.url, cloud.base);
    assert.deepEqual((await api(emailOnly, '/api/state', undefined, legacyAccount)).state, {});
    assert.deepEqual((await api(cloud, '/api/state', undefined, official.account)).state, {});
    const persisted = openStorage(legacyDir);
    assert.deepEqual(persisted.getState(paired.user.id).state.reminders, reminder);
    assert.equal(persisted.metaGet('upstream_queue'), null);
    persisted.close();
    await stopApp(restarted.child);
    const officialRestart = await startApp(legacyPort, legacyDir, mockBase, cloudEnv);
    apps.push(officialRestart);
    assert.equal((await api(officialRestart, '/api/session', undefined, official.local)).user.id, official.local.user.id);
    assert.equal((await discovery()).paired.url, cloud.base);
    console.log('PASS private desktop pairing pauses across restart until consent, saves pending changes locally, and accepts only the official cloud');
    const unsupported = await api(desk1, '/api/desktop/start', { url: previewOrigin, provider: 'wechat' });
    assert.equal(unsupported.response.status, 502);
    assert.match(unsupported.error, /未提供 WordPaper 账号同步/);
    assert.equal((await api(desk1, '/api/auth/providers')).github.enabled, false, 'local service exposed the hosted GitHub login');
    for (const [provider, label] of [['google', 'Google 登录'], ['github', 'GitHub 登录'], ['wechat', '微信登录']]) {
      const unavailable = await api(desk1, '/api/desktop/start', { url: emailOnly.base, provider });
      assert.equal(unavailable.response.status, 503);
      assert.ok(unavailable.error.includes(label));
      assert.match(unavailable.error, /邮箱 \/ 原账号登录/);
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

    // Practice events from two desktops merge, including a stale revision,
    // rather than letting one device erase the other device's daily effort.
    const activity = require('../js/learning-activity');
    const nativeActivity = activity.record({}, { action: 'quiz', activityId: 'native-quiz', at: Date.now() });
    const activityDb = new DatabaseSync(path.join(root, '1', 'wordpaper.sqlite'));
    assert.equal(writer(activityDb, first.local.user.id, nativeActivity, 'learningActivity'), true);
    activityDb.close();
    const secondActivity = activity.record({}, { action: 'sentence', activityId: 'second-sentence', at: Date.now() });
    await api(desk1, '/api/state', undefined, first.local);
    const activityWrite = await api(desk2, '/api/state/learningActivity', { value: secondActivity, expectedRevision: 0 }, second.local, 'PUT');
    assert.equal(activityWrite.response.status, 200);
    const combinedActivity = activity.merge(nativeActivity, secondActivity);
    assert.deepEqual(activityWrite.value, combinedActivity);
    assert.deepEqual((await api(cloud, '/api/state', undefined, first.account)).state.learningActivity, combinedActivity);
    assert.deepEqual((await api(desk1, '/api/state', undefined, first.local)).state.learningActivity, combinedActivity);

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
    // A committed cloud PUT can lose its reply. The exact same value on
    // replay is an acknowledgement, even while a newer local edit is queued.
    const lost = JSON.parse(localStorage.metaGet('upstream_queue')).review;
    localStorage.putState(first.local.user.id, 'review', { generation: 'c' }, 3, true);
    localStorage.settleQueuedState(first.local.user.id, 'review', lost, { conflict: true, value: lost.value, revision: 3 });
    const newer = JSON.parse(localStorage.metaGet('upstream_queue')).review;
    assert.deepEqual(newer.value, { generation: 'c' });
    assert.equal(newer.baseRevision, 3);
    assert.equal(localStorage.mirrorConflicts(first.local.user.id, true), 0);
    // Restore the fixture to the actual cloud revision before continuing.
    localStorage.metaDelete('upstream_queue');
    localStorage.replaceState(first.local.user.id, 'review', review, 1);
    localStorage.close();
    assert.equal((await api(desk1, '/api/account', undefined, first.local)).accountUrl, cloud.base + '/login.html?next=%2F%23account');
    assert.equal((await api(desk1, '/api/account/open-center', undefined, first.local)).response.status, 405);
    assert.equal((await api(desk1, '/api/account/open-center', {})).response.status, 401);
    assert.equal((await api(desk1, '/api/account/open-center', {}, { ...first.local, csrfToken: '' })).response.status, 403);
    assert.equal((await api(cloud, '/api/account/open-center', {}, first.account)).response.status, 404);
    assert.equal((await api(cloud, '/api/desktop/start', { url: cloud.base, provider: 'google' })).response.status, 404);
    assert.equal((await api(cloud, '/api/desktop/open', {})).response.status, 404);
    assert.equal((await api(desk1, '/api/desktop/open', {})).response.status, 410);
    assert.equal((await api(desk1, '/api/desktop/open', {}, { ...first.local, csrfToken: '' })).response.status, 403);
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
    assert.equal((await api(desk2, '/api/desktop/open', {}, cancelAccount)).response.status, 410);
    assert.equal((await api(desk2, '/api/desktop/poll', {}, cancelAccount)).response.status, 410);
    // WeChat can independently authorize a desktop, using the same protocol.
    const wechat = await connect(desk2, 'wechat', second.local);
    const github = await connect(desk2, 'github', wechat.local);
    assert.equal(github.account.user.username, 'github-user-a');
    assert.equal(github.local.user.username, github.account.user.username);

    // Unpair removes only the cloud shadow; existing local data/account survives.
    assert.equal((await api(desk1, '/api/unpair', {}, first.local)).response.status, 200);
    const original = await api(desk1, '/api/auth/login', { username: '谷歌用户', password: 'local-secret-password' });
    assert.equal(original.user.id, localExisting.user.id);
    // A separate local password account still works after upgrading its App,
    // including an existing session originally issued by the standalone mode.
    await stopApp(desk1.child);
    const standalone = await startApp(Number(new URL(desk1.base).port), path.join(root, '1'), mockBase, cloudEnv);
    apps.push(standalone);
    const localProviders = await api(standalone, '/api/auth/providers');
    assert.equal(localProviders.hasLocalAccount, true);
    assert.equal(localProviders.legacyConnection, null);
    assert.equal((await api(standalone, '/api/session', undefined, original)).user.id, localExisting.user.id);
    assert.equal((await api(standalone, '/api/auth/login', { username: '谷歌用户', password: 'local-secret-password' })).user.id, localExisting.user.id);
    const db = new DatabaseSync(path.join(root, '0', 'wordpaper.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM device_flows WHERE user_id IS NOT NULL').get().n, 0);
    db.close();
    console.log('PASS desktop device approval, private verifier/replay/cancel guards, Google, GitHub and WeChat, two Apps + web sync, local-account isolation and unpair preservation');
  } finally {
    for (const app of apps) await stopApp(app.child).catch(() => {});
    await new Promise(resolve => preview.close(resolve));
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
