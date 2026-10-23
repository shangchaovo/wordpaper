/* lib/updater.js — 应用内自更新（仅独立版 local 模式）。
 *
 * 链路：GitHub Releases 上的 DMG（版本必须比当前新）→ 流式下载到临时目录 →
 * SHA256 校验 → hdiutil 挂载 → rsync 同步 Resources 的 payload → 卸载 →
 * 写重启旗标 → server 自己 hardExit；launcher.sh 看到旗标自动重启服务链，
 * 用户全程只需点一次「更新」。
 *
 * 安全边界:
 *  - 只有 MODE==='local' 的独立版（BUNDLED_VERSION 非空）才会启用;
 *  - 目标版本必须严格更新于当前版本（棘轮，不可降级/重装）;
 *  - DMG 走 SHA256 校验（package_app.py 产出的 RELEASE_SHA256.json 提供）,
 *    无清单时退化为「挂载后校验 VERSION 文件与目标版本一致」;
 *  - 只同步 payload 白名单和清单覆盖的 launcher/Info.plist；失败恢复备份；
 *    不触碰用户数据库或已选定的 Node 运行时;
 *  - 数据都在 ~/.wordpaper(仓库外),换 Resources 不动数据。
 *
 * 依赖: server.js 的 execFile 已 require('child_process')。
 */

'use strict';

const os = require('os');
const https = require('https');
const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const REPO = 'shangchaovo/wordpaper';
// 与 scripts/package_app.py 的 PAYLOAD_FILES / PAYLOAD_DIRS 保持一致。
const PAYLOAD_FILES = ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html', 'VERSION'];
const PAYLOAD_DIRS = ['lib', 'css', 'js', 'data', 'assets'];
const ASSETS = {
  arm64: 'WordPaper-macOS-AppleSilicon.dmg',
  x64: 'WordPaper-macOS-Intel.dmg',
  slim: 'WordPaper-macOS-Slim.dmg',
};

function versionNewer(candidate, current) {
  const a = String(candidate).split('.').map(n => parseInt(n, 10) || 0);
  const b = String(current).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}

/** Configurable so tests can inject a stubbed downloader. */
let httpsGet;               // (url, cb) => http.ClientRequest — injectable for tests
let execFileFn = execFile;  // injectable for tests
let fsImpl = fs;            // injectable for tests
let runningFromOverride = null;  // injectable for tests

httpsGet = (url, cb) => https.get(url, { timeout: 15000 }, cb);

/** Follow redirects (GitHub release asset → objects.githubusercontent.com). */
function httpsFollow(url, maxRedirects, cb) {
  if (maxRedirects < 0) { cb(new Error('重定向过多')); return null; }
  let settled = false;
  const done = (error, res) => { if (!settled) { settled = true; cb(error, res); } };
  const req = httpsGet(url, res => {
    if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
      res.resume();
      return httpsFollow(new URL(res.headers.location, url).href, maxRedirects - 1, done);
    }
    done(null, res);
  });
  req.on('error', err => done(err));
  req.on('timeout', () => req.destroy(new Error('下载超时')));
  return req;
}

/** Read RELEASE_SHA256.json from a Resources root (defaults to the running bundle).
 * versionMs: when true, require data.version to equal bundledVersion (running-bundle reads);
 * when false (new-package self-check), skip the version gate — caller compares to target. */
