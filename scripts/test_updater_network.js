'use strict';

// Release discovery and the production curl path are exercised without touching
// GitHub, the user's proxy, their installed App, or Finder.
Object.defineProperty(process, 'platform', { value: 'darwin' });
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const updater = require('../lib/updater');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'wordpaper-update-network-'));
  const proxyKeys = ['https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY'];
  const originalEnv = Object.fromEntries(proxyKeys.map(key => [key, process.env[key]]));
  proxyKeys.forEach(key => delete process.env[key]);
  const app = path.join(temp, 'WordPaper.app');
  const resources = path.join(app, 'Contents/Resources');
  fs.mkdirSync(resources, { recursive: true });
  updater.__setRunningFrom(resources);
  const dmg = Buffer.alloc(2048, 0x41);
  const valid = {
    tag_name: 'companion-v2.6.1', draft: false, prerelease: false,
    assets: [{ name: updater.assetForArch(), state: 'uploaded', size: dmg.length,
      digest: 'sha256:' + crypto.createHash('sha256').update(dmg).digest('hex'),
      browser_download_url: 'https://github.com/shangchaovo/wordpaper/releases/download/companion-v2.6.1/' + updater.assetForArch() }],
  };
  let release = valid, downloaded = dmg, downloadError, apiError = false, checksumMissing = false;
  const calls = [];
  updater.__setExecFile((cmd, args, opts, callback) => {
    calls.push({ cmd, args, opts });
    if (cmd === '/usr/sbin/scutil') return callback(null, '<dictionary> {\n HTTPSEnable : 1\n HTTPSProxy : 127.0.0.1\n HTTPSPort : 1299\n}', '');
    assert.equal(cmd, '/usr/bin/curl', 'network failure must not reach installer');
    const url = args.at(-1);
    if (url.includes('api.github.com') && apiError) return callback(new Error('HTTP 403: rate limited'), '', 'rate limit exceeded');
    if (url.startsWith('https://github.com/') && url.endsWith('/releases/latest')) return callback(null, 'https://github.com/shangchaovo/wordpaper/releases/tag/companion-v2.6.1', '');
    if (args.includes('--dump-header')) return callback(null, 'HTTP/2 302\r\ncontent-length: 0\r\n\r\nHTTP/2 200\r\ncontent-length: 2048\r\n', '');
    if (/SHA256SUMS(?:\.txt)?$/.test(url)) return callback(null, checksumMissing ? '' : valid.assets[0].digest.slice(7) + '  ' + updater.assetForArch() + '\n', '');
    if (args.includes('--output')) {
      fs.writeFileSync(args[args.indexOf('--output') + 1], downloaded);
      return callback(downloadError || null, '', downloadError ? 'connection timed out' : '');
    }
    callback(null, JSON.stringify(release), '');
  });
  try {
    const latest = await updater.latestRelease();
    assert.equal(latest.version, '2.6.1');
    assert.equal(latest.url, valid.assets[0].browser_download_url);
    assert.equal(latest.sha256, valid.assets[0].digest.slice(7));
    const metadataCall = calls.find(call => call.cmd === '/usr/bin/curl');
    assert(metadataCall.args.includes('https://api.github.com/repos/shangchaovo/wordpaper/releases/latest'));
    assert(metadataCall.args.includes('http://127.0.0.1:1299'));
    assert(metadataCall.args.includes('--proto-redir') && metadataCall.args.includes('=https'));
    assert(metadataCall.opts.timeout <= 17000);
    console.log('PASS published release discovery honors macOS HTTPS proxy and bounded HTTPS curl');

    for (const candidate of [
      { ...valid, draft: true }, { ...valid, prerelease: true }, { ...valid, tag_name: 'main' },
      { ...valid, assets: [] },
      { ...valid, assets: [{ ...valid.assets[0], state: 'new' }] },
      { ...valid, assets: [{ ...valid.assets[0], browser_download_url: 'https://example.com/installer.dmg' }] },
    ]) {
      release = candidate;
      await assert.rejects(updater.latestRelease(), /尚未|正式发布/);
    }
    console.log('PASS drafts, prereleases, missing/incomplete assets and foreign URLs never announce an update');
    release = valid;
    calls.length = 0;
    process.env.HTTPS_PROXY = 'http://127.0.0.1:1300';
    await updater.latestRelease();
    assert(!calls.some(call => call.cmd === '/usr/sbin/scutil'));
    assert(!calls[0].args.includes('--proxy'), 'curl keeps explicit environment proxy precedence');
    delete process.env.HTTPS_PROXY;
    console.log('PASS explicit environment proxy takes precedence over system settings');

    apiError = true;
    const fallback = await updater.latestRelease();
    assert.deepEqual(fallback, latest);
    await assert.rejects(updater.applyUpdate('2.5.0', '2.6.0'), { code: 'RELEASE_CHANGED' });
    checksumMissing = true;
    await assert.rejects(updater.latestRelease(), /尚未发布完成/);
    checksumMissing = false; apiError = false;
    console.log('PASS API rate limiting uses official stable redirect plus ready DMG and checksum; stale targets fail');

    downloaded = Buffer.alloc(512);
    await assert.rejects(updater.applyUpdate('2.6.0', '2.6.1'), /下载不完整/);
    downloaded = Buffer.alloc(2048, 0x42);
    await assert.rejects(updater.applyUpdate('2.6.0', '2.6.1'), /下载校验失败/);
    downloaded = dmg; downloadError = new Error('timeout');
    await assert.rejects(updater.applyUpdate('2.6.0', '2.6.1'), /下载失败.*timed out/);
    const downloadCall = calls.find(call => call.args.includes('--speed-time'));
    assert(downloadCall.args.includes('--speed-time') && downloadCall.args.includes('--max-time'));
    assert(downloadCall.opts.timeout <= 305000);
    assert(!fs.existsSync(downloadCall.args[downloadCall.args.indexOf('--output') + 1]));
    assert(!fs.existsSync(path.join(resources, 'VERSION')));
    console.log('PASS incomplete downloads, digest mismatch and timeout fail before mounting or installing');

    let destroyedRedirect = false;
    updater.__setHttpsGet((url, callback) => {
      const request = new EventEmitter(); request.destroy = () => { if (url.includes('/redirected')) destroyedRedirect = true; };
      process.nextTick(() => {
        if (!url.includes('/redirected')) {
          const res = Readable.from([]); res.statusCode = 302; res.headers = { location: 'https://api.github.com/redirected' }; callback(res);
        } else {
          const res = new Readable({ read() {} }); res.statusCode = 200; res.headers = {};
          callback(res); res.emit('aborted');
        }
      });
      return request;
    });
    await assert.rejects(updater.latestRelease(), /连接中断/);
    assert(destroyedRedirect, 'the active redirected request must be cancelled');
    console.log('PASS aborted metadata response closes the actual redirected request');
  } finally {
    for (const key of proxyKeys) {
      if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key];
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
