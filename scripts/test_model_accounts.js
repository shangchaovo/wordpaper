'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { DatabaseSync } = require('node:sqlite');
const { freePort, startApp, stopApp, cookieValue } = require('./test_oauth');
const ai = require('../lib/ai-model');
const { openStorage } = require('../lib/storage');
const root = path.resolve(__dirname, '..');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-model-'));
  const port = await freePort(), companionPort = await freePort();
  const calls = [];
  const mock = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    calls.push({ body, auth: req.headers.authorization || req.headers['x-api-key'], url: req.url });
    const status = /^error-(\d+)$/.exec(body.model)?.[1];
    if (status) { res.writeHead(Number(status)); return res.end(JSON.stringify({ error: { message: 'must-not-leak-provider-body-or-key' } })); }
    if (body.model === 'slow') await new Promise(r => setTimeout(r, 150));
    const grading = body.messages.some(m => m.content.includes('请批改这句'));
    const text = body.model === 'malformed' ? 'not JSON' : grading
      ? JSON.stringify({ score: 3, used: true, fixed: 'I hear a hum.', feedback: 'hum 表示一种声音，通常说 a hum。', example: 'I can hear the hum of the engine.\n我听到引擎的嗡嗡声。' }) : 'OK';
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.url.endsWith('/messages') ? { content: [{ type: 'text', text }] } : { choices: [{ message: { content: text } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const endpoint = `http://127.0.0.1:${mock.address().port}/v1`;
  let app, companion, satellite;
  async function start(mode = 'local') {
    app = await startApp(port, dir, endpoint, { WORDPAPER_MODE: mode, WORDPAPER_COMPANION_ENABLED: '0' });
  }
  async function api(route, account, method = 'GET', body, headers = {}, base = app.base) {
    const r = await fetch(base + route, { method, headers: { Origin: base, Cookie: account?.cookie || '', 'X-CSRF-Token': account?.csrfToken || '', 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, data: await r.json() };
  }
  async function register(name) {
    const r = await fetch(app.base + '/api/auth/register', { method: 'POST', headers: { Origin: app.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: 'model-test-password' }) });
    assert.equal(r.status, 201); return { ...(await r.json()), cookie: cookieValue(r, 'wp_session') };
  }
  const config = { baseUrl: endpoint, model: 'test-model', apiKey: 'private-test-key-A', protocol: 'openai' };
  try {
    await start();
    const a = await register('model-a'), b = await register('model-b');
    assert.equal((await api('/api/account/model')).status, 401);
    assert.equal((await api('/api/account/model', a, 'PUT', config, { 'X-CSRF-Token': '' })).status, 403);
    assert.equal((await api('/api/account/model', a, 'PUT', config, { Origin: 'https://evil.test' })).status, 403);
    assert.equal((await api('/api/account/model', a, 'GET')).data.configured, false);
    const saved = await api('/api/account/model', a, 'PUT', config);
    assert.equal(saved.status, 200, JSON.stringify(saved)); assert.equal(saved.data.configured, true);
    assert.ok(!JSON.stringify(saved).includes(config.apiKey));
    assert.equal((await api('/api/account/model', b)).data.configured, false);
    assert.equal((await api('/api/ai/chat', b, 'POST', { messages: [{ role: 'user', content: 'hi' }] })).data.code, 'model_not_configured');
    assert.equal((await api('/api/account/model', a, 'PUT', { ...config, apiKey: '', baseUrl: endpoint + '/changed' })).data.code, 'key_required');
    for (const status of [401, 402, 403, 404, 429, 503]) {
      const failed = await api('/api/account/model', a, 'PUT', { ...config, model: 'error-' + status });
      assert.equal(failed.status, 502); assert.ok(!JSON.stringify(failed).includes('must-not-leak'));
      assert.equal((await api('/api/account/model', a)).data.model, config.model);
    }
    assert.equal((await api('/api/account/model/test', a, 'POST', { ...config, apiKey: '' })).status, 200);
    const db = new DatabaseSync(path.join(dir, 'wordpaper.sqlite'));
    const row = db.prepare('SELECT * FROM user_models WHERE user_id=?').get(a.user.id);
    assert.ok(!JSON.stringify(row).includes(config.apiKey));
    assert.equal(fs.statSync(path.join(dir, 'model-key.bin')).mode & 0o777, 0o600);
    for (const route of ['/api/state', '/api/export']) assert.ok(!JSON.stringify(await api(route, a)).includes(config.apiKey));
    for (const route of ['/model-key.bin', '/lib/ai-model.js', '/wordpaper.sqlite']) assert.equal((await fetch(app.base + route)).status, 404);
    // Ciphertext is bound to the account, not just the installation.
    db.prepare('INSERT INTO user_models SELECT ?,base_url,protocol,model,key_cipher,updated_at FROM user_models WHERE user_id=?').run(b.user.id, a.user.id);
    const store = ai.createModelStore(db, dir);
    assert.throws(() => store.get(b.user.id), /重新绑定/);
    store.remove(b.user.id); db.close();
    await stopApp(app.child); await start();
    assert.equal((await api('/api/account/model', a)).data.model, 'test-model');
    assert.equal((await api('/api/ai/chat', a, 'POST', { messages: [{ role: 'user', content: 'hi' }] })).data.text, 'OK');
    assert.equal(calls.at(-1).auth, 'Bearer ' + config.apiKey);
    await ai.complete({ ...config, model: 'deepseek-flash' }, [{ role: 'user', content: 'hi' }], { allowPrivate: true });
    assert.deepEqual(calls.at(-1).body.thinking, { type: 'disabled' });
    // Both supported protocols reach their real routes with the right auth.
    assert.equal((await api('/api/account/model', b, 'PUT', { ...config, protocol: 'anthropic', apiKey: 'private-test-key-B' })).status, 200);
    assert.equal(calls.at(-1).url, '/v1/messages'); assert.equal(calls.at(-1).auth, 'private-test-key-B');
    assert.deepEqual(calls.at(-1).body.cache_control, { type: 'ephemeral' });
    assert.equal((await api('/api/account/model', b, 'DELETE')).status, 200);
    assert.equal((await api('/api/account/model', b)).data.configured, false);
    assert.equal((await api('/api/account/model', a)).data.configured, true);
    console.log('PASS account API: auth/CSRF, encrypted key, A/B isolation, replace failure, protocol, restart, unlink and no key exports');

    // Full companion HTTP path, with isolated runtime and captured quiz account.
    const runtime = path.join(dir, 'companion'); fs.mkdirSync(runtime);
    fs.writeFileSync(path.join(runtime, 'config.json'), JSON.stringify({ port: companionPort, srsUserId: a.user.id, autoSetWallpaper: false, petEnabled: false, hotkeyEnabled: false }));
    fs.writeFileSync(path.join(runtime, 'state.json'), JSON.stringify({ lastQuiz: { word: 'hum', meaning: '嗡嗡声', library: 'cet4', userId: a.user.id }, sentenceNotes: [] }));
    companion = spawn(process.execPath, ['companion.js'], { cwd: root, stdio: 'ignore', env: { ...process.env, WORDPAPER_TEST_MODE: '1', WORDPAPER_PORT: String(companionPort), WORDPAPER_DATA_DIR: dir, WORDPAPER_COMPANION_DATA_DIR: runtime, WORDPAPER_CONFIG_PATH: path.join(runtime, 'config.json'), WORDPAPER_STATE_PATH: path.join(runtime, 'state.json') } });
    const base = `http://127.0.0.1:${companionPort}`;
    for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/pet-sentence.json')).ok) break; } catch {} await new Promise(r => setTimeout(r, 30)); }
    const grade = () => api('/pet-sentence.php', null, 'POST', { sentence: 'i hear hum' }, {}, base);
    assert.equal((await fetch(base + '/pet-sentence.php', { method: 'POST', headers: { Origin: 'http://localhost:1' }, body: '{}' })).status, 403);
    const good = await grade(); assert.equal(good.data.score, 3, JSON.stringify(good)); assert.equal(good.data.fixed, 'I hear a hum.');
    assert.equal(calls.at(-1).body.max_tokens, 1200);
    assert.equal((await api('/pet-sentence.php', null, 'POST', { sentence: 'i hear hum' }, { 'X-WordPaper-User-Id': String(b.user.id) }, base)).data.code, 'account_mismatch');
    const storage = openStorage(dir);
    const before = storage.getState(a.user.id).state.learningActivity;
    storage.models.save(a.user.id, { ...config, model: 'malformed' });
    assert.equal((await grade()).data.code, 'invalid_grading');
    assert.deepEqual(storage.getState(a.user.id).state.learningActivity, before);
    storage.models.save(a.user.id, { ...config, model: 'error-403' });
    assert.equal((await grade()).data.code, 'provider_forbidden');
    storage.models.remove(a.user.id);
    assert.equal((await grade()).data.code, 'model_not_configured');
    storage.models.save(a.user.id, config);
    storage.close();
    console.log('PASS companion: real grading route, captured account, malformed output not counted, forbidden/not-configured feedback');

    // Satellite forwards requests to the account server without copying keys.
    const satelliteDir = path.join(dir, 'satellite');
    const sat = openStorage(satelliteDir), shadow = sat.createUser('mirror', 'mirror-model', 'mirror$test');
    sat.metaSet('upstream_pairing', JSON.stringify({ url: app.base, cookie: a.cookie, csrfToken: a.csrfToken, localUserId: shadow.id, user: a.user, pairedAt: Date.now() })); sat.close();
    const bridge = await require('../lib/model-pairing').pairedCompletion({ url: app.base, cookie: a.cookie, csrfToken: a.csrfToken }, [{ role: 'user', content: 'hi' }], 64);
    assert.equal(bridge.text, 'OK');
    satellite = await startApp(await freePort(), satelliteDir, endpoint, { WORDPAPER_MODE: 'local', WORDPAPER_COMPANION_ENABLED: '0' });
    const resumed = await fetch(satellite.base + '/api/auth/resume', { method: 'POST', headers: { Origin: satellite.base } });
    const mirror = { ...(await resumed.json()), cookie: cookieValue(resumed, 'wp_session') };
    assert.equal((await api('/api/account/model', mirror, 'GET', undefined, {}, satellite.base)).data.model, 'test-model');
    assert.equal((await api('/api/account/model/test', mirror, 'POST', {}, {}, satellite.base)).status, 200);
    const satDb = new DatabaseSync(path.join(satelliteDir, 'wordpaper.sqlite'));
    assert.equal(satDb.prepare('SELECT count(*) AS n FROM user_models').get().n, 0); satDb.close();
    console.log('PASS satellite: account-owned configuration and completion, no copied model keys');

    await stopApp(app.child); await start('public');
    assert.equal((await api('/api/account/model', a, 'PUT', config)).status, 400);
    assert.equal((await api('/api/account/model', a, 'PUT', { ...config, baseUrl: 'https://127.0.0.1/v1' })).status, 400);
    assert.equal((await api('/api/account/model', a, 'PUT', { ...config, baseUrl: 'https://[::ffff:127.0.0.1]/v1' })).status, 400);
    await assert.rejects(ai.complete({ ...config, baseUrl: 'https://localtest.me/v1' }, [{ role: 'user', content: 'hi' }]), error => ['private_endpoint', 'model_network'].includes(error.code));
    await assert.rejects(ai.complete({ ...config, model: 'slow' }, [{ role: 'user', content: 'hi' }], { allowPrivate: true, timeoutMs: 30 }), error => error.code === 'model_timeout');
    console.log('PASS public endpoint validation, DNS private-address guard and bounded timeout');

    if (process.argv.includes('--browser')) {
      await stopApp(app.child); await start();
      const browser = spawn('python3', ['scripts/test_model_settings_browser.py'], { cwd: root, stdio: 'inherit', env: { ...process.env, WORDPAPER_TEST_BASE_URL: app.base, WORDPAPER_TEST_MODEL_URL: endpoint, WORDPAPER_TEST_COMPANION_URL: base } });
      const [code] = await once(browser, 'exit'); assert.equal(code, 0);
    }
  } finally {
    if (companion?.exitCode === null) { const done = once(companion, 'exit'); companion.kill(); await done; }
    await stopApp(app?.child); await stopApp(satellite?.child);
    await new Promise(r => mock.close(r)); fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
