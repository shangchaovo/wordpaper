'use strict';
const http = require('http');
const https = require('https');
const { failure } = require('./ai-model');

// A satellite calls the account server. Its model key never travels to the Mac.
function pairedCompletion(connection, messages, maxTokens) {
  return new Promise((resolve, reject) => {
    const target = new URL('/api/ai/chat', connection.url);
    const body = JSON.stringify({ messages, maxTokens });
    const req = (target.protocol === 'https:' ? https : http).request(target, {
      method: 'POST', headers: { Cookie: connection.cookie, 'X-CSRF-Token': connection.csrfToken,
        Origin: connection.url, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) req.destroy(); else chunks.push(chunk); });
      res.on('error', () => finish(failure('upstream_offline', '连接主账号服务器中断，请稍后重试。', 503)));
      res.on('end', () => {
        if (res.statusCode === 401) return finish(failure('upstream_reauth', '主账号登录已过期，请重新连接账号。', 401));
        if (res.statusCode === 404) return finish(failure('upstream_upgrade_required', '请先更新主账号服务器，以启用账号模型接口。', 409));
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (res.statusCode !== 200 || !data.ok) return finish(failure(data.code || 'upstream_model_error', data.error || '主账号模型请求失败。', 502));
          finish(null, data);
        } catch { finish(failure('invalid_response', '主账号返回内容无法读取。', 502)); }
      });
    });
    const timer = setTimeout(() => req.destroy(failure('model_timeout', '主账号模型响应超时，请重试。', 504)), 60000);
    function finish(error, value) { clearTimeout(timer); error ? reject(error) : resolve(value); }
    req.on('error', error => finish(error.status ? error : failure('upstream_offline', '无法连接主账号服务器，请检查网络。', 503)));
    req.end(body);
  });
}
module.exports = { pairedCompletion };
