#!/usr/bin/env node
'use strict';

/* test_admin.js — 管理员接口(内测开关 + 账号管理):
 *   - 非管理员访问 /api/admin/* → 403
 *   - 管理员 GET /api/admin/users 列出账号(含 role)
 *   - 管理员改密码后新密码可登录、旧密码失效
 *   - 改 role 后目标账号获得/失去管理员权限
 *   - 管理员不能取消自己的 admin(防自锁)
 *   - 功能开关白名单 + 持久化
 *   - /api/session 与登录响应都带 role 字段
 * 自包含:临时数据目录 + 空闲端口。 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const s = http.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
async function waitForServer(base) {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('test server did not start');
}

function makeClient(base) {
  let cookie = '';
  let csrf = '';
  async function req(url, options = {}) {
    const headers = Object.assign({ Origin: base }, options.headers || {});
    if (cookie) headers.Cookie = cookie;
    if (csrf && options.method === 'POST') headers['X-CSRF-Token'] = csrf;
    if (options.body) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + url, Object.assign({}, options, { headers }));
    const setCookie = r.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const data = await r.json().catch(() => ({}));
    if (data && data.csrfToken) csrf = data.csrfToken;
    return { status: r.status, data };
  }
  return { req, get csrf() { return csrf; } };
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-admin-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: Object.assign({}, process.env, {
      PORT: String(port), HOST: '127.0.0.1', WORDPAPER_MODE: 'local',
      WORDPAPER_DATA_DIR: temp, WORDPAPER_COMPANION_ENABLED: '0', NODE_ENV: 'test',
    }),
  });
  try {
    await waitForServer(base);

    // -- 注册两个账号
    const admin = makeClient(base);
    const reg1 = await admin.req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'rootuser', password: 'rootpass1234' }) });
    assert.equal(reg1.status, 201, 'register admin candidate: ' + JSON.stringify(reg1.data));
    assert.equal(reg1.data.user.role, 'user', 'new accounts default to user role');

    const bob = makeClient(base);
    const reg2 = await bob.req('/api/auth/register', { method: 'POST', body: JSON.stringify({ username: 'bobuser', password: 'bobpass12345' }) });
    assert.equal(reg2.status, 201);

    // -- 非管理员访问管理接口 → 403
    const denied = await bob.req('/api/admin/users');
    assert.equal(denied.status, 403, 'non-admin must be rejected');

    // -- 把 rootuser 提为管理员（直接改库，模拟首次部署）
    const Database = require('node:sqlite').DatabaseSync;
    const db = new Database(path.join(temp, 'wordpaper.sqlite'));
    db.prepare("UPDATE users SET role='admin' WHERE username_key='rootuser'").run();
    db.close();

    // 重新登录让会话带上 admin
    const admin2 = makeClient(base);
    const login = await admin2.req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'rootuser', password: 'rootpass1234' }) });
    assert.equal(login.status, 200);
    assert.equal(login.data.user.role, 'admin', 'login response must carry role');

    const sessionInfo = await admin2.req('/api/session');
    assert.equal(sessionInfo.data.user.role, 'admin', '/api/session must carry role');

    // -- 列账号
    const users = await admin2.req('/api/admin/users');
    assert.equal(users.status, 200);
    const names = users.data.users.map(u => u.username);
    assert.ok(names.includes('rootuser') && names.includes('bobuser'), 'user list must include both');
    const bobRow = users.data.users.find(u => u.username === 'bobuser');

    // -- 改密码：新密码可登录，旧密码失效
    const reset = await admin2.req('/api/admin/password', { method: 'POST', body: JSON.stringify({ userId: bobRow.id, password: 'newbobpass99' }) });
    assert.equal(reset.status, 200, JSON.stringify(reset.data));
    const oldLogin = await makeClient(base).req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'bobuser', password: 'bobpass12345' }) });
    assert.equal(oldLogin.status, 401, 'old password must stop working');
    const newLogin = await makeClient(base).req('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'bobuser', password: 'newbobpass99' }) });
    assert.equal(newLogin.status, 200, 'new password must work');

    // -- 短密码拒绝
    const shortPw = await admin2.req('/api/admin/password', { method: 'POST', body: JSON.stringify({ userId: bobRow.id, password: '123' }) });
    assert.equal(shortPw.status, 400, 'short passwords must be rejected');

    // -- 提 bob 为管理员
    const promote = await admin2.req('/api/admin/role', { method: 'POST', body: JSON.stringify({ userId: bobRow.id, role: 'admin' }) });
    assert.equal(promote.status, 200);
    assert.equal(promote.data.user.role, 'admin');

    // -- 管理员不能取消自己的 admin
    const selfDemote = await admin2.req('/api/admin/role', { method: 'POST', body: JSON.stringify({ userId: login.data.user.id, role: 'user' }) });
    assert.equal(selfDemote.status, 400, 'admin must not demote self');

    // -- 功能开关
    const feat0 = await admin2.req('/api/admin/features');
    assert.equal(feat0.status, 200);
    assert.equal(feat0.data.features.betaPetQuiz, false, 'features default off');
    const setFeat = await admin2.req('/api/admin/feature', { method: 'POST', body: JSON.stringify({ key: 'betaPetQuiz', enabled: true }) });
    assert.equal(setFeat.status, 200);
    const feat1 = await admin2.req('/api/admin/features');
    assert.equal(feat1.data.features.betaPetQuiz, true, 'feature flag must persist');
    const badFeat = await admin2.req('/api/admin/feature', { method: 'POST', body: JSON.stringify({ key: 'evilFlag', enabled: true }) });
    assert.equal(badFeat.status, 400, 'unknown feature keys must be rejected');

    // -- 未登录访问 → 401
    const anon = await makeClient(base).req('/api/admin/users');
    assert.equal(anon.status, 401, 'anonymous must get 401');

    console.log('PASS admin panel (role gating, password reset, role changes, self-demote guard, feature flags, session role)');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(e => { console.error(e.message || e); process.exit(1); });
