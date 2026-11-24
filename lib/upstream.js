'use strict';
/* 主账号镜像(卫星模式)——让一台 Mac 上的 WordPaper 实时共用另一台服务器上的账号。
 *
 * 模型:pull,不是网页直推 localhost。本机(卫星)持有上游会话,主动拉取/推送;
 * 页面和桌面伴侣完全照旧跟本机 server 通信,感觉不到远端的存在。
 *
 *   读:每次 /api/state 先拉上游,成功则以上游为准覆盖本地缓存;失败回退缓存(离线可用)
 *   写:先推上游,成功即同步;上游 409 → 上游赢并回传冲突;断网 → 写本地缓存 + 排队补推
 *   上游会话过期(30 天):状态转 'reauth',本地缓存继续可读,重新配对即恢复
 *
 * 配对信息存 app_meta 'upstream_pairing':
 *   { url, identifier, cookie, csrfToken, user:{id,username}, localUserId, pairedAt }
 * 离线队列存 'upstream_queue': { [namespace]: { value, baseRevision } }
 */

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { isIP } = require('node:net');

const PAIRING_KEY = 'upstream_pairing';
const QUEUE_KEY = 'upstream_queue';
const REQUEST_TIMEOUT_MS = 12000;

let storage = null;
let helpers = null;   // { usernameKey, createUser, findUserByKey } — 由 server.js 注入,避免循环依赖
let pairing = null;
let lastStatus = 'ok';       // 'ok' | 'offline' | 'reauth'
let lastError = '';
let lastForegroundAt = Date.now();
let lastPullAt = 0;

function init(deps) {
  storage = deps.storage;
  helpers = deps;
  reload();
}

function reload() {
  pairing = null;
  const raw = storage.metaGet(PAIRING_KEY);
  if (raw) { try { pairing = JSON.parse(raw); } catch {} }
}

function isPaired() { return Boolean(pairing); }
function status() { return lastStatus; }
function localUserId() { return pairing ? pairing.localUserId : null; }
function pairedInfo() {
  if (!pairing) return null;
  return { url: pairing.url, username: pairing.user.username, pairedAt: pairing.pairedAt, status: lastStatus };
}

function readQueue() {
  const raw = storage.metaGet(QUEUE_KEY);
  if (!raw) return {};
  const queue = JSON.parse(raw);
  if (!queue || typeof queue !== 'object' || Array.isArray(queue)) throw new Error('本机同步队列损坏，请从备份恢复');
  return queue;
}

/* 私有/本机网段:真实使用在 LAN / Tailscale 私有网络上跑 http 是可以的(不暴露公网);
   公网地址仍强制 https。 */
function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (['127.0.0.1', 'localhost', '::1'].includes(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.ts.net')) return true;      // mDNS / Tailscale MagicDNS
  if (isIP(h) === 6 && (h.startsWith('fe80:') || h.startsWith('fd') || h.startsWith('fc'))) return true; // IPv6 链路本地 / ULA
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  if (m.slice(1).some(n => Number(n) > 255)) return false;
  if (a === 10) return true;                          // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
  if (a === 192 && b === 168) return true;            // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 (CGNAT/Tailscale)
  if (a === 169 && b === 254) return true;            // 169.254.0.0/16 链路本地
  if (a === 127) return true;                         // 127.0.0.0/8 回环
  return false;
}

/* 归一化上游地址:公网只接受 https;私有网络(LAN/Tailscale/mDNS)与回环允许 http。 */
function normalizeUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) throw Object.assign(new Error('请填写主账号所在的服务器地址'), { status: 400 });
  let parsed;
  try { parsed = new URL(value); } catch { throw Object.assign(new Error('服务器地址格式不对'), { status: 400 }); }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isPrivateHost(parsed.hostname))) {
    throw Object.assign(new Error('公网地址必须是 https;局域网/Tailscale 私有地址可用 http'), { status: 400 });
  }
  return parsed.origin;
}

