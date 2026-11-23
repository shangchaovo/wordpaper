/* Account model settings: secrets only travel in authenticated requests. */
(function () {
  'use strict';
  window.ModelSettings = { init };
  function init() {
    const $ = id => document.getElementById(id);
    if (Store.isLocalMode()) return;
    const dialog = $('model-dialog'), trigger = $('btn-model'), key = $('model-key');
    let busy = false, configured = false, generation = 0;
    trigger.hidden = false;
    const say = (text, error = false) => { $('model-status').textContent = text; $('model-status').dataset.error = String(error); };
    async function request(method, suffix = '', body) {
      const response = await fetch('/api/account/model' + suffix, {
        method, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': Store.csrfToken() },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '接口操作失败，请重试。');
      return result;
    }
    function fields() { return { protocol: $('model-protocol').value, baseUrl: $('model-base-url').value.trim(), model: $('model-name').value.trim(), apiKey: key.value.trim() }; }
    function render(data) {
      configured = !!data.configured;
      $('model-protocol').value = data.protocol || 'openai';
      $('model-base-url').value = data.baseUrl || '';
      $('model-name').value = data.model || '';
      key.value = '';
      key.placeholder = configured ? '已绑定；留空保留原 Key' : '粘贴 API Key';
      $('model-remove').disabled = !configured;
    }
    async function open() {
      if (busy) return;
      const current = ++generation;
      if (!dialog.open) dialog.showModal();
      say('正在读取当前账号…');
      try {
        const data = await request('GET');
        if (generation !== current || !dialog.open) return;
        render(data);
        $('model-identity').textContent = '当前账号：' + (data.user?.username || '已登录账号');
        say(configured ? '已绑定 ' + data.model + '，可测试连接或更换接口。' : '尚未绑定模型。填写后验证通过即可使用。');
      } catch (error) { if (generation === current) say(error.message, true); }
    }
    async function run(method, suffix = '') {
      if (busy) return;
      if (method !== 'DELETE' && !$('model-form').reportValidity()) return;
      busy = true;
      const current = generation;
      const body = method === 'DELETE' ? undefined : fields();
      key.value = '';
      dialog.querySelectorAll('input, select, button').forEach(el => { if (el.id !== 'btn-close-model') el.disabled = true; });
      say(method === 'DELETE' ? '正在解除绑定…' : '正在验证接口，通常需要几秒钟…');
      try {
        const data = await request(method, suffix, body);
        if (current !== generation) return;
        if (method !== 'POST') render(data);
        say(method === 'DELETE' ? '已解除模型绑定，学习记录已保留。' : data.message);
      } catch (error) { if (current === generation) say(error.message, true); }
      finally {
        if (body) body.apiKey = '';
        busy = false;
        dialog.querySelectorAll('input, select, button').forEach(el => { el.disabled = false; });
        $('model-remove').disabled = !configured;
      }
    }
    trigger.addEventListener('click', open);
    $('model-deepseek').addEventListener('click', () => {
      $('model-protocol').value = 'openai';
      $('model-base-url').value = 'https://api.deepseek.com';
      $('model-name').value = 'deepseek-flash';
      key.value = ''; key.focus();
      say('已填入 DeepSeek 官方地址和模型，请填写该平台的 API Key 后验证绑定。');
    });
    $('model-form').addEventListener('submit', event => { event.preventDefault(); run('PUT'); });
    $('model-test').addEventListener('click', () => run('POST', '/test'));
    $('model-remove').addEventListener('click', () => run('DELETE'));
    $('btn-close-model').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { key.value = ''; generation++; trigger.focus(); });
    function route() { if (location.hash === '#model') open(); }
    window.addEventListener('hashchange', route);
    route();
  }
})();
