/* lib/updater.js — 应用内自更新（仅独立版 local 模式）。
 *
 * 链路：GitHub Releases 上的 DMG（版本必须比当前新）→ 流式下载到临时目录 →
 * SHA256 校验 → 静默挂载 → 安装 Resources 与原生程序 → 卸载 →
 * 写重启旗标 → server 自己 hardExit；launcher.sh 看到旗标自动重启服务链，
 * 用户全程只需点一次「更新」。
 *
 * 安全边界:
 *  - 只有 MODE==='local' 的独立版（BUNDLED_VERSION 非空）才会启用;
 *  - 目标版本必须严格更新于当前版本（棘轮，不可降级/重装）;
 *  - 只下载正式 Release 中当前架构的官方资产，校验 GitHub 提供的摘要(若有)
 *    及安装包内逐文件清单；
 *  - 只同步 payload 白名单和清单覆盖的原生程序/launcher/Info.plist；失败恢复备份；
 *    不触碰用户数据库或已选定的 Node 运行时;
 *  - 数据都在 ~/.wordpaper(仓库外),换 Resources 不动数据。
 *
 * 依赖: server.js 的 execFile 已 require('child_process')。
 */

'use strict';

const os = require('os');
const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const REPO = 'shangchaovo/wordpaper';
// 与 scripts/package_app.py 的 PAYLOAD_FILES / PAYLOAD_DIRS 保持一致。
const PAYLOAD_FILES = ['server.js', 'companion.js', 'package.json', 'index.html', 'login.html', 'connect.html', 'pet-chat.html', 'pet-sentence.html', 'VERSION'];
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
let httpsGet = null;        // optional isolated-test downloader (url, cb)
let execFileFn = execFile;  // injectable for tests
let fsImpl = fs;            // injectable for tests
let runningFromOverride = null;  // injectable for tests

/** Follow redirects (GitHub release asset → objects.githubusercontent.com). */
function httpsFollow(url, maxRedirects, cb) {
  let request, response, settled = false, cancelled = false;
  const done = (error, res) => { if (!settled && !cancelled) { settled = true; cb(error, res); } };
  function follow(target, remaining) {
    if (remaining < 0) return done(new Error('重定向过多'));
    if (new URL(target).protocol !== 'https:') return done(new Error('更新下载必须使用 HTTPS'));
    request = httpsGet(target, res => {
      response = res;
      if (cancelled) { res.destroy?.(); return; }
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        return follow(new URL(res.headers.location, target).href, remaining - 1);
      }
      done(null, res);
    });
    request.on('error', error => done(error));
    request.on('timeout', () => { request.destroy(); done(new Error('下载超时')); });
  }
  follow(url, maxRedirects);
  return { destroy() { cancelled = true; request?.destroy(); response?.destroy?.(); } };
}

