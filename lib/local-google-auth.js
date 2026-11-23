'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const PROVIDER = 'google-desktop';
const COOKIE = 'wp_local_google_flow';
const TTL = 10 * 60 * 1000;
const WEB_CALLBACK_PORT = 8770;
const WEB_CALLBACK_URI = `http://localhost:${WEB_CALLBACK_PORT}/api/auth/google/callback`;
const random = size => crypto.randomBytes(size).toString('base64url');
const hash = value => crypto.createHash('sha256').update(value).digest('base64url');

function readClientFile(dataDir, name) {
  const filename = path.join(dataDir, name);
  try {
    const info = fs.statSync(filename);
    if (!info.isFile() || info.size > 16384) return null;
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
}

function credentials(client) {
  const id = client?.client_id;
  const secret = client?.client_secret ?? '';
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(id)) return null;
  if (typeof secret !== 'string' || (secret && !/^[A-Za-z0-9_-]{1,256}$/.test(secret))) return null;
  return { clientId: id, clientSecret: secret };
}

function localClient(dataDir) {
  const desktop = credentials(readClientFile(dataDir, 'google-desktop.json')?.installed);
  if (desktop) return desktop;
  const config = readClientFile(dataDir, 'google-local-web.json');
  const web = credentials(config);
  if (web?.clientSecret && config.redirect_uri === WEB_CALLBACK_URI) return { ...web, redirectUri: WEB_CALLBACK_URI };
  return null;
}

// The loopback listener closes as soon as it receives the one-shot result.
// Include only known packaged assets so the page needs no second request.
function packagedAsset(...parts) {
  try { return fs.readFileSync(path.join(__dirname, '..', ...parts)); }
  catch { return Buffer.alloc(0); }
}

const resultCss = packagedAsset('css', 'local-google-return.css').toString('utf8');
const resultLogo = packagedAsset('assets', 'favicon-128.png');
const resultLogoUrl = resultLogo.length ? `data:image/png;base64,${resultLogo.toString('base64')}` : '';
const resultCsp = [
  "default-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "form-action 'none'",
  ...(resultCss ? [`style-src 'sha256-${crypto.createHash('sha256').update(resultCss).digest('base64')}'`] : []),
  ...(resultLogoUrl ? ['img-src data:'] : []),
].join('; ');

const browserResults = {
  success: ['success', '✓', 'Google 授权已完成', '请返回 WordPaper App。App 会继续处理这次登录或绑定。'],
  cancelled: ['cancelled', '×', 'Google 授权已取消', '请返回 WordPaper App。需要时可以重新发起授权。'],
  failed: ['error', '!', 'Google 授权未完成', '请返回 WordPaper App 查看提示，或重新发起授权。'],
  expired: ['error', '!', 'Google 授权请求已过期', '请回到 WordPaper App 重新发起授权。'],
  ended: ['error', '!', 'Google 授权请求已结束', '请回到 WordPaper App 继续操作。'],
  unavailable: ['error', '!', '授权链接不可用', '请回到 WordPaper App 继续操作。'],
};

function browserResult(res, status, result) {
  const [variant, mark, title, message] = browserResults[result];
  res.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': resultCsp,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    Connection: 'close',
  });
  res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · WordPaper</title>
  ${resultLogoUrl ? `<link rel="icon" href="${resultLogoUrl}">` : ''}
  ${resultCss ? `<style>${resultCss}</style>` : ''}
</head>
<body>
  <main class="return-sheet" data-result="${variant}">
    <div class="brand">${resultLogoUrl ? `<img src="${resultLogoUrl}" alt="" width="50" height="50">` : ''}WordPaper</div>
    <span class="return-mark" aria-hidden="true">${mark}</span>
    <h1>${title}</h1>
    <p class="return-message">${message}</p>
    <p class="return-note">现在可以关闭此页面。</p>
  </main>
