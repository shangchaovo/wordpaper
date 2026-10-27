#!/usr/bin/env node
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const net = require('net');
const { promisify } = require('util');
const { execFile, spawn } = require('child_process');
const { openStorage, STATE_NAMESPACES } = require('./lib/storage');

const ROOT = __dirname;
const LOCAL_ENV_FILE = path.join(ROOT, '.env');
if (process.env.NODE_ENV !== 'test' && typeof process.loadEnvFile === 'function' && fs.existsSync(LOCAL_ENV_FILE)) {
  process.loadEnvFile(LOCAL_ENV_FILE);
}
const PORT = Number(process.env.PORT || 8770);
const HOST = process.env.HOST || '127.0.0.1';
const MODE = process.env.WORDPAPER_MODE || (isLoopbackHost(HOST) ? 'local' : 'public');
// Tests must opt into their own companion; the user's desktop may already be
// running on 8771 even when the test web server/database are isolated.
const COMPANION_PORT = Number(process.env.WORDPAPER_COMPANION_PORT || (process.env.NODE_ENV === 'test' ? 1 : 8771));
const COMPANION_ENABLED = MODE === 'local' && process.env.WORDPAPER_COMPANION_ENABLED !== '0';
const DATA_DIR = path.resolve(process.env.WORDPAPER_DATA_DIR || path.join(os.homedir(), '.wordpaper'));
const PUBLIC_ORIGIN = String(process.env.WORDPAPER_PUBLIC_ORIGIN || '').replace(/\/$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_DAYS = Math.max(1, Math.min(365, Number(process.env.WORDPAPER_SESSION_DAYS) || 30));
const OAUTH_FLOW_SECONDS = 10 * 60;
const ACCOUNT_AUTH_MS = 10 * 60 * 1000;
const ACCOUNT_ERRORS = {
  identity_in_use: '这个第三方账号已绑定其他 WordPaper 账号，请先在原账号中解除绑定。',
  binding_changed: '绑定状态已经变化，请刷新后重试。',
  last_login_method: '请先添加另一种可用的登录方式，再解除绑定。',
  reauth_required: '请先验证当前账号，再管理绑定。',
  oauth_expired: '授权已过期或登录状态已改变，请重新尝试。',
  oauth_cancelled: '已取消授权，原有绑定保持不变。',
  oauth_failed: '授权未完成，原有绑定保持不变，请稍后重试。',
};
const EMAIL_CODE_SECONDS = 10 * 60;
const EMAIL_CODE_COOLDOWN_MS = 60 * 1000;
const GOOGLE_CLIENT_ID = String(process.env.WORDPAPER_GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = String(process.env.WORDPAPER_GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REDIRECT_URI = String(process.env.WORDPAPER_GOOGLE_REDIRECT_URI || '').trim();
const WECHAT_APP_ID = String(process.env.WORDPAPER_WECHAT_APP_ID || '').trim();
const WECHAT_APP_SECRET = String(process.env.WORDPAPER_WECHAT_APP_SECRET || '').trim();
const WECHAT_REDIRECT_URI = String(process.env.WORDPAPER_WECHAT_REDIRECT_URI || '').trim();
const RESEND_API_KEY = String(process.env.WORDPAPER_RESEND_API_KEY || '').trim();
const EMAIL_FROM = String(process.env.WORDPAPER_EMAIL_FROM || '').trim();
const MAX_JSON_BYTES = 25 * 1024 * 1024;
const MAX_PROXY_BYTES = 25 * 1024 * 1024;
const scryptAsync = promisify(crypto.scrypt);

function providerEndpoint(envName, fallback) {
  return process.env.NODE_ENV === 'test' && process.env[envName] ? String(process.env[envName]) : fallback;
}

const GOOGLE_AUTHORIZATION_ENDPOINT = providerEndpoint('WORDPAPER_TEST_GOOGLE_AUTHORIZATION_ENDPOINT', 'https://accounts.google.com/o/oauth2/v2/auth');
const GOOGLE_TOKEN_ENDPOINT = providerEndpoint('WORDPAPER_TEST_GOOGLE_TOKEN_ENDPOINT', 'https://oauth2.googleapis.com/token');
const GOOGLE_USERINFO_ENDPOINT = providerEndpoint('WORDPAPER_TEST_GOOGLE_USERINFO_ENDPOINT', 'https://openidconnect.googleapis.com/v1/userinfo');
const WECHAT_AUTHORIZATION_ENDPOINT = providerEndpoint('WORDPAPER_TEST_WECHAT_AUTHORIZATION_ENDPOINT', 'https://open.weixin.qq.com/connect/qrconnect');
const WECHAT_TOKEN_ENDPOINT = providerEndpoint('WORDPAPER_TEST_WECHAT_TOKEN_ENDPOINT', 'https://api.weixin.qq.com/sns/oauth2/access_token');
const WECHAT_USERINFO_ENDPOINT = providerEndpoint('WORDPAPER_TEST_WECHAT_USERINFO_ENDPOINT', 'https://api.weixin.qq.com/sns/userinfo');
const RESEND_EMAIL_ENDPOINT = providerEndpoint('WORDPAPER_TEST_RESEND_ENDPOINT', 'https://api.resend.com/emails');

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('PORT 必须是 1-65535 的整数');
if (!Number.isInteger(COMPANION_PORT) || COMPANION_PORT < 1 || COMPANION_PORT > 65535) throw new Error('WORDPAPER_COMPANION_PORT 无效');

const storage = openStorage(DATA_DIR);
storage.deleteExpiredSessions();
storage.deleteExpiredOAuthFlows();

// 主账号镜像(卫星模式):本机作为上游账号的实时缓存 + 写入代理。
// 只有 local 模式允许配对/镜像;public 实例永远是权威数据源,不做卫星。
const upstream = require('./lib/upstream');
const updater = require('./lib/updater');
upstream.init({
  storage,
  usernameKey,
  createUser: (username, key, hash) => storage.createUser(username, key, hash),
  findUserByKey: key => storage.findUserByKey(key),
});
upstream.startBackground();
function mirroring() { return MODE === 'local' && upstream.isPaired(); }
const handleDeviceAuth = require('./lib/device-auth').createDeviceAuth({
  storage, upstream, json, readJson, requireOrigin, requireCsrf, requireSession,
  requestSession, authRateAllowed, expectedOrigin, oauthProviderConfigured, newSession,
  isLoopbackRequest, mode: MODE, sessionDays: SESSION_DAYS, parseCookies,
});

// ── 新版本提示(仅独立版/本地模式):仓库根的 VERSION 是唯一版本源,
//    与 GitHub main 的 VERSION 比较,有新版本时在 /api/session 里带给页面。 ──
const BUNDLED_VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return ''; } })();
let latestVersion = '';
let updateApplying = false;   // 应用内更新进行中(CSRF 保护后的互斥)
let lastRefreshProbe = 0;     // 上次手动 refresh 的时间戳(30s 限速)
let updateProgress = null;   // {fraction, stage} — 前端经 /api/update/status 轮询
let updateError = '';
let updateRequest = null;   // 进行中的版本检查请求;shutdown 时取消,避免卡住退出
function versionNewer(candidate, current) {
  const a = String(candidate).split('.').map(n => parseInt(n, 10) || 0);
  const b = String(current).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
// 版本源按可达性排序:直连 raw 在多数网络上可用;失败时退到 ghproxy(国内可达)与
// fastly.jsdelivr(CN 加速)。任一成功即停止。
const VERSION_SOURCES = [
  'https://raw.githubusercontent.com/shangchaovo/wordpaper/main/VERSION',
  'https://ghproxy.net/https://raw.githubusercontent.com/shangchaovo/wordpaper/main/VERSION',
  'https://fastly.jsdelivr.net/gh/shangchaovo/wordpaper@main/VERSION',
];
function checkForUpdateOnce(url) {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: 8000 }, res => {
      if (res.statusCode !== 200) { res.resume(); resolve(false); return; }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        const v = body.trim();
        if (/^\d+\.\d+\.\d+$/.test(v)) { latestVersion = v; resolve(true); }
        else resolve(false);
      });
    });
    updateRequest = req;
    req.on('close', () => { if (updateRequest === req) updateRequest = null; });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}
// 并发竞态保护:一次只有一个探索在跑
let updateChecking = false;
let updateCheckPromise = null;
async function checkForUpdate() {
  if (!BUNDLED_VERSION || MODE !== 'local') return false;
  if (updateChecking) return updateCheckPromise;
  updateChecking = true;
  updateCheckPromise = (async () => {
    for (const url of VERSION_SOURCES) {
      if (await checkForUpdateOnce(url)) { updateChecking = false; return true; }
    }
    updateChecking = false;
    return false;
  })();
  return updateCheckPromise;
}
checkForUpdate();
setInterval(checkForUpdate, 24 * 60 * 60 * 1000).unref();
function updateNotice() {
  return latestVersion && BUNDLED_VERSION && versionNewer(latestVersion, BUNDLED_VERSION) ? { latest: latestVersion } : null;
}
function updateStatus() {
  return { applying: updateApplying, progress: updateProgress, error: updateError,
    current: BUNDLED_VERSION || '', target: latestVersion || '', latest: latestVersion || '',
    available: Boolean(updateNotice()), checked: Boolean(latestVersion) };
}
function beginUpdate(target) {
  updateApplying = true;
  updateError = '';
  updateProgress = { fraction: 0, stage: 'download' };
  updater.applyUpdate(BUNDLED_VERSION, target, (fraction, stage) => {
    updateProgress = { fraction, stage };
  }).then(() => {
    updateProgress = { fraction: 1, stage: 'restart' };
    // Only a successful install has a restart flag. Keep failed installs online.
    setTimeout(shutdown, 1200);
  }).catch(error => {
    updateApplying = false;
    updateProgress = null;
    updateError = String(error.message || error);
    console.error('[update] apply failed:', updateError);
  });
}
storage.deleteExpiredEmailVerifications();
setInterval(() => {
  storage.deleteExpiredSessions();
  storage.deleteExpiredOAuthFlows();
  storage.deleteExpiredEmailVerifications();
}, 60 * 60 * 1000).unref();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const STATIC_RULES = {
  css: new Set(['.css', '.woff', '.woff2', '.png', '.svg']),
  js: new Set(['.js']),
  data: new Set(['.json']),
  // assets/ 只放图标等同资源(favicon/app 图标/DMG 背景);类型白名单拦 .icns/.json 等,
  // 且入口判定已在 safeStaticPath 里挡 ".."/隐藏文件,无目录穿越风险。
  assets: new Set(['.png', '.svg', '.ico']),
};