// Finder-launched apps do not inherit terminal proxy variables. curl respects
// explicit environment proxies; otherwise honor macOS's configured HTTPS/SOCKS
// proxy, instead of a Node https.get that silently bypasses the user's network.
async function systemProxyArgs() {
  if (['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'].some(key => process.env[key])) return [];
  if (process.platform !== 'darwin') return [];
  try {
    const { stdout } = await exec('/usr/sbin/scutil', ['--proxy'], 2500);
    const value = key => new RegExp('^\\s*' + key + '\\s*:\\s*(.*?)\\s*$', 'm').exec(stdout)?.[1];
    for (const [kind, scheme] of [['HTTPS', 'http'], ['SOCKS', 'socks5h']]) {
      if (value(kind + 'Enable') !== '1') continue;
      const host = value(kind + 'Proxy'), port = Number(value(kind + 'Port'));
      if (!host || !/^[a-zA-Z0-9.:[\]-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      const authority = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
      return ['--proxy', scheme + '://' + authority + ':' + port];
    }
  } catch { /* no system proxy available; use curl's normal direct connection */ }
  return [];
}

async function curlArgs(url, seconds) {
  if (new URL(url).protocol !== 'https:') throw new Error('更新下载必须使用 HTTPS');
  return ['--fail', '--location', '--silent', '--show-error', '--proto', '=https', '--proto-redir', '=https',
    '--connect-timeout', '10', '--max-time', String(seconds), '--max-redirs', '5',
    '--user-agent', 'WordPaper-Updater', ...await systemProxyArgs(), url];
}

function readInjectedJSON(url) {
  return new Promise((resolve, reject) => {
    let controller, timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); controller?.destroy();
      if (error) reject(error); else resolve(value);
    };
    timer = setTimeout(() => finish(new Error('检查更新超时')), 15000);
    controller = httpsFollow(url, 5, (error, res) => {
      if (error) return finish(error);
      if (res.statusCode !== 200) { res.resume(); return finish(new Error('版本检查失败: HTTP ' + res.statusCode)); }
      let body = '';
      res.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024) finish(new Error('版本信息过大'));
      });
      res.on('error', error => finish(error));
      res.on('aborted', () => finish(new Error('版本检查连接中断')));
      res.on('end', () => { try { finish(null, JSON.parse(body)); } catch { finish(new Error('版本信息格式无效')); } });
    });
  });
}

async function releaseMetadata(target) {
  if (target && !/^\d+\.\d+\.\d+$/.test(target)) throw new Error('更新版本格式无效');
  const url = `https://api.github.com/repos/${REPO}/releases/` + (target ? 'tags/companion-v' + target : 'latest');
  let data;
  if (httpsGet) data = await readInjectedJSON(url);
  else {
    const args = await curlArgs(url, 15);
    args.unshift('--max-filesize', '1048576', '--header', 'Accept: application/vnd.github+json');
    let stdout;
    try { ({ stdout } = await exec('/usr/bin/curl', args, 17000)); }
    catch { return officialReleaseFallback(target); }
    try { data = JSON.parse(stdout); } catch { throw new Error('版本信息格式无效'); }
  }
  const match = /^companion-v(\d+\.\d+\.\d+)$/.exec(data?.tag_name || '');
  if (!match || data.draft !== false || data.prerelease !== false || (target && match[1] !== target)) throw new Error('版本尚未正式发布');
  const assetName = assetForArch();
  const expectedURL = `https://github.com/${REPO}/releases/download/${data.tag_name}/${assetName}`;
  const asset = Array.isArray(data.assets) && data.assets.find(value => value.name === assetName && value.state === 'uploaded' && value.browser_download_url === expectedURL && value.size >= 1024);
  if (!asset) throw new Error('这个版本的安装包尚未发布完成，请稍后重试');
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '');
  return { version: match[1], url: expectedURL, size: asset.size, sha256: digest ? digest[1].toLowerCase() : '', releaseUrl: `https://github.com/${REPO}/releases/tag/${data.tag_name}` };
}

function latestRelease() { return releaseMetadata(); }

