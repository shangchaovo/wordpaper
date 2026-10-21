/* store.js — authenticated server persistence with a per-user local cache. */
(function () {
  'use strict';
  const NS = 'wp:';
  const STATE_KEYS = [
    'settings', 'uiTheme', 'customWords', 'knownWords', 'reminders', 'engine',
    'review', 'seeded', 'moduleLayout', 'hiddenModules', 'petMemoryCursor', 'petSyncCursor', 'dragHint',
  ];
  let cache = {};
  let revisions = {};
  let pending = {};
  let currentUser = null;
  let csrfToken = '';
  let userPrefix = '';
  let availableLegacy = {};
  let localMode = false;   // 静态托管本地模式:只写 localStorage,无任何同步
  const syncing = new Map();
  const timers = new Map();

  const DEFAULT_SETTINGS = {
    uiTheme: 'liquid',         // 'anime' | 'editorial' | 'liquid' | 'darkliquid'（网站界面皮肤）
    library: 'ielts',          // see LIBRARIES in app.js (chuzhong/gaozhong/cet4/.../custom)
    layout: 'group',           // 唯一版式;旧数据里的 'poster' 会自动落到 group 渲染
    size: 'phone-1080x2400',   // see SIZES in app.js
    theme: 'pearl',            // match the default Liquid interface with a clean glass wallpaper
    bgPattern: 'none',         // 'none'|'soft'|'dots'|'grid'|'diag'|'waves'|'blobs'
    wordsPerGroup: 6,          // words shown in 'group' layout (multi-col wraps 7+)
    wordCols: 0,               // 0 = 自动列数（按词数+宽高比），1-3 = 强制列数
    order: 'sequential',       // 'sequential' | 'random'
    // typography
    fontScale: 1.0,            // 0.7 – 1.7 multiplier on word sizes
    fontWeight: 700,           // word weight 400–800
    fontStyle: 'yuan',         // 'hei'|'song'|'kai'|'yuan'|'heiti' (system font stacks)
    inkOverride: '',           // '' = use theme.ink; else a css color for ALL text
    letterSpacing: 0,          // px letter spacing on the word
    lineHeight: 1.0,           // multiplier on row/line gaps
    // background
    bgImage: null,             // dataURL string of a user-uploaded photo (or null)
    bgScrim: 0.22,             // 0..1 light overlay over bgImage for legibility
    bgImagePos: { x: 0, y: 0 },// -1..1 cover-crop offset; drag empty preview area to adjust
    bgImageZoom: 1.14,         // keep a small safe crop so photos can pan on both axes
    // layout anchors + free nudge offsets (fractions of W/H, -1..1)
    anchorWords: 'center',     // 'top'|'center'|'bottom'
    anchorReminders: 'bottom', // 'top'|'center'|'bottom'
    offWords: { x: 0, y: 0 },  // drag nudge, fraction of W/H
    offReminders: { x: 0, y: 0 },
    // refresh
    autoRefreshDaily: true,    // new group each calendar day
    rotateEnabled: false,      // timed rotation (live mode)
    rotateMinutes: 30,         // rotation interval
    cycleEnabled: false,       // whole-page cycling words<->reminders in live mode
    cycleSeconds: 120,         // page cycle interval
    showPhonetic: true,
    showExample: true,
    showReminders: true,
    srsEnabled: true,          // 艾宾浩斯记忆轮换：到期的旧单词组混回壁纸复习
    petWallpaperSync: true,    // 壁纸/预览与小词灵当前页词同步（总闸，可关）
    antiTouch: true,           // require long-press to interact (live mode)
    antiTouchMs: 1200,         // long-press duration to unlock
    custom: {                  // custom text overlay (free-floating blocks)
      enabled: false,
      title: '',
      footer: '',
      pos: {},                 // { title:{x,y,scale}, footer:{x,y,scale} } fractions 0..1
    },
  };

  function parseJSON(raw, fallback) {
    try {
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (_) { return fallback; }
  }

  function localGet(storageKey, fallback) {
    try { return parseJSON(localStorage.getItem(storageKey), fallback); }
    catch (_) { return fallback; }
  }

  function emit(name, detail) {
    try { window.dispatchEvent(new CustomEvent(name, { detail: detail || {} })); } catch (_) {}
  }

  function localSet(storageKey, value) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
      return true;
    } catch (error) {
      emit('wordpaper:storage-warning', { message: '浏览器本地缓存空间不足；数据仍会尝试保存到账号。', error: String(error && error.message || error) });
      return false;
    }
  }

  function sameJSON(a, b) {
    try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; }
  }

  function read(key, fallback) {
    return Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : fallback;
  }

  function persistPending() {
    if (userPrefix) localSet(userPrefix + 'syncPending', pending);
  }

  function scheduleSync(key, delay) {
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(function () { syncKey(key); }, delay == null ? 100 : delay));
  }

  async function syncKey(key) {
    if (!pending[key] || syncing.has(key) || !csrfToken) return true;
    const snapshot = pending[key];
    const serialized = JSON.stringify(snapshot.value);
    emit('wordpaper:sync-status', { state: 'saving' });

    const task = fetch('/api/state/' + encodeURIComponent(key), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ value: snapshot.value, expectedRevision: snapshot.expectedRevision }),
    }).then(async function (response) {
      const body = await response.json().catch(function () { return {}; });
      if (response.status === 401) {
        location.assign('/login.html');
        throw new Error('登录已过期');
      }
      if (response.status === 409) {
        revisions[key] = Number(body.revision) || 0;
        if (sameJSON(body.value, snapshot.value)) {
          const latest = pending[key];
          if (latest && JSON.stringify(latest.value) === serialized) delete pending[key];
          else if (latest) { latest.expectedRevision = revisions[key]; scheduleSync(key, 0); }
          persistPending();
          emit('wordpaper:sync-status', { state: Object.keys(pending).length ? 'saving' : 'saved' });
          return true;
        }
        localSet(userPrefix + 'conflict:' + key, { value: snapshot.value, at: Date.now(), serverRevision: revisions[key] });
        delete pending[key];
        persistPending();
        emit('wordpaper:sync-status', { state: 'conflict', message: '另一台设备已修改这份数据；服务器版本未被覆盖，本机冲突副本已保留。请刷新后再操作。' });
        return false;
      }
      if (!response.ok) throw new Error(body.error || '保存失败');

      revisions[key] = Number(body.revision) || snapshot.expectedRevision + 1;
      const latest = pending[key];
      if (latest && JSON.stringify(latest.value) === serialized && latest.expectedRevision === snapshot.expectedRevision) {
        delete pending[key];
      } else if (latest) {
        latest.expectedRevision = revisions[key];
        scheduleSync(key, 0);
      }
      persistPending();
      emit('wordpaper:sync-status', { state: Object.keys(pending).length ? 'saving' : 'saved' });
      return true;
    }).catch(function (error) {
      emit('wordpaper:sync-status', { state: 'error', message: '账号数据暂未保存：' + error.message });
      scheduleSync(key, 3000);
      return false;
    }).finally(function () {
      syncing.delete(key);
    });
    syncing.set(key, task);
    return task;
  }

  async function flush() {
    flushLocal();
    const keys = Object.keys(pending);
    if (!keys.length) return true;
    const results = await Promise.all(keys.map(syncKey));
    return results.every(Boolean) && Object.keys(pending).length === 0;
  }

  /* settings 里带着背景照片的 dataURL（可达数 MB）；滑块每动一格都同步序列化 + 写
   * localStorage 会把主线程卡住。内存缓存立即生效，本地落盘合并到 250ms 一次，
   * 页面隐藏 / 关闭 / 登出前强制落盘。 */
  const localDirty = new Set();
  let pendingDirty = false;
  let localTimer = 0;
  function scheduleLocalFlush() {
    if (!localTimer) localTimer = setTimeout(flushLocal, 250);
  }
  function flushLocal() {
    clearTimeout(localTimer);
    localTimer = 0;
    if (userPrefix) localDirty.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(cache, key)) localSet(userPrefix + key, cache[key]);
    });
    localDirty.clear();
    if (pendingDirty) { pendingDirty = false; persistPending(); }
  }
  window.addEventListener('pagehide', flushLocal);
  document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') flushLocal(); });

  function queueWrite(key, value) {
    if (!STATE_KEYS.includes(key)) return false;
    cache[key] = value;
    if (userPrefix) localDirty.add(key);
    if (key === 'uiTheme') localSet(NS + 'uiTheme', value); // harmless pre-paint preference, shared only on this browser
    if (currentUser) {
      if (!pending[key]) pending[key] = { value: value, expectedRevision: Number(revisions[key]) || 0 };
      else pending[key].value = value;
      pendingDirty = true;
      scheduleSync(key);
    }
    scheduleLocalFlush();
    return !!userPrefix;
  }

  function legacyState() {
    const state = {};
    STATE_KEYS.forEach(function (key) {
      const raw = localStorage.getItem(NS + key);
      if (raw != null) state[key] = parseJSON(raw, null);
    });
    return state;
  }

  async function init() {
    // 纯静态托管(无后端)时 /api/session 不存在:静态托管的 SPA 兜底会返回
    // 200 + text/html 的首页。按 content-type 区分真假后端,非 JSON 即进入
    // 「本地模式」:只读写 localStorage(wp: 命名空间,与旧版本地数据兼容),
    // 不做账号同步,不跳转登录页。
    let sessionResponse = null;
    try {
      sessionResponse = await fetch('/api/session', { cache: 'no-store' });
    } catch (e) {
      sessionResponse = null;
    }
    if (sessionResponse && sessionResponse.status === 401) {
      location.assign('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
      throw new Error('authentication required');
    }
    const sessionCT = sessionResponse ? String(sessionResponse.headers.get('content-type') || '') : '';
    if (!sessionResponse || !sessionResponse.ok || sessionCT.indexOf('application/json') === -1) {
      userPrefix = NS;
      cache = legacyState();
      localMode = true;
      return null;
    }
    const session = await sessionResponse.json();
    currentUser = session.user;
    csrfToken = session.csrfToken;
    if (session.update && session.update.latest) {
      emit('wordpaper:storage-warning', { message: 'WordPaper 有新版本 v' + session.update.latest + ':重新下载安装即可,数据不受影响' });
    }
    if (session.mirrored && session.upstream && session.upstream !== 'ok') {
      emit('wordpaper:storage-warning', { message: session.upstream === 'reauth'
        ? '主账号连接已过期:退出登录后重新验证即可恢复同步(本机数据不丢)'
        : '暂时连不上主账号:改动已存本机,恢复后自动补同步' });
    }
    userPrefix = NS + 'user:' + currentUser.id + ':';

    const stateResponse = await fetch('/api/state', { cache: 'no-store' });
    if (!stateResponse.ok) throw new Error('无法读取账号数据');
    const remote = await stateResponse.json();
    cache = Object.assign({}, remote.state || {});
    revisions = Object.assign({}, remote.revisions || {});
    pending = localGet(userPrefix + 'syncPending', {});
    if (!pending || typeof pending !== 'object' || Array.isArray(pending)) pending = {};

    const localUserState = {};
    STATE_KEYS.forEach(function (key) {
      const value = localGet(userPrefix + key, undefined);
      if (value !== undefined) localUserState[key] = value;
    });
    const unscopedLegacy = !localStorage.getItem(NS + 'legacyMigratedTo') ? legacyState() : {};
    availableLegacy = Object.keys(unscopedLegacy).some(function (key) { return key !== 'uiTheme'; }) ? unscopedLegacy : {};

    Object.keys(pending).forEach(function (key) {
      const entry = pending[key];
      if (!STATE_KEYS.includes(key) || !entry || !Object.prototype.hasOwnProperty.call(entry, 'value')) { delete pending[key]; return; }
      if ((Number(revisions[key]) || 0) > Number(entry.expectedRevision || 0) && sameJSON(cache[key], entry.value)) {
        delete pending[key];
        return;
      }
      cache[key] = entry.value;
    });

    let importingLegacy = false;
    if (!Object.keys(cache).length && !Object.keys(pending).length) {
      const source = Object.keys(localUserState).length ? localUserState
        : (session.allowLegacyImport ? availableLegacy : {});
      importingLegacy = Object.keys(source).length > 0 && source !== localUserState;
      Object.keys(source).forEach(function (key) {
        cache[key] = source[key];
        pending[key] = { value: source[key], expectedRevision: 0 };
      });
    }

    STATE_KEYS.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(cache, key)) localSet(userPrefix + key, cache[key]);
    });
    persistPending();

    if (Object.keys(pending).length) {
      emit('wordpaper:sync-status', { state: 'saving', message: importingLegacy ? '正在把本机旧数据迁入账号…' : '' });
      const saved = await flush();
      if (saved && importingLegacy) {
        localStorage.setItem(NS + 'legacyMigratedTo', String(currentUser.id));
        STATE_KEYS.forEach(function (key) { if (key !== 'uiTheme') localStorage.removeItem(NS + key); });
        availableLegacy = {};
        emit('wordpaper:sync-status', { state: 'saved', message: '本机旧数据已迁入当前账号' });
      }
    }

    if (!importingLegacy && Object.keys(availableLegacy).length) {
      emit('wordpaper:legacy-available', { keys: Object.keys(availableLegacy) });
    }

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
    window.addEventListener('pagehide', flush);
    return currentUser;
  }

  async function importLegacy() {
    if (!currentUser || !Object.keys(availableLegacy).length) return false;
    Object.keys(availableLegacy).forEach(function (key) {
      const value = availableLegacy[key];
      cache[key] = value;
      localSet(userPrefix + key, value);
      pending[key] = { value: value, expectedRevision: Number(revisions[key]) || 0 };
    });
    persistPending();
    const saved = await flush();
    if (!saved) return false;
    localStorage.setItem(NS + 'legacyMigratedTo', String(currentUser.id));
    STATE_KEYS.forEach(function (key) { if (key !== 'uiTheme') localStorage.removeItem(NS + key); });
    availableLegacy = {};
    return true;
  }

  function write(key, value) {
    return queueWrite(key, value);
  }

  const Store = {
    init,
    importLegacy,
    flush,
    currentUser() { return currentUser; },
    async logout() {
      await flush();
      await fetch('/api/session', { method: 'DELETE', headers: { 'X-CSRF-Token': csrfToken } }).catch(function () {});
      cache = {}; revisions = {}; pending = {}; currentUser = null; csrfToken = ''; userPrefix = '';
      location.assign('/login.html');
    },
    getSettings() {
      const raw = read('settings', {});
      const s = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      // Merge over defaults so new keys appear on upgrade.
      const merged = Object.assign({}, DEFAULT_SETTINGS, s);
      merged.custom = Object.assign({}, DEFAULT_SETTINGS.custom, s.custom || {});
      merged.custom.pos = Object.assign({}, (s.custom && s.custom.pos) || {});
      merged.offWords = Object.assign({}, DEFAULT_SETTINGS.offWords, s.offWords || {});
      merged.offReminders = Object.assign({}, DEFAULT_SETTINGS.offReminders, s.offReminders || {});
      merged.bgImagePos = Object.assign({}, DEFAULT_SETTINGS.bgImagePos, s.bgImagePos || {});
      merged.bgImageZoom = Math.max(1, Number(s.bgImageZoom) || DEFAULT_SETTINGS.bgImageZoom);
      const mirroredTheme = read('uiTheme', null);
      merged.uiTheme = ['anime', 'editorial', 'liquid', 'darkliquid'].includes(mirroredTheme)
        ? mirroredTheme
        : (['anime', 'editorial', 'liquid', 'darkliquid'].includes(merged.uiTheme) ? merged.uiTheme : DEFAULT_SETTINGS.uiTheme);
      if (!['anime', 'editorial', 'liquid', 'darkliquid'].includes(mirroredTheme)) write('uiTheme', merged.uiTheme);
      return merged;
    },
    saveSettings(settings) {
      write('uiTheme', ['anime', 'editorial', 'liquid', 'darkliquid'].includes(settings.uiTheme) ? settings.uiTheme : DEFAULT_SETTINGS.uiTheme);
      write('settings', settings);
    },
    setUITheme(theme) {
      const value = ['anime', 'editorial', 'liquid', 'darkliquid'].includes(theme) ? theme : DEFAULT_SETTINGS.uiTheme;
      write('uiTheme', value);
      return value;
    },

    // Custom / imported words (user's own library). Array of word objects.
    getCustomWords() {
      const w = read('customWords', []);
      return Array.isArray(w) ? w : [];
    },
    saveCustomWords(words) {
      write('customWords', words);
    },

    // First-pass screening: each library owns a set of words the learner says
    // they already know. These words are excluded from future daily groups.
    getKnownWords(library) {
      const all = read('knownWords', {});
      const values = all && Array.isArray(all[library]) ? all[library] : [];
      return new Set(values);
    },
    setKnownWord(library, key, known) {
      const all = read('knownWords', {});
      const set = new Set(Array.isArray(all[library]) ? all[library] : []);
      if (known) set.add(key); else set.delete(key);
      all[library] = Array.from(set);
      write('knownWords', all);
      return set;
    },
    setKnownWords(library, keys, known) {
      const all = read('knownWords', {});
      const set = new Set(Array.isArray(all[library]) ? all[library] : []);
      keys.forEach(function (key) { if (known) set.add(key); else set.delete(key); });
      all[library] = Array.from(set);
      write('knownWords', all);
      return set;
    },
    clearKnownWords(library) {
      const all = read('knownWords', {});
      delete all[library]; write('knownWords', all);
    },

    // Reminders for "today". Array of {id,text,time?,done?,kind}
    getReminders() {
      const r = read('reminders', []);
      return Array.isArray(r) ? r : [];
    },
    saveReminders(list) {
      write('reminders', list);
    },

    // Rotation/refresh engine state (last date served, cursor position, etc.)
    getEngine() {
      return read('engine', {});
    },
    saveEngine(obj) {
      write('engine', obj);
    },

    // SRS (艾宾浩斯) review state, per library:
    // { [libId]: { cursor: n,
    //   groups: { [groupKey]: { words:[], learnedAt, stage, due, learnedCount, learnedLog:[] } } } }
    getReview() {
      const r = read('review', {});
      return (r && typeof r === 'object') ? r : {};
    },
    saveReview(obj) {
      write('review', obj);
    },

    getSeeded() {
      return read('seeded', false);
    },
    setSeeded() {
      write('seeded', true);
    },

    // Generic helpers for one-off keys (e.g. live-mode UI prefs)
    read,
    write,
    NS,
    isLocalMode() { return localMode; },
  };

  window.Store = Store;
})();
