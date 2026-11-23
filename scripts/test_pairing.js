#!/usr/bin/env node
'use strict';
/* 主账号镜像(卫星模式)测试:配对、读写代理、冲突上游赢、离线缓存+补推、
   恢复会话、断开清除、public 模式拒绝配对、配对后禁止注册。 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

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

async function startServer(port, dataDir, mode) {
  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', WORDPAPER_MODE: mode,
      WORDPAPER_DATA_DIR: dataDir, NODE_ENV: 'test',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => output.push(chunk.toString()));
  child.stderr.on('data', chunk => output.push(chunk.toString()));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base, child, output);
  return { child, base, output };
}

async function stopServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not stop')), 7000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function api(base, opts) {
  const response = await fetch(base + opts.path, {
    method: opts.method || 'GET',
    headers: Object.assign({ Origin: base }, opts.cookie ? { Cookie: opts.cookie } : {},
      opts.csrf ? { 'X-CSRF-Token': opts.csrf } : {}, opts.headers || {},
      opts.body ? { 'Content-Type': 'application/json' } : {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json = null;
  try { json = await response.json(); } catch {}
  return { status: response.status, json, setCookie: response.headers.get('set-cookie') || '' };
}

async function main() {
  const upstreamPort = await freePort();
  const satellitePort = await freePort();
  const publicPort = await freePort();
  const dirUp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-up-'));
  const dirSat = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-sat-'));
  const dirPub = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-pub-'));

  let upstream = await startServer(upstreamPort, dirUp, 'public');
  let satellite = await startServer(satellitePort, dirSat, 'local');
  const pub = await startServer(publicPort, dirPub, 'public');

  try {
    // 上游注册 chaest 并写入一份设置
    const reg = await api(upstream.base, { method: 'POST', path: '/api/auth/register', body: { username: 'chaest', password: 'pairing-test-pw' } });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const up = { cookie: reg.setCookie.split(';')[0], csrf: reg.json.csrfToken };
    const other = await api(upstream.base, { method: 'POST', path: '/api/auth/register', body: { username: 'other', password: 'other-pairing-password' } });
    assert.equal(other.status, 201);
    const b = { cookie: other.setCookie.split(';')[0], csrf: other.json.csrfToken };
    let w = await api(upstream.base, { method: 'PUT', path: '/api/state/settings', cookie: up.cookie, csrf: up.csrf, body: { value: { theme: 'cream', wordsPerGroup: 6 }, expectedRevision: 0 } });
    assert.equal(w.status, 200, JSON.stringify(w.json));

    // public 模式拒绝配对
    let r = await api(pub.base, { method: 'POST', path: '/api/pair', body: { url: upstream.base, identifier: 'chaest', password: 'pairing-test-pw' } });
    assert.equal(r.status, 404, 'public 模式必须拒绝配对');

    // 错误密码 → 401
    r = await api(satellite.base, { method: 'POST', path: '/api/pair', body: { url: upstream.base, identifier: 'chaest', password: 'wrong-wrong-wrong' } });
    assert.equal(r.status, 401, '错误密码必须 401');

    // 正确配对 → 200 + 本会话 cookie
    r = await api(satellite.base, { method: 'POST', path: '/api/pair', body: { url: upstream.base, identifier: 'chaest', password: 'pairing-test-pw' } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.user.username, 'chaest');
    const sat = { cookie: r.setCookie.split(';')[0], csrf: r.json.csrfToken };

    // 会话带上镜像标记
    r = await api(satellite.base, { path: '/api/session', cookie: sat.cookie });
    assert.equal(r.json.mirrored, true, '会话必须标记 mirrored');
    assert.equal(r.json.upstream, 'ok');
    r = await api(satellite.base, { path: '/api/account', cookie: sat.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.accountUrl, upstream.base + '/login.html?next=%2F%23account', '镜像账号在登录后继续前往主账号绑定页');
    r = await api(satellite.base, { path: '/api/auth/google/start', cookie: sat.cookie });
    assert.equal(r.status, 403, '镜像设备不能绕过登录入口直接发起 OAuth');

    // 配对后禁止注册/普通登录
    r = await api(satellite.base, { method: 'POST', path: '/api/auth/register', body: { username: 'someoneelse', password: 'whatever-pass' } });
    assert.equal(r.status, 403, '配对后注册必须被拒');
    r = await api(satellite.base, { method: 'POST', path: '/api/auth/login', body: { identifier: 'chaest', password: 'pairing-test-pw' } });
    assert.equal(r.status, 403, '配对后密码登录必须让位给 resume');

    // 读镜像:卫星看到上游写入的设置
    r = await api(satellite.base, { path: '/api/state', cookie: sat.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.state.settings.theme, 'cream', '卫星必须镜像到上游数据');
    assert.equal(r.json.revisions.settings, 1, '镜像 revision 必须与上游一致');

    // 写代理:卫星写入 → 上游可见
    w = await api(satellite.base, { method: 'PUT', path: '/api/state/settings', cookie: sat.cookie, csrf: sat.csrf, body: { value: { theme: 'liquid', wordsPerGroup: 8 }, expectedRevision: 1 } });
    assert.equal(w.status, 200, JSON.stringify(w.json));
    assert.equal(w.json.queued, false, '在线写入必须直推而不是排队');
    r = await api(upstream.base, { path: '/api/state', cookie: up.cookie });
    assert.equal(r.json.state.settings.theme, 'liquid', '上游必须看到卫星的写入');

    // 主力机直改 → 卫星下次读取看到
    w = await api(upstream.base, { method: 'PUT', path: '/api/state/reminders', cookie: up.cookie, csrf: up.csrf, body: { value: [{ id: 'r1', text: '主机提醒' }], expectedRevision: 0 } });
    assert.equal(w.status, 200);
    r = await api(satellite.base, { path: '/api/state', cookie: sat.cookie });
    assert.equal(r.json.state.reminders[0].text, '主机提醒', '卫星必须拉到主力机的新增');

    // 冲突:上游先前进,卫星用旧 revision 写 → 409 且本地镜像被上游覆盖
    w = await api(upstream.base, { method: 'PUT', path: '/api/state/settings', cookie: up.cookie, csrf: up.csrf, body: { value: { theme: 'pearl', wordsPerGroup: 9 }, expectedRevision: 2 } });
    assert.equal(w.status, 200);
    w = await api(satellite.base, { method: 'PUT', path: '/api/state/settings', cookie: sat.cookie, csrf: sat.csrf, body: { value: { theme: 'stale' }, expectedRevision: 2 } });
    assert.equal(w.status, 409, '过期 revision 必须冲突');
    assert.equal(w.json.value.theme, 'pearl', '冲突必须回传上游值');
    r = await api(satellite.base, { path: '/api/state', cookie: sat.cookie });
    assert.equal(r.json.state.settings.theme, 'pearl', '冲突后本地镜像必须落回上游值');

    const copy = (await api(satellite.base, { path: '/api/sync/conflicts', cookie: sat.cookie })).json.conflicts[0];
    assert.equal(copy.namespace, 'settings');
    assert.deepEqual(copy.value, { theme: 'stale' });
    assert.equal((await api(satellite.base, { path: '/api/sync/conflicts' })).status, 401);
    const delta = await api(upstream.base, { path: '/api/state', cookie: up.cookie, headers: {
      'X-WordPaper-Revisions': JSON.stringify({ settings: 3, reminders: 0 }),
    } });
    assert.deepEqual(Object.keys(delta.json.state), ['reminders']);
    assert.equal(delta.json.partial, true);
    const unchanged = await api(upstream.base, { path: '/api/state', cookie: up.cookie, headers: {
      'X-WordPaper-Revisions': JSON.stringify({ settings: 3, reminders: 1 }),
    } });
    assert.deepEqual(unchanged.json.state, {});
    const separate = await api(upstream.base, { path: '/api/state', cookie: b.cookie, headers: {
      'X-WordPaper-Revisions': '{"settings":3}',
    } });
    assert.deepEqual(separate.json.missing, ['settings']);
    assert.deepEqual(separate.json.state, {});

    // 离线:关掉上游 → 卫星写入排队、读取走缓存;上游恢复后补推成功
    await stopServer(upstream.child); upstream.child = null;
    w = await api(satellite.base, { method: 'PUT', path: '/api/state/reminders', cookie: sat.cookie, csrf: sat.csrf, body: { value: [{ id: 'r2', text: '离线新增' }], expectedRevision: 1 } });
    assert.equal(w.status, 200, JSON.stringify(w.json));
    assert.equal(w.json.queued, true, '断网写入必须标记 queued');
    assert.equal(w.json.upstream, 'offline');
    w = await api(satellite.base, { method: 'PUT', path: '/api/state/reminders', cookie: sat.cookie, csrf: sat.csrf, body: { value: [{ id: 'r2', text: '离线再次编辑' }], expectedRevision: w.json.revision } });
    assert.equal(w.status, 200);
    assert.equal(w.json.queued, true);
    r = await api(satellite.base, { path: '/api/state', cookie: sat.cookie });
    assert.equal(r.status, 200, '断网读取必须回退缓存');
    assert.equal(r.json.upstream, 'offline');
    assert.equal(r.json.state.reminders[0].text, '离线再次编辑', '缓存必须包含最新离线写入');

    // The queue and pairing survive losing the desktop server without graceful shutdown.
    satellite.child.kill('SIGKILL');
    await new Promise(resolve => satellite.child.once('exit', resolve));
    satellite = await startServer(satellitePort, dirSat, 'local');
    r = await api(satellite.base, { method: 'POST', path: '/api/unpair' });
    assert.equal(r.status, 409);
    r = await api(satellite.base, { path: '/api/state', cookie: sat.cookie });
    assert.equal(r.json.pending, 1);
    assert.equal(r.json.state.reminders[0].text, '离线再次编辑');

    upstream = await startServer(upstreamPort, dirUp, 'public');
    r = await api(satellite.base, { method: 'POST', path: '/api/pair', body: { url: upstream.base, identifier: 'other', password: 'other-pairing-password' } });
    assert.equal(r.status, 409, 'queued changes block switching accounts');
    assert.deepEqual((await api(upstream.base, { path: '/api/state', cookie: b.cookie })).json.state, {});
    // 任意一次读取都会先 flushQueue 再 pull
    r = await api(satellite.base, { path: '/api/state', cookie: sat.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.upstream, 'ok');
    r = await api(upstream.base, { path: '/api/state', cookie: up.cookie });
    assert.equal(r.json.state.reminders[0].text, '离线再次编辑', '连续离线编辑必须保留最初云端 revision 并成功补推');

    // A second device adds an item while the desktop edits an existing item.
    // The shared ancestor lets both survive without restoring deleted items.
    const remoteReminder = { id: 'remote', text: 'second device' };
    const localReminder = { id: 'r2', text: 'desktop edit' };
    const rev = r.json.revisions.reminders;
    assert.equal((await api(upstream.base, { method: 'PUT', path: '/api/state/reminders', ...up,
      body: { value: [...r.json.state.reminders, remoteReminder], expectedRevision: rev } })).status, 200);
    const merged = await api(satellite.base, { method: 'PUT', path: '/api/state/reminders', ...sat,
      body: { value: [localReminder], expectedRevision: rev } });
    assert.equal(merged.status, 200, JSON.stringify(merged.json));
    assert.deepEqual(merged.json.value, [localReminder, remoteReminder]);
    assert.deepEqual((await api(upstream.base, { path: '/api/state', ...up })).json.state.reminders, merged.json.value);

    // resume:删掉本机会话后免密恢复(仅回环)
    await api(satellite.base, { method: 'DELETE', path: '/api/session', cookie: sat.cookie, csrf: sat.csrf });
    r = await api(satellite.base, { path: '/api/session', cookie: sat.cookie });
    assert.equal(r.status, 401);
    r = await api(satellite.base, { method: 'POST', path: '/api/auth/resume' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.user.username, 'chaest');
    const sat2 = { cookie: r.setCookie.split(';')[0], csrf: r.json.csrfToken };
    r = await api(satellite.base, { path: '/api/state', cookie: sat2.cookie });
    assert.equal(r.json.state.settings.theme, 'pearl', 'resume 后镜像仍在');

    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(dirSat, 'wordpaper.sqlite'), { readOnly: true });
    const pairing = JSON.parse(db.prepare("SELECT value FROM app_meta WHERE key='upstream_pairing'").get().value);
    db.close();
    await api(upstream.base, { method: 'DELETE', path: '/api/session', cookie: pairing.cookie, csrf: pairing.csrfToken });
    r = await api(satellite.base, { path: '/api/state', cookie: sat2.cookie });
    assert.equal(r.status, 200);
    assert.equal(r.json.upstream, 'reauth');
    assert.equal(r.json.state.settings.theme, 'pearl');

    // 断开:影子账号连同本机副本被清除,会话失效
    r = await api(satellite.base, { method: 'POST', path: '/api/unpair' });
    assert.equal(r.status, 200);
    r = await api(satellite.base, { path: '/api/session', cookie: sat2.cookie });
    assert.equal(r.status, 401, '断开后旧会话必须失效');
    r = await api(satellite.base, { method: 'POST', path: '/api/auth/resume' });
    assert.equal(r.status, 409, '断开后 resume 必须 409');
    // 上游账号数据不受断开影响
    r = await api(upstream.base, { path: '/api/state', cookie: up.cookie });
    assert.equal(r.json.state.settings.theme, 'pearl', '断开不能影响上游账号');

    const asOther = await api(satellite.base, { method: 'POST', path: '/api/pair', body: { url: upstream.base, identifier: 'other', password: 'other-pairing-password' } });
    assert.equal(asOther.status, 200);
    assert.deepEqual((await api(satellite.base, { path: '/api/sync/conflicts', cookie: asOther.setCookie.split(';')[0] })).json.conflicts, []);
    const back = await api(satellite.base, { method: 'POST', path: '/api/pair', body: { url: upstream.base, identifier: 'chaest', password: 'pairing-test-pw' } });
    assert.equal(back.status, 200);
    const connected = { cookie: back.setCookie.split(';')[0], csrf: back.json.csrfToken };
    assert.deepEqual((await api(satellite.base, { path: '/api/sync/conflicts', ...connected })).json.conflicts, [copy]);
    const removed = await api(satellite.base, { method: 'DELETE', path: '/api/sync/conflicts?id=' + copy.id, ...connected });
    assert.equal(removed.status, 200);
    assert.deepEqual((await api(satellite.base, { path: '/api/sync/conflicts', ...connected })).json.conflicts, []);
    console.log('PASS pairing: pair/mirror/push/conflict/offline-queue/resume/unpair/public-guard/register-guard');
  } finally {
    if (upstream.child) await stopServer(upstream.child);
    await stopServer(satellite.child);
    await stopServer(pub.child);
    fs.rmSync(dirUp, { recursive: true, force: true });
    fs.rmSync(dirSat, { recursive: true, force: true });
    fs.rmSync(dirPub, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
