(function () {
  'use strict';
  const code = new URLSearchParams(location.search).get('code') || '';
  const validCode = /^[A-F0-9]{6}-[A-F0-9]{6}$/.test(code);
  const status = document.querySelector('#connect-status');
  const approve = document.querySelector('#connect-approve');
  const account = document.querySelector('#connect-user');
  const changeAccount = document.querySelector('#connect-login');
  const loginUrl = '/login.html?next=' + encodeURIComponent(location.pathname + location.search);
  let session;
  changeAccount.addEventListener('click', async function () {
    if (!session) { location.assign(loginUrl); return; }
    this.disabled = true;
    try {
      const response = await fetch('/api/session', { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken } });
      if (!response.ok) throw new Error('暂时无法切换账号，请稍后重试');
      location.assign(loginUrl);
    } catch (error) { showError(error.message); this.disabled = false; }
  });
  document.querySelector('#connect-code').textContent = validCode ? code : '连接码无效';
  fetch('/api/session', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('请先登录再连接 App');
    session = await response.json();
    account.textContent = '当前账号：' + session.user.username;
    approve.disabled = !validCode;
  }).catch(() => {
    account.hidden = true;
    showError('暂时无法读取账号，请重新登录后继续。');
  });
  function showError(message) {
    status.classList.add('is-error');
    status.textContent = message;
  }
  approve.addEventListener('click', async function () {
    approve.disabled = true;
    changeAccount.disabled = true;
    try {
      const response = await fetch('/api/device/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ userCode: code }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '授权失败，请在 App 重试');
      const title = document.querySelector('#connect-title');
      title.textContent = '已允许同步';
      document.title = '已允许同步 · WordPaper';
      document.querySelector('#connect-mark').hidden = false;
      document.querySelector('#connect-details').hidden = true;
      document.querySelector('#connect-actions').hidden = true;
      status.classList.remove('is-error');
      status.textContent = '回到 WordPaper App，连接会自动完成。';
      title.focus();
    } catch (error) {
      showError(error.message);
      approve.disabled = false;
      changeAccount.disabled = false;
    }
  });
})();
