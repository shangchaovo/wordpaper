/* Per-account desktop TTS settings. The server returns only public fields. */
(function () {
  'use strict';
  window.SpeechSettings = { init };
  function init() {
    if (!Store.canConfigureSpeech()) return;
    const $ = id => document.getElementById(id);
    const dialog = $('speech-dialog'), form = $('speech-form'), audio = $('speech-audio');
    const provider = $('speech-provider'), address = $('speech-url'), model = $('speech-model');
    const voice = $('speech-voice'), key = $('speech-key'), status = $('speech-status');
    const official = 'https://api.openai.com/v1';
    let saved, busy = false, generation = 0, objectUrl = '';
    function stopAudio() {
      audio.pause(); audio.removeAttribute('src'); audio.hidden = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      objectUrl = '';
    }
    function update() {
      const locked = busy || !saved;
      for (const field of [provider,address,model,voice,key,$('speech-save'),$('speech-preview')]) field.disabled = locked;
      address.readOnly = provider.value === 'openai';
      $('speech-remove').disabled = locked || !saved.configured;
      const reuse = saved?.configured && address.value.trim().replace(/\/audio\/speech\/?$|\/+$/g, '') === saved.baseUrl;
      key.required = !reuse;
      key.placeholder = reuse ? '已保存 · 留空沿用密钥' : '粘贴此语音服务的 API Key';
    }
    function render(data) {
      saved = data;
      provider.value = data.baseUrl === official ? 'openai' : 'custom';
      address.value = data.baseUrl; model.value = data.model; voice.value = data.voice; key.value = '';
      $('speech-current').textContent = data.configured ? '当前朗读使用 ' + data.model + ' · ' + data.voice : '当前朗读使用微软语音。';
      update();
    }
    async function request(method, preview, fields) {
      const response = await fetch('/api/account/speech' + (preview ? '/preview' : ''), {
        method, cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': Store.csrfToken() },
        ...(fields ? { body: JSON.stringify(fields) } : {}),
      });
      if (!response.ok) throw new Error((await response.json()).error || '语音设置请求失败。');
      return preview ? response.blob() : response.json();
    }
    function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
    async function open() {
      if (dialog.open) return;
      const current = ++generation;
      saved = null; busy = true; form.reset(); key.value = ''; $('speech-current').textContent = ''; update();
      dialog.showModal(); message('正在读取语音设置…');
      try { const data = await request('GET'); if (current === generation) { render(data); message(''); } }
      catch (err) { if (current === generation) message(err.message, true); }
      finally { if (current === generation) { busy = false; update(); } }
    }
    async function submit(method, preview = false) {
      if (busy || !saved || (method !== 'DELETE' && !form.reportValidity())) return;
      const current = generation;
      stopAudio(); busy = true; update(); message(preview ? '正在合成试听…' : '正在保存…');
      try {
        const fields = { baseUrl: address.value.trim(), model: model.value.trim(), voice: voice.value.trim(), apiKey: key.value.trim() };
        const result = await request(method, preview, method === 'DELETE' ? undefined : fields);
        if (current !== generation) return;
        if (preview) {
          objectUrl = URL.createObjectURL(result); audio.src = objectUrl; audio.hidden = false;
          await audio.play().catch(() => {});
          if (current === generation) message('试听已就绪。');
        } else { render(result); message(method === 'DELETE' ? '已恢复微软语音。' : '已保存，下次朗读使用此声音。'); }
      } catch (err) { if (current === generation) message(err.message, true); }
      finally { if (current === generation) { busy = false; update(); } }
    }
    const trigger = document.querySelector('[data-speech-settings]');
    trigger.hidden = false;
    trigger.addEventListener('click', open);
    provider.addEventListener('change', () => {
      stopAudio(); key.value = '';
      if (provider.value === 'openai') { address.value = official; model.value = 'gpt-4o-mini-tts'; voice.value = 'coral'; }
      else if (saved.baseUrl !== official) { address.value = saved.baseUrl; model.value = saved.model; voice.value = saved.voice; }
      else { address.value = ''; model.value = ''; voice.value = ''; }
      update();
    });
    address.addEventListener('input', update);
    form.addEventListener('submit', event => { event.preventDefault(); submit('PUT'); });
    $('speech-preview').addEventListener('click', () => submit('POST', true));
    $('speech-remove').addEventListener('click', () => submit('DELETE'));
    $('speech-close').addEventListener('click', () => dialog.close());
    dialog.addEventListener('close', () => { generation++; key.value = ''; stopAudio(); });
  }
})();
