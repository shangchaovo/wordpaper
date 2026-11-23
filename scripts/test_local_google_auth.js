#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { callback, cookieValue, freePort, startApp, startFlow, stopApp } = require('./test_oauth');

const clientId = 'desktop-test.apps.googleusercontent.com';
const clientSecret = 'installed-test-key';
const webClient = { clientId: 'local-web-test.apps.googleusercontent.com', clientSecret: 'local-web-test-key' };
const webCallback = 'http://localhost:8770/api/auth/google/callback';
const password = 'local-google-test-password';

(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-local-google-'));
  const authFile = path.join(dataDir, 'test-google-authorization.txt');
  const configFile = path.join(dataDir, 'google-desktop.json');
  const exchanges = [];
  const mock = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/google/token' && req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString());
      exchanges.push(form);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: form.get('code') }));
      return;
    }
    if (url.pathname === '/google/userinfo') {
      const token = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (['shared-code', 'replacement-code'].includes(token)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sub: token.replace('-code', '-sub'), email: `${token}@example.test`, email_verified: true }));
        return;
      }
    }
    res.writeHead(404).end();
  });
  let local, cloud, db;
  try {
    await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
    const mockBase = `http://127.0.0.1:${mock.address().port}`;
    const noCloudGoogle = { WORDPAPER_GOOGLE_CLIENT_ID: '', WORDPAPER_WECHAT_APP_ID: '' };
    const [localPort, cloudPort] = await Promise.all([freePort(), freePort()]);
    local = await startApp(localPort, dataDir, mockBase, {
      ...noCloudGoogle, WORDPAPER_MODE: 'local', WORDPAPER_TEST_LOCAL_GOOGLE_BROWSER: '1',
      WORDPAPER_COMPANION_AUTOSTART: '0', WORDPAPER_PUBLIC_ORIGIN: '',
    });
    cloud = await startApp(cloudPort, dataDir, mockBase, { WORDPAPER_PUBLIC_ORIGIN: '' });
    db = new DatabaseSync(path.join(dataDir, 'wordpaper.sqlite'));
    const base = local.base.replace('127.0.0.1', 'localhost');

    async function api(route, body, account, extra = {}, origin = base) {
      const response = await fetch(origin + route, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-CSRF-Token': account?.csrfToken || '', Cookie: account?.cookie || '', ...extra },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { response, body: await response.json() };
    }

    const init = await api('/api/auth/providers');
    assert.equal(init.body.localGoogle, undefined);
    fs.writeFileSync(configFile, JSON.stringify({ web: { client_id: clientId, client_secret: clientSecret } }), { mode: 0o600 });
    assert.equal((await api('/api/auth/providers')).body.localGoogle, undefined, 'a Web credential enabled Desktop OAuth');
    fs.writeFileSync(configFile, JSON.stringify({ installed: { client_id: clientId, client_secret: clientSecret } }));
    assert.deepEqual((await api('/api/auth/providers')).body.localGoogle, { enabled: true });
    assert.equal((await api('/api/auth/providers', undefined, null, {}, cloud.base)).body.localGoogle, undefined);
    assert.equal((await api('/api/local-google/start', { purpose: 'login' }, null, {}, cloud.base)).response.status, 404);
    assert.equal((await api('/api/local-google/start', { purpose: 'login' }, null, { Origin: 'https://other.example.test' })).response.status, 403);

    // One SQLite file backs both instances. The public Google identity must
    // remain independent, even when both providers authenticate the same sub.
    const cloudFlow = await startFlow(cloud.base, 'google', '/');
    const cloudLogin = await callback(cloud.base, 'google', cloudFlow, 'shared-code');
    const cloudCookie = cookieValue(cloudLogin, 'wp_session');
    const cloudAccount = (await api('/api/session', undefined, { cookie: cloudCookie }, {}, cloud.base)).body;
    const registered = await api('/api/auth/register', { username: 'existing-local', password });
    assert.equal(registered.response.status, 201);
    const original = { ...registered.body, cookie: cookieValue(registered.response, 'wp_session') };
    const state = { customWords: [{ word: 'preserve', meaning: '保留' }] };
    const write = await fetch(base + '/api/state/customWords', {
      method: 'PUT', headers: { Origin: base, Cookie: original.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': original.csrfToken },
      body: JSON.stringify({ value: state.customWords, expectedRevision: 0 }),
    });
    assert.equal(write.status, 200);

    async function start(purpose, account, web = false) {
      const result = await api('/api/local-google/start', { purpose }, account);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      assert.deepEqual(result.body, { ok: true });
      const cookie = cookieValue(result.response, 'wp_local_google_flow');
      assert.ok(cookie);
      assert.match(result.response.headers.get('set-cookie'), /Path=\/api\/local-google; HttpOnly; SameSite=Strict/);
      const combined = { ...account, cookie: [account?.cookie, cookie].filter(Boolean).join('; ') };
      const authorization = new URL(fs.readFileSync(authFile, 'utf8'));
      const expectedClient = web ? webClient : { clientId, clientSecret };
      assert.equal(authorization.searchParams.get('client_id'), expectedClient.clientId);
      assert.equal(authorization.searchParams.get('client_secret'), null);
      assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
      const redirect = new URL(authorization.searchParams.get('redirect_uri'));
      if (web) assert.equal(redirect.href, webCallback);
      else {
        assert.equal(redirect.hostname, '127.0.0.1');
        assert.equal(redirect.pathname, '/');
        assert.ok(redirect.port && Number(redirect.port) !== localPort);
      }
      redirect.searchParams.set('state', authorization.searchParams.get('state'));
      return { combined, authorization, redirect, expectedClient };
    }

    async function browserResult(flow, variant, title) {
      const browser = await fetch(flow.redirect, { redirect: 'manual' });
      assert.equal(browser.status, 200);
      assert.equal(browser.headers.has('set-cookie'), false, 'system browser received a WordPaper cookie');
      assert.equal(browser.headers.get('cache-control'), 'no-store');
      assert.equal(browser.headers.get('referrer-policy'), 'no-referrer');
      const body = await browser.text();
      assert.ok(body.includes(`data-result="${variant}"`));
      assert.ok(body.includes(`<h1>${title}</h1>`));
      assert.match(body, /请返回 WordPaper App/);
      assert.ok(!body.includes(flow.redirect.searchParams.get('state')), 'browser result exposes its OAuth state');
      const css = body.match(/<style>([\s\S]+)<\/style>/)[1];
      const cssHash = crypto.createHash('sha256').update(css).digest('base64');
      const policy = browser.headers.get('content-security-policy');
      assert.ok(policy.includes("default-src 'none'"));
      assert.ok(policy.includes(`style-src 'sha256-${cssHash}'`));
      assert.ok(policy.includes('img-src data:'));
      assert.match(body, /<img src="data:image\/png;base64,/);
      assert.doesNotMatch(body, /<script|href="https?:|src="https?:/i);
    }

    async function code(flow, value) {
      flow.redirect.searchParams.set('code', value);
      await browserResult(flow, 'success', 'Google 授权已完成');
      const exchange = exchanges.at(-1);
      assert.equal(exchange.get('client_id'), flow.expectedClient.clientId);
      assert.equal(exchange.get('client_secret'), flow.expectedClient.clientSecret);
      assert.equal(exchange.get('redirect_uri'), flow.authorization.searchParams.get('redirect_uri'));
      const digest = crypto.createHash('sha256').update(exchange.get('code_verifier')).digest('base64url');
      assert.equal(digest, flow.authorization.searchParams.get('code_challenge'));
    }

    const poll = flow => api('/api/local-google/poll', {}, flow.combined);
    const declined = await start('login');
    declined.redirect.searchParams.set('error', 'access_denied');
    await browserResult(declined, 'cancelled', 'Google 授权已取消');
    assert.equal((await poll(declined)).body.code, 'oauth_cancelled');

    const failed = await start('login');
    failed.redirect.searchParams.set('code', 'unavailable-profile');
    await browserResult(failed, 'error', 'Google 授权未完成');
    assert.equal((await poll(failed)).body.code, 'oauth_failed');

    const unknown = await start('login');
    assert.deepEqual((await poll(unknown)).body, { pending: true });
    await code(unknown, 'shared-code');
    assert.equal((await poll(unknown)).body.code, 'identity_not_bound');
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);

    assert.equal((await api('/api/local-google/start', { purpose: 'login' }, original)).response.status, 409);
    assert.equal((await api('/api/local-google/start', { purpose: 'link' }, { cookie: original.cookie })).response.status, 403);
    const link = await start('link', original);
    const wrong = new URL(link.redirect);
    wrong.searchParams.set('state', crypto.randomBytes(32).toString('base64url'));
    assert.equal((await fetch(wrong)).status, 400);
    await code(link, 'shared-code');
    assert.equal(db.prepare("SELECT count(*) AS n FROM auth_identities WHERE provider='google-desktop'").get().n, 0);
    assert.equal((await api('/api/local-google/poll', {}, original)).body.code, 'oauth_expired');
    assert.deepEqual((await poll(link)).body, { ok: true });
    assert.equal((await poll(link)).body.code, 'oauth_expired');
    const localGoogle = (await api('/api/account', undefined, original)).body.providers.find(row => row.provider === 'google');
    assert.ok(localGoogle.enabled && localGoogle.bound && localGoogle.localDesktop);

    const login = await start('login');
    await code(login, 'shared-code');
    const logged = await poll(login);
    const loginCookie = cookieValue(logged.response, 'wp_session');
    assert.ok(loginCookie);
    const session = (await api('/api/session', undefined, { cookie: loginCookie })).body;
    assert.equal(session.user.id, original.user.id);
    assert.deepEqual((await api('/api/state', undefined, { cookie: loginCookie })).body.state, state);
    assert.equal((await api('/api/session', undefined, { cookie: loginCookie }, {}, cloud.base)).response.status, 401);
    const scopedCookie = loginCookie.replace('wp_session=', 'wp_session=wordpaper-local-google:');
    assert.equal((await api('/api/session', undefined, { cookie: scopedCookie }, {}, cloud.base)).response.status, 401);
    assert.equal((await api('/api/session', undefined, { cookie: loginCookie }, { 'X-Forwarded-For': '198.51.100.12' })).response.status, 401);

    db.prepare('UPDATE sessions SET authenticated_at = 0 WHERE user_id = ?').run(original.user.id);
    assert.equal((await api('/api/local-google/start', { purpose: 'replace' }, original)).body.code, 'reauth_required');
    const reauth = await start('reauth', original);
    await code(reauth, 'shared-code');
    assert.deepEqual((await poll(reauth)).body, { ok: true });
    const cancelled = await start('replace', original);
    assert.deepEqual((await api('/api/local-google/cancel', {}, cancelled.combined)).body, { ok: true });
    assert.equal((await poll(cancelled)).body.code, 'oauth_expired');
    const replacement = await start('replace', original);
    await code(replacement, 'replacement-code');
    assert.deepEqual((await poll(replacement)).body, { ok: true });
    assert.equal((await api('/api/session', undefined, { cookie: loginCookie })).response.status, 401);

    const unchangedCloud = (await api('/api/account', undefined, { cookie: cloudCookie }, {}, cloud.base)).body;
    assert.equal(unchangedCloud.user.id, cloudAccount.user.id);
    assert.equal(unchangedCloud.providers[0].label, 'shared-code@example.test');
    assert.equal(unchangedCloud.providers[0].localDesktop, undefined);
    assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
    assert.deepEqual((await api('/api/state', undefined, original)).body.state, state);

    // The fixed callback uses an explicitly approved port, so opt in to this
    // test on a machine where the normal App can leave loopback 8770 free.
    if (process.argv.includes('--fixed-web')) {
      const webFile = path.join(dataDir, 'google-local-web.json');
      const config = { client_id: webClient.clientId, client_secret: webClient.clientSecret, redirect_uri: webCallback };
      fs.writeFileSync(webFile, JSON.stringify(config), { mode: 0o600 });
      const preferred = await start('login');
      await api('/api/local-google/cancel', {}, preferred.combined);
      fs.unlinkSync(configFile);
      fs.writeFileSync(webFile, JSON.stringify({ ...config, redirect_uri: webCallback.replace('localhost', '127.0.0.1') }));
      assert.equal((await api('/api/auth/providers')).body.localGoogle, undefined);
      fs.writeFileSync(webFile, JSON.stringify(config));
      assert.deepEqual((await api('/api/auth/providers')).body.localGoogle, { enabled: true });

      const busy = http.createServer();
      await new Promise((resolve, reject) => {
        busy.once('error', reject);
        busy.listen(8770, '127.0.0.1', resolve);
      });
      try {
        const blocked = await api('/api/local-google/start', { purpose: 'login' });
        assert.equal(blocked.response.status, 503);
        assert.match(blocked.body.error, /8770/);
      } finally { await new Promise(resolve => busy.close(resolve)); }

      const viaWeb = await start('login', null, true);
      const wrongHost = new URL(viaWeb.redirect);
      wrongHost.hostname = '127.0.0.1';
      assert.equal((await fetch(wrongHost)).status, 404);
      await code(viaWeb, 'replacement-code');
      const authenticated = await poll(viaWeb);
      const cookie = cookieValue(authenticated.response, 'wp_session');
      assert.equal((await api('/api/session', undefined, { cookie })).body.user.id, original.user.id);
      assert.equal((await api('/api/session', undefined, { cookie }, {}, cloud.base)).response.status, 401);
      assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 2);
      console.log('PASS fixed Google Web approval callback, exact hostname, occupied-port failure, Desktop preference and same existing local account');
    }

    assert.equal((await api('/api/account/google/unlink', {}, original)).response.status, 200);
    assert.equal(db.prepare("SELECT count(*) AS n FROM auth_identities WHERE provider='google'").get().n, 1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM auth_identities WHERE provider='google-desktop'").get().n, 0);
    console.log('PASS standalone Google PKCE, private system-browser callback, local binding without account creation, isolated sessions, cancellation and independent public Google');
  } finally {
    if (db) db.close();
    if (local) await stopApp(local.child).catch(() => {});
    if (cloud) await stopApp(cloud.child).catch(() => {});
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