function request(method, path, body, connection = pairing, timeout = REQUEST_TIMEOUT_MS, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(connection.url + path);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method,
      timeout,
      headers: Object.assign({
        Cookie: connection.cookie,
        'X-CSRF-Token': connection.csrfToken,
        Origin: connection.url,
        Accept: 'application/json',
      }, headers, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('远端响应中断')));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        resolve({ status: res.statusCode || 0, json, setCookie: res.headers['set-cookie'] || [] });
      });
    });
    req.on('timeout', () => { req.destroy(Object.assign(new Error('timeout'), { code: 'OFFLINE' })); });
    req.on('error', err => reject(Object.assign(err, { code: err.code || 'OFFLINE' })));
    if (payload) req.write(payload);
    req.end();
  });
}

function markOk() { lastStatus = 'ok'; lastError = ''; }
function markOffline(err) { lastStatus = 'offline'; lastError = String(err && err.message || err); }

/* 用上游响应对会话 401 统一收口:置 reauth,由页面引导重新配对。 */
function noteResponse(res) {
  if (res.status === 401) { lastStatus = 'reauth'; return true; }
  if (res.status >= 500 || res.status === 429) markOffline('HTTP ' + res.status);
  else if (res.status >= 200 && res.status < 300) markOk();
  return false;
}

/* 配对:用账号密码向上游换长期会话,并在本机建影子账号 + 首次全量拉取。 */
async function pair({ url, identifier, password }) {
  const origin = normalizeUrl(url);
  const connection = { url: origin, cookie: '', csrfToken: '' };
  const login = await request('POST', '/api/auth/login', { identifier: String(identifier || ''), password: String(password || '') }, connection);
  if (login.status === 401 || login.status === 403) {
    throw Object.assign(new Error('账号或密码不对,主账号拒绝了这次连接'), { status: 401 });
  }
  if (!login.json || !login.json.csrfToken || !login.json.user) {
    throw Object.assign(new Error(login.status ? '主账号服务器返回异常(' + login.status + ')' : '连不上主账号服务器'), { status: 502 });
  }
  const sessionCookie = login.setCookie
    .map(c => String(c).split(';')[0])
    .find(c => /^(?:__Host-)?wp_session=.+/.test(c));
  if (!sessionCookie) throw Object.assign(new Error('没有拿到主账号会话'), { status: 502 });
  return pairWithSession({ url: origin, cookie: sessionCookie, csrfToken: login.json.csrfToken });
}

async function pairWithSession({ url, cookie, csrfToken, canAdopt = () => true }) {
  const origin = normalizeUrl(url);
  const connection = { url: origin, cookie, csrfToken };
  const previous = pairing;
  const session = await request('GET', '/api/session', null, connection);
  if (session.status >= 500 || session.status === 429) throw Object.assign(new Error('同步服务器暂时不可用，请稍后重试'), { status: 503 });
  if (session.status !== 200 || !session.json?.user || session.json.mirrored || session.json.csrfToken !== csrfToken) {
    throw Object.assign(new Error('同步服务器的登录会话无效，请重新授权'), { status: 401 });
  }
  const upstreamUser = session.json.user;
  const snapshot = await request('GET', '/api/state', null, connection);
  if (!validSnapshot(snapshot, upstreamUser.id)) throw Object.assign(new Error('暂时无法确认云端账号数据，请稍后重试'), { status: 503 });
  if (previous !== pairing) throw Object.assign(new Error('连接已更改，请重试'), { status: 409 });
  // Never reuse a normal local user just because its name matches a cloud
  // account. Unpair deletes only a dedicated shadow account, not local data.
  const sameAccount = pairing && pairing.url === origin && pairing.user.id === upstreamUser.id;
  if (pairing && !sameAccount && Object.keys(readQueue()).length) {
    throw Object.assign(new Error('当前账号还有离线改动，请同步完成后再更换账号'), { status: 409 });
  }
  if (!canAdopt()) throw Object.assign(new Error('连接已取消，请重新发起'), { status: 409 });
  const key = `mirror:${crypto.createHash('sha256').update(origin).digest('hex').slice(0, 24)}:${upstreamUser.id}`;
  let local = helpers.findUserByKey(key);
  if (sameAccount && storage.accountCredentials(pairing.localUserId).passwordHash.startsWith('mirror$')) {
    local = { id: pairing.localUserId, username: pairing.user.username };
  }
  if (!local) {
    // 影子账号:随机口令哈希永远不可登录,本机口令登录对它无效。
    local = helpers.createUser(upstreamUser.username, key, 'mirror$' + Math.random().toString(36).slice(2) + Date.now().toString(36));
  }
  const next = {
    url: origin,
    cookie,
    csrfToken,
    user: { id: upstreamUser.id, username: upstreamUser.username },
    localUserId: local.id,
    pairedAt: Date.now(),
  };
  storage.changePairing(previous, next, snapshot.json);
  pairing = next;
  markOk();
  await flushQueue();
  if (pairing !== next) throw Object.assign(new Error('连接已更改，请刷新'), { status: 409 });
  return { id: local.id, username: local.username };
}

