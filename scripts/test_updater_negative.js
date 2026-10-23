'use strict';
/* Negative test: mounted DMG payload corrupted → per-file SHA mismatch → abort. */
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const u = require(path.join(ROOT, 'lib', 'updater.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-upd-neg-'));
process.env.WORDPAPER_DATA_DIR = path.join(tmp, 'state');
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

const appPath = path.join(tmp, 'fakeRes', 'WordPaper.app');
const resPath = path.join(appPath, 'Contents', 'Resources');
fs.mkdirSync(resPath, { recursive: true });
for (const f of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html']) fs.writeFileSync(path.join(resPath, f), 'stale');
fs.writeFileSync(path.join(resPath, 'VERSION'), '2.2.3');
for (const d of ['lib', 'css', 'js', 'data', 'assets']) fs.mkdirSync(path.join(resPath, d), { recursive: true });
fs.writeFileSync(path.join(resPath, 'lib', 'updater.js'), 'x');
fs.writeFileSync(path.join(resPath, 'js', 'app.js'), 'x');

const mountRes = path.join(tmp, 'dmgMount', 'WordPaper.app', 'Contents', 'Resources');
fs.mkdirSync(mountRes, { recursive: true });
for (const f of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html']) fs.writeFileSync(path.join(mountRes, f), 'new');
fs.writeFileSync(path.join(mountRes, 'VERSION'), '2.3.0');
for (const d of ['lib', 'css', 'js', 'data', 'assets']) fs.mkdirSync(path.join(mountRes, d), { recursive: true });
fs.writeFileSync(path.join(mountRes, 'lib', 'updater.js'), '// ok');
// CORRUPT: js/app.js has different content than manifest records
fs.writeFileSync(path.join(mountRes, 'js', 'app.js'), '// CLEAN');

const digest = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const manifest = { version: '2.2.3', files: {} };
for (const rel of ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html', 'lib/updater.js', 'js/app.js']) {
  manifest.files[rel] = digest(path.join(mountRes, rel));   // digest the CLEAN payload
}
fs.writeFileSync(path.join(mountRes, 'js', 'app.js'), '// CORRUPTED');  // then corrupt AFTER digesting
manifest.version = '2.3.0';   // 新包自校验要求 manifest.version === target
fs.writeFileSync(path.join(mountRes, 'RELEASE_SHA256.json'), JSON.stringify(manifest));   // 新包内也要有
const runningManifest = { version: '2.2.3', files: manifest.files };   // 旧包自带旧摘要
fs.writeFileSync(path.join(resPath, 'RELEASE_SHA256.json'), JSON.stringify(runningManifest));

u.__setRunningFrom(resPath);
// remap repo-root reads to fakeRes
const realFs = fs;
u.__setFs({
  ...realFs,
  existsSync(p) { return realFs.existsSync(remap(p)); },
  readFileSync(p, enc) { return realFs.readFileSync(remap(p), enc); },
  createReadStream(p, opts) { return realFs.createReadStream(remap(p), opts); },
  writeFileSync(p, d) { return realFs.writeFileSync(remap(p), d); },
  mkdirSync(p, o) { return realFs.mkdirSync(remap(p), o); },
  mkdtempSync(pre) { return realFs.mkdtempSync(pre); },
  rmSync(p, o) { return realFs.rmSync(remap(p), o); },
});
function remap(p) {
  return String(p).startsWith(ROOT + '/') ? path.join(resPath, path.basename(String(p))) : p;
}
u.__setExecFile((cmd, args, opts, cb) => {
  if (cmd.endsWith('rsync')) {
    const src = String(args[args.length - 2]).replace(/\/$/, '');
    const dst = String(args[args.length - 1]).replace(/\/$/, '');
    realFs.cpSync(src, dst, { recursive: true });
    cb(null, '', '');
  } else if (cmd.endsWith('hdiutil')) {
    if (args[0] === 'attach') {
      const mountPoint = args[args.indexOf('-mountpoint') + 1];
      realFs.cpSync(path.join(tmp, 'dmgMount', 'WordPaper.app'), path.join(String(mountPoint), 'WordPaper.app'), { recursive: true });
      cb(null, '', '');
    } else cb(null, '', '');
  } else cb(new Error('unexpected ' + cmd), '', '');
});
u.__setHttpsGet((url, cb) => {
  const fakeRes = Object.assign(new (require('events').EventEmitter)(), {
    statusCode: 200, headers: { 'content-length': '4096' },
    pipe(dest) { dest.write(Buffer.alloc(4096, 0x41)); process.nextTick(() => dest.end()); return dest; },
    resume() { return this; },
    on(ev, fn) { if (ev === 'data') process.nextTick(() => fn(Buffer.alloc(4096, 0x41))); return this; },
  });
  process.nextTick(() => cb(fakeRes));
  return { on: () => {}, destroy: () => {}, setTimeout() {} };
});

(async () => {
  let failed = 0;
  const check = (name, cond) => { console.log((cond ? 'PASS  ' : 'FAIL  ') + name); if (!cond) failed++; };
  try {
    await u.applyUpdate('2.2.3', '2.3.0', () => {});
    check('损坏的安装包被拒绝', false);
    process.exit(1);
  } catch (e) {
    check('损坏的安装包被拒绝', /校验失败|app\.js/.test(e.message));
    // verify the RUNNING resources were NOT touched (abort must happen before rsync)
    check('运行中 Resources 未被触碰', fs.readFileSync(path.join(resPath, 'VERSION'), 'utf8').trim() === '2.2.3');
    const flagPath = path.join(process.env.WORDPAPER_DATA_DIR, 'update-pending.json');
    check('失败时不写重启旗标', !fs.existsSync(flagPath));
    process.exit(failed ? 1 : 0);
  }
})();