// GitHub's unauthenticated API quota is shared by the proxy's public IP. Its
// official /latest redirect remains usable when the API returns 403. It only
// selects published stable releases; require both the DMG and its checksum
// asset before treating the redirect as an available update.
async function officialReleaseFallback(target) {
  const repoURL = `https://github.com/${REPO}`;
  const latestArgs = await curlArgs(repoURL + '/releases/latest', 15);
  latestArgs.unshift('--head', '--output', '/dev/null', '--write-out', '%{url_effective}');
  const { stdout: redirect } = await exec('/usr/bin/curl', latestArgs, 17000);
  const match = /^https:\/\/github\.com\/shangchaovo\/wordpaper\/releases\/tag\/companion-v(\d+\.\d+\.\d+)$/.exec(redirect.trim());
  if (!match) throw new Error('版本信息格式无效，请稍后重新检查更新');
  if (target && match[1] !== target) throw Object.assign(new Error('版本信息已变化，请重新检查更新'), { code: 'RELEASE_CHANGED' });
  const base = `${repoURL}/releases/download/companion-v${match[1]}/`;
  const name = assetForArch();
  async function checksumText() {
    for (const filename of ['SHA256SUMS.txt', 'SHA256SUMS']) {
      try {
        const args = await curlArgs(base + filename, 15);
        args.unshift('--max-filesize', '8192');
        return (await exec('/usr/bin/curl', args, 17000)).stdout;
      } catch { /* older releases used the extensionless name */ }
    }
    throw new Error('这个版本的安装包校验文件尚未就绪，请稍后重试');
  }
  const headersArgs = await curlArgs(base + name, 15);
  headersArgs.unshift('--head', '--dump-header', '-', '--output', '/dev/null');
  const [headers, checksums] = await Promise.all([exec('/usr/bin/curl', headersArgs, 17000), checksumText()]);
  const lengths = [...headers.stdout.matchAll(/^content-length:\s*(\d+)\s*$/gim)];
  const size = Number(lengths.at(-1)?.[1]);
  const checksumLine = checksums.split(/\r?\n/).map(line => /^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trim())).find(parts => parts && parts[2] === name);
  if (!Number.isSafeInteger(size) || size < 1024 || !checksumLine) throw new Error('这个版本的安装包尚未发布完成，请稍后重试');
  return { version: match[1], url: base + name, size, sha256: checksumLine[1], releaseUrl: redirect.trim() };
}

/** Read the selected package's per-file checksum manifest. */
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
 * 滴流永远不触发。curl 用低速限制，注入下载器另有无字节看门狗；
 * 总时长 5 分钟墙钟硬上限。 */
const DOWNLOAD_STALL_MS = 20000;
const DOWNLOAD_TOTAL_MS = 5 * 60 * 1000;
function downloadTo(url, dest, onProgress, totalBytes) {
  if (!httpsGet) return downloadWithCurl(url, dest, onProgress, totalBytes);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stallTimer = null, controller, response, out;
    const wallClock = setTimeout(() => finish(reject, new Error('下载总时长超限(5 分钟)')), DOWNLOAD_TOTAL_MS);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer); clearTimeout(wallClock);
      controller?.destroy(); response?.destroy?.(); out?.destroy();
      fn(value);
    };
    armStall();
    controller = httpsFollow(url, 5, (error, res) => {
      if (error) { finish(reject, error); return; }
      if (!res || res.statusCode !== 200) { if (res) res.resume(); finish(reject, new Error('下载失败: HTTP ' + (res && res.statusCode))); return; }
      response = res;
      const declared = Number(res.headers['content-length']) || totalBytes || 0;
      let received = 0, lastReport = 0;
      out = fsImpl.createWriteStream(dest);
      armStall();
      res.on('data', chunk => {
        received += chunk.length;
        armStall();
        if (onProgress && declared && received - lastReport > 1024 * 1024) {
          lastReport = received;
          onProgress(Math.min(0.95, received / declared));
        }
      });
      res.on('error', error => finish(reject, error));
      res.on('aborted', () => finish(reject, new Error('下载连接中断')));
      res.pipe(out);
      out.on('finish', () => {
        if (Number(res.headers['content-length']) && received !== Number(res.headers['content-length'])) return finish(reject, new Error('安装包下载不完整'));
        finish(resolve, { bytes: received });
      });
      out.on('error', error => finish(reject, error));
    });
    function armStall() {
      if (stallTimer) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (settled) return;
        finish(reject, new Error('下载停滞(20 秒无数据)，请检查网络后重试'));
      }, DOWNLOAD_STALL_MS);
      if (stallTimer.unref) stallTimer.unref();
    }
  });
}