const COMPANION_METHODS = new Map([
  ['/ocr.php', new Set(['HEAD', 'POST'])],
  ['/set-wallpaper.php', new Set(['HEAD', 'POST'])],
  ['/pet.php', new Set(['POST'])],
  ['/pet-mode.php', new Set(['POST'])],
  ['/pet-speak.php', new Set(['POST'])],
  ['/pet-quiz.php', new Set(['POST'])],
  ['/pet-quiz-shown.php', new Set(['POST'])],
  ['/pet-sentence-window.php', new Set(['POST'])],
  ['/pet-sentence.php', new Set(['POST'])],
  ['/pet-sentence.json', new Set(['GET'])],
  ['/pet-ime.php', new Set(['POST'])],
  ['/pet-celebrate.php', new Set(['POST'])],
  ['/pet-patrick.json', new Set(['GET'])],
  ['/pet-size.php', new Set(['HEAD', 'POST'])],
  ['/pet-page.php', new Set(['POST'])],
  ['/pet-sync.php', new Set(['POST'])],
  ['/pet-memory-events.json', new Set(['GET'])],
  ['/pet-current.json', new Set(['GET'])],
  ['/next.php', new Set(['POST'])],
  ['/prev.php', new Set(['POST'])],
]);

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1'].includes(String(host).replace(/^\[|\]$/g, ''));
}

function isLoopbackRequest(req) {
  const address = req.socket && req.socket.remoteAddress;
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/* 本机网卡地址集合(每次现算,网卡/DHCP 变化也能跟上;只用于伴侣这种低频判断)。 */
function ownInterfaceAddresses() {
  const set = new Set();
  try {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list || []) if (ni && ni.address) set.add(ni.address);
    }
  } catch {}
  return set;
}

/* 「这台机器自己」的请求:回环,或源地址是本机任意网卡 IP(同一台 Mac 用自己的
   局域网 IP / mDNS 主机名访问时,源地址就是本机网卡地址)。真正的远端机器(卫星机)
   源地址不在本机网卡列表里,仍被挡在门外——伴侣驱动的是这台机器的桌面,不该被远程控制。
   TCP 三次握手决定了远端无法伪造本机源地址完成连接,所以这个判断是安全的。 */
function isSameMachineRequest(req) {
  const raw = req.socket && req.socket.remoteAddress;
  if (!raw) return false;
  if (raw === '127.0.0.1' || raw === '::1' || raw === '::ffff:127.0.0.1') return true;
  const addr = raw.startsWith('::ffff:') ? raw.slice(7) : raw;
  return ownInterfaceAddresses().has(addr);
}

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
}

function json(res, status, value, headers) {
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  }, headers || {}));
  res.end(JSON.stringify(value));
}

function text(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(value);
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function parseCookies(req) {
  const cookies = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const index = part.indexOf('=');
    if (index < 0) return;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = value;
  });
  return cookies;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

function requestSession(req) {
  const cookies = parseCookies(req);
  const token = cookies['__Host-wp_session'] || cookies.wp_session;
  const session = token ? storage.findSession(tokenHash(token)) : null;
  if (session && mirroring() && session.user.id !== upstream.localUserId()) return null;
  return session;
}

function lastForwardedValue(req, headerName) {
  if (!TRUST_PROXY) return '';
  const values = String(req.headers[headerName] || '').split(',').map(value => value.trim()).filter(Boolean);
  return values.length ? values[values.length - 1] : '';
}

function isSecureRequest(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (!TRUST_PROXY) return false;
  return lastForwardedValue(req, 'x-forwarded-proto') === 'https';
}

function sessionCookie(req, token, maxAge, sameSite) {
  const secure = isSecureRequest(req);
  const name = secure ? '__Host-wp_session' : 'wp_session';
  return `${name}=${token}; Path=/; HttpOnly; SameSite=${sameSite || 'Strict'}; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function clearSessionCookies() {
  return [
    'wp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    '__Host-wp_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0',
  ];
}

function oauthFlowCookie(req, binding, maxAge) {
  const secure = isSecureRequest(req);
  const name = secure ? '__Host-wp_oauth_flow' : 'wp_oauth_flow';
  return `${name}=${binding}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function clearOAuthFlowCookies() {
  return [
    'wp_oauth_flow=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
    '__Host-wp_oauth_flow=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0',
  ];
}

function appendSetCookies(res, cookies) {
  const current = res.getHeader('Set-Cookie');
  const values = current == null ? [] : Array.isArray(current) ? current : [current];
  res.setHeader('Set-Cookie', values.concat(cookies));
}

function expectedOrigin(req) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const protocol = isSecureRequest(req) ? 'https' : 'http';
  const forwardedHost = lastForwardedValue(req, 'x-forwarded-host');
  const host = forwardedHost || req.headers.host;
  return host ? `${protocol}://${host}` : '';
}

function validMutationOrigin(req) {
  const origin = String(req.headers.origin || '');
  if (!origin) return process.env.NODE_ENV !== 'production';
  return origin === expectedOrigin(req);
}

function requireOrigin(req, res) {
  if (validMutationOrigin(req)) return true;
  json(res, 403, { error: '请求来源校验失败' });
  return false;
}

function requireSession(req, res) {
  const session = requestSession(req);

  if (session) return session;
  json(res, 401, { error: '请先登录' });
  return null;
}

function requireCsrf(req, res, session) {
  if (!requireOrigin(req, res)) return false;
  const supplied = String(req.headers['x-csrf-token'] || '');
  const actual = Buffer.from(supplied);
  const expected = Buffer.from(session.csrfToken);
  if (actual.length === expected.length && crypto.timingSafeEqual(actual, expected)) return true;
  json(res, 403, { error: 'CSRF 校验失败' });
  return false;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const length = Number(req.headers['content-length'] || 0);
    if (length > limit) {
      const error = new Error('payload too large'); error.status = 413; reject(error); req.resume(); return;
    }
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooLarge) { const error = new Error('payload too large'); error.status = 413; reject(error); return; }
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
    const error = new Error('Content-Type 必须是 application/json'); error.status = 415; throw error;
  }
  const body = await readBody(req, MAX_JSON_BYTES);
  try { return JSON.parse(body.toString('utf8') || '{}'); }
  catch { const error = new Error('JSON 格式无效'); error.status = 400; throw error; }
}

function normalizeUsername(value) {
  return String(value || '').trim().normalize('NFKC');
}

function usernameKey(value) {
  return normalizeUsername(value).toLowerCase();
}

function normalizeEmail(value) {
  return String(value || '').trim().normalize('NFKC').toLowerCase();
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
}

function emailDeliveryConfigured() {
  return Boolean(RESEND_API_KEY && EMAIL_FROM && EMAIL_FROM.length <= 320 && !/[\r\n]/.test(EMAIL_FROM));
}

function emailDebugAllowed(req) {
  return process.env.NODE_ENV === 'test'
    || (process.env.NODE_ENV !== 'production' && MODE === 'local' && isLoopbackRequest(req));
}

function emailRegistrationEnabled(req) {
  return emailDeliveryConfigured() || emailDebugAllowed(req);
}

function emailCodeHash(email, code) {
  return tokenHash(`${email}\0${code}`);
}

function validateCredentials(body) {
  const rawIdentifier = body && (body.email != null ? body.email : body.identifier != null ? body.identifier : body.username);
  const normalized = normalizeUsername(rawIdentifier);
  const explicitEmail = Boolean(body && body.email != null);
  const email = explicitEmail || normalized.includes('@') ? normalizeEmail(normalized) : '';
  const username = email || normalized;
  const password = String(body && body.password || '');
  if ((explicitEmail || email) && !validEmail(email)) {
    const error = new Error('请输入有效的邮箱地址'); error.status = 400; throw error;
  }
  if (!email && !/^[\p{L}\p{N}_.-]{3,32}$/u.test(username)) {
    const error = new Error('用户名需为 3-32 位文字、数字、点、横线或下划线'); error.status = 400; throw error;
  }
  if (Buffer.byteLength(password, 'utf8') < 8 || Buffer.byteLength(password, 'utf8') > 256) {
    const error = new Error('密码长度需为 8-128 个字符'); error.status = 400; throw error;
  }
  return { username, usernameKey: email || usernameKey(username), email, password };
}

async function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const N = 32768, r = 8, p = 1;
  const derived = await scryptAsync(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
}

async function passwordMatches(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]), r = Number(parts[2]), p = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');
  if (!N || !r || !p || salt.length < 16 || expected.length !== 64) return false;
  const actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return crypto.timingSafeEqual(expected, actual);
}

function newSession(req, res, user, allowLegacyImport, sameSite) {
  const previous = requestSession(req);
  if (previous) storage.deleteSession(previous.tokenHash);
  const token = crypto.randomBytes(32).toString('base64url');
  const csrfToken = crypto.randomBytes(24).toString('base64url');
  const maxAge = SESSION_DAYS * 24 * 60 * 60;
  storage.createSession(tokenHash(token), user.id, csrfToken, Date.now() + maxAge * 1000, allowLegacyImport);
  const obsolete = isSecureRequest(req)
    ? 'wp_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0'
    : '__Host-wp_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0';
  res.setHeader('Set-Cookie', [sessionCookie(req, token, maxAge, sameSite), obsolete]);
  return { user: { id: user.id, username: user.username }, csrfToken };
}

