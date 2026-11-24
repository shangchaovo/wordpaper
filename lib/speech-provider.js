'use strict';

const { execFile } = require('node:child_process');
const net = require('node:net');
const { systemProxyArgs } = require('./updater');
const { createAccountCipher, normalizeConfig, failure, providerError, privateAddress, resolveProviderAddress } = require('./ai-model');

const defaults = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-tts', voice: 'coral' };

function normalizeSpeech(input, previous, allowPrivate = true) {
  const baseUrl = String(input?.baseUrl || '').trim().replace(/\/audio\/speech\/?$/, '');
  if (/\/(chat\/completions|messages)\/?$/.test(baseUrl)) throw failure('invalid_url', '请填写语音接口的基础地址或 /audio/speech 地址。');
  const config = normalizeConfig({ baseUrl, model: input?.model, apiKey: input?.apiKey }, previous && { ...previous, protocol: 'openai' }, allowPrivate);
  const voice = String(input?.voice || '').trim();
  if (!voice || voice.length > 200 || /[\x00-\x1f]/.test(voice)) throw failure('invalid_voice', '请填写接口支持的声音名称。');
  return { baseUrl: config.baseUrl, model: config.model, apiKey: config.apiKey, voice };
}

function createSpeechStore(db, dataDir, modelKey) {
  const cipher = createAccountCipher(dataDir, modelKey);
  function summary(userId) {
    const row = db.prepare('SELECT base_url AS "baseUrl", model, voice, updated_at AS "updatedAt" FROM user_speech WHERE user_id=?').get(userId);
    return row ? { configured: true, ...row } : { configured: false, ...defaults };
  }
  function get(userId) {
    const row = db.prepare('SELECT base_url AS "baseUrl", model, voice, key_cipher AS secret FROM user_speech WHERE user_id=?').get(userId);
    if (!row) return null;
    return { userId, baseUrl: row.baseUrl, model: row.model, voice: row.voice, apiKey: cipher.decrypt('speech:' + userId, row.secret) };
  }
  function save(userId, config) {
    db.prepare(`INSERT INTO user_speech (user_id,base_url,model,voice,key_cipher,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET base_url=excluded.base_url, model=excluded.model,
      voice=excluded.voice, key_cipher=excluded.key_cipher, updated_at=excluded.updated_at`)
      .run(userId, config.baseUrl, config.model, config.voice, cipher.encrypt('speech:' + userId, config.apiKey), Date.now());
    return summary(userId);
  }
  function remove(userId) { db.prepare('DELETE FROM user_speech WHERE user_id=?').run(userId); return summary(userId); }
  return { summary, get, save, remove };
}

const maxAudioBytes = 8 * 1024 * 1024;

function audioResponse(status, body) {
  if (status < 200 || status >= 300) {
    if (status === 429) {
      let code;
      try { code = JSON.parse(body.subarray(0, 8192)).error.code; } catch {}
      if (code === 'insufficient_quota' || code === 'billing_hard_limit_reached') {
        throw failure('insufficient_quota', 'OpenAI API 额度不足，请检查项目的余额和用量上限。', 502);
      }
    }
    throw providerError(status);
  }
  if (body.length < 4 || (body.toString('ascii', 0, 3) !== 'ID3' && !(body[0] === 0xff && (body[1] & 0xe0) === 0xe0))) {
    throw failure('invalid_audio', '语音接口没有返回 MP3 音频，请检查模型、声音和地址。', 502);
  }
  return body;
}

// Finder launches without a shell proxy environment. Match the Mac's official
// download path and keep the credential and text on stdin, outside process lists.
async function macSpeechRequest(url, key, body) {
  const args = ['--disable', '--silent', '--proto', '=https', '--connect-timeout', '8', '--max-time', '30',
    '--max-filesize', String(maxAudioBytes), ...await systemProxyArgs(), '--config', '-', '--write-out', '%{http_code}', '--url', url];
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/curl', args, { encoding: 'buffer', timeout: 33000, maxBuffer: maxAudioBytes + 3 }, (err, bytes) => {
      if (err) {
        if (err.code === 28 || err.killed) return reject(failure('timeout', '语音接口响应超时。', 502));
        return reject(err);
      }
      try { resolve(audioResponse(Number(bytes.subarray(-3).toString()), bytes.subarray(0, -3))); }
      catch (error) { reject(error); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end('header = ' + JSON.stringify('Authorization: Bearer ' + key) +
      '\nheader = "Content-Type: application/json"\ndata-binary = ' + JSON.stringify(body) + '\n');
  });
}

async function publicSpeechRequest(config, text) {
  const validated = normalizeSpeech(config, null, false);
  const url = new URL(validated.baseUrl + '/audio/speech');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const selected = await resolveProviderAddress(host, false);
  const body = JSON.stringify({ model: validated.model, voice: validated.voice, input: text, response_format: 'mp3' });
  return new Promise((resolve, reject) => {
    const req = require('node:https').request(url, {
      method: 'POST', agent: false, signal: AbortSignal.timeout(30000),
      headers: { Authorization: 'Bearer ' + validated.apiKey, 'Content-Type': 'application/json' },
      lookup: (_host, options, cb) => cb(null, options.all ? [selected] : selected.address, selected.family),
    }, res => {
      const chunks = []; let length = 0;
      res.on('data', chunk => {
        length += chunk.length;
        if (length > maxAudioBytes) req.destroy(failure('invalid_audio', '返回的音频过大', 502));
        else chunks.push(chunk);
      });
      res.on('error', () => reject(failure('speech_unavailable', '语音连接中断', 502)));
      res.on('end', () => {try {resolve(audioResponse(res.statusCode, Buffer.concat(chunks)));} catch (err) {reject(err);}});
    });
    req.on('error', err => reject(err.status ? err : failure('speech_unavailable', '语音服务连接失败', 502)));
    req.end(body);
  });
}

async function generateSpeech(config, text, {allowPrivate = true} = {}) {
  if (!allowPrivate) return publicSpeechRequest(config, text);
  const url = new URL(config.baseUrl + '/audio/speech');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const local = host === 'localhost' || host.endsWith('.local') || host.endsWith('.ts.net') || (net.isIP(host) && privateAddress(host));
  const body = JSON.stringify({ model: config.model, voice: config.voice, input: text, response_format: 'mp3' });
  const signal = AbortSignal.timeout(30000);
  try {
    if (process.platform === 'darwin' && url.protocol === 'https:' && !local) return await macSpeechRequest(url.href, config.apiKey, body);
    const response = await fetch(url, { method: 'POST', redirect: 'error', signal,
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' }, body });
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxAudioBytes) throw failure('invalid_audio', '接口返回的音频过大。', 502);
      chunks.push(chunk);
    }
    return audioResponse(response.status, Buffer.concat(chunks));
  } catch (error) {
    if (error.status) throw error;
    throw failure('speech_unavailable', signal.aborted ? '语音接口响应超时。' : '无法连接语音接口，请检查地址和网络。', 502);
  }
}

module.exports = { defaults, normalizeSpeech, createSpeechStore, generateSpeech };
