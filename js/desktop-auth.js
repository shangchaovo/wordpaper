(function () {
  'use strict';
  const section = document.querySelector('#desktop-sync');
  if (!section) return;
  const origin = document.querySelector('#desktop-origin');
  const status = document.querySelector('#desktop-sync-status');
  const pending = document.querySelector('#desktop-sync-pending');
  const link = document.querySelector('#desktop-sync-open');
  const address = document.querySelector('#desktop-sync-address');
  const buttons = Array.from(section.querySelectorAll('[data-cloud-provider]'));
  const localGoogle = document.querySelector('#desktop-local-google');
  const localSignIn = document.querySelector('#desktop-local-google-sign-in');
  const localStatus = document.querySelector('#desktop-local-google-status');
  const localCancel = document.querySelector('#desktop-local-google-cancel');
  let timer = null, csrfToken = '', generation = 0;
  let localAttempt = null;

  function disableSignInButtons(disabled) {
    buttons.forEach(button => { button.disabled = disabled; });
    localSignIn.disabled = disabled;
  }

  async function openAuthorization(id) {
    if (!window.WordPaperDesktop) { window.open(link.href, '_blank', 'noopener'); return; }
    try {
      await post('/api/desktop/open');
    } catch {
      if (id !== generation) return;
      address.value = link.href;
      address.hidden = false;
      status.textContent = '请将授权地址复制到系统浏览器，核对连接码后继续。';
      address.select();
    }
  }
  async function post(route, body) {
    const response = await fetch(route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body || {}),
    }).catch(() => null);
    const data = await response?.json().catch(() => null);
    if (!response?.ok || !data) throw new Error(data?.error || '桌面连接暂时不可用。请稍后再试。');
    return data;
  }
  function stop() {
    generation += 1; clearTimeout(timer); timer = null;
    disableSignInButtons(false);
    pending.hidden = true;
    address.hidden = true;
  }
  async function poll(id) {
    try {
      const result = await post('/api/desktop/poll');
      if (id !== generation) return;
      if (result.pending) { timer = setTimeout(() => poll(id), 2500); return; }
      status.textContent = '连接成功，正在打开同步工作区…';
      location.replace('/');
    } catch (error) {
      if (id !== generation) return;
      stop(); status.textContent = error.message;
    }
  }
  buttons.forEach(button => button.addEventListener('click', async function () {
    if (!origin.reportValidity()) return;
    stop(); const id = generation;
    disableSignInButtons(true);
    status.textContent = '正在连接账号服务器…';
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      csrfToken = response.ok ? (await response.json()).csrfToken : '';
      const result = await post('/api/desktop/start', { url: origin.value.trim(), provider: button.dataset.cloudProvider });
      if (id !== generation) return;
      try { localStorage.setItem('wp:sync-origin', origin.value.trim()); } catch {}
      document.querySelector('#desktop-sync-code').textContent = result.userCode;
      link.href = result.verificationUrl; pending.hidden = false;
      status.textContent = '等待浏览器授权。请核对账号与连接码，然后允许这台 App 同步。';
      timer = setTimeout(() => poll(id), 2500);
      await openAuthorization(id);
    } catch (error) { if (id === generation) { stop(); status.textContent = error.message; } }
  }));
  localSignIn.addEventListener('click', async () => {
    localAttempt = new AbortController();
    disableSignInButtons(true);
    localCancel.hidden = false;
    localCancel.disabled = false;
    localStatus.hidden = false;
    localStatus.textContent = '正在打开系统浏览器…';
    try {
      const completed = await window.LocalGoogle.authorize('login', '', localAttempt.signal, () => {
        localStatus.textContent = '请在系统浏览器完成 Google 授权。完成后 App 将打开本机工作区。';
      });
      if (completed) {
        localStatus.textContent = '登录成功，正在打开本机工作区…';
        location.replace('/');
      } else localStatus.textContent = '已取消 Google 登录。';
    } catch (error) {
      localStatus.textContent = error.message;
    } finally {
      localAttempt = null;
      localCancel.hidden = true;
      disableSignInButtons(false);
    }
  });
  localCancel.addEventListener('click', () => {
    localCancel.disabled = true;
    localStatus.textContent = '正在取消授权…';
    localAttempt?.abort();
  });
  link.addEventListener('click', event => { if (window.WordPaperDesktop) { event.preventDefault(); openAuthorization(generation); } });
  document.querySelector('#desktop-sync-cancel').addEventListener('click', async () => {
    stop();
    try { const result = await post('/api/desktop/cancel'); if (result.connected) { location.replace('/'); return; } }
    catch (error) { status.textContent = error.message; return; }
    status.textContent = '已取消连接，可以重新发起。';
  });
  fetch('/api/auth/providers', { cache: 'no-store' }).then(response => response.json()).then(data => {
    if (!data.pairingAllowed) return;
    section.hidden = false;
    const requestedSync = new URLSearchParams(location.search).has('sync');
    localGoogle.hidden = !data.localGoogle?.enabled || Boolean(data.paired) || requestedSync;
    section.open = localGoogle.hidden;
    try { origin.value = data.paired?.url || localStorage.getItem('wp:sync-origin') || ''; } catch {}
    if (window.WordPaperDesktop) {
      document.querySelector('.provider-stack').hidden = true;
      document.querySelector('#auth-intro-help').textContent = '继续使用这台 Mac 上的词库和学习进度。';
    }
  }).catch(() => {});
  window.addEventListener('pagehide', () => { localAttempt?.abort(); stop(); });
})();
