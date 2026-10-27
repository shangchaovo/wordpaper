'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-release-discovery-'));
  const releaseFile = path.join(temp, 'release.json');
  const probesFile = path.join(temp, 'probes');
  fs.writeFileSync(releaseFile, JSON.stringify({ error: 'Installer not published yet' }));
  const preload = path.join(temp, 'release.cjs');
  fs.writeFileSync(preload, `
    const fs = require('node:fs');
    require('node:https').get = () => { throw new Error('Must not check main/VERSION'); };
    require(${JSON.stringify(path.join(root, 'lib/updater.js'))}).latestRelease = async () => {
      fs.appendFileSync(${JSON.stringify(probesFile)}, 'probe\\n');
      await new Promise(resolve => setTimeout(resolve, 50));
      const release = JSON.parse(fs.readFileSync(${JSON.stringify(releaseFile)}, 'utf8'));
      if (release.error) throw new Error(release.error);
      return release;
    };
  `);
  const port = await new Promise(resolve => {
    const server = http.createServer();
    server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
  const child = spawn(process.execPath, ['--require', preload, 'server.js'], {
    cwd: root, stdio: 'ignore', env: { ...process.env, NODE_ENV: 'test', PORT: String(port), HOST: '127.0.0.1',
      WORDPAPER_MODE: 'local', WORDPAPER_DATA_DIR: temp, WORDPAPER_COMPANION_ENABLED: '0', WORDPAPER_COMPANION_AUTOSTART: '0' },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(base + '/healthz')).ok) { ready = true; break; } } catch {}
      await pause(50);
    }
    assert(ready, 'server must start even when release lookup fails');
    await pause(100);
    const initial = await (await fetch(base + '/api/update/check')).json();
    assert.equal(initial.available, false);
    assert.equal(initial.checked, false);
    assert.equal(initial.latest, '');
    const refused = await fetch(base + '/api/update/apply-local', { method: 'POST', headers: { 'X-WordPaper-Local': '1' } });
    assert.equal(refused.status, 409, 'unpublished installer cannot be offered or installed');
    console.log('PASS failed/unpublished release lookup offers no update and leaves the service online');

    fs.writeFileSync(releaseFile, JSON.stringify({ version: '9999.0.0' }));
    const available = await (await fetch(base + '/api/update/check?refresh=1')).json();
    assert.equal(available.checked, true);
    assert.equal(available.available, true);
    assert.equal(available.latest, '9999.0.0');
    await Promise.all(Array.from({ length: 3 }, () => fetch(base + '/api/update/check?refresh=1')));
    assert.equal(fs.readFileSync(probesFile, 'utf8').trim().split('\n').length, 2, 'repeat refreshes stay rate limited');
    console.log('PASS a newly published release is discovered on refresh without querying main/VERSION');
  } finally {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