const authAttempts = new Map();
function authRateAllowed(req) {
  // With one trusted reverse-proxy hop, the proxy-appended rightmost address is
  // authoritative; client-supplied values can only appear to its left.
  const forwardedCandidate = lastForwardedValue(req, 'x-forwarded-for');
  const forwarded = net.isIP(forwardedCandidate) ? forwardedCandidate : '';
  const key = forwarded || String(req.socket.remoteAddress || 'unknown');
  const now = Date.now();
  let entry = authAttempts.get(key);
  if (!entry || entry.resetAt <= now) entry = { count: 0, resetAt: now + 10 * 60 * 1000 };
  entry.count += 1;
  authAttempts.set(key, entry);
  return entry.count <= 30;
}

function safeNextPath(value) {
  const candidate = String(value || '/');
  if (!candidate.startsWith('/') || candidate.startsWith('//') || candidate.includes('\\')) return '/';
  try {
    const parsed = new URL(candidate, 'http://wordpaper.invalid');
    if (parsed.origin !== 'http://wordpaper.invalid') return '/';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return '/';
  }
}

function oauthProviderConfigured(provider) {
  const stableCallback = process.env.NODE_ENV !== 'production' || Boolean(PUBLIC_ORIGIN || (provider === 'google' ? GOOGLE_REDIRECT_URI : WECHAT_REDIRECT_URI));
  if (provider === 'google') return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET && stableCallback);
  if (provider === 'wechat') return Boolean(WECHAT_APP_ID && WECHAT_APP_SECRET && stableCallback);
  return false;
}

function oauthRedirectUri(req, provider) {
  const configured = provider === 'google' ? GOOGLE_REDIRECT_URI : WECHAT_REDIRECT_URI;
  return configured || `${expectedOrigin(req)}/api/auth/${provider}/callback`;
}

function validOAuthRedirectUri(value, provider) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash || parsed.search) return false;
    if (parsed.pathname !== `/api/auth/${provider}/callback`) return false;
    return process.env.NODE_ENV !== 'production' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function oauthBinding(req) {
  const cookies = parseCookies(req);
  return String(cookies['__Host-wp_oauth_flow'] || cookies.wp_oauth_flow || '');
}

function oauthFailure(res, code, flow) {
  appendSetCookies(res, clearOAuthFlowCookies());
  redirect(res, flow && flow.purpose !== 'login'
    ? `/?accountError=${encodeURIComponent(code)}#account`
    : `/login.html?authError=${encodeURIComponent(code)}`);
}

function oauthStart(req, res, parsed, provider, accountFlow) {
  if (!oauthProviderConfigured(provider)) {
    oauthFailure(res, `${provider}_not_configured`);
    return;
  }
  if (!accountFlow && !authRateAllowed(req)) {
    oauthFailure(res, 'rate_limited');
    return;
  }

  const redirectUri = oauthRedirectUri(req, provider);
  if (!validOAuthRedirectUri(redirectUri, provider)) {
    oauthFailure(res, `${provider}_not_configured`);
    return;
  }

  const state = crypto.randomBytes(32).toString('base64url');
  const binding = crypto.randomBytes(32).toString('base64url');
  const codeVerifier = provider === 'google' ? crypto.randomBytes(48).toString('base64url') : '';
  const nextPath = accountFlow ? '/#account' : safeNextPath(parsed.searchParams.get('next'));
  const initiatingSession = requestSession(req);
  storage.createOAuthFlow(
    tokenHash(state), tokenHash(binding), provider, codeVerifier,
    initiatingSession && initiatingSession.tokenHash,
    redirectUri, nextPath, Date.now() + OAUTH_FLOW_SECONDS * 1000,
    accountFlow?.purpose || 'login', accountFlow?.expectedSubject || '',
  );
  res.setHeader('Set-Cookie', oauthFlowCookie(req, binding, OAUTH_FLOW_SECONDS));
  if (accountFlow && initiatingSession) {
    // Keep the existing account available on the cross-site callback and its
    // redirect, including provider cancellation. Mutations still require CSRF.
    const cookies = parseCookies(req);
    const token = cookies['__Host-wp_session'] || cookies.wp_session;
    appendSetCookies(res, [sessionCookie(req, token, Math.max(1, Math.floor((initiatingSession.expiresAt - Date.now()) / 1000)), 'Lax')]);
  }

  if (provider === 'google') {
    const authorization = new URL(GOOGLE_AUTHORIZATION_ENDPOINT);
    authorization.searchParams.set('client_id', GOOGLE_CLIENT_ID);
    authorization.searchParams.set('redirect_uri', redirectUri);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('scope', 'openid email profile');
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('code_challenge', crypto.createHash('sha256').update(codeVerifier).digest('base64url'));
    authorization.searchParams.set('code_challenge_method', 'S256');
    authorization.searchParams.set('prompt', 'select_account');
    if (accountFlow) json(res, 200, { authorizationUrl: authorization.toString() });
    else redirect(res, authorization.toString());
    return;
  }

  const authorization = new URL(WECHAT_AUTHORIZATION_ENDPOINT);
  authorization.searchParams.set('appid', WECHAT_APP_ID);
  authorization.searchParams.set('redirect_uri', redirectUri);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('scope', 'snsapi_login');
  authorization.searchParams.set('state', state);
  authorization.hash = 'wechat_redirect';
  if (accountFlow) json(res, 200, { authorizationUrl: authorization.toString() });
  else redirect(res, authorization.toString());
}

async function providerJson(url, options) {
  const response = await fetch(url, Object.assign({}, options || {}, { signal: AbortSignal.timeout(10_000) }));
  const raw = await response.text();
  if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) throw new Error('identity provider response too large');
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error(`identity provider returned invalid JSON (${response.status})`); }
  if (!response.ok) throw new Error(`identity provider HTTP ${response.status}`);
  return body;
}

async function sendEmailVerification(email, code) {
  await providerJson(RESEND_EMAIL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [email],
      subject: 'WordPaper 邮箱验证码',
      text: `你的 WordPaper 验证码是 ${code}。验证码 10 分钟内有效；如果不是你本人操作，请忽略此邮件。`,
      html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1d1d1f;line-height:1.7"><p>你的 WordPaper 验证码是：</p><p style="font-size:30px;font-weight:700;letter-spacing:.18em">${code}</p><p style="color:#6e6e73">验证码 10 分钟内有效；如果不是你本人操作，请忽略此邮件。</p></div>`,
    }),
  });
}

function usableAccessToken(value) {
  const token = String(value || '');
  return token && token.length <= 4096 && !/[\r\n]/.test(token) ? token : '';
}

async function googleIdentity(code, flow) {
  const form = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: flow.redirectUri,
    grant_type: 'authorization_code',
    code_verifier: flow.codeVerifier,
  });
  const tokenBody = await providerJson(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: form.toString(),
  });
  const accessToken = usableAccessToken(tokenBody.access_token);
  if (!accessToken) throw new Error('Google did not return an access token');
  const profile = await providerJson(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const subject = String(profile.sub || '').trim();
  const email = normalizeEmail(profile.email);
  if (!subject || subject.length > 255 || !validEmail(email) || profile.email_verified !== true) {
    throw new Error('Google identity is missing a verified subject or email');
  }
  return {
    subject,
    profile: {
      email,
      emailVerified: true,
      displayName: String(profile.name || email.split('@')[0] || 'Google 用户'),
    },
  };
}

async function wechatIdentity(code, flow) {
  const tokenUrl = new URL(WECHAT_TOKEN_ENDPOINT);
  tokenUrl.searchParams.set('appid', WECHAT_APP_ID);
  tokenUrl.searchParams.set('secret', WECHAT_APP_SECRET);
  tokenUrl.searchParams.set('code', code);
  tokenUrl.searchParams.set('grant_type', 'authorization_code');
  const tokenBody = await providerJson(tokenUrl, { headers: { Accept: 'application/json' } });
  if (tokenBody.errcode) throw new Error(`WeChat token error ${tokenBody.errcode}`);
  const accessToken = usableAccessToken(tokenBody.access_token);
  const openid = String(tokenBody.openid || '').trim();
  if (!accessToken || !openid || openid.length > 255) throw new Error('WeChat did not return a usable identity');

  const profileUrl = new URL(WECHAT_USERINFO_ENDPOINT);
  profileUrl.searchParams.set('access_token', accessToken);
  profileUrl.searchParams.set('openid', openid);
  profileUrl.searchParams.set('lang', 'zh_CN');
  const profile = await providerJson(profileUrl, { headers: { Accept: 'application/json' } });
  if (profile.errcode) throw new Error(`WeChat profile error ${profile.errcode}`);
  if (String(profile.openid || '') !== openid) throw new Error('WeChat identity mismatch');
  return {
    // openid is scoped to one website AppID, so include that namespace in the
    // durable subject. Nickname and unionid are never used as the login key.
    subject: `${WECHAT_APP_ID}:${openid}`,
    profile: { displayName: String(profile.nickname || '微信用户'), email: '', emailVerified: false },
  };
}

