'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MINUTE = 60000;
const FLOW_TTL = 5 * MINUTE;
const SESSION_TTL = 30 * 24 * 60 * MINUTE;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const error = (status, message) => Object.assign(new Error(message), { status });
const token = () => crypto.randomBytes(32).toString('base64url');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const looksLikeToken = value => typeof value === 'string' && TOKEN.test(value);

function maskedAccount(name) {
  const [local, domain] = String(name).split('@');
  const chars = Array.from(local);
  return { label: (chars[0] || '') + '***' + (chars.length > 2 ? chars.at(-1) : '') + (domain ? '@' + domain : '') };
}

function readTemplateFields(raw) {
  if (!raw) return null;
  const fields = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const allowed = { count: /^number\d+$/, time: /^(?:date|time)\d+$/, title: /^thing\d+$/ };
  if (!fields || Array.isArray(fields) || !Object.keys(fields).length ||
      Object.entries(fields).some(([key, value]) => !Object.hasOwn(allowed, key) || typeof value !== 'string' || !allowed[key].test(value))) {
    throw new Error('小程序订阅模板字段无效，请检查 WORDPAPER_MINI_TEMPLATE_FIELDS。');
  }
  return fields;
}

function templateData(fields, count, at, timezone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at);
  const t = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const values = { count: String(count), time: t.year + '-' + t.month + '-' + t.day + ' ' + t.hour + ':' + t.minute, title: '单词复习' };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [v, { value: values[k] }]));
}