function shaManifest(bundledVersion, root) {
  try {
    const file = path.join(root || path.join(__dirname, '..'), 'RELEASE_SHA256.json');
    if (!fsImpl.existsSync(file)) return null;
    const data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    return data ? data : null;
  } catch { return null; }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fsImpl.createReadStream(file);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Download `url` to `dest` following redirects; resolves with {bytes}.
 * Stall watchdog: 45% 卡死的根因是连接在缓慢滴流——Node 的 timeout 是「字节日闲超时」,
 * 滴流永远不触发。双保险:20s 无字节 → 中止本次尝试(调用方切镜像重试);
 * 总时长 5 分钟墙钟硬上限。 */
const DOWNLOAD_STALL_MS = 20000;
const DOWNLOAD_TOTAL_MS = 5 * 60 * 1000;
function downloadTo(url, dest, onProgress, totalBytes) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stallTimer = null;
    let wallClock = null;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; }
      if (wallClock) { clearTimeout(wallClock); wallClock = null; }
      fn(value);
    };
    const req = httpsFollow(url, 5, (error, res) => {
      if (error) { finish(reject, error); return; }
      if (!res || res.statusCode !== 200) { if (res) res.resume(); finish(reject, new Error('下载失败: HTTP ' + (res && res.statusCode))); return; }
      const declared = Number(res.headers['content-length']) || totalBytes || 0;
      let received = 0, lastReport = 0;
      const out = fsImpl.createWriteStream(dest);
      wallClock = setTimeout(() => {
        try { req.destroy(); } catch {}
        finish(reject, new Error('下载总时长超限(5 分钟)'));
      }, DOWNLOAD_TOTAL_MS);
      if (wallClock.unref) wallClock.unref();
      armStall();
      res.on('data', chunk => {
        received += chunk.length;
        armStall();
        if (onProgress && declared && received - lastReport > 1024 * 1024) {
          lastReport = received;
          onProgress(Math.min(0.95, received / declared));
        }
      });
      res.pipe(out);
      out.on('finish', () => finish(resolve, { bytes: received }));
      out.on('error', error => finish(reject, error));
    });
    function armStall() {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        try { req.destroy(new Error('下载停滞')); } catch {}
        finish(reject, new Error('下载停滞(20 秒无数据),换镜像重试'));
      }, DOWNLOAD_STALL_MS);
      if (stallTimer.unref) stallTimer.unref();
    }
    if (req) req.on('error', error => finish(reject, error));
  });
}

function rmdirrf(dir) { try { fsImpl.rmSync(dir, { recursive: true, force: true }); } catch {} }

function exec(cmd, args, timeout) {
  return new Promise((resolve, reject) => {
    execFileFn(cmd, args, { timeout: timeout || 120000 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }));
      else resolve({ stdout, stderr });
    });
  });
}

/** Which DMG asset fits this machine. Apple Silicon → arm64, Intel → x64. */
function assetForArch() {
  const arch = os.arch(); // 'arm64' | 'x64'
  return arch === 'arm64' ? ASSETS.arm64 : ASSETS.x64;
}

/**
 * Full self-update flow. `bundledVersion` is the running version; `target`
 * the version that /api/update/check already established as newer.
 * onProgress(fraction, stage) drives the UI progress bar.
 * Resolves {done: true} — the caller is expected to have already signalled
 * the user, then call process exit (server's hardExit) itself.
 */