async function oauthCallback(req, res, parsed, provider) {
  if (!oauthProviderConfigured(provider)) {
    oauthFailure(res, `${provider}_not_configured`);
    return;
  }
  const state = String(parsed.searchParams.get('state') || '');
  const code = String(parsed.searchParams.get('code') || '');
  const binding = oauthBinding(req);
  if (!state || state.length > 256 || !binding || binding.length > 256) {
    oauthFailure(res, 'oauth_expired');
    return;
  }
  const flow = storage.consumeOAuthFlow(tokenHash(state), tokenHash(binding), provider);
  if (!flow) {
    oauthFailure(res, 'oauth_expired');
    return;
  }
  if (parsed.searchParams.get('error') || !code) {
    oauthFailure(res, 'oauth_cancelled', flow);
    return;
  }
  if (code.length > 4096) { oauthFailure(res, 'oauth_expired', flow); return; }

  try {
    // Password sessions are SameSite=Strict and may be absent on the cross-site
    // callback. The Lax flow cookie binds this browser to its initiating session;
    // that session must still exist, both before and after the provider request.
    const boundSession = () => {
      const session = storage.findSession(flow.initiatingSessionHash);
      const current = requestSession(req);
      if (!session || (current && current.tokenHash !== session.tokenHash)) {
        throw Object.assign(new Error('oauth_expired'), { code: 'oauth_expired' });
      }
      return session;
    };
    if (flow.purpose !== 'login') boundSession();
    const identity = provider === 'google' ? await googleIdentity(code, flow) : await wechatIdentity(code, flow);
    if (flow.purpose !== 'login') {
      const session = boundSession();
      if (flow.purpose === 'reauth') {
        const linked = storage.accountCredentials(session.user.id).identities.find(row => row.provider === provider);
        if (!linked || linked.provider_subject !== identity.subject || identity.subject !== flow.expectedSubject) {
          throw Object.assign(new Error('binding_changed'), { code: 'binding_changed' });
        }
        storage.markSessionAuthenticated(session.tokenHash);
      } else {
        if (Date.now() - session.authenticatedAt > ACCOUNT_AUTH_MS) {
          throw Object.assign(new Error('reauth_required'), { code: 'reauth_required' });
        }
        storage.bindIdentity(session.user.id, provider, identity.subject, identity.profile, flow.expectedSubject, session.tokenHash);
      }
      appendSetCookies(res, clearOAuthFlowCookies());
      redirect(res, `/?accountSuccess=${flow.purpose === 'reauth' ? 'verified' : 'bound'}#account`);
      return;
    }
    const account = storage.findOrCreateFederatedUser(provider, identity.subject, identity.profile);
    newSession(req, res, account.user, account.created, 'Lax');
    if (flow.initiatingSessionHash) storage.deleteSession(flow.initiatingSessionHash);
    appendSetCookies(res, clearOAuthFlowCookies());
    redirect(res, flow.nextPath);
  } catch (error) {
    if (!ACCOUNT_ERRORS[error.code]) console.error(`${provider} OAuth failed:`, error && error.message ? error.message : error);
    oauthFailure(res, ACCOUNT_ERRORS[error.code] ? error.code : 'oauth_failed', flow);
  }
}

async function handleAccount(req, res, parsed) {
  const session = requireSession(req, res);
  if (!session) return;
  if (mirroring()) {
    if (parsed.pathname === '/api/account' && req.method === 'GET') {
      json(res, 200, { managedExternally: true, accountUrl: upstream.pairedInfo().url + '/#account' });
    } else json(res, 409, { error: '请在主账号所在的 WordPaper 网站管理登录绑定。' });
    return;
  }
  const credentials = storage.accountCredentials(session.user.id);
  const enabledProviders = ['google', 'wechat'].filter(oauthProviderConfigured);
  const reauthRequired = () => Date.now() - session.authenticatedAt > ACCOUNT_AUTH_MS;
  if (parsed.pathname === '/api/account' && req.method === 'GET') {
    json(res, 200, {
      user: session.user, hasPassword: Boolean(credentials.passwordHash), reauthRequired: reauthRequired(),
      providers: ['google', 'wechat'].map(provider => {
        const identity = credentials.identities.find(row => row.provider === provider);
        return {
          provider, enabled: enabledProviders.includes(provider), bound: Boolean(identity),
          label: identity ? identity.email || identity.display_name || (provider === 'google' ? 'Google 账号' : '微信账号') : '',
          canUnlink: Boolean(identity && (credentials.passwordHash || credentials.identities.some(row => row.provider !== provider && enabledProviders.includes(row.provider)))),
        };
      }),
    });
    return;
  }
  if (req.method !== 'POST') { json(res, 405, { error: 'Method Not Allowed' }); return; }
  if (!requireCsrf(req, res, session)) return;
  if (!authRateAllowed(req)) { json(res, 429, { error: '操作过于频繁，请稍后再试' }); return; }
  if (parsed.pathname === '/api/account/reauth') {
    const body = await readJson(req);
    const password = String(body?.password || '');
    const valid = credentials.passwordHash && password.length <= 128 && await passwordMatches(password, credentials.passwordHash);
    if (!valid) { json(res, 403, { error: '当前账号密码不正确' }); return; }
    if (!storage.findSession(session.tokenHash)) { json(res, 401, { error: '请重新登录' }); return; }
    storage.markSessionAuthenticated(session.tokenHash);
    json(res, 200, { ok: true });
    return;
  }
  const match = /^\/api\/account\/(google|wechat)\/(link|replace|unlink|reauth)$/.exec(parsed.pathname);
  if (!match) { json(res, 404, { error: 'Not Found' }); return; }
  const [, provider, purpose] = match;
  const identity = credentials.identities.find(row => row.provider === provider);
  if ((purpose === 'link' && identity) || (purpose !== 'link' && !identity)) {
    json(res, 409, { error: ACCOUNT_ERRORS.binding_changed }); return;
  }
  if (purpose !== 'reauth' && reauthRequired()) {
    json(res, 403, { error: ACCOUNT_ERRORS.reauth_required, code: 'reauth_required' }); return;
  }
  if (purpose === 'unlink') {
    try {
      storage.unlinkIdentity(session.user.id, provider, session.tokenHash, enabledProviders);
      json(res, 200, { ok: true });
    } catch (error) {
      if (!ACCOUNT_ERRORS[error.code]) throw error;
      json(res, error.status || 409, { error: ACCOUNT_ERRORS[error.code], code: error.code });
    }
    return;
  }
  if (!oauthProviderConfigured(provider) || !validOAuthRedirectUri(oauthRedirectUri(req, provider), provider)) {
    json(res, 503, { error: `${provider === 'google' ? 'Google' : '微信'}登录尚未配置完成` }); return;
  }
  oauthStart(req, res, parsed, provider, { purpose, expectedSubject: identity?.provider_subject || '' });
}

function safeStaticPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '/' || decoded === '/index.html') return path.join(ROOT, 'index.html');
  if (decoded === '/login' || decoded === '/login.html') return path.join(ROOT, 'login.html');
  if (decoded === '/connect.html') return path.join(ROOT, 'connect.html');
  if (decoded === '/pet-sentence.html') return path.join(ROOT, 'pet-sentence.html');

  const segments = decoded.split('/').filter(Boolean);
  if (segments.length < 2 || segments.some(segment => segment === '.' || segment === '..' || segment.startsWith('.'))) return null;
  const rule = STATIC_RULES[segments[0]];
  const extension = path.extname(segments[segments.length - 1]).toLowerCase();
  if (!rule || !rule.has(extension)) return null;

  const allowedRoot = path.resolve(ROOT, segments[0]);
  const resolved = path.resolve(ROOT, '.' + decoded);
  if (resolved !== allowedRoot && !resolved.startsWith(allowedRoot + path.sep)) return null;
  return resolved;
}

function serveStatic(req, res, pathname) {
  if (!['GET', 'HEAD'].includes(req.method)) { text(res, 405, 'Method Not Allowed'); return; }
  const filePath = safeStaticPath(pathname);
  if (!filePath) { text(res, 404, 'Not Found'); return; }
  fs.readFile(filePath, (error, data) => {
    if (error) { text(res, 404, 'Not Found'); return; }
    const extension = path.extname(filePath).toLowerCase();
    const isDocument = extension === '.html';
    res.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      // 文档与 js/css 都每次重验证(no-cache):源文件带 ?v= 版本号,改动即换 URL,无需
      // 长缓存;no-cache 保证浏览器总能拿到最新,避免“改了不生效、要手动强刷”的困扰。
      'Cache-Control': (isDocument || extension === '.js' || extension === '.css') ? 'no-cache' : 'public, max-age=3600',
    });
    if (req.method === 'HEAD') res.end(); else res.end(data);
  });
}

