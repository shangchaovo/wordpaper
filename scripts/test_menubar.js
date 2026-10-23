#!/usr/bin/env node
'use strict';

/* test_menubar.js — 菜单栏链路端点测试:
 *   /menu-status.json   需要 X-WordPaper-Local 头,否则 403
 *   /menu.php           GET 405、无头 403、命令分发(pet-open / pet-close /
 *                       next / update-check 在开发模式下的拒绝)
 *   /status.json        新增 menuBar 字段
 * 自包含:临时数据目录 + 空闲端口,WORDPAPER_TEST_MODE=1(伴侣不起宠物/热键/
 * 菜单栏子进程,但 HTTP 端点全在)。 */

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = http.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}

async function waitForServer(base) {
  for (let i = 0; i < 60; i++) {
    try { const response = await fetch(base + '/status.json'); if (response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('test companion did not start');
}

async function get(base, url, headers) {
  const response = await fetch(base + url, { headers: headers || {} });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}
async function post(base, url, headers) {
  const response = await fetch(base + url, { method: 'POST', headers: headers || {} });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-menubar-test-'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'companion.js')], {
    cwd: path.join(__dirname, '..'), stdio: 'ignore',
    env: Object.assign({}, process.env, {
      WORDPAPER_TEST_MODE: '1', WORDPAPER_PORT: String(port),
      WORDPAPER_COMPANION_DATA_DIR: temp,
      WORDPAPER_STATE_PATH: path.join(temp, 'state.json'),
      WORDPAPER_CONFIG_PATH: path.join(temp, 'config.json'),
      WORDPAPER_CUSTOM_WORDS_PATH: path.join(temp, 'custom-words.json'),
    }),
  });
  const results = [];
  const check = (name, ok) => { results.push(Boolean(ok)); console.log((ok ? 'PASS  ' : 'FAIL  ') + name); };
  try {
    await waitForServer(base);
    const H = { 'X-WordPaper-Local': '1' };

    // status.json 带 menuBar 字段(TEST_MODE 下不 spawn 子进程,应为 false)
    const st = await get(base, '/status.json');
    check('status.json 暴露 menuBar 字段', st.status === 200 && 'menuBar' in st.data);

    // menu-status.json:无头 403;带头 200 且结构完整
    const noHeader = await get(base, '/menu-status.json');
    check('menu-status 无头=403', noHeader.status === 403);
    const withHeader = await get(base, '/menu-status.json', H);
    check('menu-status 带头=200', withHeader.status === 200);
    check('menu-status 结构完整', withHeader.data.ok === true
      && typeof withHeader.data.pet === 'boolean'
      && typeof withHeader.data.appMode === 'boolean'
      && typeof withHeader.data.version === 'string'
      && typeof withHeader.data.web === 'string'
      && withHeader.data.update && typeof withHeader.data.update.applying === 'boolean');

    // menu.php:GET 405;无头 403;未知命令 400
    const getMenu = await fetch(base + '/menu.php?cmd=next');
    check('menu.php GET=405', getMenu.status === 405);
    const noHeaderPost = await post(base, '/menu.php?cmd=next');
    check('menu.php 无头=403', noHeaderPost.status === 403);
    const badCmd = await post(base, '/menu.php?cmd=nope', H);
    check('menu.php 未知命令=400', badCmd.status === 400);

    // pet-open / pet-close:切换 petVisible 并写/清 pet-closed 标记
    const close = await post(base, '/menu.php?cmd=pet-close', H);
    check('pet-close ok', close.status === 200 && close.data.ok === true && close.data.pet === false);
    const stAfterClose = await get(base, '/status.json');
    check('pet-close 后 status.pet=false', stAfterClose.data.pet === false);
    const closedMark = path.join(temp, 'pet-closed');
    check('pet-close 写入标记文件', fs.existsSync(closedMark));
    const open = await post(base, '/menu.php?cmd=pet-open', H);
    check('pet-open ok', open.status === 200 && open.data.ok === true);
    check('pet-open 清除标记文件', !fs.existsSync(closedMark));

    // next:返回 ok(壁纸推进由 advance 管道处理,这里只验证路由与节流不炸)
    const next = await post(base, '/menu.php?cmd=next', H);
    check('next ok', next.status === 200 && next.data.ok === true);

    // update-check:开发模式(ROOT 不在 WordPaper.app)必须拒绝
    const updDev = await post(base, '/menu.php?cmd=update-check', H);
    check('开发模式 update-check 拒绝', updDev.status === 200 && updDev.data.ok === false);

    // update-apply 同理
    const applyDev = await post(base, '/menu.php?cmd=update-apply', H);
    check('开发模式 update-apply 拒绝', applyDev.status === 200 && applyDev.data.ok === false);
  } catch (e) {
    check('全程无异常:' + e.message, false);
  } finally {
    child.kill();
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch {}
  }
  const failed = results.filter(r => !r).length;
  console.log(failed === 0 ? `\n全部 ${results.length} 项通过` : `\n${failed}/${results.length} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
