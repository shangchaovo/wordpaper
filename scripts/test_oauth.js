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
const deliveredCodes = new Map();
const resendCalls = [];

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

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

function responseJson(res, value) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
}

async function requestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

async function startMockProvider(port, exchanges) {
  const googleProfiles = {
    'google-code-a': { sub: 'google-subject-a', email: 'google.one@example.test', email_verified: true, name: '谷歌用户' },
    'google-code-conflict': { sub: 'google-subject-conflict', email: 'mail.user@example.test', email_verified: true, name: '冲突用户' },
    'google-code-squat': { sub: 'google-subject-squat', email: 'provider.safe@example.test', email_verified: true, name: 'victim@example.test' },
    'google-code-b': { sub: 'google-subject-b', email: 'google.two@example.test', email_verified: true, name: 'Google B' },
    'google-code-c': { sub: 'google-subject-c', email: 'google.three@example.test', email_verified: true, name: 'Google C' },
    'google-code-unverified': { sub: 'google-unverified', email: 'unverified@example.test', email_verified: false },
  };
  const server = http.createServer(async (req, res) => {
    const parsed = new URL(req.url, `http://127.0.0.1:${port}`);
    const authorize = /^\/(google|wechat)\/authorize$/.exec(parsed.pathname);
    if (authorize) {
      const redirect = new URL(parsed.searchParams.get('redirect_uri'));
      redirect.searchParams.set('state', parsed.searchParams.get('state'));
      redirect.searchParams.set('code', `${authorize[1]}-code-${server.loginIdentity || 'a'}`);
      res.writeHead(302, { Location: redirect.toString() }); res.end(); return;
    }
    if (parsed.pathname === '/resend/emails' && req.method === 'POST') {
      assert.equal(req.headers.authorization, 'Bearer resend-test-key');
      assert.ok(req.headers['idempotency-key']);
      const payload = JSON.parse(await requestBody(req));
      assert.equal(payload.from, 'WordPaper <login@example.test>');
      const email = String(payload.to && payload.to[0] || '').toLowerCase();
      const match = /\b(\d{6})\b/.exec(String(payload.text || ''));
      assert.ok(email && match, 'verification delivery omitted email or code');
      deliveredCodes.set(email, match[1]);
      resendCalls.push(email);
      await new Promise(resolve => setTimeout(resolve, 80));
      responseJson(res, { id: `email-${resendCalls.length}` });
      return;
    }
    if (parsed.pathname === '/google/token' && req.method === 'POST') {
      const form = new URLSearchParams(await requestBody(req));
      assert.equal(form.get('client_id'), 'google-client-test');
      assert.equal(form.get('client_secret'), 'google-secret-test');
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.ok(form.get('code_verifier').length >= 43);
      exchanges.push({ provider: 'google', code: form.get('code'), verifier: form.get('code_verifier') });
      responseJson(res, { access_token: form.get('code'), token_type: 'Bearer', expires_in: 3600 });
      return;
    }
    if (parsed.pathname === '/google/userinfo') {
      const code = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      responseJson(res, googleProfiles[code] || googleProfiles['google-code-a']);
      return;
    }
    if (parsed.pathname === '/wechat/token') {
      assert.equal(parsed.searchParams.get('appid'), 'wechat-app-test');
      assert.equal(parsed.searchParams.get('secret'), 'wechat-secret-test');
      assert.equal(parsed.searchParams.get('grant_type'), 'authorization_code');
      const code = parsed.searchParams.get('code');
      if (code === 'wechat-code-failed') { responseJson(res, { errcode: 40029 }); return; }
      const openid = code === 'wechat-code-b' ? 'wechat-openid-b' : 'wechat-openid-a';
      exchanges.push({ provider: 'wechat', code, openid });
      responseJson(res, { access_token: `wechat-token-${openid}`, expires_in: 7200, openid, scope: 'snsapi_login' });
      return;
    }
    if (parsed.pathname === '/wechat/userinfo') {
      const openid = parsed.searchParams.get('openid');
      assert.equal(parsed.searchParams.get('access_token'), `wechat-token-${openid}`);
      responseJson(res, { openid, nickname: openid.endsWith('-b') ? '微信用户 B' : '微信用户 A' });
      return;
    }
    responseJson(res, { ok: true });
  });
  await listen(server, port);
  return server;
}