async function downloadWithCurl(url, dest, onProgress, totalBytes) {
  const args = await curlArgs(url, DOWNLOAD_TOTAL_MS / 1000);
  args.unshift('--speed-limit', '1024', '--speed-time', '20', '--output', dest);
  const ticker = setInterval(() => {
    if (!onProgress || !totalBytes) return;
    try { onProgress(Math.min(0.95, fsImpl.statSync(dest).size / totalBytes), 'download'); } catch {}
  }, 1000);
  try {
    await exec('/usr/bin/curl', args, DOWNLOAD_TOTAL_MS + 5000);
    const bytes = fsImpl.statSync(dest).size;
    if (totalBytes && bytes !== totalBytes) throw new Error('安装包下载不完整');
    return { bytes };
  } catch (error) {
    try { fsImpl.unlinkSync(dest); } catch {}
    throw new Error('安装包下载失败，请检查网络或代理后重试：' + String(error.stderr || error.message).trim().slice(-300));
  } finally { clearInterval(ticker); }
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
  const release = await releaseMetadata(target);

  const tmpDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-update-'));
  const dmgPath = path.join(tmpDir, asset);
  const mountPoint = path.join(tmpDir, 'mnt');
  const flagPath = path.join(process.env.WORDPAPER_DATA_DIR || path.join(os.homedir(), '.wordpaper'), 'update-pending.json');
  const backups = [];
  let installing = false;
  let preserveBackup = false;
  let nativeReplaced = false;

  const progress = (fraction, stage) => { if (onProgress) onProgress(fraction, stage || 'download'); };
  try {
    progress(0, 'download');
    const { bytes } = await downloadTo(release.url, dmgPath, onProgress, release.size);
    if (bytes < 1024) throw new Error('下载内容为空');

    progress(0.96, 'verify');
    if (release.sha256 && await sha256File(dmgPath) !== release.sha256) throw new Error('安装包下载校验失败，请重试');
    // 挂载出来的包是用 manifest 逐文件校验的 —— DMG 本身因包含运行时差异,
    // 其整体哈希架构不同(两 pass 构建会自校验失效),所以记录的是「逐文件摘要」。

    progress(0.97, 'mount');
    await exec('/usr/bin/hdiutil', ['attach', '-nobrowse', '-noautoopen', '-readonly', '-mountpoint', mountPoint, dmgPath]);
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

      const bundleFiles = ['MacOS/launcher.sh', 'MacOS/WordPaper', 'Info.plist'].filter(rel => newManifest && newManifest.bundleFiles && newManifest.bundleFiles[rel]);
      for (const rel of bundleFiles) {
        const got = await sha256File(path.join(mountedRes, '..', rel));
        if (got !== newManifest.bundleFiles[rel]) throw new Error('安装包文件校验失败: ' + rel);
        if (rel.startsWith('MacOS/') && !(fsImpl.statSync(path.join(mountedRes, '..', rel)).mode & 0o111)) throw new Error('安装包缺少可执行权限: ' + rel);
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
      nativeReplaced = bundleFiles.includes('MacOS/WordPaper');
    } finally {
      try { await exec('/usr/bin/hdiutil', ['detach', mountPoint, '-force'], 30000); } catch {}
    }

    progress(1, 'restart');
    // 重启旗标:launcher.sh 在 server 退出后读它,自动重新拉起服务链。
    fsImpl.mkdirSync(path.dirname(flagPath), { recursive: true });
    const nextFlag = flagPath + '.next';
    try {
      fsImpl.writeFileSync(nextFlag, JSON.stringify({ from: bundledVersion, to: target, at: new Date().toISOString(),
        nativeReplaced, appPath: fsImpl.realpathSync(path.join(runningFrom, '../..')) }));
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
  latestRelease,
  // test hooks — not part of the runtime contract
  __setExecFile: fn => { execFileFn = fn; },
  __setFs: impl => { fsImpl = impl; },
  __setRunningFrom: p => { runningFromOverride = p; },
  __setHttpsGet: fn => { httpsGet = fn; },
};