function probeCompanion() {
  return new Promise(resolve => {
    const request = http.get({ host: '127.0.0.1', port: COMPANION_PORT, path: '/status.json', timeout: 1200 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          const status = JSON.parse(body);
          resolve(status && status.config ? status : null);
        } catch { resolve(null); }
      });
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

function companionAllowed(req, session, claimOwner) {
  /* 同机多账号共享:伴侣驱动的是这台 Mac 的桌面(壁纸/小窗是物理共享资源),
     所以本机请求 + 任意登录账号即可用——同一台机器上的几个账号往往就是同一个人。
     用户之间的数据隔离不受影响:settings/review 等状态在服务器上仍按账号分命名空间,
     共享的只是「桌面显示什么」。真正的远端机器仍被 isSameMachineRequest 挡在门外。 */
  if (!COMPANION_ENABLED || !isSameMachineRequest(req)) return false;
  if (claimOwner) storage.claimCompanionOwner(session.user.id); // 记录首个使用者(仅信息,不再做闸门)
  return true;
}

async function proxyToCompanion(req, res, session) {
  const body = ['GET', 'HEAD'].includes(req.method) ? Buffer.alloc(0) : await readBody(req, MAX_PROXY_BYTES);
  const gracefulWhenStopped = !['/ocr.php', '/set-wallpaper.php'].includes(new URL(req.url, 'http://wordpaper.invalid').pathname);
  await new Promise(resolve => {
    const headers = { 'X-WordPaper-User-Id': String(session.user.id) };
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];
    if (body.length) headers['Content-Length'] = body.length;
    const upstream = http.request({
      host: '127.0.0.1', port: COMPANION_PORT, path: req.url,
      method: req.method, headers, timeout: 30000,
    }, response => {
      res.writeHead(response.statusCode || 502, {
        'Content-Type': response.headers['content-type'] || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      response.pipe(res);
      response.on('end', resolve);
    });
    upstream.on('error', () => { if (!res.headersSent) json(res, gracefulWhenStopped ? 200 : 503, { ok: false, companion: false }); resolve(); });
    upstream.on('timeout', () => { upstream.destroy(); if (!res.headersSent) json(res, gracefulWhenStopped ? 200 : 504, { ok: false, companion: false, error: '桌面伴侣响应超时' }); resolve(); });
    upstream.end(body);
  });
}

function spawnCompanion(extraEnv) {
  const companionJs = path.join(ROOT, 'companion.js');
  if (!fs.existsSync(companionJs)) return false;
  const logDir = path.join(os.homedir(), 'Library', 'Logs');
  try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
  const logPath = path.join(logDir, 'daily-wallpaper-companion.log');
  let logFd = 2;
  try { logFd = fs.openSync(logPath, 'a'); } catch {}
  const child = spawn(process.execPath, [companionJs], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: Object.assign({}, process.env, {
      WORDPAPER_PORT: String(COMPANION_PORT),
      WORDPAPER_WEB_ORIGIN: `http://localhost:${PORT}`,
      // 伴侣跟随本 server 生命周期:server 退出(update/菜单栏退出/被杀)后
      // 伴侣 3 个探测周期内自杀,服务链由 launcher 接管。launchd/server 派生
      // 的伴侣才带这个标记;开发目录手动 `node companion.js` 不带,防误杀。
      WORDPAPER_FOLLOW_SERVER: '1',
    }, extraEnv),
  });
  child.unref();
  if (logFd !== 2) { try { fs.closeSync(logFd); } catch {} }
  return true;
}

async function startCompanion(req, res) {
  if (req.url.includes('dry=1')) { json(res, 200, { ok: true, dry: true }); return; }
  const running = await probeCompanion();
  if (running) { json(res, 200, { ok: true, already: true }); return; }
  if (!fs.existsSync(path.join(ROOT, 'companion.js'))) { json(res, 500, { ok: false, error: 'companion.js 不存在' }); return; }
  spawnCompanion();

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300));
    if (await probeCompanion()) { json(res, 200, { ok: true, spawned: true }); return; }
  }
  json(res, 504, { ok: false, error: `启动超时，请查看 ${path.join(os.homedir(), 'Library', 'Logs', 'daily-wallpaper-companion.log')}` });
}

/* ── 开机自启(Wallpaper-Engine 式,仅桌面端)──────────────────────────────
 * 登录服务(launchd)拉起 server 后,由 server 自动派生 companion——与手动
 * /companion/start 完全同一条派生链,所以 osascript→System Events 的 TCC
 * 自动化授权继续有效(千万别改成独立 LaunchAgent,责任进程变了会重新弹授权)。
 * 闸门:plist 注入 WORDPAPER_COMPANION_AUTOSTART=1 才启用(dev/e2e 无此环境变量,
 * 不会误起伴侣);companion-config.json 里 "autoStart": false 可整机关停。
 * 附带看门狗:每 60s 探活,伴侣崩溃/被杀后自动重拉。 */
const COMPANION_CONFIG_PATH = process.env.WORDPAPER_CONFIG_PATH
  || path.join(process.env.WORDPAPER_COMPANION_DATA_DIR
    || path.join(os.homedir(), 'Library', 'Application Support', 'WordPaper', 'companion'), 'companion-config.json');

function companionAutoStartEnabled() {
  if (!COMPANION_ENABLED || process.env.WORDPAPER_COMPANION_AUTOSTART !== '1') return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(COMPANION_CONFIG_PATH, 'utf8'));
    if (cfg.autoStart === false) return false;
  } catch {}
  return true;
}

let companionSpawnInFlight = false;
async function ensureCompanionRunning(reason) {
  if (!companionAutoStartEnabled() || companionSpawnInFlight) return;
  if (await probeCompanion()) return;
  companionSpawnInFlight = true;
  try {
    console.log(`[companion] autostart: spawning (${reason})`);
    // SILENT:开机自启不弹浏览器窗口,对应 Wallpaper Engine 的 -silent
    spawnCompanion({ WORDPAPER_COMPANION_SILENT: '1' });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 500));
      if (await probeCompanion()) { console.log(`[companion] autostart: up (${reason})`); return; }
    }
    console.error('[companion] autostart: spawn timed out, will retry on next watchdog tick');
  } finally {
    companionSpawnInFlight = false;
  }
}

let companionPackaging = false;
function serveCompanionZip(req, res) {
  if (companionPackaging) { json(res, 429, { error: '安装包正在生成，请稍后重试' }); return; }
  const zipPath = path.join(ROOT, 'scripts', '每日壁纸伴侣.zip');
  const sendZip = () => fs.readFile(zipPath, (error, data) => {
    if (error) { text(res, 503, '桌面伴侣安装包暂不可用'); return; }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="wordpaper-companion.zip"',
      'Cache-Control': 'private, no-cache',
    });
    res.end(data);
  });

  if (MODE !== 'local') {
    if (fs.existsSync(zipPath)) sendZip();
    else text(res, 503, '生产镜像未包含桌面伴侣安装包');
    return;
  }
  companionPackaging = true;
  execFile('python3', [path.join(ROOT, 'scripts', 'package_companion.py')], { timeout: 30000 }, error => {
    companionPackaging = false;
    if (error) { text(res, 500, '桌面伴侣打包失败'); return; }
    sendZip();
  });
}

