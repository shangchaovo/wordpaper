#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { freePort, startMockProvider, startApp, stopApp, startFlow, callback, cookieValue } = require('./test_oauth');

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-account-links-'));
  const port = await freePort(), mockPort = await freePort();
  const mock = await startMockProvider(mockPort, []);
  let app, db;
  try {
    const browserOrigin = `http://localhost:${port}`;
    app = await startApp(port, dataDir, `http://127.0.0.1:${mockPort}`, process.argv.includes('--browser') ? {
      WORDPAPER_GOOGLE_REDIRECT_URI: browserOrigin + '/api/auth/google/callback',
      WORDPAPER_WECHAT_REDIRECT_URI: browserOrigin + '/api/auth/wechat/callback',
    } : {});
    // A different site from the mock provider exercises real SameSite cookie
    // behavior, not merely redirects between two ports on 127.0.0.1.
    const base = process.argv.includes('--browser') ? app.base.replace('127.0.0.1', 'localhost') : app.base;
    db = new DatabaseSync(path.join(dataDir, 'wordpaper.sqlite'));
    async function api(route, account, body, extra = {}) {
      const response = await fetch(base + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Origin: base, Cookie: account?.cookie || '', 'X-CSRF-Token': account?.csrfToken || '', 'Content-Type': 'application/json', ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'manual',
      });
      return { response, body: await response.json() };
    }
    async function passwordLogin(username, register = false) {
      const r = await api('/api/auth/' + (register ? 'register' : 'login'), null, { username, password: 'account-test-password' });
      assert.equal(r.response.status, register ? 201 : 200);
      return { ...r.body, cookie: cookieValue(r.response, 'wp_session') };
    }
    async function oauthLogin(provider, code) {
      const flow = await startFlow(base, provider, '/');
      const r = await callback(base, provider, flow, code);
      assert.equal(r.headers.get('location'), '/');
      const cookie = cookieValue(r, 'wp_session');
      return { ...(await api('/api/session', { cookie })).body, cookie };
    }
    async function accountFlow(account, provider, purpose) {
      const r = await api(`/api/account/${provider}/${purpose}`, account, {});
      assert.equal(r.response.status, 200, JSON.stringify(r.body));
      assert.ok(r.response.headers.getSetCookie().some(value => value.startsWith(account.cookie + ';') && value.includes('SameSite=Lax')));
      const authorization = new URL(r.body.authorizationUrl);
      return { state: authorization.searchParams.get('state'), flowCookie: cookieValue(r.response, 'wp_oauth_flow') };
    }
    async function finish(account, provider, purpose, code, expected = 'accountSuccess=bound') {
      const flow = await accountFlow(account, provider, purpose);
      // Simulate the real cross-site callback: only the Lax flow cookie arrives.
      const r = await callback(base, provider, flow, code);
      assert.ok(r.headers.get('location').includes(expected), r.headers.get('location'));
      assert.equal(cookieValue(r, 'wp_session'), '', 'binding unexpectedly switched the login session');
      return flow;
    }
    async function details(account) { return (await api('/api/account', account)).body; }
    async function restart() {
      await stopApp(app.child);
      app = await startApp(port, dataDir, `http://127.0.0.1:${mockPort}`);
    }

    if (process.argv.includes('--browser')) {
      await new Promise((resolve, reject) => {
        const child = spawn('python3', ['scripts/test_account_links_browser.py'], {
          cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
          env: { ...process.env, WORDPAPER_TEST_BASE_URL: base, WORDPAPER_TEST_DB: path.join(dataDir, 'wordpaper.sqlite') },
        });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`browser test exited ${code}`)));
      });
      return;
    }

    const a = await passwordLogin('legacy-account', true);
    const b = await oauthLogin('google', 'google-code-b');
    // Simulate an identity created by the pre-binding implementation.
    db.prepare('UPDATE users SET username_key = ? WHERE id = ?').run('federated:google:google-subject-b', b.user.id);
    const original = { reminders: [{ id: 'private', text: '原账号的提醒' }], review: { custom: { words: { sample: { stage: 3 } } } }, customWords: [{ word: 'sample', meaning: '样本' }] };
    for (const [namespace, value] of Object.entries(original)) {
      const r = await fetch(`${base}/api/state/${namespace}`, {
        method: 'PUT', headers: { Cookie: a.cookie, Origin: base, 'X-CSRF-Token': a.csrfToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ value, expectedRevision: 0 }),
      });
      assert.equal(r.status, 200);
    }
    assert.equal((await api('/api/account')).response.status, 401);
    assert.equal((await api('/api/account/google/link', a, {}, { 'X-CSRF-Token': '' })).response.status, 403);
    assert.equal((await api('/api/account/google/link', a, {}, { Origin: 'https://evil.test' })).response.status, 403);
    assert.equal((await api('/api/account/google/link', a)).response.status, 405);
    const initial = await details(a);
    assert.equal(initial.hasPassword, true);
    assert.equal(initial.reauthRequired, false);
    assert.ok(initial.providers.every(p => !p.bound));
    assert.ok(!JSON.stringify(initial).includes('passwordHash'));

    const link = await finish(a, 'google', 'link', 'google-code-a');
    assert.match((await callback(base, 'google', link, 'google-code-a')).headers.get('location'), /oauth_expired/);
    const viaGoogle = await oauthLogin('google', 'google-code-a');
    assert.equal(viaGoogle.user.id, a.user.id);
    assert.equal(viaGoogle.allowLegacyImport, false);
    await finish(a, 'wechat', 'link', 'wechat-code-a');
    const viaWechat = await oauthLogin('wechat', 'wechat-code-a');
    assert.equal(viaWechat.user.id, a.user.id);
    assert.deepEqual((await api('/api/state', viaWechat)).body.state, original);
    assert.deepEqual((await api('/api/state', b)).body.state, {});

    await finish(a, 'google', 'replace', 'google-code-b', 'accountError=identity_in_use');
    await finish(a, 'google', 'replace', 'google-code-unverified', 'accountError=oauth_failed');
    await finish(a, 'wechat', 'replace', 'wechat-code-failed', 'accountError=oauth_failed');
    const cancel = await accountFlow(a, 'google', 'replace');
    const cancelled = await fetch(`${base}/api/auth/google/callback?state=${cancel.state}&error=access_denied`, { headers: { Cookie: cancel.flowCookie }, redirect: 'manual' });
    assert.match(cancelled.headers.get('location'), /accountError=oauth_cancelled/);
    assert.equal((await details(a)).providers[0].label, 'google.one@example.test');

    const stale = await accountFlow(a, 'google', 'replace');
    await finish(a, 'google', 'replace', 'google-code-c');
    assert.match((await callback(base, 'google', stale, 'google-code-a')).headers.get('location'), /accountError=binding_changed/);
    assert.equal((await api('/api/session', viaGoogle)).response.status, 401, 'old device session survived replacement');
    assert.equal((await api('/api/session', viaWechat)).response.status, 401);
    assert.equal((await api('/api/session', a)).response.status, 200);
    const viaNewGoogle = await oauthLogin('google', 'google-code-c');
    assert.equal(viaNewGoogle.user.id, a.user.id);
    const viaDetached = await oauthLogin('google', 'google-code-a');
    assert.notEqual(viaDetached.user.id, a.user.id);
    assert.deepEqual((await api('/api/state', viaDetached)).body.state, {});
    await restart();

    assert.equal((await details(a)).providers[0].label, 'google.three@example.test');
    assert.deepEqual((await api('/api/state', a)).body.state, original);
    assert.equal((await api('/api/account/google/unlink', a, {})).response.status, 200);
    assert.equal((await api('/api/session', viaNewGoogle)).response.status, 401);
    assert.equal((await details(a)).providers[0].bound, false);
    assert.equal((await api('/api/account/google/unlink', b, {})).body.code, 'last_login_method');

    // Expired reauthentication is enforced by the server, not just disabled UI.
    db.prepare('UPDATE sessions SET authenticated_at = 0 WHERE user_id = ?').run(a.user.id);
    assert.equal((await details(a)).reauthRequired, true);
    assert.equal((await api('/api/account/wechat/unlink', a, {})).body.code, 'reauth_required');
    assert.equal((await api('/api/account/reauth', a, { password: 'wrong' })).response.status, 403);
    assert.equal((await api('/api/account/reauth', a, { password: 'account-test-password' })).response.status, 200);
    assert.equal((await details(a)).reauthRequired, false);

    db.prepare('UPDATE sessions SET authenticated_at = 0 WHERE user_id = ?').run(b.user.id);
    await finish(b, 'google', 'reauth', 'google-code-c', 'accountError=binding_changed');
    assert.equal((await details(b)).reauthRequired, true);
    await finish(b, 'google', 'reauth', 'google-code-b', 'accountSuccess=verified');
    await finish(b, 'wechat', 'link', 'wechat-code-b');
    assert.equal((await api('/api/account/google/unlink', b, {})).response.status, 200);
    assert.equal((await api('/api/account/wechat/unlink', b, {})).body.code, 'last_login_method');
    const legacyDetached = await oauthLogin('google', 'google-code-b');
    assert.notEqual(legacyDetached.user.id, b.user.id, 'legacy internal login key prevented detached identity registration');

    const switched = await accountFlow(a, 'google', 'link');
    assert.match((await callback(base, 'google', switched, 'google-code-c', `${switched.flowCookie}; ${b.cookie}`)).headers.get('location'), /accountError=oauth_expired/);
    const expired = await accountFlow(a, 'google', 'link');
    db.prepare('UPDATE oauth_flows SET expires_at = 0').run();
    assert.match((await callback(base, 'google', expired, 'google-code-c')).headers.get('location'), /oauth_expired/);
    const afterLogout = await accountFlow(a, 'google', 'link');
    await fetch(base + '/api/session', { method: 'DELETE', headers: { Cookie: a.cookie, Origin: base, 'X-CSRF-Token': a.csrfToken } });
    assert.match((await callback(base, 'google', afterLogout, 'google-code-c')).headers.get('location'), /accountError=oauth_expired/);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM auth_identities WHERE user_id = ? AND provider = 'google'").get(a.user.id).n, 0);
    await restart();
    const passwordStillWorks = await passwordLogin('legacy-account');
    assert.equal(passwordStillWorks.user.id, a.user.id);
    assert.deepEqual((await api('/api/state', passwordStillWorks)).body.state, original);
    console.log('PASS account link/replace/unlink, preserved data and password, conflicts, callback replay/cancellation/expiry, reauthentication, last-method guard, session revocation and restart persistence');
  } finally {
    if (db) db.close();
    if (app) await stopApp(app.child).catch(() => {});
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
