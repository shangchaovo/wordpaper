(function () {
  'use strict';
  const section = document.querySelector('#desktop-sync');
  if (!section || (!location.search && !location.hash && GuestWorkspace.selected())) return;
  async function openAccount() {
    location.replace(await GuestWorkspace.accountURL());
  }
  const status = document.querySelector('#desktop-sync-status');
  const pending = document.querySelector('#desktop-sync-pending');
  const link = document.querySelector('#desktop-sync-open');
  const address = document.querySelector('#desktop-sync-address');
  const providerButtons = document.querySelectorAll('.provider-stack [data-provider]');
  const email = document.querySelector('#desktop-cloud-email');
  const resume = document.querySelector('#desktop-resume');
  const disconnect = document.querySelector('#desktop-legacy-disconnect');
  const consent = document.querySelector('#desktop-disconnect-dialog');
  const consentCopy = document.querySelector('#disconnect-copy');
  const localGoogle = document.querySelector('#desktop-local-google');
  const localSignIn = document.querySelector('#desktop-local-google-sign-in');
  const localStatus = document.querySelector('#desktop-local-google-status');
  const localCancel = document.querySelector('#desktop-local-google-cancel');
  let timer = null, csrfToken = '', generation = 0;
  let localAttempt = null;
  let legacy = null;
  let resumeDestination = '/';

  function forgetOldServerAddress() {
    try { localStorage.removeItem('wp:sync-origin'); } catch {}
  }

  function disableSignInButtons(disabled) {
    providerButtons.forEach(button => { if (!button.hidden) button.disabled = disabled; });
    email.disabled = disabled;
    resume.disabled = disabled;
    disconnect.disabled = disabled;
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
      forgetOldServerAddress();
      status.textContent = '连接成功，正在打开同步工作区…';
      await openAccount();
    } catch (error) {
      if (id !== generation) return;
      stop(); status.textContent = error.message;
    }
  }
  async function sessionToken() {
    const response = await fetch('/api/session', { cache: 'no-store' });
    return response.ok ? (await response.json()).csrfToken : '';
  }
  async function disconnectLegacy() {
    if (!legacy) return true;
    consentCopy.textContent = '旧连接账号为 ' + legacy.username + '。' +
      (legacy.pending ? '恢复副本会包含本机待同步的改动。' : '旧账号上的词库与学习记录会保留。');
    consent.returnValue = '';
    const choice = new Promise(resolve => consent.addEventListener('close', () => resolve(consent.returnValue), { once: true }));
    consent.showModal();
    if (await choice !== 'disconnect') return false;
    csrfToken = await sessionToken();
    await post('/api/desktop/disconnect-legacy', { confirmed: true });
    forgetOldServerAddress();
    legacy = null;
    disconnect.hidden = true;
    status.textContent = '旧连接已断开。恢复副本已保存到 WordPaper 数据目录的 recovery 文件夹。';
    return true;
  }
  disconnect.addEventListener('click', async () => {
    disableSignInButtons(true);
    try { await disconnectLegacy(); }
    catch (error) { status.textContent = error.message; }
    finally { disableSignInButtons(false); }
  });
  resume.addEventListener('click', async () => {
    disableSignInButtons(true);
    try {
      await post('/api/auth/resume');
      location.replace(await GuestWorkspace.accountURL(resumeDestination));
    } catch (error) { status.textContent = error.message; disableSignInButtons(false); }
  });
  async function start(provider) {
    stop(); const id = generation;
    disableSignInButtons(true);
    try {
      if (!await disconnectLegacy()) { stop(); return; }
      status.textContent = '正在连接 WordPaper 云账号…';
      csrfToken = await sessionToken();
      const result = await post('/api/desktop/start', { provider });
      if (id !== generation) return;
      document.querySelector('#desktop-sync-code').textContent = result.userCode;
      link.href = result.verificationUrl; pending.hidden = false;
      status.textContent = '请在系统浏览器选择账号，核对连接码并允许此 Mac 同步。';
      timer = setTimeout(() => poll(id), 2500);
      await openAuthorization(id);
    } catch (error) { if (id === generation) { stop(); status.textContent = error.message; } }
  }
  email.addEventListener('click', () => start('email'));
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
        await openAccount();
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
    try { const result = await post('/api/desktop/cancel'); if (result.connected) { await openAccount(); return; } }
    catch (error) { status.textContent = error.message; return; }
    status.textContent = '已取消连接，可以重新发起。';
  });
  function configure(data, destination) {
    resumeDestination = destination;
    const cloud = data.desktopCloud === true;
    section.hidden = !cloud && !data.paired;
    email.hidden = !cloud;
    legacy = cloud ? data.legacyConnection : null;
    disconnect.hidden = !legacy;
    if (data.pairingAllowed && data.paired) {
      resume.textContent = cloud ? '继续使用 ' + data.paired.username : '继续进入工作区';
      resume.hidden = false;
    }
    const localOptions = document.querySelector('#local-account-options');
    localGoogle.hidden = !data.localGoogle?.enabled || Boolean(data.paired) || (cloud && !data.hasLocalAccount);
    if (cloud) {
      document.querySelector('#auth-intro-help').textContent = '登录后可在网页和 Mac 间同步词库与学习进度。';
      const panel = document.querySelector('#email-panel');
      localOptions.appendChild(panel);
      panel.hidden = Boolean(data.paired) || !data.hasLocalAccount;
      if (!panel.hidden) {
        panel.querySelector('.auth-tabs').hidden = true;
        document.querySelector('#form-title').textContent = '登录已有本机账号';
        document.querySelector('#form-hint').textContent = '使用这台 Mac 上原有的用户名和密码打开本机工作区。';
        document.querySelector('#submit-auth').textContent = '登录本机账号';
      }
      localOptions.hidden = panel.hidden && localGoogle.hidden;
    } else {
      if (data.paired) document.querySelector('#auth-intro-help').textContent = '继续打开此设备已连接的工作区。';
      localOptions.hidden = localGoogle.hidden;
    }
  }
  window.DesktopAuth = { configure, start };
  window.addEventListener('pagehide', () => { localAttempt?.abort(); stop(); });
})();
