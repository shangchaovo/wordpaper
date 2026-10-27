#!/usr/bin/env node
'use strict';

// Exercise a running companion without opening a browser, touching user data,
// or starting native windows. Only the OS open command is intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LOCAL = { 'X-WordPaper-Local': '1' };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function makeApp(directory, name, { executable = true, server = true } = {}) {
  const app = path.join(directory, name);
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'WordPaper'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(app, 'Contents', 'MacOS', 'WordPaper'), executable ? 0o755 : 0o644);
  if (server) fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'server.js'), '// fixture\n');
  return app;
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-workspace-navigation-'));
  const configPath = path.join(temp, 'config.json');
  const capturePath = path.join(temp, 'open.jsonl');
  const preloadPath = path.join(temp, 'capture-open.cjs');
  const initialOrigin = 'http://localhost:18123';
  const registeredOrigin = 'http://127.0.0.1:18124';
  const appPath = makeApp(temp, 'WordPaper Navigation Fixture.app');
  const appAlias = path.join(temp, 'WordPaper Alias.app');
  fs.symlinkSync(appPath, appAlias);
  const realAppPath = fs.realpathSync(appPath);
  const invalidAppPaths = [
    'relative/WordPaper.app',
    path.join(temp, 'Missing.app'),
    makeApp(temp, 'Not A Bundle'),
    makeApp(temp, 'Nonexecutable.app', { executable: false }),
    makeApp(temp, 'Missing Server.app', { server: false }),
  ];
  fs.writeFileSync(configPath, JSON.stringify({ webOrigin: initialOrigin }));
  fs.writeFileSync(preloadPath, `
'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const original = childProcess.execFile;
childProcess.execFile = function (command, args, ...rest) {
  if (command !== 'open' && command !== '/usr/bin/open') {
    return original.call(this, command, args, ...rest);
  }
  fs.appendFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ command, args }) + '\\n');
  const callback = rest.find(value => typeof value === 'function');
  if (callback) setImmediate(() => callback(null, '', ''));
  return { kill() {}, unref() {} };
};
`);

  let child;
  let base;
  let output = '';
  let checks = 0;
  const captures = () => fs.existsSync(capturePath)
    ? fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : [];
  function passed(name) { checks++; console.log('PASS  ' + name); }

  async function request(url, { method = 'POST', headers = LOCAL, body } = {}) {
    const response = await fetch(base + url, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    return { status: response.status, data: await response.json().catch(() => ({})) };
  }

  async function start() {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const env = {
      ...process.env,
      NODE_ENV: 'test',
      WORDPAPER_TEST_MODE: '1',
      WORDPAPER_COMPANION_SILENT: '1',
      WORDPAPER_PORT: String(port),
      WORDPAPER_COMPANION_DATA_DIR: temp,
      WORDPAPER_DATA_DIR: path.join(temp, 'account-data'),
      WORDPAPER_CONFIG_PATH: configPath,
      WORDPAPER_STATE_PATH: path.join(temp, 'state.json'),
      WORDPAPER_CUSTOM_WORDS_PATH: path.join(temp, 'custom-words.json'),
    };
    for (const key of ['WORDPAPER_WEB_ORIGIN', 'WORDPAPER_NATIVE_UI', 'WORDPAPER_NATIVE_APP_PATH',
      'WORDPAPER_SERVER_PID', 'WORDPAPER_SERVER_PORT', 'NODE_OPTIONS']) delete env[key];
    output = '';
    child = spawn(process.execPath, ['--require', preloadPath, path.join(ROOT, 'companion.js')], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { output = (output + chunk).slice(-12000); });
    child.stderr.on('data', chunk => { output = (output + chunk).slice(-12000); });
    let spawnError;
    child.once('error', error => { spawnError = error; });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (spawnError) throw spawnError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('companion exited:\n' + output);
      try {
        if ((await request('/status.json', { method: 'GET' })).status === 200) return;
      } catch {}
      await pause(50);
    }
    throw new Error('companion did not start:\n' + output);
  }

  async function expectNavigation(command, expectedArgs, native) {
    const before = captures().length;
    const result = await request('/menu.php?cmd=' + command);
    assert.equal(result.status, 200, command + ' status');
    assert.equal(result.data.ok, true, command + ' response');
    for (let attempt = 0; attempt < 30 && captures().length === before; attempt++) await pause(20);
    const added = captures().slice(before);
    assert.equal(added.length, 1, command + ' opens exactly one destination');
    assert.deepEqual(added[0].args, expectedArgs, command + ' destination');
    if (native) assert.equal(added[0].command, '/usr/bin/open');
    passed(command + (native ? ' opens the exact registered App' : ' retains browser fallback'));
  }

  async function expectRegistrationRejected(body, headers, status, label) {
    const before = captures().length;
    const configBefore = fs.readFileSync(configPath, 'utf8');
    const result = await request('/desktop/register', { body, headers });
    assert.equal(result.status, status, label);
    assert.equal(captures().length, before, label + ' must not launch anything');
    assert.equal(fs.readFileSync(configPath, 'utf8'), configBefore, label + ' must not change config');
    passed(label);
  }

  try {
    const source = fs.readFileSync(path.join(ROOT, 'companion.js'), 'utf8');
    const petFactory = source.slice(source.indexOf('function buildPetJXA('), source.indexOf('let petChild = null;'));
    const petContext = {
      PET_BTN: 36, PET_FRAME: 12, PET_FOOTER_H: 80, PET_RESIZE: 32,
      MIN_PET_W: 200, MIN_PET_H: 200, MAX_PET: 1000,
      CFG: { port: 18125, uiTheme: 'editorial' }, petWords: [],
      petWordKey: word => word.word, petSkin: () => ({ dark: false }),
    };
    vm.runInNewContext(petFactory, petContext);
    const petJXA = petContext.buildPetJXA(400, 600);
    new vm.Script(petJXA);
    assert.match(petJXA, /\/menu\.php\?cmd=workspace-memory/);
    assert.match(petJXA, /postUrl\(memoryUrl\)/);
    assert.match(petJXA, /setHTTPMethod\('POST'\)/);
    assert.match(petJXA, /setValueForHTTPHeaderField\('1', 'X-WordPaper-Local'\)/);
    assert.doesNotMatch(petJXA, /NSWorkspace/);
    passed('generated word-card memory button posts to native workspace navigation');

    const menuFactory = source.slice(source.indexOf('function buildMenuBarJXA('), source.indexOf('let menuBarChild = null;'));
    const menuContext = {};
    vm.runInNewContext(menuFactory, menuContext);
    const menuJXA = menuContext.buildMenuBarJXA(18125, 1234);
    new vm.Script(menuJXA);
    assert.match(menuJXA, /addItem\(menu, '记忆复习本…', 'workspace-memory'/);
    assert.match(menuJXA, /addItem\(menu, '打开控制面板…', 'workspace-home'/);
    passed('generated menu uses the same home and memory commands as the word card');

    await start();
    await expectNavigation('workspace-home', [initialOrigin + '/'], false);
    await expectNavigation('workspace-memory', [initialOrigin + '/?openMemory=1'], false);
    const validRegistration = { appPath: appAlias, webOrigin: registeredOrigin };
    assert.equal((await request('/desktop/register', { method: 'GET' })).status, 405);
    passed('registration requires POST');
    await expectRegistrationRejected(validRegistration, {}, 403, 'registration requires native local header');
    for (const headers of [
      { ...LOCAL, Origin: 'https://example.com' },
      { ...LOCAL, Origin: base },
      { ...LOCAL, Referer: base + '/' },
    ]) {
      await expectRegistrationRejected(validRegistration, headers, 403,
        'registration rejects browser ' + (headers.Origin ? 'Origin ' + headers.Origin : 'Referer'));
    }
    for (const invalidAppPath of invalidAppPaths) {
      await expectRegistrationRejected({ ...validRegistration, appPath: invalidAppPath }, LOCAL, 400,
        'registration rejects ' + path.basename(invalidAppPath));
    }
    for (const webOrigin of [
      'https://127.0.0.1:18124', 'http://example.com:18124', 'http://localhost',
      'file:///tmp/index.html', 'http://user:password@localhost:18124',
      'http://localhost:18124/other', 'http://localhost:18124/?next=elsewhere',
    ]) {
      await expectRegistrationRejected({ ...validRegistration, webOrigin }, LOCAL, 400,
        'registration rejects invalid web origin ' + webOrigin);
    }

    const registered = await request('/desktop/register', { body: validRegistration });
    assert.equal(registered.status, 200);
    assert.equal(registered.data.ok, true);
    assert.equal(registered.data.nativeNavigation, 1);
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.equal(saved.desktopAppPath, realAppPath);
    assert.equal(saved.webOrigin, registeredOrigin);
    passed('running companion registers and persists the resolved App path and web origin');

    await expectNavigation('workspace-home', ['-a', realAppPath, 'wordpaper://open?path=' + encodeURIComponent('/')], true);
    await expectNavigation('workspace-memory', ['-a', realAppPath, 'wordpaper://open?path=' + encodeURIComponent('/?openMemory=1')], true);

    const beforeDeniedNavigation = captures().length;
    assert.equal((await request('/menu.php?cmd=workspace-memory', { headers: {} })).status, 403);
    assert.equal((await request('/menu.php?cmd=workspace-home', { method: 'GET' })).status, 405);
    assert.equal((await request('/menu.php?cmd=workspace-https%3A%2F%2Fexample.com')).status, 400);
    assert.equal(captures().length, beforeDeniedNavigation);
    passed('workspace menu rejects unauthorized requests and arbitrary destinations');

    const sync = await request('/pet-sync.php', {
      headers: { Origin: initialOrigin },
      body: { library: 'custom', customWords: [{ word: 'navigation', meaning: '导航' }], webOrigin: initialOrigin },
    });
    assert.equal(sync.status, 200);
    assert.equal(sync.data.ok, true);
    const status = await request('/menu-status.json', { method: 'GET' });
    assert.equal(status.data.web, registeredOrigin);
    assert.equal(JSON.parse(fs.readFileSync(configPath, 'utf8')).webOrigin, registeredOrigin);
    passed('an older browser page cannot replace the registered workspace origin');
    await expectNavigation('workspace-memory', ['-a', realAppPath, 'wordpaper://open?path=' + encodeURIComponent('/?openMemory=1')], true);

    await stop(child);
    await start();
    assert.equal((await request('/menu-status.json', { method: 'GET' })).data.web, registeredOrigin);
    await expectNavigation('workspace-home', ['-a', realAppPath, 'wordpaper://open?path=' + encodeURIComponent('/')], true);
    await expectNavigation('workspace-memory', ['-a', realAppPath, 'wordpaper://open?path=' + encodeURIComponent('/?openMemory=1')], true);
    passed('native navigation and its web origin survive a companion restart');
    fs.renameSync(appPath, path.join(temp, 'Moved WordPaper.app'));
    const beforeMissingApp = captures().length;
    for (const command of ['workspace-home', 'workspace-memory']) {
      const missingApp = await request('/menu.php?cmd=' + command);
      assert.equal(missingApp.status, 500, command + ' must report a missing registered App');
      assert.equal(missingApp.data.ok, false);
    }
    assert.equal(captures().length, beforeMissingApp, 'missing App must never silently open the browser');
    passed('a missing registered App fails explicitly without browser fallback');
    console.log(`\n全部 ${checks} 项通过`);
  } catch (error) {
    console.error(error.stack || error);
    if (output) console.error('\nCompanion output:\n' + output);
    process.exitCode = 1;
  } finally {
    await stop(child);
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