</body>
</html>`);
}

function createLocalGoogleAuth(deps) {
  const { dataDir, storage, localOrigin, requestSession, requireCsrf, readJson, json, parseCookies,
    appendSetCookies, authRateAllowed, authorizationUrl, googleIdentity, openSystemBrowser,
    newLocalSession, accountErrors, accountAuthMs } = deps;
  const flows = new Map();

  function enabled(req) {
    return Boolean(openSystemBrowser && localOrigin(req) && localClient(dataDir));
  }

  function stop(flow) {
    if (!flow) return;
    flows.delete(flow.key);
    clearTimeout(flow.timeout);
    flow.listener.close();
  }

  function setFlowCookie(res, value, maxAge) {
    appendSetCookies(res, [`${COOKIE}=${value}; Path=/api/local-google; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`]);
  }

  function error(res, code, status = 409) {
    json(res, status, { error: accountErrors[code], code });
  }

  function googleBinding(user) {
    return storage.accountCredentials(user.id).identities.find(row => row.provider === PROVIDER);
  }

  async function receive(req, res, flow) {
    const callback = new URL(flow.redirectUri);
    const parsed = URL.parse(req.url, callback);
    if (req.method !== 'GET' || req.headers.host !== callback.host || !parsed || parsed.origin !== callback.origin || parsed.pathname !== callback.pathname) {
      browserResult(res, 404, 'unavailable');
      return;
    }
    const states = parsed.searchParams.getAll('state');
    if (flows.get(flow.key) !== flow || flow.phase !== 'browser' || Date.now() >= flow.expiresAt ||
        states.length !== 1 || !/^[A-Za-z0-9_-]{43}$/.test(states[0]) || hash(states[0]) !== flow.stateHash) {
      browserResult(res, 400, 'expired');
      return;
    }
    flow.phase = 'exchanging';
    flow.listener.close();
    const codes = parsed.searchParams.getAll('code');
    const providerError = parsed.searchParams.get('error');
    if (providerError || codes.length !== 1 || !codes[0] || codes[0].length > 4096) {
      flow.errorCode = providerError === 'access_denied' ? 'oauth_cancelled' : 'oauth_failed';
    } else {
      try { flow.identity = await googleIdentity(codes[0], flow, flow.client); }
      catch { flow.errorCode = 'oauth_failed'; }
    }
    if (flows.get(flow.key) !== flow || Date.now() >= flow.expiresAt) {
      browserResult(res, 410, 'ended');
      return;
    }
    flow.phase = 'ready';
    flow.client = null;
    flow.codeVerifier = '';
    const result = flow.errorCode === 'oauth_cancelled' ? 'cancelled' : flow.errorCode ? 'failed' : 'success';
    browserResult(res, 200, result);
  }

  async function start(req, res, origin, session) {
    const client = openSystemBrowser && localClient(dataDir);
    if (!client) return json(res, 503, { error: '本机尚未配置 Google 桌面登录。' });
    if (!authRateAllowed(req)) return json(res, 429, { error: '操作过于频繁，请稍后再试。' });
    const purpose = (await readJson(req))?.purpose;
    if (!['login', 'link', 'replace', 'reauth'].includes(purpose)) return json(res, 400, { error: '登录操作无效。' });
    const currentHash = requestSession(req)?.tokenHash || '';
    if (currentHash !== (session?.tokenHash || '')) return error(res, 'oauth_expired');
    if (purpose === 'login' && session) return json(res, 409, { error: '请先退出当前本机账号，再使用 Google 登录。' });
    if (purpose !== 'login' && !session) return json(res, 401, { error: '请先登录本机账号。' });
    const expectedSubject = session ? googleBinding(session.user)?.provider_subject || '' : '';
    if ((purpose === 'link' && expectedSubject) || (['replace', 'reauth'].includes(purpose) && !expectedSubject)) return error(res, 'binding_changed');
    if (session && purpose !== 'reauth' && Date.now() - session.authenticatedAt > accountAuthMs) return error(res, 'reauth_required', 403);

    stop(readFlow(req, origin));
    const ticket = random(32);
    const state = random(32);
    const flow = { key: hash(ticket), origin, purpose, expectedSubject, sessionHash: currentHash, stateHash: hash(state),
      codeVerifier: random(48), client, expiresAt: Date.now() + TTL, phase: 'browser' };
    flow.listener = http.createServer({ headersTimeout: 5000, requestTimeout: 15000 }, (callbackReq, callbackRes) => {
      receive(callbackReq, callbackRes, flow).catch(() => browserResult(callbackRes, 500, 'failed'));
    });
    try {
      await new Promise((resolve, reject) => {
        flow.listener.once('error', reject);
        flow.listener.listen(client.redirectUri ? WEB_CALLBACK_PORT : 0, '127.0.0.1', resolve);
      });
    } catch {
      stop(flow);
      return json(res, 503, { error: client.redirectUri ? 'Google 本机授权需要使用 8770 端口。该端口当前不可用。' : '无法启动 Google 本机授权，请稍后重试。' });
    }
    try {
      const port = flow.listener.address().port;
      flow.listener.unref();
      flow.redirectUri = client.redirectUri || `http://127.0.0.1:${port}/`;
      flow.timeout = setTimeout(() => stop(flow), TTL).unref();
      flows.set(flow.key, flow);
      await openSystemBrowser(authorizationUrl(client.clientId, flow.redirectUri, state, flow.codeVerifier));
    } catch {
      stop(flow);
      return json(res, 503, { error: '无法打开 Google 授权，请检查系统浏览器后重试。' });
    }
    setFlowCookie(res, ticket, Math.floor(TTL / 1000));
    return json(res, 200, { ok: true });
  }

  function readFlow(req, origin) {
    const ticket = parseCookies(req)[COOKIE] || '';
    if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
    const flow = flows.get(hash(ticket));
    return flow?.origin === origin ? flow : null;
  }

  function complete(req, res, flow, session) {
    stop(flow);
    if (flow.errorCode) {
      setFlowCookie(res, '', 0);
      return error(res, flow.errorCode);
    }
    const { subject, profile } = flow.identity;
    try {
      if (flow.purpose === 'login') {
        const user = storage.findFederatedUser(PROVIDER, subject);
        if (!user) {
          setFlowCookie(res, '', 0);
          return json(res, 409, { code: 'identity_not_bound', error: '这个 Google 账号尚未绑定本机账号。请先使用原账号登录，在账号绑定中连接 Google。' });
        }
        newLocalSession(req, res, user);
      } else if (flow.purpose === 'reauth') {
        if (subject !== flow.expectedSubject || googleBinding(session.user)?.provider_subject !== subject) {
          setFlowCookie(res, '', 0);
          return error(res, 'binding_changed');
        }
        storage.markSessionAuthenticated(session.tokenHash);
      } else {
        if (Date.now() - session.authenticatedAt > accountAuthMs) {
          setFlowCookie(res, '', 0);
          return error(res, 'reauth_required', 403);
        }
        storage.bindIdentity(session.user.id, PROVIDER, subject, profile, flow.expectedSubject, session.tokenHash);
      }
    } catch (err) {
      if (!Object.hasOwn(accountErrors, err.code)) throw err;
      setFlowCookie(res, '', 0);
      return error(res, err.code, err.status);
    }
    setFlowCookie(res, '', 0);
    return json(res, 200, { ok: true });
  }

  async function handle(req, res, pathname) {
    const origin = localOrigin(req);
    if (!origin) return json(res, 404, { error: 'Not Found' });
    if (req.method !== 'POST') return json(res, 405, { error: 'Method Not Allowed' });
    if (req.headers.origin !== origin) return json(res, 403, { error: '请求来源校验失败' });
    const session = requestSession(req);
    if (session && !requireCsrf(req, res, session)) return;
    if (pathname === '/api/local-google/start') return start(req, res, origin, session);
    if (!['/api/local-google/cancel', '/api/local-google/poll'].includes(pathname)) return json(res, 404, { error: 'Not Found' });
    const flow = readFlow(req, origin);
    const valid = flow && flow.sessionHash === (session?.tokenHash || '') && Date.now() < flow.expiresAt;
    if (pathname.endsWith('/cancel')) {
      if (valid) stop(flow);
      setFlowCookie(res, '', 0);
      return json(res, 200, { ok: true });
    }
    if (!valid) return error(res, 'oauth_expired');
    if (flow.phase !== 'ready') return json(res, 200, { pending: true });
    return complete(req, res, flow, session);
  }

  return { enabled, handle, close: () => { for (const flow of flows.values()) stop(flow); } };
}

module.exports = { createLocalGoogleAuth, PROVIDER };
