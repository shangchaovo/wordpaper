'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');

function failure(code, message, status = 400) {
  return Object.assign(new Error(message), { code, status });
}

function privateAddress(address) {
  const host = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (host.startsWith('::ffff:')) return net.isIP(host.slice(7)) === 4 ? privateAddress(host.slice(7)) : true;
  if (net.isIP(host) === 6) return !/^[23][0-9a-f]{3}:/.test(host);
  const [a, b] = host.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || a >= 224;
}

function normalizeConfig(input, previous, allowPrivate = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_config', '请填写模型接口配置。');
  let url;
  try { url = new URL(String(input.baseUrl || '').trim()); } catch { throw failure('invalid_url', '请填写完整的接口地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.href.length > 2048) {
    throw failure('invalid_url', '接口地址只允许 HTTP / HTTPS，不能包含密码、查询参数或片段。');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host.endsWith('.local') || host.endsWith('.ts.net') || (net.isIP(host) && privateAddress(host));
  if ((!allowPrivate && local) || (url.protocol === 'http:' && !(allowPrivate && local))) {
    throw failure('invalid_url', '公网接口必须使用 HTTPS；本机客户端可以连接局域网或 Tailscale 接口。');
  }
  url.pathname = url.pathname.replace(/\/(chat\/completions|messages)\/?$/, '').replace(/\/+$/, '');
  const baseUrl = url.toString().replace(/\/+$/, '');
  const protocol = input.protocol || 'openai';
  if (!['openai', 'anthropic'].includes(protocol)) throw failure('invalid_protocol', '不支持这种接口格式。');
  const model = String(input.model || '').trim();
  if (!model || model.length > 200 || /[\r\n\x00-\x1f]/.test(model)) throw failure('invalid_model', '请填写有效的模型名称。');
  let apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (!apiKey && previous && previous.baseUrl === baseUrl && previous.protocol === protocol) apiKey = previous.apiKey;
  if (!apiKey || apiKey.length > 4096 || /[^\x21-\x7e]/.test(apiKey)) {
    throw failure('key_required', '请填写 API Key；更换接口地址或格式时需要重新填写。');
  }
  return { baseUrl, protocol, model, apiKey };
}

// Keys are separate from user_state, browser caches and user-data exports.
// Bind authenticated ciphertext to the account ID so swapping rows fails closed.
function createAccountCipher(dataDir, modelKey) {
  function key(create) {
    if (modelKey) return modelKey;
    const file = path.join(dataDir, 'model-key.bin');
    if (create && !fs.existsSync(file)) {
      try { fs.writeFileSync(file, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
    const value = fs.readFileSync(file);
    if (value.length !== 32) throw failure('key_unavailable', '模型密钥无法读取，请重新绑定。', 503);
    return value;
  }
  function encrypt(scope, plaintext) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key(true), iv);
    cipher.setAAD(Buffer.from(String(scope)));
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  function decrypt(scope, value) {
    try {
      const blob = Buffer.from(value, 'base64');
      const cipher = crypto.createDecipheriv('aes-256-gcm', key(false), blob.subarray(0, 12));
      cipher.setAAD(Buffer.from(String(scope)));
      cipher.setAuthTag(blob.subarray(12, 28));
      return Buffer.concat([cipher.update(blob.subarray(28)), cipher.final()]).toString('utf8');
    } catch { throw failure('key_unavailable', '密钥无法读取，请重新绑定。', 503); }
  }
  return { encrypt, decrypt };
}

function createModelStore(db, dataDir, modelKey) {
  const cipher = createAccountCipher(dataDir, modelKey);
  function row(userId) { return db.prepare('SELECT * FROM user_models WHERE user_id=?').get(userId); }
  function summary(userId) {
    const value = row(userId);
    return value ? { configured: true, baseUrl: value.base_url, protocol: value.protocol, model: value.model, updatedAt: value.updated_at }
      : { configured: false, baseUrl: '', protocol: 'openai', model: '' };
  }
  function get(userId) {
    const value = row(userId);
    if (!value) throw failure('model_not_configured', '请先在「模型接口」中为当前账号绑定 API Key。', 409);
    const apiKey = cipher.decrypt(userId, value.key_cipher);
    return { baseUrl: value.base_url, protocol: value.protocol, model: value.model, apiKey };
  }
  function save(userId, config) {
    const value = cipher.encrypt(userId, config.apiKey);
    db.prepare(`INSERT INTO user_models (user_id,base_url,protocol,model,key_cipher,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET base_url=excluded.base_url,protocol=excluded.protocol,
      model=excluded.model,key_cipher=excluded.key_cipher,updated_at=excluded.updated_at`)
      .run(userId, config.baseUrl, config.protocol, config.model, value, Date.now());
    return summary(userId);
  }
  return { get, save, summary, remove: userId => db.prepare('DELETE FROM user_models WHERE user_id=?').run(userId) };
}

function providerError(status) {
  const errors = {
    401: ['invalid_api_key', 'API Key 无效或已过期，请重新填写。'],
    402: ['insufficient_balance', '模型账户余额不足，请在服务商处检查余额。'],
    403: ['provider_forbidden', '模型服务拒绝访问：账号受限或没有该模型权限，请联系服务商或更换接口。'],
    404: ['model_not_found', '接口地址或模型名称不存在，请检查配置。'],
    429: ['rate_limited', '模型请求受到限流，请稍后再试。'],
  };
  const [code, message] = errors[status] || ['provider_error', `模型服务返回 HTTP ${status}，请检查接口配置或稍后再试。`];
  return failure(code, message, 502);
}

async function complete(config, messages, { allowPrivate = false, maxTokens = 1000, timeoutMs = 45000 } = {}) {
  if (!Array.isArray(messages) || !messages.length || messages.length > 20 || messages.some(m => !m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string')
    || messages.reduce((n, m) => n + m.content.length, 0) > 16000) throw failure('invalid_messages', '对话内容过长或格式不正确。');
  const checked = normalizeConfig(config, null, allowPrivate);
  const target = new URL(checked.baseUrl + (checked.protocol === 'anthropic' ? '/messages' : '/chat/completions'));
  const hostname = target.hostname.replace(/^\[|\]$/g, '');
  const budget = Math.max(1, Math.min(2048, Number(maxTokens) || 1000));
  const body = JSON.stringify(checked.protocol === 'anthropic' ? {
    model: checked.model, max_tokens: budget,
    cache_control: { type: 'ephemeral' },
    system: messages.filter(m => m.role === 'system').map(m => m.content).join('\n'),
    messages: messages.filter(m => m.role !== 'system'),
  } : { model: checked.model, messages, max_tokens: budget, stream: false,
    // Short grading/probe responses must not spend their output budget on reasoning.
    ...(/deepseek-(?:flash|v4)/i.test(checked.model) ? { thinking: { type: 'disabled' } } : {}),
  });
  return new Promise((resolve, reject) => {
    let req, settled = false;
    const timer = setTimeout(() => { const err = failure('model_timeout', '模型响应超时，请稍后再试或更换接口。', 504); req?.destroy(err); done(err); }, timeoutMs);
    const done = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); error ? reject(error) : resolve(value); };
    // Resolve once and pin the address to prevent public-server SSRF / DNS rebinding.
    (async () => {
      const addresses = net.isIP(hostname) ? [{ address: hostname, family: net.isIP(hostname) }] : await dns.lookup(hostname, { all: true });
      if (settled) return;
      if (!addresses.length || (!allowPrivate && addresses.some(a => privateAddress(a.address)))) throw failure('private_endpoint', '云端模型接口不能访问私有网络地址。');
      const selected = addresses[0];
      const auth = checked.protocol === 'anthropic'
        ? { 'x-api-key': checked.apiKey, 'anthropic-version': '2023-06-01' }
        : { Authorization: 'Bearer ' + checked.apiKey };
      req = (target.protocol === 'https:' ? https : http).request(target, {
        method: 'POST', headers: { ...auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        lookup: (_host, options, cb) => cb(null, options.all ? [selected] : selected.address, selected.family),
      }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > 1024 * 1024) req.destroy(failure('invalid_response', '模型返回内容过大。', 502));
          else chunks.push(chunk);
        });
        res.on('error', () => done(failure('model_network', '模型连接中断，请重试。', 502)));
        res.on('end', () => {
          if (res.statusCode !== 200) return done(providerError(res.statusCode));
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const text = checked.protocol === 'anthropic' ? (value.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n') : value.choices?.[0]?.message?.content;
            if (typeof text !== 'string' || !text.trim()) throw new Error('empty');
            done(null, { text: text.trim(), model: checked.model });
          } catch { done(failure('invalid_response', '模型没有返回有效内容，请检查模型名称或重试。', 502)); }
        });
      });
      req.on('error', error => done(error.status ? error : failure('model_network', '无法连接模型接口，请检查地址、网络和服务是否在线。', 502)));
      req.end(body);
    })().catch(error => done(error.status ? error : failure('model_network', '无法连接模型接口，请检查地址和网络。', 502)));
  });
}

module.exports = { createAccountCipher, providerError, createModelStore, normalizeConfig, complete, failure, privateAddress };
