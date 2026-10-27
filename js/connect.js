(function () {
  'use strict';
  const code = new URLSearchParams(location.search).get('code') || '';
  const status = document.querySelector('#connect-status');
  const approve = document.querySelector('#connect-approve');
  let session;
  document.querySelector('#connect-login').addEventListener('click', async function () {
    if (!session) return;
    this.disabled = true;
    try {
      const response = await fetch('/api/session', { method: 'DELETE', headers: { 'X-CSRF-Token': session.csrfToken } });
      if (!response.ok) throw new Error('暂时无法切换账号，请稍后重试');
      location.assign('/login.html?next=' + encodeURIComponent(location.pathname + location.search));
    } catch (error) { status.textContent = error.message; this.disabled = false; }
  });
  document.querySelector('#connect-code').textContent = /^[A-F0-9]{6}-[A-F0-9]{6}$/.test(code) ? code : '连接码无效';
  fetch('/api/session', { cache: 'no-store' }).then(async response => {
    if (!response.ok) throw new Error('请先登录再连接 App');
    session = await response.json();
    document.querySelector('#connect-user').textContent = '当前账号：' + session.user.username;
    approve.disabled = !/^[A-F0-9]{6}-[A-F0-9]{6}$/.test(code);
  }).catch(error => { status.textContent = error.message; });
  approve.addEventListener('click', async function () {
    approve.disabled = true;
    try {
      const response = await fetch('/api/device/approve', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken },
        body: JSON.stringify({ userCode: code }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '授权失败，请在 App 重试');
      status.textContent = '已授权。回到 WordPaper App，连接会自动完成。';
      approve.textContent = '已允许连接';
    } catch (error) { status.textContent = error.message; approve.disabled = false; }
  });
})();
