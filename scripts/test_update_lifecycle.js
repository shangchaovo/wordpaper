'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-update-lifecycle-'));
  const preload = path.join(tmp, 'preload.cjs');
  fs.writeFileSync(preload, `
    const { EventEmitter } = require('events');
    require('https').get = (url, opts, cb) => {
      if (typeof opts === 'function') cb = opts;
      const req = new EventEmitter(); req.destroy = () => {};
      process.nextTick(() => {
        const res = new EventEmitter(); res.statusCode = 200; res.resume = () => {};
        cb(res); res.emit('data', '99.0.0'); res.emit('end');
      }); return req;
    };
    let calls = 0;
    require(${JSON.stringify(path.join(root, 'lib/updater.js'))}).applyUpdate = async () => {
      if (++calls <= 2) throw new Error('simulated install failure');
      require('fs').writeFileSync(require('path').join(process.env.WORDPAPER_DATA_DIR, 'update-pending.json'), '{}');
    };
  `);
  const port = await new Promise(resolve => {
    const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: root, stdio: 'ignore', env: { ...process.env, PORT: String(port), HOST: '127.0.0.1',
      WORDPAPER_MODE: 'local', WORDPAPER_DATA_DIR: tmp, WORDPAPER_COMPANION_AUTOSTART: '0', NODE_ENV: 'test' },
  });
  const base = `http://127.0.0.1:${port}`;
  const local = { 'X-WordPaper-Local': '1' };
  try {
    let ready = false;
    for (let i = 0; i < 80; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {}
      await sleep(50);
    }
    assert(ready);
    assert.equal((await fetch(base + '/api/update/status-local')).status, 403);
    const reg = await fetch(base + '/api/auth/register', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'update_lifecycle', password: 'update-lifecycle-test' }) });
    assert.equal(reg.status, 201);
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const session = await (await fetch(base + '/api/session', { headers: { Cookie: cookie } })).json();
    for (const [route, headers] of [['apply-local', local], ['apply', { Cookie: cookie, Origin: base, 'X-CSRF-Token': session.csrfToken }]]) {
      assert.equal((await fetch(base + '/api/update/' + route, { method: 'POST', headers })).status, 200);
      await sleep(1600);
      assert.equal(child.exitCode, null, route + ' failure must keep server alive');
      assert((await fetch(base + '/healthz')).ok);
      const state = await (await fetch(base + '/api/update/status-local', { headers: local })).json();
      assert.equal(state.applying, false); assert.match(state.error, /simulated install failure/);
      assert(!fs.existsSync(path.join(tmp, 'update-pending.json')));
      console.log('PASS update failure stays online:', route);
    }
    assert.equal((await fetch(base + '/api/update/apply-local', { method: 'POST', headers: local })).status, 200);
    const state = await (await fetch(base + '/api/update/status-local', { headers: local })).json();
    assert.equal(state.error, '', 'retry clears stale failure');
    for (let i = 0; i < 80 && child.exitCode === null; i++) await sleep(50);
    assert.equal(child.exitCode, 0, 'successful install shuts down for launcher restart');
    assert(fs.existsSync(path.join(tmp, 'update-pending.json')));
    console.log('PASS successful retry shuts down with restart flag');
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(r => child.once('exit', r)); }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
