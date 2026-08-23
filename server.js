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
const COMPANION_PORT = Number(process.env.WORDPAPER_COMPANION_PORT || 8771);
const COMPANION_ENABLED = MODE === 'local' && process.env.WORDPAPER_COMPANION_ENABLED !== '0';
const DATA_DIR = path.resolve(process.env.WORDPAPER_DATA_DIR || path.join(os.homedir(), '.wordpaper'));
const PUBLIC_ORIGIN = String(process.env.WORDPAPER_PUBLIC_ORIGIN || '').replace(/\/$/, '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SESSION_DAYS = Math.max(1, Math.min(365, Number(process.env.WORDPAPER_SESSION_DAYS) || 30));
const OAUTH_FLOW_SECONDS = 10 * 60;
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
upstream.init({
  storage,
  usernameKey,
  createUser: (username, key, hash) => storage.createUser(username, key, hash),
  findUserByKey: key => storage.findUserByKey(key),
});
upstream.startBackground();
function mirroring() { return MODE === 'local' && upstream.isPaired(); }

// ── 新版本提示(仅独立版/本地模式):仓库根的 VERSION 是唯一版本源,
//    与 GitHub main 的 VERSION 比较,有新版本时在 /api/session 里带给页面。 ──
const BUNDLED_VERSION = (() => { try { return fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').trim(); } catch { return ''; } })();
let latestVersion = '';
function versionNewer(candidate, current) {
  const a = String(candidate).split('.').map(n => parseInt(n, 10) || 0);
  const b = String(current).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
function checkForUpdate() {
  if (!BUNDLED_VERSION || MODE !== 'local') return;
  const req = https.get('https://raw.githubusercontent.com/shangchaovo/wordpaper/main/VERSION', { timeout: 8000 }, res => {
    if (res.statusCode !== 200) { res.resume(); return; }
    let body = '';
    res.on('data', c => { body += c; });
    res.on('end', () => { const v = body.trim(); if (/^\d+\.\d+\.\d+$/.test(v)) latestVersion = v; });
  });
  req.on('error', () => {});
  req.on('timeout', () => req.destroy());
}
checkForUpdate();
setInterval(checkForUpdate, 24 * 60 * 60 * 1000).unref();
function updateNotice() {
  return latestVersion && BUNDLED_VERSION && versionNewer(latestVersion, BUNDLED_VERSION) ? { latest: latestVersion } : null;
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
};

const COMPANION_METHODS = new Map([
  ['/ocr.php', new Set(['HEAD', 'POST'])],
  ['/set-wallpaper.php', new Set(['HEAD', 'POST'])],
  ['/pet.php', new Set(['POST'])],
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
  return token ? storage.findSession(tokenHash(token)) : null;
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

function oauthFailure(res, code) {
  appendSetCookies(res, clearOAuthFlowCookies());
  redirect(res, `/login.html?authError=${encodeURIComponent(code)}`);
}

function oauthStart(req, res, parsed, provider) {
  if (!oauthProviderConfigured(provider)) {
    oauthFailure(res, `${provider}_not_configured`);
    return;
  }
  if (!authRateAllowed(req)) {
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
  const nextPath = safeNextPath(parsed.searchParams.get('next'));
  const initiatingSession = requestSession(req);
  storage.createOAuthFlow(
    tokenHash(state), tokenHash(binding), provider, codeVerifier,
    initiatingSession && initiatingSession.tokenHash,
    redirectUri, nextPath, Date.now() + OAUTH_FLOW_SECONDS * 1000,
  );
  res.setHeader('Set-Cookie', oauthFlowCookie(req, binding, OAUTH_FLOW_SECONDS));

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
    redirect(res, authorization.toString());
    return;
  }

  const authorization = new URL(WECHAT_AUTHORIZATION_ENDPOINT);
  authorization.searchParams.set('appid', WECHAT_APP_ID);
  authorization.searchParams.set('redirect_uri', redirectUri);
  authorization.searchParams.set('response_type', 'code');
  authorization.searchParams.set('scope', 'snsapi_login');
  authorization.searchParams.set('state', state);
  authorization.hash = 'wechat_redirect';
  redirect(res, authorization.toString());
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
  if (parsed.searchParams.get('error')) {
    oauthFailure(res, 'oauth_cancelled');
    return;
  }

  const state = String(parsed.searchParams.get('state') || '');
  const code = String(parsed.searchParams.get('code') || '');
  const binding = oauthBinding(req);
  if (!state || state.length > 256 || !code || code.length > 4096 || !binding || binding.length > 256) {
    oauthFailure(res, 'oauth_expired');
    return;
  }
  const flow = storage.consumeOAuthFlow(tokenHash(state), tokenHash(binding), provider);
  if (!flow) {
    oauthFailure(res, 'oauth_expired');
    return;
  }

  try {
    const identity = provider === 'google' ? await googleIdentity(code, flow) : await wechatIdentity(code, flow);
    const account = storage.findOrCreateFederatedUser(provider, identity.subject, identity.profile);
    newSession(req, res, account.user, account.created, 'Lax');
    if (flow.initiatingSessionHash) storage.deleteSession(flow.initiatingSessionHash);
    appendSetCookies(res, clearOAuthFlowCookies());
    redirect(res, flow.nextPath);
  } catch (error) {
    console.error(`${provider} OAuth failed:`, error && error.message ? error.message : error);
    oauthFailure(res, 'oauth_failed');
  }
}

function safeStaticPath(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return null; }
  if (decoded.includes('\0') || decoded.includes('\\')) return null;
  if (decoded === '/' || decoded === '/index.html') return path.join(ROOT, 'index.html');
  if (decoded === '/login' || decoded === '/login.html') return path.join(ROOT, 'login.html');

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

async function proxyToCompanion(req, res) {
  const body = ['GET', 'HEAD'].includes(req.method) ? Buffer.alloc(0) : await readBody(req, MAX_PROXY_BYTES);
  const gracefulWhenStopped = !['/ocr.php', '/set-wallpaper.php'].includes(new URL(req.url, 'http://wordpaper.invalid').pathname);
  await new Promise(resolve => {
    const headers = {};
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
    json(res, 201, session);
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
    json(res, 200, session);
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

  if (await handleAuth(req, res, parsed)) return;

  const session = requestSession(req);

  if ((pathname === '/' || pathname === '/index.html') && !session) {
    redirect(res, '/login.html');
    return;
  }
  if ((pathname === '/login' || pathname === '/login.html') && session) {
    redirect(res, '/');
    return;
  }

  if (pathname === '/api/session' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    json(res, 200, {
      user: session.user, csrfToken: session.csrfToken, allowLegacyImport: session.allowLegacyImport,
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

  if (pathname === '/api/export' && req.method === 'GET') {
    if (!session) { json(res, 401, { error: '请先登录' }); return; }
    const snapshot = storage.getState(session.user.id);
    json(res, 200, {
      format: 'wordpaper-backup', schemaVersion: 1, exportedAt: new Date().toISOString(),
      username: session.user.username, state: snapshot.state,
    }, { 'Content-Disposition': 'attachment; filename="wordpaper-backup.json"' });
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
    await proxyToCompanion(req, res);
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
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => {
    storage.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST);
