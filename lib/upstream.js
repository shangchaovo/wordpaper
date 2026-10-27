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

function save() { storage.metaSet(PAIRING_KEY, JSON.stringify(pairing)); }

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
  try { const q = JSON.parse(raw); return q && typeof q === 'object' ? q : {}; } catch { return {}; }
}
function writeQueue(queue) {
  if (Object.keys(queue).length) storage.metaSet(QUEUE_KEY, JSON.stringify(queue));
  else storage.metaDelete(QUEUE_KEY);
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

function request(method, path, body, connection = pairing) {
  return new Promise((resolve, reject) => {
    const target = new URL(connection.url + path);
    const transport = target.protocol === 'https:' ? https : http;
    const payload = body == null ? null : JSON.stringify(body);
    const req = transport.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method,
      timeout: REQUEST_TIMEOUT_MS,
      headers: Object.assign({
        Cookie: connection.cookie,
        'X-CSRF-Token': connection.csrfToken,
        Origin: connection.url,
        Accept: 'application/json',
      }, payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
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
  markOk();
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
  const session = await request('GET', '/api/session', null, connection);
  if (session.status !== 200 || !session.json?.user || session.json.mirrored || session.json.csrfToken !== csrfToken) {
    throw Object.assign(new Error('同步服务器的登录会话无效，请重新授权'), { status: 401 });
  }
  const upstreamUser = session.json.user;
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
  pairing = {
    url: origin,
    cookie,
    csrfToken,
    user: { id: upstreamUser.id, username: upstreamUser.username },
    localUserId: local.id,
    pairedAt: Date.now(),
  };
  save();
  markOk();
  if (!sameAccount) writeQueue({});
  await flushQueue();
  await pull();   // 首次全量镜像;失败不致命(下次请求再补)
  return { id: local.id, username: local.username };
}

/* 断开:删掉本机影子账号(级联清掉状态与会话),上游账号不受影响。 */
function unpair() {
  if (!pairing) return;
  // Older versions could have reused a normal account with the same name.
  // Never cascade-delete a real password account when disconnecting a mirror.
  try {
    if (storage.accountCredentials(pairing.localUserId).passwordHash.startsWith('mirror$')) storage.deleteUser(pairing.localUserId);
  } catch {}
  pairing = null;
  storage.metaDelete(PAIRING_KEY);
  storage.metaDelete(QUEUE_KEY);
  lastStatus = 'ok';
}

/* 已配对设备的本地恢复登录:回环请求即可领本机会话(上游不存明文密码)。 */
function resumeUser() {
  if (!pairing) return null;
  return { id: pairing.localUserId, username: pairing.user.username };
}

/* 全量拉取并覆盖本地缓存。返回 true=成功。 */
async function pull() {
  if (!pairing) return false;
  const connection = pairing;
  let res;
  try { res = await request('GET', '/api/state'); }
  catch (err) { markOffline(err); return false; }
  if (pairing !== connection) return false;
  if (noteResponse(res)) return false;
  if (res.status !== 200 || !res.json || !res.json.state) { markOffline('bad pull ' + res.status); return false; }
  const revisions = res.json.revisions || {};
  for (const ns of Object.keys(res.json.state)) {
    try { storage.replaceUnqueuedState(pairing.localUserId, ns, res.json.state[ns], revisions[ns] || 0); } catch {}
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
  if (!pairing) return;
  const connection = pairing;
  const queue = readQueue();
  const keys = Object.keys(queue);
  if (!keys.length) return;
  for (const ns of keys) {
    const entry = queue[ns];
    let res;
    try { res = await request('PUT', '/api/state/' + encodeURIComponent(ns), { value: entry.value, expectedRevision: entry.baseRevision }); }
    catch (err) { markOffline(err); return; }   // 仍离线,保留队列
    if (pairing !== connection) return;
    if (noteResponse(res)) return;              // 需要重新配对,保留队列
    if (res.status === 200 && res.json) {
      storage.settleQueuedState(pairing.localUserId, ns, entry, { revision: res.json.revision });
    } else if (res.status === 409 && res.json) {
      storage.settleQueuedState(pairing.localUserId, ns, entry, { conflict: true, value: res.json.value, revision: res.json.revision });
    } else { markOffline('bad flush ' + res.status); return; }
  }
}

/* 读:先补推再拉取,返回本地缓存(此时已是最新镜像)。 */
async function mirroredState() {
  const connection = pairing;
  await flushQueue();
  await pull();
  if (!connection || pairing !== connection) throw Object.assign(new Error('同步账号已改变，请刷新页面'), { status: 409 });
  return storage.getState(pairing.localUserId);
}

/* 每次写入先原子落本地与队列，再立即推送。连续离线编辑保持最初的
 * 云端 revision；并发读取共享补推，避免同一条写入被重复提交后误判冲突。 */
async function pushState(namespace, value, expectedRevision) {
  const connection = pairing;
  const local = storage.putState(connection.localUserId, namespace, value, expectedRevision, true);
  if (local.conflict) return { kind: 'conflict', revision: local.revision, value: local.value };
  await flushQueue();
  if (pairing !== connection) throw Object.assign(new Error('同步账号已改变，请刷新页面'), { status: 409 });
  const current = storage.getState(connection.localUserId);
  const revision = current.revisions[namespace];
  if (JSON.stringify(current.state[namespace]) !== JSON.stringify(value)) {
    return { kind: 'conflict', revision, value: current.state[namespace] };
  }
  return { kind: readQueue()[namespace] ? 'queued' : 'synced', revision };
}

/* 后台节拍:45s 一轮,补推 + 拉取,让两台 Mac 无需刷新也能逐步收敛。 */
function startBackground(intervalMs) {
  const tick = async () => {
    if (!pairing) return;
    try { await flushQueue(); await pull(); } catch {}
  };
  const timer = setInterval(tick, intervalMs || 45000);
  timer.unref();
}

module.exports = {
  init, isPaired, status, pairedInfo, localUserId,
  pair, pairWithSession, normalizeUrl, unpair, resumeUser, pull, flushQueue, mirroredState, pushState, startBackground,
};
