/* The browser keeps guest state in IndexedDB. The Mac app owns its guest files. */
(function () {
  'use strict';
  const MODE_KEY = 'wp:guest:selected';
  const DATABASE = 'wordpaper-guest';
  const STORE = 'state';
  let database = null;
  let opening = null;
  const latestWrites = new Map();
  const failedWrites = new Map();
  let lastStatus = 'local';

  function nativeStorage() {
    return window.webkit?.messageHandlers?.wordPaperGuest;
  }

  function onGuestPage() {
    return /^\/guest\/?$/.test(location.pathname) || new URLSearchParams(location.search).get('guest') === '1';
  }

  function browserPreference() {
    try { return localStorage.getItem(MODE_KEY) === '1'; }
    catch { return false; }
  }

  function selected() {
    if (onGuestPage()) return true;
    const params = new URLSearchParams(location.search);
    if (nativeStorage() || params.get('account') === '1' || location.hash === '#account'
        || params.has('accountSuccess') || params.has('accountError')) return false;
    return browserPreference();
  }

  function url() {
    const staticSite = location.protocol === 'file:' || location.hostname === 'wordpaper.pages.dev'
      || (location.hostname === 'shangchaovo.github.io' && location.pathname.startsWith('/wordpaper/'));
    return staticSite ? 'index.html?guest=1' : '/guest';
  }

  function open() {
    if (database) return Promise.resolve(database);
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => { db.close(); database = null; };
          db.onclose = () => { if (database === db) database = null; };
          database = db;
          resolve(db);
        };
        request.onerror = () => reject(request.error);
      }).finally(() => { opening = null; });
    }
    return opening;
  }

  function transaction(db, mode, work) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error('本地保存中断'));
      work(tx.objectStore(STORE));
    });
  }

  async function enter() {
    try {
      const native = nativeStorage();
      if (native) { await native.postMessage({ op: 'select', active: true }); return; }
      const db = await open();
      // Exercise a write before advertising a persistent guest workspace.
      await transaction(db, 'readwrite', store => { store.put(1, '_probe'); store.delete('_probe'); });
      localStorage.setItem(MODE_KEY, '1');
    } catch {
      throw new Error('无法保存游客数据。请检查本地存储权限和设备的可用空间。');
    }
  }

  async function leave() {
    try {
      const native = nativeStorage();
      if (native) await native.postMessage({ op: 'select', active: false });
      else if (browserPreference()) localStorage.removeItem(MODE_KEY);
    } catch { throw new Error('无法切换登录方式，请检查本地存储权限。'); }
  }

  async function accountURL(destination = '/') {
    try {
      await leave();
      return destination;
    } catch {
      // An explicit account login still works when the guest preference is read-only.
      const account = new URL(destination, location.href);
      account.searchParams.set('account', '1');
      return account.pathname + account.search + account.hash;
    }
  }

  async function load() {
    const state = Object.create(null);
    try {
      const native = nativeStorage();
      if (native) return await native.postMessage({ op: 'read' });
      const db = await open();
      await transaction(db, 'readonly', store => {
        const request = store.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor) { state[cursor.key] = cursor.value; cursor.continue(); }
        };
      });
      return state;
    } catch {
      throw new Error('无法读取游客数据。请检查本地存储权限，然后重新打开 WordPaper。');
    }
  }

  function reportStatus() {
    const state = failedWrites.size ? 'error' : latestWrites.size ? 'saving' : 'local';
    if (lastStatus === state) return;
    lastStatus = state;
    window.dispatchEvent(new CustomEvent('wordpaper:sync-status', { detail: { state } }));
    if (state === 'error') window.dispatchEvent(new CustomEvent('wordpaper:storage-warning', {
      detail: { message: '游客数据尚未写入本机。请检查本地存储权限和可用空间，然后再试。' },
    }));
  }

  function write(key, value) {
    // Start the transaction during the edit, including edits immediately before
    // pagehide. IndexedDB serializes overlapping writes and clones the value.
    const save = db => transaction(db, 'readwrite', store => store.put(value, key));
    let operation;
    try {
      const native = nativeStorage();
      if (native) operation = native.postMessage({ op: 'write', key, value });
      else operation = database ? save(database) : open().then(save);
    } catch (error) { operation = Promise.reject(error); }
    failedWrites.delete(key);
    latestWrites.set(key, operation);
    reportStatus();
    operation.then(() => {
      if (latestWrites.get(key) !== operation) return;
      latestWrites.delete(key);
      reportStatus();
    }, () => {
      if (latestWrites.get(key) !== operation) return;
      latestWrites.delete(key);
      failedWrites.set(key, value);
      reportStatus();
    });
  }

  async function flush() {
    for (const [key, value] of [...failedWrites]) write(key, value);
    while (latestWrites.size) await Promise.allSettled([...latestWrites.values()]);
    return failedWrites.size === 0;
  }

  window.GuestWorkspace = { selected, onGuestPage, url, enter, leave, accountURL, load, write, flush };
})();
