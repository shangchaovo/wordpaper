'use strict';
/* Updater e2e harness: fake DMG mount + rsync through stubbed execFile/fs. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const u = require(path.join(__dirname, '..', 'lib', 'updater.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-upd-'));

process.env.WORDPAPER_DATA_DIR = path.join(tmp, 'state');
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
// ── Running app: fakeRes/WordPaper.app/Contents/Resources ──
const appPath = path.join(tmp, 'fakeRes', 'WordPaper.app');
const resPath = path.join(appPath, 'Contents', 'Resources');
fs.mkdirSync(resPath, { recursive: true });
for (const f of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html']) {
  fs.writeFileSync(path.join(resPath, f), 'stale-' + f);
}
fs.writeFileSync(path.join(resPath, 'VERSION'), '2.2.3');
for (const d of ['lib', 'css', 'js', 'data', 'assets']) fs.mkdirSync(path.join(resPath, d), { recursive: true });
fs.writeFileSync(path.join(resPath, 'lib', 'updater.js'), 'require("x")');
fs.writeFileSync(path.join(resPath, 'js', 'app.js'), 'stale');

// ── Fake mounted DMG contents: dmgMount/WordPaper.app/Contents/Resources (v2.3.0) ──
const mountRes = path.join(tmp, 'dmgMount', 'WordPaper.app', 'Contents', 'Resources');
fs.mkdirSync(mountRes, { recursive: true });
for (const f of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html']) {
  fs.writeFileSync(path.join(mountRes, f), 'new-' + f);
}
fs.writeFileSync(path.join(mountRes, 'VERSION'), '2.3.0');
for (const d of ['lib', 'css', 'js', 'data', 'assets']) fs.mkdirSync(path.join(mountRes, d), { recursive: true });
fs.writeFileSync(path.join(mountRes, 'lib', 'updater.js'), '// new');
fs.writeFileSync(path.join(mountRes, 'js', 'app.js'), '// new');

const bundleFiles = { 'MacOS/launcher.sh': '#!/bin/bash\necho new', 'Info.plist': 'new plist' };
for (const [rel, body] of Object.entries(bundleFiles)) {
  const target = path.join(mountRes, '..', rel);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, body);
}
fs.writeFileSync(path.join(mountRes, 'assets', 'favicon-32.png'), 'new favicon');
// Manifest: per-file digests of the NEW payload (as package_app.py generates).
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = { version: '2.2.3', files: {} };
for (const rel of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html', 'lib/updater.js', 'js/app.js']) {
  manifest.files[rel] = digest(path.join(mountRes, rel));
}
manifest.bundleFiles = Object.fromEntries(Object.keys(bundleFiles).map(rel => [rel, digest(path.join(mountRes, '..', rel))]));
manifest.version = '2.3.0';   // 新包自校验:manifest.version 必须等于目标版本
fs.writeFileSync(path.join(mountRes, 'RELEASE_SHA256.json'), JSON.stringify(manifest));

// Place the manifest in the RUNNING resources too (that's what shaManifest reads).
const runningManifest = { version: '2.2.3', files: manifest.files };   // 旧包自带旧摘要
fs.writeFileSync(path.join(resPath, 'RELEASE_SHA256.json'), JSON.stringify(runningManifest));

// ── Not from WordPaper.app check: applyUpdate requires runningFrom.includes('WordPaper.app');
//    our fakeRes path includes 'fakeRes/WordPaper.app' — passes. ──
// __dirname of updater is lib/ inside REAL repo, not our fakeRes... The module reads
// shaManifest via its __dirname — that would read the REAL repo's (missing) manifest.
// Test hook: __setFs lets us redirect file reads for the manifest.

// Wrap fs to redirect paths from real <repo>/.. to fakeResPath.
const realFs = fs;
let failRestartFlag = false;
u.__setFs({
  ...realFs,
  existsSync(p) { return realFs.existsSync(remap(p)); },
  readFileSync(p, enc) { return realFs.readFileSync(remap(p), enc); },
  createReadStream(p, opts) { return realFs.createReadStream(remap(p), opts); },
  writeFileSync(p, data) {
    if (failRestartFlag && p === path.join(process.env.WORDPAPER_DATA_DIR, 'update-pending.json.next')) {
      realFs.writeFileSync(p, '{');
      throw new Error('simulated flag write failure');
    }
    return realFs.writeFileSync(remap(p), data);
  },
  mkdirSync(p, opts) { return realFs.mkdirSync(remap(p), opts); },
  mkdtempSync(prefix) { return realFs.mkdtempSync(prefix); },
  rmSync(p, opts) { return realFs.rmSync(remap(p), opts); },
});
function remap(p) {
  // '<repo>/RELEASE_SHA256.json' is requested via path.join(updater.__dirname, '..')
  // — its real value is /Users/xieshangchao/daily-wallpaper/lib/.. = repo root. We
  // remap ALL reads under the repo root into our fakeRes Resources.
  if (String(p).startsWith(path.resolve(__dirname, '..') + path.sep)) {
    return path.join(resPath, path.basename(String(p)));
  }
  return p;
}

u.__setRunningFrom(resPath);  // the harness pretends the running app root is here

// Stub execFile: hdiutil attach → populate mountpoint with dmgMount copy;
// rsync → 真实语义模拟:目录+尾斜杠 OK;**文件+尾斜杠必须报错**(macOS rsync
// 对 "(l)stat: Not a directory")——正是 2.3.x/2.4.0 一键更新必失败的根因,
// 回归锁:如果有人把文件路径再加回尾斜杠,这里立刻红。
let failInstall = false;
u.__setExecFile((cmd, args, opts, cb) => {
  if (cmd.endsWith('rsync')) {
    const src = String(args[args.length - 2]);
    const dst = String(args[args.length - 1]);
    if (failInstall && dst.replace(/\/$/, '') === path.join(resPath, 'js')) { failInstall = false; return cb(new Error('simulated rsync failure')); }
    const srcIsDir = realFs.existsSync(src) && realFs.statSync(src).isDirectory();
    if (src.endsWith('/') && !srcIsDir) {
      cb(new Error(`Command failed: /usr/bin/rsync ... ${src} ... rsync error: (l)stat: Not a directory`), '', '');
      return;
    }
    realFs.cpSync(src.replace(/\/$/, ''), dst.replace(/\/$/, ''), { recursive: true });
    cb(null, '', '');
  } else if (cmd.endsWith('hdiutil')) {
    if (args[0] === 'attach') {
      const mountPoint = args[args.indexOf('-mountpoint') + 1];
      realFs.cpSync(path.join(tmp, 'dmgMount', 'WordPaper.app'), path.join(String(mountPoint), 'WordPaper.app'), { recursive: true });
      cb(null, '', '');
    } else cb(null, '', '');
  } else cb(new Error('unexpected: ' + cmd), '', '');
});

// Stub the DMG download: bypass https entirely via __setHttpsGet.
u.__setHttpsGet((url, cb) => {
  const fakeRes = Object.assign(new (require('events').EventEmitter)(), {
    statusCode: 200, headers: { 'content-length': '8' },
    pipe(dest) { dest.write(Buffer.alloc(2048, 0x41)); process.nextTick(() => dest.end()); return dest; },
    resume() { return this; },
    on(ev, fn) { if (ev === 'data') process.nextTick(() => fn(Buffer.alloc(2048, 0x41))); return this; },
  });
  process.nextTick(() => cb(fakeRes));
  return { on: () => {}, destroy: () => {}, setTimeout() {} };
});
const destPath = path.join(tmp, 'fake.dmg');

(async () => {
  let failed = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) failed++; };
  try {
    const result = await u.applyUpdate('2.2.3', '2.3.0', () => {});
    check('applyUpdate 返回 ok + 新版本号', result && result.ok === true && result.version === '2.3.0');
    check('Resources VERSION 已替换', fs.readFileSync(path.join(resPath, 'VERSION'), 'utf8').trim() === '2.3.0');
    check('Resources server.js 已替换(内容为新包)', fs.readFileSync(path.join(resPath, 'server.js'), 'utf8').startsWith('new-'));
    const flagPath = path.join(process.env.WORDPAPER_DATA_DIR, 'update-pending.json');
    let flag = null;
    try { flag = JSON.parse(fs.readFileSync(flagPath, 'utf8')); } catch {}
    check('重启旗标已写入(from/to 正确)', flag && flag.from === '2.2.3' && flag.to === '2.3.0');
    fs.rmSync(flagPath);
    // manifest 写入新包(应为 rsync 过来的新包版 manifest)
    let newManifest = null;
    try { newManifest = JSON.parse(fs.readFileSync(path.join(resPath, 'RELEASE_SHA256.json'), 'utf8')); } catch {}
    check('RELEASE_SHA256.json 同步成功', newManifest && newManifest.version === '2.3.0' && JSON.stringify(newManifest.files) === JSON.stringify(manifest.files));
    check('网页图标随更新安装', fs.readFileSync(path.join(resPath, 'assets/favicon-32.png'), 'utf8') === 'new favicon');
    check('启动器与 Info.plist 随更新安装', Object.entries(bundleFiles).every(([rel, body]) => fs.readFileSync(path.join(resPath, '..', rel), 'utf8') === body));
    fs.writeFileSync(path.join(resPath, 'VERSION'), '2.2.3');
    fs.writeFileSync(path.join(resPath, 'server.js'), 'old server');
    fs.writeFileSync(path.join(resPath, 'js', 'app.js'), 'old client');
    failInstall = true;
    let installFailed = false;
    try { await u.applyUpdate('2.2.3', '2.3.0', () => {}); } catch (e) { installFailed = /simulated rsync failure/.test(e.message); }
    check('中途安装失败被报告', installFailed);
    check('失败恢复已覆盖的服务器与网页文件', fs.readFileSync(path.join(resPath, 'server.js'), 'utf8') === 'old server' && fs.readFileSync(path.join(resPath, 'js/app.js'), 'utf8') === 'old client');
    check('失败保留旧版本且不写旗标', fs.readFileSync(path.join(resPath, 'VERSION'), 'utf8') === '2.2.3' && !fs.existsSync(flagPath));
    fs.writeFileSync(path.join(resPath, '..', 'MacOS/launcher.sh'), 'old launcher');
    fs.chmodSync(path.join(resPath, '..', 'MacOS/launcher.sh'), 0o755);
    fs.writeFileSync(path.join(resPath, '..', 'Info.plist'), 'old plist');
    fs.writeFileSync(path.join(resPath, 'RELEASE_SHA256.json'), JSON.stringify(runningManifest));
    failRestartFlag = true;
    let flagFailed = false;
    try { await u.applyUpdate('2.2.3', '2.3.0', () => {}); } catch (e) { flagFailed = /simulated flag write failure/.test(e.message); }
    failRestartFlag = false;
    check('最后写旗标失败也回滚启动器与元数据', flagFailed && fs.readFileSync(path.join(resPath, '..', 'MacOS/launcher.sh'), 'utf8') === 'old launcher' && fs.readFileSync(path.join(resPath, '..', 'Info.plist'), 'utf8') === 'old plist' && JSON.parse(fs.readFileSync(path.join(resPath, 'RELEASE_SHA256.json'), 'utf8')).version === '2.2.3');
    check('回滚保留启动器执行权限且清理不完整旗标', (fs.statSync(path.join(resPath, '..', 'MacOS/launcher.sh')).mode & 0o777) === 0o755 && !fs.existsSync(flagPath) && !fs.existsSync(flagPath + '.next'));
    // 版本棘轮:目标不比当前新时必须拒绝
    let rejected = false;
    try { await u.applyUpdate('2.3.0', '2.3.0', () => {}); } catch (e) { rejected = /不比当前版本新/.test(e.message); }
    check('同版本不重复安装(棘轮)', rejected);
    let downgraded = false;
    try { await u.applyUpdate('2.3.0', '2.2.9', () => {}); } catch (e) { downgraded = /不比当前版本新/.test(e.message); }
    check('降级被拒绝(棘轮)', downgraded);
    process.exit(failed ? 1 : 0);
  } catch (e) {
    console.error('FAIL:', e.message);
    process.exit(1);
  }
})();
