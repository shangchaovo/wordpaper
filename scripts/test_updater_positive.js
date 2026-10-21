'use strict';
/* Updater e2e harness: fake DMG mount + rsync through stubbed execFile/fs. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const u = require(path.join(__dirname, '..', 'lib', 'updater.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-upd-'));
// ── Running app: fakeRes/WordPaper.app/Contents/Resources ──
const appPath = path.join(tmp, 'fakeRes', 'WordPaper.app');
const resPath = path.join(appPath, 'Contents', 'Resources');
fs.mkdirSync(resPath, { recursive: true });
for (const f of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html']) {
  fs.writeFileSync(path.join(resPath, f), 'stale-' + f);
}
fs.writeFileSync(path.join(resPath, 'VERSION'), '2.2.3');
for (const d of ['lib', 'css', 'js', 'data']) fs.mkdirSync(path.join(resPath, d), { recursive: true });
fs.writeFileSync(path.join(resPath, 'lib', 'updater.js'), 'require("x")');
fs.writeFileSync(path.join(resPath, 'js', 'app.js'), 'stale');

// ── Fake mounted DMG contents: dmgMount/WordPaper.app/Contents/Resources (v2.3.0) ──
const mountRes = path.join(tmp, 'dmgMount', 'WordPaper.app', 'Contents', 'Resources');
fs.mkdirSync(mountRes, { recursive: true });
for (const f of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html']) {
  fs.writeFileSync(path.join(mountRes, f), 'new-' + f);
}
fs.writeFileSync(path.join(mountRes, 'VERSION'), '2.3.0');
for (const d of ['lib', 'css', 'js', 'data']) fs.mkdirSync(path.join(mountRes, d), { recursive: true });
fs.writeFileSync(path.join(mountRes, 'lib', 'updater.js'), '// new');
fs.writeFileSync(path.join(mountRes, 'js', 'app.js'), '// new');

// Manifest: per-file digests of the NEW payload (as package_app.py generates).
const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = { version: '2.2.3', files: {} };
for (const rel of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html', 'lib/updater.js', 'js/app.js']) {
  manifest.files[rel] = digest(path.join(mountRes, rel));
}
fs.writeFileSync(path.join(mountRes, 'RELEASE_SHA256.json'), JSON.stringify(manifest));

// Place the manifest in the RUNNING resources too (that's what shaManifest reads).
fs.writeFileSync(path.join(resPath, 'RELEASE_SHA256.json'), JSON.stringify(manifest));

// ── Not from WordPaper.app check: applyUpdate requires runningFrom.includes('WordPaper.app');
//    our fakeRes path includes 'fakeRes/WordPaper.app' — passes. ──
// __dirname of updater is lib/ inside REAL repo, not our fakeRes... The module reads
// shaManifest via its __dirname — that would read the REAL repo's (missing) manifest.
// Test hook: __setFs lets us redirect file reads for the manifest.

// Wrap fs to redirect paths from real <repo>/.. to fakeResPath.
const realFs = fs;
u.__setFs({
  ...realFs,
  existsSync(p) { return realFs.existsSync(remap(p)); },
  readFileSync(p, enc) { return realFs.readFileSync(remap(p), enc); },
  createReadStream(p, opts) { return realFs.createReadStream(remap(p), opts); },
  writeFileSync(p, data) { return realFs.writeFileSync(remap(p), data); },
  mkdirSync(p, opts) { return realFs.mkdirSync(remap(p), opts); },
  mkdtempSync(prefix) { return realFs.mkdtempSync(prefix); },
  rmSync(p, opts) { return realFs.rmSync(remap(p), opts); },
});
function remap(p) {
  // '<repo>/RELEASE_SHA256.json' is requested via path.join(updater.__dirname, '..')
  // — its real value is /Users/xieshangchao/daily-wallpaper/lib/.. = repo root. We
  // remap ALL reads under the repo root into our fakeRes Resources.
  if (String(p).startsWith('/Users/xieshangchao/daily-wallpaper/')) {
    return path.join(resPath, path.basename(String(p)));
  }
  return p;
}

u.__setRunningFrom(resPath);  // the harness pretends the running app root is here

// Stub execFile: hdiutil attach → populate mountpoint with dmgMount copy; rsync → cp.
u.__setExecFile((cmd, args, opts, cb) => {
  if (cmd.endsWith('rsync')) {
    const src = String(args[args.length - 2]).replace(/\/$/, '');
    const dst = String(args[args.length - 1]).replace(/\/$/, '');
    realFs.cpSync(src, dst, { recursive: true });
    cb(null, '', '');
  } else if (cmd.endsWith('hdiutil')) {
    if (args[0] === 'attach') {
      const mountPoint = args[args.indexOf('-mountpoint') + 1];
      // mountRes = .../dmgMount/WordPaper.app/Contents/Resources — the APP dir is two dirs up.
      const appDir = realFs.realpathSync ? path.dirname(path.dirname(path.dirname(mountRes))) : null;
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
    const flagPath = path.join(os.homedir(), '.wordpaper', 'update-pending.json');
    let flag = null;
    try { flag = JSON.parse(fs.readFileSync(flagPath, 'utf8')); } catch {}
    check('重启旗标已写入(from/to 正确)', flag && flag.from === '2.2.3' && flag.to === '2.3.0');
    fs.rmSync(flagPath);
    // manifest 写入新包(应为 rsync 过来的新包版 manifest)
    let newManifest = null;
    try { newManifest = JSON.parse(fs.readFileSync(path.join(resPath, 'RELEASE_SHA256.json'), 'utf8')); } catch {}
    check('RELEASE_SHA256.json 同步成功', Boolean(newManifest));
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