async function handleAuth(req, res, parsed) {
  const pathname = parsed.pathname;
  if (pathname === '/api/auth/providers' && req.method === 'GET') {
    json(res, 200, {
      email: { enabled: true, registrationEnabled: emailRegistrationEnabled(req) },
      google: { enabled: oauthProviderConfigured('google') && !mirroring() },
      wechat: { enabled: oauthProviderConfigured('wechat') && !mirroring() },
      pairingAllowed: MODE === 'local',
      paired: upstream.pairedInfo(),
    });
    return true;
  }

  // ── 主账号配对(仅本机 local 模式;回环 + Origin 校验 + 限流) ──────────
  if (pathname === '/api/pair' && req.method === 'POST') {
    if (MODE !== 'local' || !isLoopbackRequest(req)) { json(res, 404, { error: '只有本机部署可以连接主账号' }); return true; }
    if (!requireOrigin(req, res)) return true;
    if (!authRateAllowed(req)) { json(res, 429, { error: '操作过于频繁，请稍后再试' }); return true; }
    // 已配对时重复调用视为「重新验证/换绑」:复用影子账号,刷新上游会话。
    const body = await readJson(req);
    try {
      const user = await upstream.pair({ url: body && body.url, identifier: body && body.identifier, password: body && body.password });
      const session = newSession(req, res, user, true);
      json(res, 200, session);
    } catch (error) {
      json(res, error.status || 502, { error: error.message || '连接主账号失败' });
    }
    return true;
  }

  if (pathname === '/api/unpair' && req.method === 'POST') {
    if (MODE !== 'local' || !isLoopbackRequest(req)) { json(res, 404, { error: '只有本机部署可以断开主账号' }); return true; }
    if (!requireOrigin(req, res)) return true;
    if (!authRateAllowed(req)) { json(res, 429, { error: '操作过于频繁，请稍后再试' }); return true; }
    upstream.unpair();   // 删除本机影子账号(含会话),当前页面随即回到登录页
    res.setHeader('Set-Cookie', clearSessionCookies());
    json(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/auth/resume' && req.method === 'POST') {
    if (MODE !== 'local' || !isLoopbackRequest(req)) { json(res, 404, { error: 'Not Found' }); return true; }
    if (!requireOrigin(req, res)) return true;
    if (!authRateAllowed(req)) { json(res, 429, { error: '操作过于频繁，请稍后再试' }); return true; }
    const user = upstream.resumeUser();
    if (!user) { json(res, 409, { error: '这台设备还没有连接主账号' }); return true; }
    const session = newSession(req, res, user, false);
    json(res, 200, session);
    return true;
  }

  if (pathname === '/api/auth/email/code' && req.method === 'POST') {
    if (!requireOrigin(req, res)) return true;
    if (!authRateAllowed(req)) { json(res, 429, { error: '验证码请求过于频繁，请稍后再试' }); return true; }
    if (!emailRegistrationEnabled(req)) {
      json(res, 503, { error: '邮箱注册尚未配置，请联系管理员' });
      return true;
    }
    const body = await readJson(req);
    const email = normalizeEmail(body && body.email);
    if (!validEmail(email)) { json(res, 400, { error: '请输入有效的邮箱地址' }); return true; }
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const codeHash = emailCodeHash(email, code);
    const claim = storage.claimEmailVerification(
      email, codeHash, Date.now() + EMAIL_CODE_SECONDS * 1000, EMAIL_CODE_COOLDOWN_MS,
    );
    if (!claim.claimed) {
      json(res, 429, { error: '验证码已发送，请稍后再试', retryAfter: Math.ceil(claim.retryAfterMs / 1000) });
      return true;
    }
    if (emailDeliveryConfigured()) {
      try {
        await sendEmailVerification(email, code);
      } catch (error) {
        storage.releaseEmailVerification(email, codeHash);
        console.error('Email verification delivery failed:', error && error.message ? error.message : error);
        json(res, 502, { error: '验证码发送失败，请稍后重试' });
        return true;
      }
    }
    const response = { ok: true, expiresIn: EMAIL_CODE_SECONDS };
    if (!emailDeliveryConfigured() && emailDebugAllowed(req)) response.debugCode = code;
    json(res, 200, response);
    return true;
  }

  const oauthMatch = /^\/api\/auth\/(google|wechat)\/(start|callback)$/.exec(pathname);
  if (oauthMatch) {
    if (mirroring()) { json(res, 403, { error: '请在主账号所在的网站使用第三方登录' }); return true; }
    if (req.method !== 'GET') { text(res, 405, 'Method Not Allowed'); return true; }
    const provider = oauthMatch[1];
    if (oauthMatch[2] === 'start') oauthStart(req, res, parsed, provider);
    else await oauthCallback(req, res, parsed, provider);
    return true;
  }

  if (pathname === '/api/auth/register' && req.method === 'POST') {
    if (!requireOrigin(req, res)) return true;
    if (mirroring()) { json(res, 403, { error: '这台设备已连接主账号，无需注册本地账号' }); return true; }
    if (!authRateAllowed(req)) { json(res, 429, { error: '操作过于频繁，请稍后再试' }); return true; }
    const body = await readJson(req);
    const { username, usernameKey: key, email, password } = validateCredentials(body);
    if (email) {
      if (storage.findUserByKey(key)) { json(res, 409, { error: '该邮箱已注册' }); return true; }
      const verificationCode = String(body && body.verificationCode || '').trim();
      if (!/^\d{6}$/.test(verificationCode)
          || !storage.consumeEmailVerification(email, emailCodeHash(email, verificationCode))) {
        json(res, 400, { error: '邮箱验证码无效或已过期' });
        return true;
      }
    }
    const hash = await passwordHash(password);
    let user;
    try { user = storage.createUser(username, key, hash); }
    catch (error) {
      if (String(error.code || '').startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/i.test(String(error.message || ''))) { json(res, 409, { error: username.includes('@') ? '该邮箱已注册' : '该用户名已存在' }); return true; }
      throw error;
    }
    const session = newSession(req, res, user, true);
    json(res, 201, Object.assign({}, session, { user: Object.assign({}, session.user, { role: user.role || 'user' }) }));
    return true;
  }

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    if (!requireOrigin(req, res)) return true;
    if (mirroring()) { json(res, 403, { error: '这台设备已连接主账号，直接点「继续」即可进入' }); return true; }
    if (!authRateAllowed(req)) { json(res, 429, { error: '登录尝试过多，请稍后再试' }); return true; }
    const body = await readJson(req);
    const { usernameKey: key, password } = validateCredentials(body);
    const user = storage.findUserByKey(key);
    let valid = false;
    if (user && user.password_hash) valid = await passwordMatches(password, user.password_hash);
    else await scryptAsync(password, Buffer.alloc(16, 7), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    if (!user || !valid) { json(res, 401, { error: '邮箱、用户名或密码错误' }); return true; }
    const session = newSession(req, res, { id: Number(user.id), username: user.username }, false);
    json(res, 200, Object.assign({}, session, { user: Object.assign({}, session.user, { role: user.role || 'user' }) }));
    return true;
  }
  return false;
}

async function handle(req, res) {
  securityHeaders(res);
  const parsed = new URL(req.url, 'http://wordpaper.invalid');
  const pathname = parsed.pathname;

  if (pathname === '/healthz' && req.method === 'GET') {
    json(res, 200, { ok: true, mode: MODE, version: BUNDLED_VERSION || '' });
    return;
  }

  // ── 应用内自更新(独立版专属):检查 + 安装。棘轮与权限校验都在 POST /apply
  //    里重做一遍,GET /check 只读无副作用。 ──────────────────────────────
  if (pathname === '/api/update/check' && req.method === 'GET') {
    // ?refresh=1: 请求方明确要新探测(点击「重新检查」/菜单栏更新时)。限速 30s 防滥用。
    if (parsed.searchParams.get('refresh') === '1' && BUNDLED_VERSION && MODE === 'local') {
      const now = Date.now();
      if (now - lastRefreshProbe > 30000) {
        lastRefreshProbe = now;
        latestVersion = '';   // 清掉旧值,强制重新取
        await checkForUpdate();
      }
    }
    json(res, 200, {
      available: Boolean(updateNotice()),
      current: BUNDLED_VERSION || '',
      latest: latestVersion || '',
      checked: Boolean(latestVersion),
      supported: Boolean(BUNDLED_VERSION && MODE === 'local' && process.platform === 'darwin'),
    });
    return;
  }

  if (await handleAuth(req, res, parsed)) return;
  if (await handleDeviceAuth(req, res, parsed)) return;

  if (pathname === '/api/account' || pathname.startsWith('/api/account/')) {
    await handleAccount(req, res, parsed);
    return;
  }

  const session = requestSession(req);

  if (pathname === '/api/update/apply' && req.method === 'POST') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    if (!requireCsrf(req, res, session)) return;
    if (MODE !== 'local' || !isLoopbackRequest(req) || !BUNDLED_VERSION) {
      json(res, 404, { error: '只有本机安装的 WordPaper.app 支持内置更新' });
      return;
    }
    if (updateApplying) { json(res, 429, { error: '更新正在进行中,请勿重复点击' }); return; }
    if (!latestVersion || !versionNewer(latestVersion, BUNDLED_VERSION)) {
      json(res, 409, { error: '没有可安装的新版本(已是最新,或尚未检查到更新)' });
      return;
    }
    const target = latestVersion;
    beginUpdate(target);
    json(res, 200, { ok: true, started: true, target });
    return;
  }

  if (pathname === '/api/update/status' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    json(res, 200, updateStatus());
    return;
  }

  if (pathname === '/api/update/status-local' && req.method === 'GET') {
    if (!isLoopbackRequest(req) || req.headers['x-wordpaper-local'] !== '1') { json(res, 403, { error: '仅限本机菜单栏调用' }); return; }
    if (MODE !== 'local') { json(res, 404, { error: 'Not Found' }); return; }
    json(res, 200, updateStatus());
    return;
  }

  /* ── 菜单栏专用(伴侣子进程 JXA 调用;仅本机回环 + 共享密钥头)────────
   * /api/update/apply-local:与 /api/update/apply 相同的安装流程,但不要求
   * 浏览器登录会话 —— 菜单栏没有 cookie,靠「回环来源 + X-WordPaper-Local」
   * 闸门(与伴侣 mutation 端点同一信任级别)。菜单栏先经 /api/update/check
   * 拿到 latest 才会触发这里。 */
  if (pathname === '/api/update/apply-local' && req.method === 'POST') {
    if (!isLoopbackRequest(req) || req.headers['x-wordpaper-local'] !== '1') { json(res, 403, { error: '仅限本机菜单栏调用' }); return; }
    if (MODE !== 'local' || !BUNDLED_VERSION) { json(res, 404, { error: '只有本机安装的 WordPaper.app 支持内置更新' }); return; }
    if (updateApplying) { json(res, 429, { error: '更新正在进行中,请勿重复点击' }); return; }
    if (!latestVersion || !versionNewer(latestVersion, BUNDLED_VERSION)) {
      json(res, 409, { error: '没有可安装的新版本(已是最新,或尚未检查到更新)' });
      return;
    }
    const targetLocal = latestVersion;
    beginUpdate(targetLocal);
    json(res, 200, { ok: true, started: true, target: targetLocal });
    return;
  }

  /* ── 菜单栏「退出 WordPaper」:server 先走正常 shutdown(存库/关连接),
   *    伴侣经 follow-server 探测到死亡后跟随退出,launcher 的 wait 返回,
   *    服务链整体干净收场。闸门同上。 ─────────────────────────────── */
  if (pathname === '/api/quit' && req.method === 'POST') {
    if (!isLoopbackRequest(req) || req.headers['x-wordpaper-local'] !== '1') { json(res, 403, { error: '仅限本机菜单栏调用' }); return; }
    if (MODE !== 'local') { json(res, 404, { error: '公网部署不响应退出命令' }); return; }
    json(res, 200, { ok: true });
    console.log('[server] 菜单栏请求退出:1.2s 后 shutdown');
    setTimeout(() => { try { shutdown(); } catch {} }, 1200);
    return;
  }


  if ((pathname === '/' || pathname === '/index.html' || pathname === '/connect.html') && !session) {
    redirect(res, pathname === '/connect.html' ? '/login.html?next=' + encodeURIComponent(pathname + parsed.search) : '/login.html');
    return;
  }
  if ((pathname === '/login' || pathname === '/login.html') && session && !(MODE === 'local' && parsed.searchParams.get('sync') === '1')) {
    redirect(res, safeNextPath(parsed.searchParams.get('next')));
    return;
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    const meRow = storage.findUserById(session.user.id);
    json(res, 200, {
      user: Object.assign({}, session.user, { role: (meRow && meRow.role) || 'user' }),
      csrfToken: session.csrfToken, allowLegacyImport: session.allowLegacyImport,
      mirrored: mirroring(), upstream: mirroring() ? upstream.status() : null,
      update: updateNotice(),
    });
    return;
  }

  if (pathname === '/api/session' && req.method === 'DELETE') {
    if (!session) { res.setHeader('Set-Cookie', clearSessionCookies()); json(res, 200, { ok: true }); return; }
    if (!requireCsrf(req, res, session)) return;
    storage.deleteSession(session.tokenHash);
    res.setHeader('Set-Cookie', clearSessionCookies());
    json(res, 200, { ok: true });
    return;
  }


  /* ── 管理员接口(内测/账号管理)────────────────────────────────
   * 只有 users.role='admin' 的账号可用。所有写操作都要 CSRF + 同源校验。
   * 首次升级时把历史主账号 chaest 提为 admin(幂等,已有 admin 则不动)。 */
  if (pathname.startsWith('/api/admin/')) {
    if (!session) { json(res, 401, { error: '请先登录' }); return true; }
    const me = storage.findUserById(session.user.id);
    if (!me || me.role !== 'admin') { json(res, 403, { error: '需要管理员权限' }); return true; }

    if (pathname === '/api/admin/users' && req.method === 'GET') {
      json(res, 200, { users: storage.listUsers() });
      return true;
    }

    if (req.method === 'POST') {
      if (!requireCsrf(req, res, session)) return true;
      const body = await readJson(req);
      if (pathname === '/api/admin/password') {
        const targetId = Number(body.userId);
        const target = storage.findUserById(targetId);
        if (!target) { json(res, 404, { error: '账号不存在' }); return true; }
        const password = String(body.password || '');
        if (Buffer.byteLength(password, 'utf8') < 8 || Buffer.byteLength(password, 'utf8') > 256) {
          json(res, 400, { error: '密码长度需为 8-128 个字符' }); return true;
        }
        storage.setUserPassword(targetId, await passwordHash(password));
        json(res, 200, { ok: true, username: target.username });
        return true;
      }
      if (pathname === '/api/admin/role') {
        const targetId = Number(body.userId);
        const role = body.role === 'admin' ? 'admin' : 'user';
        const target = storage.findUserById(targetId);
        if (!target) { json(res, 404, { error: '账号不存在' }); return true; }
        if (target.id === session.user.id && role !== 'admin') {
          json(res, 400, { error: '不能取消自己的管理员权限' }); return true;
        }
        json(res, 200, { user: storage.setUserRole(targetId, role) });
        return true;
      }
      if (pathname === '/api/admin/feature') {
        // 内测功能开关:key 白名单,值存 app_meta('feature:<key>')。
        const ALLOWED = new Set(['betaPetQuiz', 'betaPatrickVoice', 'betaCompanionRoam', 'betaMirror']);
        const key = String(body.key || '');
        if (!ALLOWED.has(key)) { json(res, 400, { error: '未知功能开关' }); return true; }
        storage.setMeta('feature:' + key, body.enabled ? '1' : '0');
        json(res, 200, { ok: true, key, enabled: !!body.enabled });
        return true;
      }
    }

    if (pathname === '/api/admin/features' && req.method === 'GET') {
      const ALLOWED = ['betaPetQuiz', 'betaPatrickVoice', 'betaCompanionRoam', 'betaMirror'];
      const features = {};
      ALLOWED.forEach(k => { features[k] = storage.getMeta('feature:' + k) === '1'; });
      json(res, 200, { features });
      return true;
    }

    json(res, 404, { error: 'not found' });
    return true;
  }

  if (pathname === '/api/state' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    // 卫星模式:先补推再拉取,返回的本地缓存即为上游最新镜像;断网自动回退缓存。
    const snapshot = mirroring() ? await upstream.mirroredState() : storage.getState(session.user.id);
    json(res, 200, Object.assign({ user: session.user }, snapshot));
    return;
  }

  const stateMatch = /^\/api\/state\/([^/]+)$/.exec(pathname);
  if (stateMatch && req.method === 'PUT') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    if (!requireCsrf(req, res, session)) return;
    const namespace = decodeURIComponent(stateMatch[1]);
    if (!STATE_NAMESPACES.has(namespace)) { json(res, 404, { error: '未知数据类型' }); return; }
    const body = await readJson(req);
    if (!Object.prototype.hasOwnProperty.call(body, 'value') || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0) {
      json(res, 400, { error: 'value 或 expectedRevision 无效' }); return;
    }
    if (mirroring()) {
      const mirrored = await upstream.pushState(namespace, body.value, body.expectedRevision);
      if (mirrored.kind === 'conflict') { json(res, 409, { conflict: true, revision: mirrored.revision, value: mirrored.value }); return; }
      json(res, 200, { conflict: false, revision: mirrored.revision, updatedAt: Date.now(), queued: mirrored.kind === 'queued' });
      return;
    }
    const result = storage.putState(session.user.id, namespace, body.value, body.expectedRevision);
    if (result.conflict) { json(res, 409, result); return; }
    json(res, 200, result);
    return;
  }

