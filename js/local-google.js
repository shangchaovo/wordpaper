(function () {
  'use strict';

  async function post(action, body, csrfToken) {
    const response = await fetch(`/api/local-google/${action}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Google 授权暂时不可用，请重试。');
    return data;
  }

  async function authorize(purpose, csrfToken, signal, onWaiting) {
    await post('start', { purpose }, csrfToken);
    if (!signal.aborted) onWaiting();
    while (!signal.aborted) {
      const result = await post('poll', {}, csrfToken);
      if (result.ok) return true;
      if (!result.pending) throw new Error('Google 授权未完成，请重试。');
      if (!signal.aborted) await new Promise(resolve => setTimeout(resolve, 1200));
    }
    // Let any in-flight poll finish before cancelling, so a committed binding
    // or login is never reported as cancelled by the interface.
    await post('cancel', {}, csrfToken);
    return false;
  }

  window.LocalGoogle = { authorize };
})();
