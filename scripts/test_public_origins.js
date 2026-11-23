'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { freePort, startApp, stopApp, startMockProvider, cookieValue } = require('./test_oauth');

const primary = 'https://wordpaper.example.test';
const alternate = 'https://alternate.example.test';

function request(base, site, route, { headers, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + route, {
      method: body ? 'POST' : 'GET',
      headers: { Host: new URL(site).host, Origin: site, 'X-Forwarded-Proto': 'https',
        'Content-Type': 'application/json', ...headers },
    }, res => {
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => resolve(new Response(Buffer.concat(data), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-public-origins-'));
  const mockPort = await freePort();
  const exchanges = [];
  const mock = await startMockProvider(mockPort, exchanges);
  let app;
  try {
    app = await startApp(await freePort(), dir, 'http://127.0.0.1:' + mockPort, {
      TRUST_PROXY: '1', WORDPAPER_PUBLIC_ORIGIN: primary, WORDPAPER_ADDITIONAL_PUBLIC_ORIGINS: alternate,
      WORDPAPER_GOOGLE_REDIRECT_URI: primary + '/api/auth/google/callback',
    });
    const { base } = app;
    const accounts = new Map();
    for (const site of [primary, alternate]) {
      const other = site === primary ? alternate : primary;
      const provider = await request(base, site, '/api/auth/providers');
      assert.equal((await provider.json()).google.enabled, true);
      const next = '/connect.html?code=123456-ABCDEF';
      const start = await request(base, site, '/api/auth/google/start?next=' + encodeURIComponent(next));
      assert.equal(start.status, 302);
      const auth = new URL(start.headers.get('location'));
      const callback = '/api/auth/google/callback';
      assert.equal(auth.searchParams.get('redirect_uri'), site + callback);
      const flowCookie = cookieValue(start, '__Host-wp_oauth_flow');
      assert.ok(flowCookie);
      const returnTo = callback + '?code=google-code-a&state=' + auth.searchParams.get('state');
      const wrongSite = await request(base, other, returnTo, { headers: { Cookie: flowCookie } });
      assert.match(wrongSite.headers.get('location'), /authError=oauth_expired/);
      const signedIn = await request(base, site, returnTo, { headers: { Cookie: flowCookie } });
      assert.equal(signedIn.headers.get('location'), next);
      assert.equal(exchanges.at(-1).redirectUri, site + callback);
      const cookie = cookieValue(signedIn, '__Host-wp_session');
      assert.ok(cookie);
      const session = await (await request(base, site, '/api/session', { headers: { Cookie: cookie } })).json();
      assert.ok(session.user?.id && session.csrfToken);
      accounts.set(site, { userId: session.user.id, headers: { Cookie: cookie, 'X-CSRF-Token': session.csrfToken } });
    }
    assert.equal(accounts.get(primary).userId, accounts.get(alternate).userId);
    for (const site of [primary, alternate]) {
      const other = site === primary ? alternate : primary;
      const verifier = crypto.randomBytes(32).toString('base64url');
      const body = { provider: 'google', challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
      const create = '/api/device/start', approve = '/api/device/approve', token = '/api/device/token';
      const badOrigin = await request(base, site, create, { headers: { Origin: other, 'X-Forwarded-Host': new URL(other).host }, body });
      assert.equal(badOrigin.status, 403);
      const grant = await request(base, site, create, { body });
      assert.equal(grant.status, 200);
      const { verificationUrl, userCode, deviceCode } = await grant.json();
      assert.equal(new URL(verificationUrl).origin, site);
      assert.equal(new URL(verificationUrl).searchParams.get('next'), '/connect.html?code=' + userCode);
      const account = accounts.get(site).headers;
      assert.equal((await request(base, site, approve, { headers: { ...account, Origin: other }, body: { userCode } })).status, 403);
      assert.equal((await request(base, site, approve, { headers: { ...account, 'X-CSRF-Token': 'invalid' }, body: { userCode } })).status, 403);
      assert.equal((await request(base, other, approve, { headers: accounts.get(other).headers, body: { userCode } })).status, 409);
      assert.equal((await request(base, site, approve, { headers: account, body: { userCode } })).status, 200);
      assert.equal((await request(base, other, token, { body: { verifier, deviceCode } })).status, 410);
      const issued = await request(base, site, token, { body: { verifier, deviceCode } });
      assert.match((await issued.json()).cookie, /^__Host-wp_session=/);
      assert.equal((await request(base, site, token, { body: { verifier, deviceCode } })).status, 410);
    }
    assert.equal((await request(base, primary, '/api/auth/providers', {
      headers: { Host: 'not-listed.example.test', 'X-Forwarded-Host': new URL(primary).host },
    })).status, 421);
    assert.equal((await request(base, alternate, '/api/auth/providers', { headers: { 'X-Forwarded-Proto': 'http' } })).status, 421);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    console.log('PASS dual public origins: Google, same account, host-bound callbacks/CSRF/device approvals, host validation, private health probe');
  } finally {
    if (app) await stopApp(app.child);
    await new Promise(resolve => mock.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