/* 断开:删掉本机影子账号(级联清掉状态与会话),上游账号不受影响。 */
function unpair() {
  if (!pairing) return;
  storage.changePairing(pairing, null);
  pairing = null;
  lastStatus = 'ok';
}

/* 已配对设备的本地恢复登录:回环请求即可领本机会话(上游不存明文密码)。 */
function resumeUser() {
  if (!pairing) return null;
  return { id: pairing.localUserId, username: pairing.user.username };
}

function validSnapshot(response, userId) {
  const body = response.json;
  if (response.status !== 200 || body?.user?.id !== userId || !body.state || typeof body.state !== 'object' ||
      Array.isArray(body.state) || !body.revisions || typeof body.revisions !== 'object' || Array.isArray(body.revisions)) return false;
  return Object.keys(body.state).every(ns => Number.isSafeInteger(body.revisions[ns]) && body.revisions[ns] > 0);
}

// Older servers ignore the revision header and return a full snapshot.
let pulling;
function pull(passive = false) {
  if (pulling?.connection === pairing) {
    return pulling.passive && !passive ? pulling.promise.then(() => pull(false)) : pulling.promise;
  }
  const current = { connection: pairing, passive };
  current.promise = pullChanges(passive).finally(() => { if (pulling === current) pulling = null; });
  pulling = current;
  return current.promise;
}

async function pullChanges(passive) {
  lastPullAt = Date.now();
  if (!pairing) return false;
  const connection = pairing;
  const known = storage.getRevisions(connection.localUserId);
  // Local revisions can run ahead provisionally. Request the canonical value
  // for queued keys even if the revision numbers happen to match.
  for (const key of Object.keys(readQueue())) delete known[key];
  let res;
  try { res = await request('GET', '/api/state', null, connection, REQUEST_TIMEOUT_MS, { 'X-WordPaper-Revisions': JSON.stringify(known),
    ...(passive ? { 'X-WordPaper-Passive': '1' } : {}) }); }
  catch (err) { if (pairing === connection) markOffline(err); return false; }
  if (pairing !== connection) return false;
  if (noteResponse(res)) return false;
  if (res.json?.missing?.length || !validSnapshot(res, connection.user.id)) { markOffline('bad pull ' + res.status); return false; }
  if (!res.json.partial && Object.keys(known).some(ns => !(ns in res.json.state))) { markOffline('incomplete snapshot'); return false; }
  for (const [ns, value] of Object.entries(res.json.state)) {
    if (storage.supportsNamespace(ns)) storage.replaceUnqueuedState(connection.localUserId, ns, value, res.json.revisions[ns]);
  }
  return true;
}

