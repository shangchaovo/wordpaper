(function () {
  'use strict';

  const form = document.querySelector('#auth-form');
  const emailPanel = document.querySelector('#email-panel');
  const loginTab = document.querySelector('#tab-login');
  const registerTab = document.querySelector('#tab-register');
  const title = document.querySelector('#form-title');
  const hint = document.querySelector('#form-hint');
  const identifierLabel = document.querySelector('#identifier-label');
  const identifier = document.querySelector('#username');
  const verificationRow = document.querySelector('#verification-row');
  const emailCode = document.querySelector('#email-code');
  const sendEmailCode = document.querySelector('#send-email-code');
  const emailCodeHint = document.querySelector('#email-code-hint');
  const password = document.querySelector('#password');
  const confirmRow = document.querySelector('#confirm-row');
  const confirm = document.querySelector('#password-confirm');
  const submit = document.querySelector('#submit-auth');
  const errorBox = document.querySelector('#auth-error');
  const authStatus = document.querySelector('#auth-status');
  const providerStatus = document.querySelector('#provider-status');
  const providerButtons = Array.from(document.querySelectorAll('[data-provider]'));
  let mode = 'login';
  let emailRegistrationEnabled = null;
  let codeTimer = 0;

  const oauthErrors = {
    google_not_configured: 'Google 登录尚未配置，请暂时使用邮箱登录。',
    wechat_not_configured: '微信登录尚未配置，请暂时使用其他方式登录。',
    oauth_cancelled: '你取消了授权，可以重新尝试或改用邮箱。',
    oauth_expired: '登录请求已过期或不是从当前浏览器发起，请重新尝试。',
    oauth_failed: '第三方登录暂时失败，请稍后重试。',
    rate_limited: '尝试次数过多，请稍后再试。',
  };

  function destination() {
    const value = new URLSearchParams(location.search).get('next') || '/';
    return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\\\') ? value : '/';
  }

  function showError(message, invalid) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
    identifier.setAttribute('aria-invalid', invalid && message ? 'true' : 'false');
    password.setAttribute('aria-invalid', invalid && message ? 'true' : 'false');
    confirm.setAttribute('aria-invalid', 'false');
    emailCode.setAttribute('aria-invalid', invalid && /验证码/.test(message || '') ? 'true' : 'false');
  }

  function updateEmailRegistrationState() {
    const unavailable = mode === 'register' && emailRegistrationEnabled === false;
    sendEmailCode.disabled = unavailable || codeTimer > 0;
    submit.disabled = unavailable;
    if (unavailable) {
      emailCodeHint.textContent = '管理员尚未配置邮件发送服务，现有邮箱账号仍可登录。';
      submit.textContent = '邮箱注册尚未开放';
    } else if (!codeTimer) {
      emailCodeHint.textContent = '验证码 10 分钟内有效。';
      sendEmailCode.textContent = '发送验证码';
      submit.textContent = mode === 'register' ? '使用邮箱创建账号' : '使用邮箱登录';
    }
  }

  // 登录/注册的白色指示块随选择滑过去；测量失败或窄屏异常时静默退回按钮自带底色。
  function positionAuthPill() {
    const tabs = document.querySelector('.auth-tabs');
    if (!tabs || !tabs.offsetParent) return;
    const active = tabs.querySelector('.auth-tab.active');
    if (!active) return;
    tabs.style.setProperty('--tab-x', active.offsetLeft + 'px');
    tabs.style.setProperty('--tab-w', active.offsetWidth + 'px');
    requestAnimationFrame(function () { tabs.classList.add('auth-pill-ready'); });
  }

  function setMode(next, focusTab) {
    mode = next === 'register' ? 'register' : 'login';
    const registering = mode === 'register';
    [loginTab, registerTab].forEach(function (tab) {
      const active = tab === (registering ? registerTab : loginTab);
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
    emailPanel.setAttribute('aria-labelledby', registering ? 'tab-register' : 'tab-login');
    verificationRow.hidden = !registering;
    emailCode.required = registering;
    confirmRow.hidden = !registering;
    confirm.required = registering;
    identifier.type = registering ? 'email' : 'text';
    identifier.autocomplete = registering ? 'email' : 'username';
    identifier.inputMode = registering ? 'email' : 'text';
    identifierLabel.textContent = registering ? '邮箱地址' : '邮箱地址或旧用户名';
    identifier.placeholder = registering ? 'name@example.com' : '邮箱地址或旧用户名';
    password.autocomplete = registering ? 'new-password' : 'current-password';
    title.textContent = registering ? '创建邮箱账号' : '邮箱登录';
    hint.textContent = registering ? '验证邮箱后创建账号，并迁入这个浏览器里的旧数据。' : '登录后会从服务器恢复你的全部 WordPaper 数据。';
    showError('', false);
    updateEmailRegistrationState();
    positionAuthPill();
    if (focusTab) (registering ? registerTab : loginTab).focus();
  }

  loginTab.addEventListener('click', function () { setMode('login'); });
  registerTab.addEventListener('click', function () { setMode('register'); });
  [loginTab, registerTab].forEach(function (tab) {
    tab.addEventListener('keydown', function (event) {
      let target = null;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') target = tab === loginTab ? registerTab : loginTab;
      if (event.key === 'Home') target = loginTab;
      if (event.key === 'End') target = registerTab;
      if (!target) return;
      event.preventDefault();
      setMode(target === registerTab ? 'register' : 'login', true);
    });
  });

  [identifier, password, confirm, emailCode].forEach(function (field) {
    field.addEventListener('input', function () {
      field.setAttribute('aria-invalid', 'false');
      if (!errorBox.hidden) showError('', false);
    });
  });

  async function loadProviders() {
    let providers = {};
    try {
      const response = await fetch('/api/auth/providers', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error('provider discovery failed');
      providers = await response.json();
    } catch {
      providerStatus.textContent = '登录状态加载失败，请刷新后重试。';
      return;
    }
    emailRegistrationEnabled = Boolean(providers.email && providers.email.registrationEnabled);
    updateEmailRegistrationState();

    // ── 主账号镜像(卫星模式) ─────────────────────────────
    const paired = providers.paired || null;
    const pairCard = document.querySelector('#pair-card');
    const pairSection = document.querySelector('#pair-section');
    if (paired) {
      // 已连接主账号:本地注册/登录/OAuth 全部让位,只留「继续」。
      emailPanel.style.display = 'none';
      const stack = document.querySelector('.provider-stack');
      if (stack) stack.style.display = 'none';
      const divider0 = document.querySelector('.auth-divider');
      if (divider0) divider0.style.display = 'none';
      const note = document.querySelector('.migration-note');
      if (note) note.style.display = 'none';
      pairCard.hidden = false;
      document.querySelector('#pair-identity').textContent = paired.username + ' @ ' + paired.url.replace(/^https?:\/\//, '');
      document.querySelector('#pair-status').textContent =
        paired.status === 'ok' ? '与主账号连接正常,数据实时同步。'
        : paired.status === 'reauth' ? '主账号会话已过期:点继续可先用本机缓存,建议在下方重新验证。'
        : '暂时连不上主账号:本机缓存可离线使用,恢复后自动同步。';
      // 已配对时配对区收起为「重新验证/换绑」入口
      pairSection.hidden = false;
      document.querySelector('#pair-summary').textContent = '重新验证 / 更换主账号 →';
      return;
    }
    if (providers.pairingAllowed) pairSection.hidden = false;

    let anyEnabled = false;
    providerButtons.forEach(function (button) {
      const enabled = Boolean(providers[button.dataset.provider]?.enabled);
      anyEnabled = anyEnabled || enabled;
      button.style.display = enabled ? '' : 'none';
      button.disabled = !enabled;
      button.setAttribute('aria-disabled', String(!enabled));
      button.querySelector('[data-provider-state]').textContent = enabled ? '首次使用将自动创建账号' : '';
    });
    const divider = document.querySelector('.auth-divider');
    if (divider) divider.style.display = anyEnabled ? '' : 'none';
  }

  // ── 配对 / 继续 / 断开 ──────────────────────────────────
  async function postPlain(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || '操作失败,请稍后重试');
    return data;
  }

  const pairButton = document.querySelector('#btn-pair');
  pairButton.addEventListener('click', async function () {
    showError('', false);
    const url = document.querySelector('#pair-url').value.trim();
    const identifier = document.querySelector('#pair-identifier').value.trim();
    const password = document.querySelector('#pair-password').value;
    if (!url || !identifier || !password) { showError('服务器地址、账号和密码都要填', false); return; }
    pairButton.disabled = true;
    pairButton.textContent = '正在连接并同步…';
    try {
      await postPlain('/api/pair', { url: url, identifier: identifier, password: password });
      location.replace(destination());
    } catch (error) {
      showError(error.message, false);
      pairButton.disabled = false;
      pairButton.textContent = '连接并同步';
    }
  });

  document.querySelector('#btn-resume').addEventListener('click', async function () {
    showError('', false);
    try {
      await postPlain('/api/auth/resume');
      location.replace(destination());
    } catch (error) {
      showError(error.message, false);
    }
  });

  document.querySelector('#btn-unpair').addEventListener('click', async function () {
    if (!window.confirm('断开后会删除这台电脑上的同步副本(主账号数据不受影响)。确定断开吗？')) return;
    try {
      await postPlain('/api/unpair');
      location.reload();
    } catch (error) {
      showError(error.message, false);
    }
  });

  providerButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (button.disabled) return;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      providerStatus.textContent = `正在连接${button.dataset.provider === 'google' ? ' Google' : '微信'}…`;
      location.assign(`/api/auth/${button.dataset.provider}/start?next=${encodeURIComponent(destination())}`);
    });
  });

  function startCodeCountdown(seconds) {
    clearInterval(codeTimer);
    let remaining = Math.max(1, Number(seconds) || 60);
    function render() {
      sendEmailCode.disabled = true;
      sendEmailCode.textContent = `${remaining} 秒后重发`;
      remaining -= 1;
      if (remaining >= 0) return;
      clearInterval(codeTimer);
      codeTimer = 0;
      updateEmailRegistrationState();
    }
    codeTimer = setInterval(render, 1000);
    render();
  }

  sendEmailCode.addEventListener('click', async function () {
    showError('', false);
    if (emailRegistrationEnabled === false) {
      showError('邮箱注册尚未配置，请联系管理员', false);
      return;
    }
    if (!identifier.reportValidity()) return;
    sendEmailCode.disabled = true;
    sendEmailCode.textContent = '正在发送…';
    emailCodeHint.textContent = '正在验证邮箱地址…';
    try {
      const response = await fetch('/api/auth/email/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: identifier.value }),
      });
      const body = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (body.retryAfter) startCodeCountdown(body.retryAfter);
        throw new Error(body.error || '验证码发送失败，请稍后重试');
      }
      if (body.debugCode) {
        emailCode.value = body.debugCode;
        emailCodeHint.textContent = '本机开发模式：验证码已自动填入。';
      } else {
        emailCodeHint.textContent = '验证码已发送，请检查收件箱和垃圾邮件。';
      }
      startCodeCountdown(60);
      emailCode.focus();
    } catch (error) {
      showError(error.message, /邮箱/.test(error.message));
      if (!codeTimer) updateEmailRegistrationState();
    }
  });

  form.addEventListener('submit', async function (event) {
    event.preventDefault();
    showError('', false);
    if (!form.reportValidity()) return;
    if (mode === 'register' && password.value !== confirm.value) {
      showError('两次输入的密码不一致', true);
      confirm.setAttribute('aria-invalid', 'true');
      confirm.focus();
      return;
    }
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
    authStatus.textContent = mode === 'register' ? '正在创建邮箱账号…' : '正在登录…';
    submit.textContent = authStatus.textContent;
    try {
      const credentials = mode === 'register'
        ? { email: identifier.value, password: password.value, verificationCode: emailCode.value }
        : { identifier: identifier.value, password: password.value };
      const response = await fetch('/api/auth/' + mode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials),
      });
      const body = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(body.error || '操作失败，请稍后重试');
      authStatus.textContent = '登录成功，正在恢复数据…';
      location.replace(destination());
    } catch (error) {
      showError(error.message, true);
      form.setAttribute('aria-busy', 'false');
      authStatus.textContent = '';
      submit.disabled = false;
      updateEmailRegistrationState();
      (/验证码/.test(error.message) ? emailCode : identifier).focus();
    }
  });

  setMode('login');
  loadProviders();
  window.addEventListener('resize', positionAuthPill);

  const params = new URLSearchParams(location.search);
  const callbackError = oauthErrors[params.get('authError')];
  if (callbackError) {
    showError(callbackError, false);
    params.delete('authError');
    const query = params.toString();
    history.replaceState(null, '', location.pathname + (query ? `?${query}` : ''));
  }
})();
