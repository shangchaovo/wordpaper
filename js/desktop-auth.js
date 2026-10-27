(function () {
  'use strict';
  const section = document.querySelector('#desktop-sync');
  if (!section) return;
  const origin = document.querySelector('#desktop-origin');
  const status = document.querySelector('#desktop-sync-status');
  const pending = document.querySelector('#desktop-sync-pending');
  const link = document.querySelector('#desktop-sync-open');
  const buttons = Array.from(section.querySelectorAll('[data-cloud-provider]'));
  let timer = null, csrfToken = '', generation = 0;
  function openExternal(url) {
    if (window.WordPaperDesktop) WordPaperDesktop.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  }
  async function post(route, body) {
    const response = await fetch(route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '连接失败，请检查账号服务器地址');
    return data;
  }
  function stop() {
    generation += 1; clearTimeout(timer); timer = null;
    buttons.forEach(button => { button.disabled = false; });
    pending.hidden = true;
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
    if (!origin.reportValidity() || !origin.value.trim()) { origin.focus(); return; }
    stop(); const id = generation;
    buttons.forEach(el => { el.disabled = true; });
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
      openExternal(result.verificationUrl);
      timer = setTimeout(() => poll(id), 2500);
    } catch (error) { if (id === generation) { stop(); status.textContent = error.message; } }
  }));
  link.addEventListener('click', event => { if (window.WordPaperDesktop) { event.preventDefault(); openExternal(link.href); } });
  document.querySelector('#desktop-sync-cancel').addEventListener('click', async () => {
    stop();
    try { const result = await post('/api/desktop/cancel'); if (result.connected) { location.replace('/'); return; } }
    catch (error) { status.textContent = error.message; return; }
    status.textContent = '已取消连接，可以重新发起。';
  });
  fetch('/api/auth/providers', { cache: 'no-store' }).then(response => response.json()).then(data => {
    if (!data.pairingAllowed) return;
    section.hidden = false;
    try { origin.value = data.paired?.url || localStorage.getItem('wp:sync-origin') || ''; } catch {}
    if (window.WordPaperDesktop) document.querySelector('.provider-stack').hidden = true;
  }).catch(() => {});
  window.addEventListener('pagehide', stop);
})();
