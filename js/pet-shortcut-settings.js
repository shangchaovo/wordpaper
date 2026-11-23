(function () {
  'use strict';
  const $ = id => document.getElementById(id), api = window.PatrickShortcuts;
  const dialog = $('pet-shortcuts-dialog'), trigger = $('btn-pet-shortcuts');
  if (!api || !dialog || !trigger) return;
  const save = $('pet-shortcuts-save'), reset = $('pet-shortcuts-reset'), cancel = $('pet-shortcuts-cancel-key');
  let draft = null, recording = '', busy = false, generation = 0;
  const buttons = new Map();
  function say(message, error = false) { $('pet-shortcuts-status').textContent = message; $('pet-shortcuts-status').dataset.error = String(error); }
  function update() {
    buttons.forEach((button,id) => {
      button.textContent = recording === id ? '请按键…' : api.label(draft[id]);
      button.dataset.recording = String(recording === id); button.disabled = busy;
    });
    cancel.hidden = !recording;
    reset.disabled = busy || !draft;
    save.disabled = busy || !draft || !!recording || !api.validate(draft).ok;
  }
  function render() {
    const list = $('pet-shortcuts-list'); list.replaceChildren(); buttons.clear();
    for (const [group,title] of [['study','背单词'],['roam','自由走动'],['all','通用操作']]) {
      const fieldset = document.createElement('fieldset'), legend = document.createElement('legend'), grid = document.createElement('div');
      fieldset.className = 'shortcut-group'; legend.textContent = title; grid.className = 'shortcut-grid';
      for (const def of api.definitions.filter(item => item.group === group)) {
        const row = document.createElement('div'), label = document.createElement('span'), button = document.createElement('button');
        row.className = 'shortcut-row'; label.textContent = def.label;
        button.className = 'shortcut-key'; button.type = 'button'; button.dataset.action = def.id;
        button.setAttribute('aria-label','修改'+def.label+'快捷键');
        button.addEventListener('click',() => { recording = def.id; say('正在修改「'+def.label+'」，按下新的快捷键。'); update(); });
        buttons.set(def.id,button); row.append(label,button); grid.append(row);
      }
      fieldset.append(legend,grid); list.append(fieldset);
    }
    update();
  }
  async function request(method, bindings) {
    const response = await fetch('/pet-shortcuts.php', {method, cache:'no-store',
      headers:{'Content-Type':'application/json','X-CSRF-Token':window.Store?.csrfToken() || ''},
      ...(bindings ? {body:JSON.stringify({bindings})} : {}),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok || !value.ok || !value.bindings) throw new Error(value.error || '请先启用这台 Mac 的桌面伴侣，再设置快捷键。');
    return value;
  }
  async function open() {
    if (dialog.open) return;
    const current = ++generation; recording=''; draft=null; busy=true;
    $('pet-shortcuts-list').replaceChildren(); buttons.clear();
    dialog.showModal(); dialog.scrollTop=0;
    say('正在读取快捷键…'); update();
    try {
      const value = await request('GET');
      if (current !== generation) return;
      draft = api.normalize(value.bindings); render();
      say('点击按键修改。默认 A / S / D / F 对应四个选项。');
    } catch (error) { if (current === generation) say(error.message,true); }
    finally { if(current===generation){busy=false;update();} }
  }
  function close() {
    generation++; recording=''; busy=false;
    // Clear the current route before dialog.close queues its asynchronous
    // event, so immediately opening #shortcuts cannot lose the new route.
    if(location.hash==='#shortcuts')history.replaceState(null,'',location.pathname+location.search);
    dialog.close(); trigger.focus();
  }
  dialog.addEventListener('keydown', event => {
    if (!recording || busy) return;
    event.preventDefault(); event.stopPropagation();
    if (event.repeat || ['Shift','Control','Alt','Meta'].includes(event.key)) return;
    const code=event.code==='NumpadEnter'?'Enter':event.code;
    if (!Object.hasOwn(api.codes,code)) {say('暂不支持这个按键，请选择字母、数字或常用功能键。',true);return;}
    draft[recording]={code,mods:(event.shiftKey?1:0)|(event.ctrlKey?2:0)|(event.altKey?4:0)|(event.metaKey?8:0)};
    recording=''; const checked=api.validate(draft);
    say(checked.ok?'已修改，保存后立即生效。':checked.error,!checked.ok);update();
  },true);
  dialog.addEventListener('cancel', event => {event.preventDefault();if(recording){recording='';update();}else close();});
  cancel.addEventListener('click',()=>{recording='';say('已取消录入。');update();});
  reset.addEventListener('click',()=>{draft=api.normalize({});recording='';render();say('已恢复默认按键，点击保存即可应用。');});
  save.addEventListener('click',async()=>{
    if(busy || !draft)return; const checked=api.validate(draft);
    if(!checked.ok){say(checked.error,true);return;}
    busy=true;update();say('正在保存…');
    const current=generation;
    try {
      const value=await request('POST',checked.bindings);
      if(current!==generation)return;
      draft=api.normalize(value.bindings);say('已保存，派大星和词卡按键提示会立即更新。');
    } catch(error){if(current===generation)say(error.message,true);}
    finally{if(current===generation){busy=false;update();}}
  });
  trigger.addEventListener('click',open);
  $('pet-shortcuts-close').addEventListener('click',close);
  function route(){if(location.hash==='#shortcuts')open();}
  window.addEventListener('hashchange',route);
  // App.init hydrates Store asynchronously; wait for the local session before the proxy request.
  if(location.hash==='#shortcuts') {
    let attempts=0;
    const timer=setInterval(()=>{if(window.Store?.csrfToken() || ++attempts>=40){clearInterval(timer);route();}},100);
  }
})();