async function waitFor(base, child, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error('server exited early:\n' + output.join(''));
    try {
      const response = await fetch(base + '/healthz');
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  throw new Error('server did not become ready:\n' + output.join(''));
}

async function startApp(port, dataDir, mockBase, overrides = {}) {
  const output = [];
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', WORDPAPER_MODE: 'public', NODE_ENV: 'test',
      WORDPAPER_DATA_DIR: dataDir,
      WORDPAPER_GOOGLE_CLIENT_ID: 'google-client-test',
      WORDPAPER_GOOGLE_CLIENT_SECRET: 'google-secret-test',
      WORDPAPER_GOOGLE_REDIRECT_URI: base + '/api/auth/google/callback',
      WORDPAPER_WECHAT_APP_ID: 'wechat-app-test',
      WORDPAPER_WECHAT_APP_SECRET: 'wechat-secret-test',
      WORDPAPER_WECHAT_REDIRECT_URI: base + '/api/auth/wechat/callback',
      WORDPAPER_TEST_GOOGLE_AUTHORIZATION_ENDPOINT: mockBase + '/google/authorize',
      WORDPAPER_TEST_GOOGLE_TOKEN_ENDPOINT: mockBase + '/google/token',
      WORDPAPER_TEST_GOOGLE_USERINFO_ENDPOINT: mockBase + '/google/userinfo',
      WORDPAPER_TEST_WECHAT_AUTHORIZATION_ENDPOINT: mockBase + '/wechat/authorize',
      WORDPAPER_TEST_WECHAT_TOKEN_ENDPOINT: mockBase + '/wechat/token',
      WORDPAPER_TEST_WECHAT_USERINFO_ENDPOINT: mockBase + '/wechat/userinfo',
      WORDPAPER_RESEND_API_KEY: 'resend-test-key',
      WORDPAPER_EMAIL_FROM: 'WordPaper <login@example.test>',
      WORDPAPER_TEST_RESEND_ENDPOINT: mockBase + '/resend/emails',
      ...overrides,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  await waitFor(base, child, output);
  return { child, base, output };
}

async function stopApp(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not stop')), 7000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

function cookieValue(response, name) {
  const header = response.headers.get('set-cookie') || '';
  const match = new RegExp(`(?:^|,\\s*)${name}=([^;,\\s]+)`).exec(header);
  return match ? `${name}=${match[1]}` : '';
}

async function startFlow(base, provider, next, existingCookie) {
  const response = await fetch(`${base}/api/auth/${provider}/start?next=${encodeURIComponent(next || '/')}`, {
    headers: existingCookie ? { Cookie: existingCookie } : {},
    redirect: 'manual',
  });
  assert.equal(response.status, 302);
  const authorization = new URL(response.headers.get('location'));
  const flowCookie = cookieValue(response, 'wp_oauth_flow');
  assert.ok(flowCookie, 'missing OAuth binding cookie');
  assert.ok(authorization.searchParams.get('state'));
  return { authorization, flowCookie, state: authorization.searchParams.get('state') };
}

async function callback(base, provider, flow, code, cookieOverride) {
  return fetch(`${base}/api/auth/${provider}/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(flow.state)}`, {
    headers: { Cookie: cookieOverride || flow.flowCookie },
    redirect: 'manual',
  });
}

async function registerEmail(base, email, password) {
  const codeResponse = await fetch(base + '/api/auth/email/code', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  const codeBody = await codeResponse.json();
  if (!codeResponse.ok) return { response: codeResponse, body: codeBody, cookie: '' };
  assert.equal(codeBody.debugCode, undefined, 'configured mail delivery leaked its code in the response');
  const verificationCode = deliveredCodes.get(email.toLowerCase());
  assert.match(verificationCode || '', /^\d{6}$/, 'mock email delivery did not receive the verification code');
  const response = await fetch(base + '/api/auth/register', {
    method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, verificationCode }),
  });
  const body = await response.json();
  return { response, body, cookie: cookieValue(response, 'wp_session') };
}

if (require.main === module) (async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-oauth-test-'));
  const appPort = await freePort();
  const mockPort = await freePort();
  const mockBase = `http://127.0.0.1:${mockPort}`;
  const exchanges = [];
  const mock = await startMockProvider(mockPort, exchanges);
  let app;
  try {
    app = await startApp(appPort, dataDir, mockBase);
    const { base } = app;

    const discovery = await fetch(base + '/api/auth/providers');
    assert.equal(discovery.status, 200);
    assert.deepEqual(await discovery.json(), {
      email: { enabled: true, registrationEnabled: true }, google: { enabled: true }, wechat: { enabled: true },
      paired: null, pairingAllowed: false,
    });

    const parallelEmail = 'parallel@example.test';
    const parallelResponses = await Promise.all([0, 1].map(() => fetch(base + '/api/auth/email/code', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: parallelEmail }),
    })));
    assert.deepEqual(parallelResponses.map(response => response.status).sort(), [200, 429], 'parallel sends bypassed the atomic cooldown');
    assert.equal(resendCalls.filter(email => email === parallelEmail).length, 1, 'parallel sends delivered more than one email');

    const invalidEmail = await registerEmail(base, 'not-an-email', 'correct email password');
    assert.equal(invalidEmail.response.status, 400);
    assert.match(invalidEmail.body.error, /邮箱/);

    const missingCode = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'unverified@example.test', password: 'unverified password' }),
    });
    assert.equal(missingCode.status, 400);
    assert.match((await missingCode.json()).error, /验证码/);

    const lockedEmail = 'locked@example.test';
    const lockedCodeResponse = await fetch(base + '/api/auth/email/code', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: lockedEmail }),
    });
    const lockedCodeBody = await lockedCodeResponse.json();
    assert.equal(lockedCodeBody.debugCode, undefined);
    const lockedCode = deliveredCodes.get(lockedEmail);
    assert.match(lockedCode, /^\d{6}$/);
    const wrongCode = lockedCode === '000000' ? '999999' : '000000';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const wrong = await fetch(base + '/api/auth/register', {
        method: 'POST',
        headers: { Origin: base, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: lockedEmail, password: 'locked email password', verificationCode: wrongCode }),
      });
      assert.equal(wrong.status, 400);
    }
    const afterLockout = await fetch(base + '/api/auth/register', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: lockedEmail, password: 'locked email password', verificationCode: lockedCode }),
    });
    assert.equal(afterLockout.status, 400, 'verification code survived five failed attempts');
    const resendAfterLockout = await fetch(base + '/api/auth/email/code', {
      method: 'POST',
      headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: lockedEmail }),
    });
    assert.equal(resendAfterLockout.status, 429, 'new code bypassed the five-attempt lock');

    const mail = await registerEmail(base, 'mail.user@example.test', 'correct email password');
    assert.equal(mail.response.status, 201, JSON.stringify(mail.body));
    assert.ok(mail.cookie);

    const relogin = await fetch(base + '/api/auth/login', {
      method: 'POST',
      headers: { Origin: base, Cookie: mail.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'MAIL.USER@example.test', password: 'correct email password' }),
    });
    assert.equal(relogin.status, 200);
    const rotatedCookie = cookieValue(relogin, 'wp_session');
    assert.ok(rotatedCookie && rotatedCookie !== mail.cookie);
    assert.equal((await fetch(base + '/api/session', { headers: { Cookie: mail.cookie } })).status, 401, 'old session survived login rotation');
    assert.equal((await fetch(base + '/api/session', { headers: { Cookie: rotatedCookie } })).status, 200);

    const google = await startFlow(base, 'google', 'https://evil.example/steal', rotatedCookie);
    assert.equal(google.authorization.searchParams.get('client_id'), 'google-client-test');
    assert.equal(google.authorization.searchParams.get('scope'), 'openid email profile');
    assert.equal(google.authorization.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(google.authorization.searchParams.get('code_challenge'));
    // A real cross-site callback carries the Lax flow cookie, not the existing
    // SameSite=Strict password session. The flow itself must revoke that session.
    const googleResult = await callback(base, 'google', google, 'google-code-a');
    assert.equal(googleResult.status, 302);
    assert.equal(googleResult.headers.get('location'), '/', 'external next URL was not rejected');
    assert.match(googleResult.headers.get('set-cookie'), /SameSite=Lax/);
    const googleCookie = cookieValue(googleResult, 'wp_session');
    assert.equal((await fetch(base + '/api/session', { headers: { Cookie: rotatedCookie } })).status, 401, 'password session survived OAuth account switch');
    const googleSession = await (await fetch(base + '/api/session', { headers: { Cookie: googleCookie } })).json();
    assert.equal(googleSession.user.username, '谷歌用户');

    const replay = await callback(base, 'google', google, 'google-code-a');
    assert.match(replay.headers.get('location'), /authError=oauth_expired/);

    const wrongBinding = await startFlow(base, 'google', '/');
    const rejectedBinding = await callback(base, 'google', wrongBinding, 'google-code-a', 'wp_oauth_flow=wrong-browser');
    assert.match(rejectedBinding.headers.get('location'), /authError=oauth_expired/);
    const validAfterWrongBinding = await callback(base, 'google', wrongBinding, 'google-code-a');
    assert.equal(validAfterWrongBinding.headers.get('location'), '/');

    const providerMixup = await startFlow(base, 'google', '/');
    const wrongProvider = await callback(base, 'wechat', providerMixup, 'wechat-code-a');
    assert.match(wrongProvider.headers.get('location'), /authError=oauth_expired/);
    const validAfterMixup = await callback(base, 'google', providerMixup, 'google-code-a');
    assert.equal(validAfterMixup.headers.get('location'), '/');

    const conflictFlow = await startFlow(base, 'google', '/');
    const conflict = await callback(base, 'google', conflictFlow, 'google-code-conflict');
    assert.equal(conflict.headers.get('location'), '/');
    const conflictCookie = cookieValue(conflict, 'wp_session');
    const conflictSession = await (await fetch(base + '/api/session', { headers: { Cookie: conflictCookie } })).json();
    assert.notEqual(conflictSession.user.id, mail.body.user.id, 'Google identity was silently merged into the email account');

    const duplicateEmail = await registerEmail(base, 'google.one@example.test', 'another secure password');
    assert.equal(duplicateEmail.response.status, 201, 'same email across methods should remain a separate verified account');
    assert.notEqual(duplicateEmail.body.user.id, googleSession.user.id);

    const squatFlow = await startFlow(base, 'google', '/');
    const squatResult = await callback(base, 'google', squatFlow, 'google-code-squat');
    assert.equal(squatResult.headers.get('location'), '/');
    const victimEmail = await registerEmail(base, 'victim@example.test', 'victim secure password');
    assert.equal(victimEmail.response.status, 201, 'provider display name reserved a real email login');

    const wechat = await startFlow(base, 'wechat', '/review');
    assert.equal(wechat.authorization.searchParams.get('scope'), 'snsapi_login');
    assert.equal(wechat.authorization.hash, '#wechat_redirect');
    const wechatResult = await callback(base, 'wechat', wechat, 'wechat-code-a');
    assert.equal(wechatResult.status, 302);
    assert.equal(wechatResult.headers.get('location'), '/review');
    const wechatCookie = cookieValue(wechatResult, 'wp_session');
    const wechatSession = await (await fetch(base + '/api/session', { headers: { Cookie: wechatCookie } })).json();
    assert.notEqual(wechatSession.user.id, googleSession.user.id);

    const db = new DatabaseSync(path.join(dataDir, 'wordpaper.sqlite'));
    const identities = db.prepare('SELECT provider, provider_subject, email FROM auth_identities ORDER BY provider').all();
    assert.equal(identities.length, 4);
    assert.ok(identities.some(row => row.provider === 'google' && row.provider_subject === 'google-subject-a'));
    assert.ok(identities.some(row => row.provider === 'google' && row.provider_subject === 'google-subject-conflict'));
    assert.ok(identities.some(row => row.provider === 'google' && row.provider_subject === 'google-subject-squat'));
    assert.ok(identities.some(row => row.provider === 'wechat' && row.provider_subject === 'wechat-app-test:wechat-openid-a'));
    assert.equal(db.prepare('SELECT COUNT(*) AS total FROM password_credentials').get().total, 3);
    const verificationRows = db.prepare('SELECT email_key, attempts FROM email_verifications ORDER BY email_key').all()
      .map(row => ({ email_key: row.email_key, attempts: Number(row.attempts) }));
    assert.deepEqual(verificationRows, [
      { email_key: lockedEmail, attempts: 5 },
      { email_key: parallelEmail, attempts: 0 },
    ], 'used codes or lock tombstone state were wrong');
    const serializedIdentities = JSON.stringify(identities);
    assert.ok(!serializedIdentities.includes('google-code-a'));
    assert.ok(!serializedIdentities.includes('wechat-token'));
    db.close();

    await stopApp(app.child);
    app = await startApp(appPort, dataDir, mockBase);
    const persistedFlow = await startFlow(app.base, 'google', '/');
    const persistedResult = await callback(app.base, 'google', persistedFlow, 'google-code-a');
    const persistedCookie = cookieValue(persistedResult, 'wp_session');
    const persistedSession = await (await fetch(app.base + '/api/session', { headers: { Cookie: persistedCookie } })).json();
    assert.equal(persistedSession.user.id, googleSession.user.id, 'provider identity changed after restart');

    assert.ok(exchanges.some(entry => entry.provider === 'google'));
    assert.ok(exchanges.some(entry => entry.provider === 'wechat'));
    console.log('PASS email login, Google PKCE, WeChat website OAuth, state binding/replay/mix-up checks, session rotation, identity isolation, and restart persistence');
  } finally {
    if (app) await stopApp(app.child).catch(() => {});
    await close(mock).catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

module.exports = { freePort, startMockProvider, startApp, stopApp, startFlow, callback, cookieValue, registerEmail };
