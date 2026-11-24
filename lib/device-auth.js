'use strict';

// Desktop uses a browser approval plus a private verifier. Provider secrets and
// cloud session tokens never travel through a browser redirect or URL scheme.
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(value).digest('base64url');
const secret = () => crypto.randomBytes(32).toString('base64url');
const TTL = 10 * 60 * 1000;

function createDeviceAuth(deps) {
  const { storage, upstream, json, readJson, requireOrigin, requireCsrf, requireSession,
    requestSession, authRateAllowed, expectedOrigin, oauthProviderConfigured, newSession,
    isLoopbackRequest, mode, sessionDays, parseCookies } = deps;
  const attempts = new Map();

  async function remote(origin, route, body) {
    let response;
    try {
      response = await fetch(origin + route, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(12000),
        headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch {
      throw Object.assign(new Error('无法连接账号服务器。请检查地址和网络后再试。'), { status: 502 });
    }
    if (response.status >= 300 && response.status < 400) {
      throw Object.assign(new Error('账号服务器地址发生跳转。请填写浏览器地址栏中的最终地址。'), { status: 502 });
    }
    const data = await response.json().catch(() => null);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      const message = response.status >= 500
        ? '账号服务器暂时不可用，请稍后再试。'
        : '此地址未提供 WordPaper 账号同步。请填写支持桌面同步的账号服务器地址。';
      throw Object.assign(new Error(message), { status: 502 });
    }
    if (!response.ok) throw Object.assign(new Error(data.error || '账号服务器暂时不可用'), { status: response.status });
    return data;
  }

  return async function handleDeviceAuth(req, res, parsed) {
    const pathname = parsed.pathname;
    if (!pathname.startsWith('/api/device/') && !pathname.startsWith('/api/desktop/')) return false;
    if (req.method !== 'POST') { json(res, 405, { error: 'Method Not Allowed' }); return true; }
    if (!requireOrigin(req, res)) return true;

    if (pathname.startsWith('/api/device/')) {
      if (mode !== 'public' && !deps.pairedHostEnabled?.(req)) { json(res, 404, { error: '请使用已启用配对的账号服务器连接桌面 App' }); return true; }
      const body = await readJson(req);
      const origin = expectedOrigin(req);
      const scope = deps.deviceScope(origin);
      const deviceHash = code => hash(scope ? scope + '\0' + code : code);
      const approvalKey = code => scope ? deviceHash(code) : code;
      if (pathname === '/api/device/start') {
        if (!authRateAllowed(req)) { json(res, 429, { error: '请求过于频繁，请稍后重试' }); return true; }
        if (!/^[A-Za-z0-9_-]{43}$/.test(body.challenge || '')) { json(res, 400, { error: '无效的设备验证请求' }); return true; }
        const provider = body.provider;
        if (!['google', 'github', 'wechat', 'email'].includes(provider)) {
          json(res, 400, { error: '无效的登录方式' }); return true;
        }
        if (provider !== 'email' && !oauthProviderConfigured(req, provider)) {
          const method = { google: 'Google 登录', github: 'GitHub 登录', wechat: '微信登录' }[provider];
          json(res, 503, { error: `此账号服务器尚未开放「${method}」。已有账号可选择「邮箱 / 原账号登录」。` }); return true;
        }
        const deviceCode = secret();
        const rawCode = crypto.randomBytes(6).toString('hex').toUpperCase();
        const userCode = rawCode.slice(0, 6) + '-' + rawCode.slice(6);
        storage.createDeviceFlow(deviceHash(deviceCode), approvalKey(userCode), body.challenge, Date.now() + TTL);
        const next = '/connect.html?code=' + userCode;
        const route = provider === 'email' ? '/login.html' : `/api/auth/${provider}/start`;
        json(res, 200, { deviceCode, userCode, verificationUrl: origin + route + '?next=' + encodeURIComponent(next), expiresIn: TTL / 1000 });
        return true;
      }
      if (pathname === '/api/device/approve') {
        const session = requireSession(req, res);
        if (!session || !requireCsrf(req, res, session)) return true;
        if (Date.now() - session.authenticatedAt > TTL) { json(res, 403, { error: '请重新登录后再授权桌面 App' }); return true; }
        const userCode = String(body.userCode || '');
        if (!/^[0-9A-F]{6}-[0-9A-F]{6}$/.test(userCode) || !storage.approveDeviceFlow(approvalKey(userCode), session.user.id)) { json(res, 409, { error: '连接码已过期或已使用，请回 App 重试' }); return true; }
        json(res, 200, { ok: true }); return true;
      }
      if (pathname === '/api/device/token') {
        if (!/^[A-Za-z0-9_-]{43}$/.test(body.deviceCode || '') || !/^[A-Za-z0-9_-]{43}$/.test(body.verifier || '')) {
          json(res, 400, { error: '无效的设备验证请求' }); return true;
        }
        const token = secret(), csrfToken = secret();
        const grant = storage.consumeDeviceFlow(deviceHash(body.deviceCode), hash(body.verifier), {
          tokenHash: crypto.createHash('sha256').update(token).digest('hex'),
          csrfToken, expiresAt: Date.now() + sessionDays * 86400000,
        });
        if (!grant) { json(res, 410, { error: '授权已过期或已领取，请在 App 重新发起' }); return true; }
        if (!grant.userId) { json(res, 200, { pending: true }); return true; }
        const cookieName = origin.startsWith('https:') ? '__Host-wp_session' : 'wp_session';
        json(res, 200, { cookie: `${cookieName}=${token}`, csrfToken }); return true;
      }
    } else {
      if (mode !== 'local' || !isLoopbackRequest(req)) { json(res, 404, { error: '仅限桌面 App 本机连接' }); return true; }
      const session = requestSession(req);
      if (session && !requireCsrf(req, res, session)) return true;
      for (const [key, value] of attempts) if (value.expiresAt <= Date.now()) attempts.delete(key);
      if (pathname === '/api/desktop/cancel') {
        const key = hash(String(parseCookies(req).wp_desktop_flow || ''));
        const attempt = attempts.get(key);
        if (attempt?.committed) { json(res, 200, { connected: true }); return true; }
        attempts.delete(key); json(res, 200, { ok: true }); return true;
      }
      if (pathname === '/api/desktop/start') {
        if (!authRateAllowed(req)) { json(res, 429, { error: '请求过于频繁，请稍后重试' }); return true; }
        const body = await readJson(req);
        const origin = upstream.normalizeUrl(body.url);
        if (origin === expectedOrigin(req)) { json(res, 400, { error: '请输入云端账号服务器地址，而非这台电脑自己的地址' }); return true; }
        const verifier = secret();
        const start = await remote(origin, '/api/device/start', { provider: body.provider, challenge: hash(verifier) });
        const verification = URL.parse(start.verificationUrl);
        if (!start.deviceCode || !start.userCode || verification?.origin !== origin || verification.username || verification.password) {
          json(res, 502, { error: '服务器返回了无效的授权地址' }); return true;
        }
        const attempt = secret();
        const old = parseCookies(req).wp_desktop_flow;
        if (old) attempts.delete(hash(old));
        attempts.set(hash(attempt), { origin, verifier, verificationUrl: verification.href, deviceCode: start.deviceCode, sessionHash: session?.tokenHash || '', expiresAt: Date.now() + TTL, busy: false });
        res.setHeader('Set-Cookie', `wp_desktop_flow=${attempt}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${TTL / 1000}`);
        json(res, 200, { verificationUrl: start.verificationUrl, userCode: start.userCode, expiresIn: TTL / 1000 }); return true;
      }
      if (pathname === '/api/desktop/poll' || pathname === '/api/desktop/open') {
        const key = hash(String(parseCookies(req).wp_desktop_flow || ''));
        const attempt = attempts.get(key);
        if (!attempt) { json(res, 410, { error: '连接请求已过期，请重新发起' }); return true; }
        if ((session?.tokenHash || '') !== attempt.sessionHash) { attempts.delete(key); json(res, 409, { error: '本机账号已改变，请重新发起连接' }); return true; }
        if (pathname === '/api/desktop/open') {
          if (!deps.openSystemBrowser) { json(res, 503, { error: '请复制授权地址到浏览器打开。' }); return true; }
          try {
            await deps.openSystemBrowser(attempt.verificationUrl);
            json(res, 200, { ok: true });
          } catch {
            json(res, 503, { error: '系统浏览器未能打开，请复制授权地址。' });
          }
          return true;
        }
        if (attempt.busy) { json(res, 200, { pending: true }); return true; }
        attempt.busy = true;
        try {
          const result = attempt.grant || await remote(attempt.origin, '/api/device/token', { deviceCode: attempt.deviceCode, verifier: attempt.verifier });
          if (result.pending) { json(res, 200, { pending: true }); return true; }
          attempt.grant = result;
          if (attempts.get(key) !== attempt || (attempt.sessionHash && !storage.findSession(attempt.sessionHash))) {
            throw Object.assign(new Error('连接已取消，请重新发起'), { status: 409 });
          }
          const user = await upstream.pairWithSession({ url: attempt.origin, cookie: result.cookie, csrfToken: result.csrfToken,
            canAdopt: () => {
              if (attempts.get(key) !== attempt || (attempt.sessionHash && !storage.findSession(attempt.sessionHash))) return false;
              attempt.committed = true;
              return true;
            },
          });
          attempts.delete(key);
          newSession(req, res, user, false);
          json(res, 200, { ok: true });
        } finally { attempt.busy = false; }
        return true;
      }
    }
    json(res, 404, { error: 'Not Found' }); return true;
  };
}

module.exports = { createDeviceAuth };