function wechatClient(appId, appSecret, now, fetchImpl) {
  let access;
  let pending;
  async function request(url, body) {
    try {
      const response = await fetchImpl(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(10000),
        ...(body && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (!data || typeof data !== 'object') throw new Error();
      return data;
    } catch { throw error(502, '微信服务暂时无法连接。'); }
  }
  return {
    async login(code) {
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({ appid: appId, secret: appSecret, js_code: code, grant_type: 'authorization_code' });
      const data = await request(url);
      if (data.errcode === 40029 || data.errcode === 40163) throw error(401, '微信登录凭证已过期，请重新打开小程序。');
      if (data.errcode || typeof data.openid !== 'string' || !data.openid || data.openid.length > 128) {
        throw error(502, '微信登录暂时不可用。');
      }
      return data.openid;
    },
    async accessToken() {
      if (access && access.expiresAt > now()) return access.value;
      if (!pending) pending = request('https://api.weixin.qq.com/cgi-bin/stable_token', {
        grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: false,
      }).then(data => {
        if (typeof data.access_token !== 'string' || !data.access_token || !(data.expires_in > 0)) throw error(502, '微信发送凭据暂时不可用。');
        access = { value: data.access_token, expiresAt: now() + Math.max(1, data.expires_in - 60) * 1000 };
        return access.value;
      }).finally(() => { pending = null; });
      return pending;
    },
    invalidate() { access = null; },
    async send(accessToken, body) {
      const url = new URL('https://api.weixin.qq.com/cgi-bin/message/subscribe/send');
      url.searchParams.set('access_token', accessToken);
      const result = await request(url, body);
      if (!Number.isInteger(result.errcode)) throw error(502, '未收到有效的微信发送回执。');
      return result.errcode;
    },
  };
}

function createWechatMini({ db, postgres = false, getSchedules, devtools = false, env = process.env,
    now = Date.now, fetchImpl = globalThis.fetch }) {
  if (!postgres) db.exec(fs.readFileSync(path.join(__dirname, 'wechat-mini-schema.sql'), 'utf8'));
  const appId = devtools ? 'local-devtools' : String(env.WORDPAPER_MINI_APP_ID || '').trim();
  const appSecret = devtools ? '' : String(env.WORDPAPER_MINI_APP_SECRET || '').trim();
  const loginAvailable = Boolean(appId && appSecret);
  const fields = readTemplateFields(env.WORDPAPER_MINI_TEMPLATE_FIELDS);
  const templateId = (loginAvailable && fields) ? String(env.WORDPAPER_MINI_TEMPLATE_ID || '').trim() : '';
  const mode = env.WORDPAPER_MINI_TEMPLATE_MODE || 'once';
  if (!['once', 'longterm'].includes(mode)) throw new Error('小程序订阅模式须为 once 或 longterm。');
  const client = wechatClient(appId, appSecret, now, fetchImpl);
  const sql = (statement) => db.prepare(statement);
  let localPepper;
  function key(type, value) {
    if (!appSecret && !localPepper) {
      db.prepare('INSERT INTO app_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING')
        .run('mini_devtools_secret', token());
      localPepper = db.prepare('SELECT value FROM app_meta WHERE key=?').get('mini_devtools_secret').value;
    }
    return crypto.createHmac('sha256', appSecret || localPepper).update([appId, type, value].join('\0')).digest('hex');
  }
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      db.exec('COMMIT');
      return result;
    } catch (e) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw e;
    }
  }
  function limit(type, value, maximum) {
    const ts = now();
    const bucket = key(type, String(value || 'unknown'));
    // Each request consumes its attempt before any subsequent validation can roll back.
    const { attempts } = sql(`INSERT INTO mini_attempts(bucket,attempts,expires_at) VALUES(?,1,?)
      ON CONFLICT(bucket) DO UPDATE SET
        attempts = CASE WHEN mini_attempts.expires_at <= ? THEN 1 ELSE mini_attempts.attempts + 1 END,
        expires_at = CASE WHEN mini_attempts.expires_at <= ? THEN excluded.expires_at ELSE mini_attempts.expires_at END
      RETURNING attempts`).get(bucket, ts + FLOW_TTL, ts, ts);
    if (attempts > maximum) throw error(429, '操作过于频繁，请在五分钟后重试。');
  }
  function cleanup() {
    const ts = now();
    for (const table of ['mini_attempts', 'mini_sessions', 'mini_tickets', 'mini_codes']) {
      sql('DELETE FROM ' + table + ' WHERE expires_at <= ?').run(ts);
    }
  }
  function ready() {
    if (!loginAvailable && !devtools) throw error(503, '尚未配置微信小程序 AppID 和密钥。');
  }
  function binding(userId) {
    return { linked: Boolean(sql('SELECT user_id FROM mini_bindings WHERE user_id=? AND app_id=?').get(userId, appId)) };
  }
  function createPairCode(userId) {
    ready();
    cleanup();
    limit('create', userId, 5);
    return tx(() => {
      if (sql('SELECT user_id FROM mini_bindings WHERE user_id=?').get(userId)) throw error(409, '此账号已经绑定，请先解除绑定。');
      sql('DELETE FROM mini_codes WHERE user_id=?').run(userId);
      const expiresAt = now() + FLOW_TTL;
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = String(crypto.randomInt(1000000)).padStart(6, '0');
        const inserted = sql('INSERT INTO mini_codes(code_hash,user_id,expires_at) VALUES(?,?,?) ON CONFLICT DO NOTHING')
          .run(key('code', code), userId, expiresAt);
        if (inserted.changes) return { code, expiresAt };
      }
      throw error(503, '配对码生成繁忙，请重试。');
    });
  }
  function session(user) {
    const value = token();
    const expiresAt = now() + SESSION_TTL;
    sql('INSERT INTO mini_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(digest(value), user.user_id, expiresAt);
    return { token: value, expiresAt, account: { id: Number(user.user_id), ...maskedAccount(user.username) } };
  }
  function signIn(openid) {
    return tx(() => {
      const user = sql('SELECT b.user_id,u.username FROM mini_bindings b JOIN users u ON u.id=b.user_id WHERE b.app_id=? AND b.openid=?')
        .get(appId, openid);
      if (user) return session(user);
      const loginTicket = token();
      const expiresAt = now() + FLOW_TTL;
      sql('DELETE FROM mini_tickets WHERE app_id=? AND openid=? AND code_hash IS NULL').run(appId, openid);
      sql('INSERT INTO mini_tickets(token_hash,app_id,openid,expires_at) VALUES(?,?,?,?)')
        .run(digest(loginTicket), appId, openid, expiresAt);
      return { loginTicket, expiresAt };
    });
  }
  async function login(code, ip) {
    if (!loginAvailable) throw error(503, '微信登录尚未配置。');
    if (typeof code !== 'string' || !code || code.length > 512) throw error(400, '缺少有效的微信登录凭证。');
    cleanup();
    limit('login', ip, 80);
    return signIn(await client.login(code));
  }
  function loginDevtools(secret, ip) {
    if (!devtools) throw error(404, '没有这个接口。');
    if (typeof secret !== 'string' || !(/^[a-fA-F0-9]{64}$/.test(secret) || TOKEN.test(secret))) {
      throw error(400, '开发工具设备凭证无效。');
    }
    cleanup();
    limit('devtools', ip, 80);
    return signIn(key('device', secret));
  }
  function previewPair(ticket, code, ip) {
    ready();
    limit('preview-ip', ip, 32);
    if (!looksLikeToken(ticket) || typeof code !== 'string' || !/^\d{6}$/.test(code)) throw error(400, '请输入六位配对码。');
    const old = digest(ticket);
    const flow = sql('SELECT openid FROM mini_tickets WHERE token_hash=? AND app_id=? AND code_hash IS NULL AND expires_at>?')
      .get(old, appId, now());
    if (!flow) throw error(401, '微信验证已过期，请重试。');
    limit('preview-id', flow.openid, 8);
    return tx(() => {
      const codeHash = key('code', code);
      const target = sql('SELECT c.user_id,u.username,c.expires_at FROM mini_codes c JOIN users u ON u.id=c.user_id WHERE code_hash=? AND expires_at>?')
        .get(codeHash, now());
      if (!target) throw error(400, '配对码错误或已过期。');
      const confirmationToken = token();
      const row = sql(`UPDATE mini_tickets SET token_hash=?,code_hash=?
        WHERE app_id=? AND token_hash=? AND code_hash IS NULL AND expires_at>? RETURNING expires_at`)
        .get(digest(confirmationToken), codeHash, appId, old, now());
      if (!row) throw error(401, '微信验证已过期，请重试。');
      return { confirmationToken, account: maskedAccount(target.username), expiresAt: Math.min(target.expires_at, row.expires_at) };
    });
  }
  function confirmPair(confirmationToken) {
    ready();
    if (!looksLikeToken(confirmationToken)) throw error(401, '配对确认已失效。');
    return tx(() => {
      const t = now();
      const user = sql(`SELECT p.openid,c.code_hash,c.user_id,u.username
        FROM mini_tickets p JOIN mini_codes c ON c.code_hash=p.code_hash JOIN users u ON u.id=c.user_id
        WHERE p.token_hash=? AND p.app_id=? AND p.expires_at>? AND c.expires_at>?`)
        .get(digest(confirmationToken), appId, t, t);
      if (!user) throw error(401, '配对确认已过期或已使用。');
      const result = sql('INSERT INTO mini_bindings(user_id,app_id,openid) VALUES(?,?,?) ON CONFLICT DO NOTHING')
        .run(user.user_id, appId, user.openid);
      if (!result.changes) throw error(409, '微信或 WordPaper 账号已绑定，请在原账号解除绑定后重试。');
      sql('DELETE FROM mini_codes WHERE code_hash=?').run(user.code_hash);
      sql('DELETE FROM mini_tickets WHERE app_id=? AND openid=?').run(appId, user.openid);
      return session(user);
    });
  }
  function authenticate(value) {
    const sessionId = looksLikeToken(value) ? digest(value) : null;
    // If a caller is committing an account action, hold its binding until that
    // transaction finishes. An unlink on another replica then takes its turn.
    const lock = postgres && db.isTransaction ? ' FOR SHARE OF b' : '';
    const row = sessionId && sql(`SELECT b.user_id FROM mini_sessions s
        JOIN mini_bindings b ON b.user_id=s.user_id WHERE s.token_hash=? AND b.app_id=? AND s.expires_at>?` + lock)
      .get(sessionId, appId, now());
    if (!row) throw error(401, '小程序登录已过期，请重新登录。');
    return { userId: Number(row.user_id), sessionId };
  }
  function unlink(userId, authorize) {
    return tx(() => {
      authorize?.();
      const linked = sql('SELECT openid FROM mini_bindings WHERE user_id=? AND app_id=?').get(userId, appId);
      if (linked) {
        sql('DELETE FROM mini_tickets WHERE app_id=? AND openid=?').run(appId, linked.openid);
        sql('DELETE FROM mini_bindings WHERE user_id=? AND app_id=?').run(userId, appId);
      }
      sql('DELETE FROM mini_codes WHERE user_id=?').run(userId);
      return { linked: false };
    });
  }
  function schedules(userId) {
    return getSchedules(userId).filter(w => typeof w.id === 'string' && w.round != null && Number.isSafeInteger(w.due))
      .sort((a, b) => a.due - b.due);
  }
  function preferences(userId) {
    return sql('SELECT p.* FROM mini_reminder_prefs p JOIN mini_bindings b ON b.user_id=p.user_id WHERE b.app_id=? AND p.user_id=?')
      .get(appId, userId);
  }
  function jobFor(userId) {
    return sql('SELECT r.* FROM mini_reminders r JOIN mini_bindings b ON b.user_id=r.user_id WHERE b.app_id=? AND r.user_id=?')
      .get(appId, userId);
  }
  function validZone(timezone) {
    try {
      if (typeof timezone !== 'string' || timezone.length > 80) throw new Error();
      new Intl.DateTimeFormat('en', { timeZone: timezone });
    } catch { throw error(400, '提醒时区无效。'); }
    return timezone;
  }
  function reminder(userId) {
    const pref = preferences(userId);
    const row = jobFor(userId);
    const upcoming = schedules(userId).find(w => w.due > now());
    const enabled = Boolean(pref?.enabled);
    const hasGrant = Boolean(enabled && pref.has_grant && templateId && pref.template_id === templateId && pref.grant_mode === mode);
    return {
      enabled, hasGrant, mode, templateId, timezone: pref?.timezone || 'Asia/Shanghai',
      status: row?.state || (enabled ? hasGrant ? 'waiting' : 'needs_authorization' : 'none'),
      at: row?.at_ms ?? null, count: row ? JSON.parse(row.words).length : 0, nextDueAt: upcoming?.due ?? null,
    };
  }
  function savePreference(userId, enabled, granted, zone, cursor) {
    if (!binding(userId).linked) throw error(401, '需要先完成账号配对。');
    sql(`INSERT INTO mini_reminder_prefs(user_id,enabled,has_grant,template_id,grant_mode,timezone,cursor_ms,checked_at)
      VALUES(?,?,?,?,?,?,?,0) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,has_grant=excluded.has_grant,
      template_id=excluded.template_id,grant_mode=excluded.grant_mode,timezone=excluded.timezone,
      cursor_ms=excluded.cursor_ms,checked_at=0`).run(userId, Number(enabled), Number(granted), templateId, mode, zone, cursor);
  }
  function reschedule(userId, pref, options = {}) {
    if (!pref?.enabled || !pref.has_grant) return;
    if (pref.template_id !== templateId || pref.grant_mode !== mode) {
      sql('UPDATE mini_reminder_prefs SET has_grant=0 WHERE user_id=?').run(userId);
      sql("UPDATE mini_reminders SET state='needs_authorization' WHERE user_id=? AND state='scheduled'").run(userId);
      return;
    }
    const ts = now();
    sql('UPDATE mini_reminder_prefs SET checked_at=? WHERE user_id=?').run(ts, userId);
    const old = jobFor(userId);
    // Preserve a batch already ready to dispatch. A later desktop edit must
    // not advance this single grant past an unprocessed due reminder.
    if (old?.state === 'sending' || (old?.state === 'scheduled' && old.at_ms <= ts)) return;
    const candidates = schedules(userId).filter(w => w.due > pref.cursor_ms);
    const closest = candidates[0]?.due ?? null;
    if (options.expectedDueAt != null && options.expectedDueAt !== closest) throw error(409, '复习计划已变化，请刷新后重试。');
    const at = options.at ?? closest;
    if (at != null && (!Number.isSafeInteger(at) || !closest || at < closest || at > 8640000000000000)) {
      throw error(400, '提醒时间须在下一批词到期之后或同时。');
    }
    if (!closest) {
      if (old?.state === 'scheduled') sql("DELETE FROM mini_reminders WHERE user_id=? AND state='scheduled'").run(userId);
      return;
    }
    const words = JSON.stringify(candidates.filter(w => w.due <= at).map(({ id, round, due }) => ({ id, round, due }))
      .sort((a, b) => a.id.localeCompare(b.id)));
    if (old?.state === 'scheduled' && old.at_ms === at && old.words === words && old.timezone === pref.timezone) return;
    sql(`INSERT INTO mini_reminders(user_id,job_id,template_id,at_ms,timezone,words,state,attempt_at,attempts)
      VALUES(?,?,?,?,?,?,'scheduled',?,0)
      ON CONFLICT(user_id) DO UPDATE SET job_id=excluded.job_id,template_id=excluded.template_id,
      at_ms=excluded.at_ms,timezone=excluded.timezone,words=excluded.words,state='scheduled',
      attempt_at=excluded.attempt_at,attempts=0`).run(userId, token(), templateId, at, pref.timezone, words, at);
  }
  function afterLearning(userId) {
    return tx(() => reschedule(userId, preferences(userId)));
  }
  function reserveReminder(userId, options, authorize) {
    if (!templateId) throw error(503, '尚未配置可用的微信订阅消息模板。');
    if (options?.templateId !== templateId || options?.accepted !== true) throw error(400, '请先在微信授权复习提醒。');
    return tx(() => {
      authorize?.();
      const pref = preferences(userId);
      const old = jobFor(userId);
      if (old?.state === 'sending') throw error(409, '上一条提醒正在发送。');
      const hadGrant = pref?.has_grant && pref.template_id === templateId && pref.grant_mode === mode;
      const cursor = hadGrant ? pref.cursor_ms : now();
      savePreference(userId, true, true, validZone(options.timezone || pref?.timezone || 'Asia/Shanghai'), cursor);
      if (old && old.state !== 'scheduled') sql('DELETE FROM mini_reminders WHERE user_id=?').run(userId);
      reschedule(userId, preferences(userId), options);
      return reminder(userId);
    });
  }
  function setReminderEnabled(userId, enabled, zone, authorize) {
    if (typeof enabled !== 'boolean') throw error(400, '提醒设置无效。');
    return tx(() => {
      authorize?.();
      const pref = preferences(userId);
      const old = jobFor(userId);
      if (old?.state === 'sending' && !enabled) throw error(409, '微信发送已开始，请稍后查看结果。');
      const hasGrant = Boolean(enabled && pref?.has_grant && pref.template_id === templateId && pref.grant_mode === mode);
      savePreference(userId, enabled, hasGrant, validZone(zone || pref?.timezone || 'Asia/Shanghai'), hasGrant ? pref.cursor_ms : now());
      if (!enabled && old) sql("UPDATE mini_reminders SET state='cancelled' WHERE user_id=?").run(userId);
      if (enabled && old?.state === 'cancelled') sql('DELETE FROM mini_reminders WHERE user_id=?').run(userId);
      if (hasGrant) reschedule(userId, preferences(userId));
      return reminder(userId);
    });
  }
  function cancelReminder(userId, authorize) { return setReminderEnabled(userId, false, undefined, authorize); }

  // Do not replay a request after losing its response. The WeChat send endpoint
  // has no idempotency key, so a crash in flight leaves delivery unconfirmed.
  function settle(job, previous, state, attemptAt = now()) {
    return sql('UPDATE mini_reminders SET state=?,attempt_at=? WHERE job_id=? AND user_id=? AND state=?')
      .run(state, attemptAt, job.job_id, job.user_id, previous).changes;
  }
  function matches(job) {
    const scheduled = new Map(JSON.parse(job.words).map(w => [w.id, w]));
    return schedules(Number(job.user_id)).filter(w => {
      const booked = scheduled.get(w.id);
      return booked && w.due === booked.due && w.round === booked.round && w.due <= now();
    }).length;
  }
  function finish(job, previous, state) {
    return tx(() => {
      if (!settle(job, previous, state)) return;
      if (state === 'completed' || (state === 'sent' && mode === 'longterm')) {
        sql('UPDATE mini_reminder_prefs SET cursor_ms=?,checked_at=0 WHERE user_id=?').run(job.at_ms, job.user_id);
      } else {
        sql('UPDATE mini_reminder_prefs SET has_grant=0,checked_at=0 WHERE user_id=?').run(job.user_id);
      }
    });
  }
  function retry(job, previous) {
    if (job.attempts >= 5) return finish(job, previous, 'failed');
    const wait = Math.min(15 * MINUTE, MINUTE * 2 ** job.attempts);
    sql("UPDATE mini_reminders SET state='scheduled',attempt_at=?,attempts=attempts+1 WHERE user_id=? AND job_id=? AND state=? AND attempts=?")
      .run(now() + wait, job.user_id, job.job_id, previous, job.attempts);
  }
  async function dispatch(job) {
    if (job.template_id !== templateId) { finish(job, 'scheduled', 'needs_authorization'); return; }
    if (!matches(job)) { finish(job, 'scheduled', 'completed'); return; }
    let access;
    try { access = await client.accessToken(); }
    catch { retry(job, 'scheduled'); return; }

    // No asynchronous work between this final account/round check and the
    // outbound send. Concurrent replicas claim the same row exactly once.
    const body = tx(() => {
      if (postgres) sql('SELECT id FROM users WHERE id=? FOR UPDATE').get(job.user_id);
      const fresh = sql(`SELECT b.openid FROM mini_bindings b JOIN mini_reminders r ON b.user_id=r.user_id
        JOIN mini_reminder_prefs p ON p.user_id=b.user_id
        WHERE r.user_id=? AND b.app_id=? AND r.job_id=? AND r.state='scheduled' AND r.attempt_at<=?
        AND p.enabled=1 AND p.has_grant=1 AND p.template_id=? AND p.grant_mode=?`)
        .get(job.user_id, appId, job.job_id, now(), templateId, mode);
      if (!fresh) return null;
      const count = matches(job);
      if (!count) {
        if (settle(job, 'scheduled', 'completed')) sql('UPDATE mini_reminder_prefs SET cursor_ms=?,checked_at=0 WHERE user_id=?').run(job.at_ms, job.user_id);
        return null;
      }
      if (!settle(job, 'scheduled', 'sending')) return null;
      return { touser: fresh.openid, template_id: job.template_id, page: 'pages/today/index?from=reminder',
        data: templateData(fields, count, job.at_ms, job.timezone), lang: 'zh_CN', miniprogram_state: 'formal' };
    });
    if (!body) return;
    let code;
    try { code = await client.send(access, body); }
    catch { finish(job, 'sending', 'unknown'); return; }
    if (code === 0) finish(job, 'sending', 'sent');
    else if (code === 43101) finish(job, 'sending', 'needs_authorization');
    else if ([40001, 40014, 42001, -1, 43108, 45009].includes(code)) {
      if ([40001, 40014, 42001].includes(code)) client.invalidate();
      retry(job, 'sending');
    } else finish(job, 'sending', 'failed');
  }
  // The database sends the private random ID of exactly one reservation. The
  // public route checks that account's primary key; it never invokes runDue.
  const wakeInFlight = new Map();
  async function wakeReminder(account, authorization) {
    if (devtools || !templateId) throw error(404, '没有这个接口。');
    const userId = Number(account);
    const cap = typeof authorization === 'string' && /^WordPaper-Job ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!cap || typeof account !== 'string' || String(userId) !== account || !Number.isSafeInteger(userId) || userId < 1) {
      throw error(401, '任务凭证无效。');
    }
    const ts = now();
    const job = sql(`SELECT r.* FROM mini_reminders r JOIN mini_bindings b ON b.user_id=r.user_id
      JOIN mini_reminder_prefs p ON p.user_id=r.user_id WHERE r.user_id=? AND r.job_id=? AND b.app_id=?
      AND r.state='scheduled' AND r.at_ms<=? AND r.attempt_at<=? AND r.template_id=?
      AND p.enabled=1 AND p.has_grant=1 AND p.template_id=r.template_id AND p.grant_mode=?`)
      .get(userId, cap[1], appId, ts, ts, templateId, mode);
    if (!job) return;
    if (!wakeInFlight.has(job.job_id)) {
      const work = dispatch(job).finally(() => wakeInFlight.delete(job.job_id));
      wakeInFlight.set(job.job_id, work);
    }
    await wakeInFlight.get(job.job_id);
  }
  async function runDue() {
    if (!templateId) return;
    const ts = now();
    const interrupted = sql(`SELECT r.* FROM mini_reminders r JOIN mini_bindings b ON b.user_id=r.user_id
      WHERE r.state='sending' AND r.attempt_at<=? AND b.app_id=?`).all(ts - 2 * MINUTE, appId);
    for (const job of interrupted) finish(job, 'sending', 'unknown');
    // Include desktop changes, even if no mini-program client is open. Rotate
    // through enabled accounts so a large deployment does not starve later rows.
    const active = sql(`SELECT p.user_id FROM mini_reminder_prefs p JOIN mini_bindings b ON b.user_id=p.user_id
      WHERE b.app_id=? AND p.enabled=1 AND p.has_grant=1 ORDER BY p.checked_at,p.user_id LIMIT 200`).all(appId);
    for (const account of active) {
      try { afterLearning(Number(account.user_id)); }
      catch {
        sql('UPDATE mini_reminder_prefs SET checked_at=? WHERE user_id=?').run(ts, account.user_id);
        console.error('[wechat-mini] 暂时无法读取复习计划。');
      }
    }
    const jobs = sql(`SELECT r.* FROM mini_reminders r JOIN mini_bindings b ON r.user_id=b.user_id
      JOIN mini_reminder_prefs p ON p.user_id=b.user_id WHERE b.app_id=? AND p.enabled=1 AND p.has_grant=1
      AND r.state='scheduled' AND r.attempt_at<=? ORDER BY r.attempt_at LIMIT 40`).all(appId, ts);
    for (const job of jobs) {
      try { await dispatch(job); }
      catch { retry(job, 'scheduled'); }
    }
  }
  function startWorker() {
    if (!templateId) return () => {};
    let running = false;
    let stopped = false;
    async function tick() {
      if (running || stopped) return;
      running = true;
      try { cleanup(); await runDue(); }
      catch { console.error('[wechat-mini] 提醒调度暂时失败，将在下一轮检查。'); }
      finally { running = false; }
    }
    const interval = setInterval(tick, 30000);
    interval.unref();
    void tick();
    return () => { stopped = true; clearInterval(interval); };
  }
  return {
    config: () => ({ loginAvailable, devtools, templateId, mode }),
    binding, createPairCode, login, loginDevtools, previewPair, confirmPair, authenticate, unlink,
    reminder, reserveReminder, setReminderEnabled, cancelReminder, afterLearning, wakeReminder, runDue, startWorker,
  };
}
module.exports = { createWechatMini };