/* 把离线队列补推到上游。上游已前进的键:上游赢,本地被覆盖。 */
let flushing = null;
async function flushQueue() {
  if (flushing) return flushing;
  flushing = flushQueueOnce();
  try { return await flushing; } finally { flushing = null; }
}
async function flushQueueOnce() {
  const conflicts = new Set();
  if (!pairing) return conflicts;
  const connection = pairing;
  for (const ns of Object.keys(readQueue())) {
    // A disjoint rebase gets one immediate retry. Under sustained remote
    // edits leave the newest operation durable for the next tick.
    for (let attempt = 0; attempt < 2; attempt++) {
      const entry = readQueue()[ns];
      if (!entry) break;
      let res;
      try { res = await request('PUT', '/api/state/' + encodeURIComponent(ns), { value: entry.value, expectedRevision: entry.baseRevision }, connection); }
      catch (err) { if (pairing === connection) markOffline(err); return conflicts; }
      if (pairing !== connection || noteResponse(res)) return conflicts;
      if (![200, 409].includes(res.status) || !Number.isSafeInteger(res.json?.revision) || res.json.revision < 0 ||
          (res.status === 409 && (!res.json.conflict || !Object.hasOwn(res.json, 'value')))) {
        markOffline('invalid flush response ' + res.status); return conflicts;
      }
      if (res.status === 409 && res.json.revision < entry.baseRevision) {
        markOffline('cloud state revision regressed'); return conflicts;
      }
      const outcome = storage.settleQueuedState(connection.localUserId, ns, entry, {
        conflict: res.status === 409, revision: res.json.revision, value: res.json.value,
      });
      if (outcome === 'conflict') conflicts.add(ns);
      if (outcome !== 'retry') break;
    }
  }
  return conflicts;
}

/* 读:先补推再拉取,返回本地缓存(此时已是最新镜像)。 */
async function mirroredState(knownRevisions, options = {}) {
  lastForegroundAt = Date.now();
  const connection = pairing;
  await flushQueue();
  await pull(options.passive);
  if (!connection || pairing !== connection) throw Object.assign(new Error('同步账号已改变，请刷新页面'), { status: 409 });
  return storage.getState(pairing.localUserId, knownRevisions, options);
}

/* 每次写入先原子落本地与队列，再立即推送。连续离线编辑保持最初的
 * 云端 revision；并发读取共享补推，避免同一条写入被重复提交后误判冲突。 */
async function pushState(namespace, value, expectedRevision) {
  lastForegroundAt = Date.now();
  const connection = pairing;
  const local = storage.putState(connection.localUserId, namespace, value, expectedRevision, true);
  if (local.conflict) return { kind: 'conflict', revision: local.revision, value: local.value };
  const conflicts = await flushQueue();
  if (pairing !== connection) throw Object.assign(new Error('同步账号已改变，请刷新页面'), { status: 409 });
  const current = storage.getState(connection.localUserId);
  const revision = current.revisions[namespace];
  if (conflicts.has(namespace)) return { kind: 'conflict', revision, value: current.state[namespace], archived: true };
  const changed = namespace === 'learningActivity' || JSON.stringify(current.state[namespace]) !== JSON.stringify(value);
  return { kind: readQueue()[namespace] ? 'queued' : 'synced', revision, ...(changed ? { value: current.state[namespace] } : {}) };
}

/* 后台节拍:45s 一轮,补推 + 拉取,让两台 Mac 无需刷新也能逐步收敛。 */
function startBackground(intervalMs) {
  const tick = async () => {
    if (!pairing) return;
    const interval = intervalMs || 45000;
    const now = Date.now();
    const idle = now - lastForegroundAt > 2 * interval;
    // Native answers still flush at the regular tick with the window closed.
    const dirty = Boolean(storage.metaGet(QUEUE_KEY));
    if (!dirty && now - lastPullAt < (idle ? 5 * 60000 : interval)) return;
    try { await flushQueue(); await pull(); } catch {}
  };
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try { await tick(); } finally { running = false; }
  }, intervalMs || 45000);
  timer.unref();
}

async function modelRequest(method, route, body) {
  if (!pairing || !['/api/account/model', '/api/account/model/test', '/api/ai/chat', '/api/account/mini', '/api/account/speech'].includes(route)) {
    throw Object.assign(new Error('请重新连接主账号。'), { status: 409 });
  }
  const result = await request(method, route, body, pairing, 60000);
  noteResponse(result);
  return result;
}

module.exports = {
  init, isPaired, status, pairedInfo, localUserId, modelRequest,
  pendingCount: () => Object.keys(readQueue()).length,
  pair, pairWithSession, normalizeUrl, unpair, resumeUser, pull, flushQueue, mirroredState, pushState, startBackground,
};
