'use strict';

const ai = require('./ai-model');

function createModelRoutes({ storage, upstream, mirroring, mode, requireSession, requireCsrf, readJson, json }) {
  const busy = new Set();
  return async function handleModel(req, res, pathname) {
    const session = requireSession(req, res);
    if (!session) return;
    const configRoute = pathname === '/api/account/model';
    const allowed = configRoute ? ['GET', 'PUT', 'DELETE'] : ['POST'];
    if (!allowed.includes(req.method)) return json(res, 405, { error: 'Method Not Allowed' });
    if (req.method !== 'GET' && !requireCsrf(req, res, session)) return;
    const userId = session.user.id;
    if (busy.has(userId)) return json(res, 429, { error: '上一个模型请求仍在处理中，请稍候。', code: 'model_busy' });
    busy.add(userId);
    try {
      const body = ['PUT', 'POST'].includes(req.method) ? await readJson(req) : undefined;
      if (mirroring()) {
        if (userId !== upstream.localUserId()) throw ai.failure('account_mismatch', '请重新登录当前同步账号。', 403);
        const remote = await upstream.modelRequest(req.method, pathname, body);
        if (remote.status === 404) throw ai.failure('upstream_upgrade_required', '主账号服务器尚未支持模型绑定，请先更新主账号服务器。', 409);
        return json(res, remote.status, remote.json || { error: '主账号服务器返回异常。' });
      }
      if (req.method === 'GET') return json(res, 200, { ...storage.models.summary(userId), user: session.user });
      if (req.method === 'DELETE') {
        storage.models.remove(userId);
        return json(res, 200, { configured: false });
      }
      if (pathname === '/api/ai/chat') {
        const result = await ai.complete(storage.models.get(userId), body?.messages, { allowPrivate: mode === 'local', maxTokens: body?.maxTokens });
        return json(res, 200, { ok: true, ...result });
      }
      const hasInput = body && Object.keys(body).length > 0;
      let config;
      if (hasInput) {
        const previous = !body.apiKey && storage.models.summary(userId).configured ? storage.models.get(userId) : null;
        config = ai.normalizeConfig(body, previous, mode === 'local');
      } else config = storage.models.get(userId);
      const result = await ai.complete(config, [{ role: 'user', content: 'Reply with OK only.' }], { allowPrivate: mode === 'local', maxTokens: 64 });
      // A failed probe cannot replace the existing key or endpoint.
      if (req.method === 'PUT') {
        if (!storage.findSession(session.tokenHash)) throw ai.failure('session_expired', '登录已过期，请重新登录。', 401);
        storage.models.save(userId, config);
      }
      return json(res, 200, { ok: true, ...(req.method === 'PUT' ? storage.models.summary(userId) : {}), model: result.model, message: req.method === 'PUT' ? '连接成功，已绑定当前账号。' : '连接测试成功。' });
    } catch (error) {
      return json(res, error.status || 503, { ok: false, code: error.status ? error.code : 'model_unavailable', error: error.status ? error.message : '模型服务暂时不可用，请稍后重试。' });
    } finally { busy.delete(userId); }
  };
}

module.exports = { createModelRoutes };