/* 把三种可能的导入输入统一成 { libs: { libId: { words: {...} } } }。
 *   - progress JSON:{ format:'wordpaper-progress', raw:{ libId:{words} }, words:[...] }
 *   - 备份 JSON:{ format:'wordpaper-backup', state:{ review:{ libId:{words} } } }
 *   - 裸 review 对象:{ libId:{ words:{...} } }
 * 识别不出来返回 null。 */
function normalizeImportedReview(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const looksLikeReview = obj => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    const keys = Object.keys(obj);
    if (!keys.length) return false;
    // 至少一个词库带着 words 对象才算
    return keys.some(k => obj[k] && typeof obj[k] === 'object' && obj[k].words && typeof obj[k].words === 'object');
  };
  // 1) 完整备份
  if (payload.state && typeof payload.state === 'object' && looksLikeReview(payload.state.review)) {
    return { libs: payload.state.review };
  }
  // 2) progress JSON 的 raw
  if (looksLikeReview(payload.raw)) return { libs: payload.raw };
  // 3) progress JSON 只有 words 数组 → 按 library 字段重新分组
  if (Array.isArray(payload.words) && payload.words.length) {
    const libs = {};
    payload.words.forEach(w => {
      if (!w || !w.word) return;
      const libId = String(w.library || 'custom');
      if (!libs[libId]) libs[libId] = { cursor: 0, groups: {}, words: {} };
      const key = w.word + '|' + (w.meaning || '');
      libs[libId].words[key] = {
        word: { word: w.word, phonetic: w.phonetic || '', pos: w.pos || '', meaning: w.meaning || '' },
        learnedAt: w.learnedAt ? Date.parse(w.learnedAt) || Date.now() : Date.now(),
        stage: Number(w.stage) || 0,
        due: w.due ? Date.parse(w.due) || null : null,
        lastSeenAt: w.lastSeenAt ? Date.parse(w.lastSeenAt) || 0 : 0,
        learnedCount: Number(w.learnedCount) || 0,
        reviewCount: Number(w.reviewCount) || 0,
        successCount: Number(w.successCount) || 0,
        failCount: Number(w.failCount) || 0,
        events: [],
      };
    });
    return Object.keys(libs).length ? { libs } : null;
  }
  // 4) 裸 review 对象
  if (looksLikeReview(payload)) return { libs: payload };
  return null;
}

  /* 导入背单词情况(与 /api/export/progress 配套,形成闭环)。
   * 支持两种输入:
   *   1) 本应用导出的 progress JSON({format:'wordpaper-progress', raw:{...}} 或 words:[...])
   *   2) 完整备份 JSON({format:'wordpaper-backup', state:{review:{...}}})
   * 也接受直接粘贴的 review namespace 对象。
   * 合并策略(不做整表覆盖,避免误删现有进度):
   *   - 同一个词(词+释义):保留 stage 更高的那条(学得更久的赢);
   *   - due 取更早的那个(更该复习);
   *   - 计数与事件合并累加;词条本身以导入的为准补齐缺失字段。
   * dryRun=1 时只回统计不落库,便于用户先看会导入多少。 */
  if (pathname === '/api/import/progress' && req.method === 'POST') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    if (!requireOrigin(req, res)) return;
    if (!requireCsrf(req, res, session)) return;
    if (mirroring()) { json(res, 409, { error: '已连接主账号，请在主账号那台机器上导入' }); return; }
    const body = await readJson(req);
    if (!body || typeof body !== 'object') { json(res, 400, { error: '请求体无效' }); return; }
    const dryRun = body.dryRun === true;
    const incoming = normalizeImportedReview(body.payload !== undefined ? body.payload : body);
    if (!incoming || !incoming.libs) { json(res, 400, { error: '无法识别这份文件：既不是 WordPaper 进度导出，也不是备份 JSON' }); return; }
    const INTERVALS = [20, 60, 540, 1440, 2880, 4320, 8640, 17280];
    const current = mirroring() ? await upstream.mirroredState() : storage.getState(session.user.id);
    const review = (current.state && current.state.review && typeof current.state.review === 'object') ? current.state.review : {};
    const summary = { added: 0, upgraded: 0, merged: 0, skipped: 0, libraries: {} };
    Object.keys(incoming.libs).forEach(libId => {
      if (!libId || libId.length > 64) return;
      const src = incoming.libs[libId];
      if (!src || typeof src !== 'object' || !src.words || typeof src.words !== 'object') return;
      if (!review[libId] || typeof review[libId] !== 'object') review[libId] = { cursor: 0, groups: {}, words: {} };
      const dstLib = review[libId];
      if (!dstLib.words || typeof dstLib.words !== 'object') dstLib.words = {};
      if (!dstLib.groups || typeof dstLib.groups !== 'object') dstLib.groups = {};
      if (typeof dstLib.cursor !== 'number') dstLib.cursor = 0;
      summary.libraries[libId] = 0;
      Object.keys(src.words).forEach(key => {
        const item = src.words[key];
        if (!item || typeof item !== 'object') return;
        const word = item.word || {};
        if (!word.word) { summary.skipped++; return; }
        const stage = Math.max(0, Math.min(INTERVALS.length, Number(item.stage) || 0));
        const clean = {
          word: {
            word: String(word.word),
            phonetic: String(word.phonetic || ''),
            pos: String(word.pos || ''),
            meaning: String(word.meaning || ''),
          },
          learnedAt: Number(item.learnedAt) || Date.now(),
          stage,
          due: stage >= INTERVALS.length ? null : (Number(item.due) || null),
          learnedCount: Math.max(0, Number(item.learnedCount) || 0),
          reviewCount: Math.max(0, Number(item.reviewCount) || 0),
          successCount: Math.max(0, Number(item.successCount) || 0),
          failCount: Math.max(0, Number(item.failCount) || 0),
          events: Array.isArray(item.events) ? item.events.slice(-64) : [],
        };
        if (item.lastSeenAt) clean.lastSeenAt = Number(item.lastSeenAt);
        const existing = dstLib.words[key];
        if (!existing) {
          // dryRun 也要照常统计(只是最后不落库),否则预览永远显示 0
          if (!dryRun) dstLib.words[key] = clean;
          summary.added++;
          summary.libraries[libId]++;
          return;
        }
        // 合并:stage 高者胜;due 取更早;计数累加上限;事件去重合并
        const curStage = Math.max(0, Math.min(INTERVALS.length, Number(existing.stage) || 0));
        if (stage > curStage) {
          existing.word = clean.word;
          existing.stage = stage;
          existing.learnedAt = Math.min(Number(existing.learnedAt) || clean.learnedAt, clean.learnedAt);
          summary.upgraded++;
          summary.libraries[libId]++;
        } else {
          summary.merged++;
          summary.libraries[libId]++;      // 合并也是「会处理的词」,预览要算进去
        }
        const a = existing.due ? Number(existing.due) : Infinity;
        const b = clean.due ? Number(clean.due) : Infinity;
        const mergedDue = Math.min(a, b);
        existing.due = Number.isFinite(mergedDue) ? mergedDue : null;
        existing.learnedCount = Math.max(Number(existing.learnedCount) || 0, clean.learnedCount);
        existing.reviewCount = Math.max(Number(existing.reviewCount) || 0, clean.reviewCount);
        existing.successCount = Math.max(Number(existing.successCount) || 0, clean.successCount);
        existing.failCount = Math.max(Number(existing.failCount) || 0, clean.failCount);
        const seen = new Set((existing.events || []).map(e => (e && e.at) + '|' + (e && e.type)));
        (clean.events || []).forEach(e => {
          const k = (e && e.at) + '|' + (e && e.type);
          if (!seen.has(k)) { seen.add(k); existing.events.push(e); }
        });
        existing.events = (existing.events || []).slice(-64);
      });
    });
    const total = Object.keys(summary.libraries).reduce((n, k) => n + summary.libraries[k], 0);
    if (!dryRun && total > 0) {
      const rev = Number(current.revisions && current.revisions.review) || 0;
      const result = mirroring() ? await upstream.pushState('review', review, rev) : storage.putState(session.user.id, 'review', review, rev);
      if (result.conflict || result.kind === 'conflict') { json(res, 409, { error: '数据刚刚在别处被修改，请重试' }); return; }
    }
    json(res, 200, {
      ok: true, dryRun, imported: total,
      added: summary.added, upgraded: summary.upgraded, merged: summary.merged, skipped: summary.skipped,
      libraries: summary.libraries,
    });
    return;
  }

  if (pathname === '/api/export' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    const snapshot = storage.getState(session.user.id);
    json(res, 200, {
      format: 'wordpaper-backup', schemaVersion: 1, exportedAt: new Date().toISOString(),
      username: session.user.username, state: snapshot.state,
    }, { 'Content-Disposition': 'attachment; filename="wordpaper-backup.json"' });
    return;
  }

  /* 背单词情况导出:只导复习/学习记录(review namespace),不夹带设置与账号信息。
   * format=csv → 表格(Excel/ Numbers/ 飞书都能开);其它 → 完整 JSON。
   * 数据源就是服务端的权威 review 状态,所以导出内容 = 你在任何设备上看到的一致。 */
  if (pathname === '/api/export/progress' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    let snapshot;
    try { snapshot = storage.getState(session.user.id); } catch { json(res, 500, { error: '读取数据失败' }); return; }
    const review = (snapshot && snapshot.state && snapshot.state.review) || {};
    const url = new URL(req.url, 'http://wordpaper.invalid');
    const format = String(url.searchParams.get('format') || 'csv').toLowerCase();
    const INTERVALS = [20, 60, 540, 1440, 2880, 4320, 8640, 17280];
    const rows = [];
    Object.keys(review).forEach(libId => {
      const words = (review[libId] && review[libId].words) || {};
      Object.keys(words).forEach(key => {
        const item = words[key] || {};
        const word = item.word || {};
        const stage = Number(item.stage) || 0;
        rows.push({
          library: libId,
          word: String(word.word || ''),
          phonetic: String(word.phonetic || ''),
          pos: String(word.pos || ''),
          meaning: String(word.meaning || ''),
          stage,
          rounds: INTERVALS.length,
          mastered: stage >= INTERVALS.length,
          due: item.due ? new Date(Number(item.due)).toISOString() : '',
          learnedAt: item.learnedAt ? new Date(Number(item.learnedAt)).toISOString() : '',
          lastSeenAt: item.lastSeenAt ? new Date(Number(item.lastSeenAt)).toISOString() : '',
          learnedCount: Number(item.learnedCount) || 0,
          reviewCount: Number(item.reviewCount) || 0,
          successCount: Number(item.successCount) || 0,
          failCount: Number(item.failCount) || 0,
          events: Array.isArray(item.events) ? item.events.length : 0,
        });
      });
    });
    rows.sort((a, b) => (a.library === b.library ? a.due.localeCompare(b.due) : a.library.localeCompare(b.library)));
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'json') {
      json(res, 200, {
        format: 'wordpaper-progress', schemaVersion: 1,
        exportedAt: new Date().toISOString(), username: session.user.username,
        total: rows.length,
        mastered: rows.filter(r => r.mastered).length,
        learning: rows.filter(r => !r.mastered).length,
        words: rows,
        raw: review,
      }, { 'Content-Disposition': `attachment; filename="wordpaper-progress-${stamp}.json"` });
      return;
    }
    // CSV:带 BOM,Excel 打开中文不乱码;字段按 RFC4180 转义。
    const COLS = ['library', 'word', 'phonetic', 'pos', 'meaning', 'stage', 'rounds', 'mastered', 'due', 'learnedAt', 'lastSeenAt', 'learnedCount', 'reviewCount', 'successCount', 'failCount', 'events'];
    const HEAD = ['词库', '单词', '音标', '词性', '释义', '当前轮次', '总轮次', '已记牢', '下次复习', '首次学习', '最近复习', '学习次数', '复习次数', '记住次数', '遗忘次数', '事件数'];
    const esc = v => {
      const t = String(v == null ? '' : v);
      return /[",\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
    };
    const lines = [HEAD.join(',')];
    rows.forEach(r => lines.push(COLS.map(c => c === 'mastered' ? (r[c] ? '是' : '否') : r[c]).map(esc).join(',')));
    const csv = '\ufeff' + lines.join('\r\n') + '\r\n';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="wordpaper-progress-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    });
    res.end(csv);
    return;
  }

  if (pathname === '/status.json' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    if (!companionAllowed(req, session, false)) {
      json(res, 200, { ok: true, companion: false, available: false, mode: MODE });
      return;
    }
    const status = await probeCompanion();
    json(res, 200, { ok: true, companion: Boolean(status), available: true, pet: Boolean(status && status.pet), hotkey: status && status.hotkey });
    return;
  }

  if (pathname === '/companion/start') {
    if (req.method !== 'POST') { text(res, 405, 'Method Not Allowed'); return; }
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    if (!requireOrigin(req, res)) return;
    if (!companionAllowed(req, session, true)) { json(res, 404, { ok: false, error: '公网模式不启动服务器上的桌面伴侣' }); return; }
    await startCompanion(req, res);
    return;
  }

  if (pathname === '/companion.zip' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    serveCompanionZip(req, res);
    return;
  }

  if (COMPANION_METHODS.has(pathname)) {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    if (!COMPANION_METHODS.get(pathname).has(req.method)) { text(res, 405, 'Method Not Allowed'); return; }
    if (!['GET', 'HEAD'].includes(req.method) && !requireOrigin(req, res)) return;
    if (!companionAllowed(req, session, true)) { json(res, 404, { ok: false, companion: false }); return; }
    await proxyToCompanion(req, res, session);
    return;
  }

  if (pathname.startsWith('/api/')) { json(res, 404, { error: 'Not Found' }); return; }
  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '服务器内部错误' });
    else res.destroy();
  });
});