async function applyUpdate(bundledVersion, target, onProgress) {
  if (process.platform !== 'darwin') throw new Error('只有 macOS 独立版支持内置更新');
  if (!bundledVersion) throw new Error('开发/网页部署模式不支持内置更新');
  if (!versionNewer(target, bundledVersion)) throw new Error('目标版本不比当前版本新,拒绝更新');

  const asset = assetForArch();
  const slim = asset === ASSETS.slim;
  // 国内直连 GitHub Release 常失败;与 VERSION 检查同思路,依次尝试直连与镜像。
  const urls = [
    `https://github.com/${REPO}/releases/download/companion-v${target}/${asset}`,
    `https://ghproxy.net/https://github.com/${REPO}/releases/download/companion-v${target}/${asset}`,
  ];
  // 注意:不能拿「运行中旧包」的 manifest 去校验新包——旧 manifest 记录的是旧文件
  // 摘要,新包的 VERSION/JS 一变就必失败(真实事故:『安装包文件校验失败: VERSION』)。
  // 正确做法:用新包自带的 RELEASE_SHA256.json 自校验(DMG 挂载本身有镜像校验,
  // 再逐文件对一遍是防传输损坏的双保险)。旧包 manifest 仍用于声明能力是否存在。

  // 自检:本 App 必须长在一个 WordPaper.app 里(launcher 版式)。测试可注入路径。
  const runningFrom = runningFromOverride || path.resolve(__dirname, '..');
  if (!runningFrom.includes('WordPaper.app')) throw new Error('未从安装的 App 里运行,跳过内置更新');
  // App Translocation:直接从 DMG 双击时 macOS 把 App 放到只读随机临时目录,rsync 无权限
  if (/AppTranslocation/.test(runningFrom)) {
    throw new Error('应用正从安装盘(DMG)转位运行,请先把 WordPaper 拖到「应用程序」再打开');
  }

  const tmpDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-update-'));
  const dmgPath = path.join(tmpDir, asset);
  const mountPoint = path.join(tmpDir, 'mnt');
  const flagPath = path.join(process.env.WORDPAPER_DATA_DIR || path.join(os.homedir(), '.wordpaper'), 'update-pending.json');
  const backups = [];
  let installing = false;
  let preserveBackup = false;

  const progress = (fraction, stage) => { if (onProgress) onProgress(fraction, stage || 'download'); };
  try {
    progress(0, 'download');
    let bytes = 0, lastError = null;
    for (const url of urls) {
      try {
        ({ bytes } = await downloadTo(url, dmgPath, onProgress, slim ? 2 * 1024 * 1024 : 50 * 1024 * 1024));
        if (bytes >= 1024) break;
        lastError = new Error('下载内容为空');
      } catch (e) { lastError = e; }
    }
    if (bytes < 1024) throw lastError || new Error('下载内容为空');

    progress(0.96, 'verify');
    // 挂载出来的包是用 manifest 逐文件校验的 —— DMG 本身因包含运行时差异,
    // 其整体哈希架构不同(两 pass 构建会自校验失效),所以记录的是「逐文件摘要」。

    progress(0.97, 'mount');
    await exec('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath]);
    try {
      const mountedRes = path.join(mountPoint, 'WordPaper.app', 'Contents', 'Resources');
      const mountedVersion = fsImpl.readFileSync(path.join(mountedRes, 'VERSION'), 'utf8').trim();
      if (mountedVersion !== target) throw new Error('挂载出的安装包版本与目标不一致');

      // 新包自校验:读新包自带的 manifest,逐文件对摘要(防挂载/传输损坏)。
      const newManifest = shaManifest(bundledVersion, mountedRes);
      if (newManifest) {
        if (newManifest.version !== target) throw new Error('新包 manifest 版本与目标不一致');
        for (const [rel, expectedHex] of Object.entries(newManifest.files || {})) {
          if (path.isAbsolute(rel) || rel.split(/[\\/]/).some(p => p === '..' || !p)) throw new Error('安装包清单路径无效');
          const got = await sha256File(path.join(mountedRes, rel));
          if (got.toLowerCase() !== String(expectedHex).toLowerCase()) {
            throw new Error('安装包文件校验失败: ' + rel);
          }
        }
      }

      const bundleFiles = ['MacOS/launcher.sh', 'Info.plist'].filter(rel => newManifest && newManifest.bundleFiles && newManifest.bundleFiles[rel]);
      for (const rel of bundleFiles) {
        const got = await sha256File(path.join(mountedRes, '..', rel));
        if (got !== newManifest.bundleFiles[rel]) throw new Error('安装包文件校验失败: ' + rel);
      }

      const res = runningFrom;
      // Old packages have no assets/ or bundleFiles. Preserve compatibility,
      // but newer packages carry both so future updates include the launcher.
      const names = [...PAYLOAD_FILES.filter(n => n !== 'VERSION'), ...PAYLOAD_DIRS.filter(n => fsImpl.existsSync(path.join(mountedRes, n))),
        ...(newManifest ? ['RELEASE_SHA256.json'] : []), 'VERSION'];
      const entries = names.map(name => ({ src: path.join(mountedRes, name), dest: path.join(res, name), directory: PAYLOAD_DIRS.includes(name) }));
      for (const rel of bundleFiles) entries.push({ src: path.join(mountedRes, '..', rel), dest: path.join(res, '..', rel), atomic: true });
      for (const [i, entry] of entries.entries()) {
        const backup = path.join(tmpDir, 'backup', String(i));
        const exists = fsImpl.existsSync(entry.dest);
        if (exists) { fsImpl.mkdirSync(path.dirname(backup), { recursive: true }); fsImpl.cpSync(entry.dest, backup, { recursive: true }); }
        backups.push({ ...entry, backup, exists });
      }
      installing = true;
      progress(0.98, 'install');
      // 目录加尾斜杠(同步「内容」,--delete 作用于目录内);单文件绝不能加 ——
      // 实测 rsync 对文件路径报 "(l)stat: Not a directory",这是 2.3.x/2.4.0
      // 「一键更新必失败」的第三个根因(前两个:launcher wait 对象、旧实例
      // 端口漂移清不掉)。
      for (const entry of entries) {
        if (entry.atomic) {
          fsImpl.mkdirSync(path.dirname(entry.dest), { recursive: true });
          const next = entry.dest + '.wordpaper-next';
          try {
            fsImpl.copyFileSync(entry.src, next);
            fsImpl.chmodSync(next, fsImpl.statSync(entry.src).mode);
            fsImpl.renameSync(next, entry.dest);
          } finally { try { fsImpl.unlinkSync(next); } catch {} }
          continue;
        }
        await exec('/usr/bin/rsync', [
          '-a', '--delete',
          entry.src + (entry.directory ? '/' : ''),
          entry.dest + (entry.directory ? '/' : ''),
        ], 120000);
      }
      // 版本与校验清单也要带上(新包里已有,但 VERSION 可能被 rsync 表覆盖过)
      const newVersion = fsImpl.readFileSync(path.join(res, 'VERSION'), 'utf8').trim();
      if (newVersion !== target) throw new Error('同步后 VERSION 与目标不一致');
    } finally {
      try { await exec('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], 30000); } catch {}
    }

    progress(1, 'restart');
    // 重启旗标:launcher.sh 在 server 退出后读它,自动重新拉起服务链。
    fsImpl.mkdirSync(path.dirname(flagPath), { recursive: true });
    const nextFlag = flagPath + '.next';
    try {
      fsImpl.writeFileSync(nextFlag, JSON.stringify({ from: bundledVersion, to: target, at: new Date().toISOString() }));
      fsImpl.renameSync(nextFlag, flagPath);
    } finally { try { fsImpl.unlinkSync(nextFlag); } catch {} }
    return { ok: true, version: target };
  } catch (error) {
    if (installing) {
      try {
        for (const entry of backups.reverse()) {
          if (entry.atomic && entry.exists) {
            const restore = entry.dest + '.wordpaper-restore';
            fsImpl.copyFileSync(entry.backup, restore);
            fsImpl.chmodSync(restore, fsImpl.statSync(entry.backup).mode);
            fsImpl.renameSync(restore, entry.dest);
          } else {
            fsImpl.rmSync(entry.dest, { recursive: true, force: true });
            if (entry.exists) fsImpl.cpSync(entry.backup, entry.dest, { recursive: true });
          }
        }
      } catch (rollbackError) {
        preserveBackup = true;
        throw new Error(`${error.message}; 恢复旧版本失败: ${rollbackError.message}。备份保留于 ${tmpDir}`);
      }
    }
    throw error;
  } finally {
    if (!preserveBackup) rmdirrf(tmpDir);
  }
}

module.exports = {
  versionNewer,
  applyUpdate,
  shaManifest,
  assetForArch,
  // test hooks — not part of the runtime contract
  __setExecFile: fn => { execFileFn = fn; },
  __setFs: impl => { fsImpl = impl; },
  __setRunningFrom: p => { runningFromOverride = p; },
  __setHttpsGet: fn => { httpsGet = fn; },
};