server.on('listening', () => {
  console.log(`WordPaper running at http://${HOST}:${PORT}`);
  console.log(`mode=${MODE} data=${storage.databasePath}`);
  if (MODE === 'public') console.log('desktop companion endpoints are disabled; expose only this app port behind HTTPS');
  if (COMPANION_ENABLED && process.env.WORDPAPER_COMPANION_AUTOSTART === '1') {
    console.log('[companion] autostart enabled (silent, Wallpaper-Engine-style)');
    // 延迟 3s:让桌面会话/网络就绪,也避开登录初期系统繁忙
    setTimeout(() => { ensureCompanionRunning('boot').catch(error => console.error('[companion] autostart error:', error)); }, 3000).unref();
    setInterval(() => { ensureCompanionRunning('watchdog').catch(() => {}); }, 60000).unref();
  }
});

server.on('error', error => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用；为避免切换 origin 导致数据看似丢失，WordPaper 不会自动改用其他端口。`);
    process.exitCode = 1;
    storage.close();
    return;
  }
  throw error;
});

let closing = false;
// process.exit 会等 libuv 线程池排空才落地;卡死的 getaddrinfo(DNS 查询本身没有
// 超时,目标域名被污染/断网时可永不返回,req.destroy() 也撤不掉)会让 exit 永久阻塞,
// launchd kickstart 的 SIGTERM 于是杀不动本进程。最多等 3s 优雅落地,否则硬杀自己。
function hardExit(code) {
  const pendingRequests = typeof process._getActiveRequests === 'function' ? () => process._getActiveRequests().length : () => 0;
  const deadline = Date.now() + 3000;
  (function drain() {
    if (pendingRequests() === 0) return process.exit(code);
    if (Date.now() >= deadline) return process.kill(process.pid, 'SIGKILL');
    setTimeout(drain, 100);
  })();
}
function shutdown() {
  if (closing) return;
  closing = true;
  if (updateRequest) updateRequest.destroy();
  server.close(() => {
    storage.close();
    hardExit(0);
  });
  setTimeout(() => hardExit(1), 6000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST);
