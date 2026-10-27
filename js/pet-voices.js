(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  let voices = [], selected = '', generation = 0, activeVoice = '', previewId = '', controller = null, frame = 0;
  let selectionGeneration = 0, saveQueue = Promise.resolve(), activeToken = -1, cues = [], savedSelection = '';
  let menuState = null;
  const pendingCommands = new Set();
  const audio = new Audio();
  audio.preload = 'auto';
  const cards = new Map(), tokens = [];
  const sample = $('sample').textContent.trim();
  $('sample').textContent = '';
  for (const match of sample.matchAll(/\S+/g)) {
    const span = document.createElement('span'); span.className = 'token'; span.textContent = match[0];
    tokens.push({span,from:match.index,to:match.index+match[0].length});
    $('sample').append(span,document.createTextNode(' '));
  }
  async function api(path,body,signal) {
    const response = await fetch(path,body ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal} : {signal});
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '暂时无法连接');
    return data;
  }
  function highlight(index) {
    if (index===activeToken) return;
    if (tokens[activeToken]) tokens[activeToken].span.classList.remove('active');
    activeToken=index;
    if (tokens[index]) tokens[index].span.classList.add('active');
  }
  function stopPreview(message) {
    generation++;
    if (controller) controller.abort(); controller=null;
    audio.pause(); audio.removeAttribute('src'); audio.load();
    cancelAnimationFrame(frame); highlight(-1); cues=[];
    if (previewId) api('/pet-voice-preview.php',{action:'stop',id:previewId}).catch(()=>{});
    previewId=''; activeVoice='';
    cards.forEach(({card,button})=>{card.classList.remove('previewing');button.classList.remove('playing');button.setAttribute('aria-pressed','false');});
    $('preview').hidden=true; $('progress-fill').style.transform='scaleX(0)';
    if (message) $('play-status').textContent=message;
  }
  function animate() {
    const time=audio.currentTime;
    const cue=cues.find(c=>time>=c.start && time<c.end);
    highlight(cue ? tokens.findIndex(t=>cue.from<t.to && cue.to>t.from) : -1);
    $('progress-fill').style.transform='scaleX('+(Number.isFinite(audio.duration)?Math.min(1,time/audio.duration):0)+')';
    if (!audio.paused) frame=requestAnimationFrame(animate);
  }
  async function preview(voice) {
    if (activeVoice===voice.id) {stopPreview('试听已停止');return;}
    stopPreview(); const run=generation; activeVoice=voice.id; controller=new AbortController();
    const {card,button}=cards.get(voice.id);
    card.classList.add('previewing');button.classList.add('playing');button.setAttribute('aria-pressed','true');
    $('preview-title').textContent=voice.name+' · '+voice.accent;
    $('play-status').textContent='正在准备声音…';$('preview').hidden=false;
    try {
      const result=await api('/pet-voice-preview.php',{voiceId:voice.id},controller.signal);
      if (run!==generation) return;
      previewId=result.id; cues=result.cues || []; audio.src=result.url;
      await audio.play(); if (run!==generation) return;
      $('play-status').textContent=result.fallback?'当前使用系统声音 · 在线音色暂不可用':'正在试听 · 逐词跟读';
      frame=requestAnimationFrame(animate);
    } catch(error) {
      if (run===generation && error.name!=='AbortError') {stopPreview();showMessage('试听暂不可用，请再试一次');}
    }
  }
  function renderSelection() {
    for (const [id,{card,input}] of cards) {card.classList.toggle('selected',id===selected);input.checked=id===selected;}
    const voice=voices.find(v=>v.id===selected);
    $('selection').textContent=voice ? voice.name+' ✓' : '';
  }
  function select(voice) {
    stopPreview(); selected=voice.id;renderSelection();
    const run=++selectionGeneration; $('save-status').textContent='正在保存…';
    saveQueue=saveQueue.catch(()=>{}).then(async()=>{
      try {
        const result=await api('/pet-voice.php',{voiceId:voice.id});
        savedSelection=result.selected;
        if (run===selectionGeneration) {selected=result.selected;renderSelection();$('save-status').textContent='已保存';}
      } catch(error) {
        if (run===selectionGeneration) {selected=savedSelection;renderSelection();$('save-status').textContent='未保存，请重新选择';}
      }
    });
  }
  function createCard(voice) {
    const card=document.createElement('div'); card.className='voice';card.dataset.color=voice.color;
    const input=document.createElement('input');input.type='radio';input.name='voice';input.value=voice.id;input.id='voice-'+voice.id;
    input.addEventListener('change',()=>select(voice));
    const label=document.createElement('label');label.htmlFor=input.id;
    label.innerHTML='<div class="voice-name"><strong></strong><span class="selected-mark" aria-hidden="true">✓</span></div><div class="voice-detail"></div>';
    label.querySelector('strong').textContent=voice.name;
    label.querySelector('.voice-detail').textContent=voice.accent.replace('英语','')+' · '+voice.gender;
    label.title=voice.tone;
    input.setAttribute('aria-label',voice.name+'，'+voice.accent+'，'+voice.gender+'，'+voice.tone);
    const button=document.createElement('button');button.type='button';button.className='audition';button.setAttribute('aria-label','试听 '+voice.name);button.setAttribute('aria-pressed','false');
    button.title='试听 '+voice.name;
    button.innerHTML='<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M3 1.6 10 6 3 10.4Z"/></svg><span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>';button.addEventListener('click',()=>preview(voice));
    card.append(input,label,button);$('voices').append(card);cards.set(voice.id,{card,input,button});
  }
  // Actions stay in the native bridge: workspace navigation requires a local
  // native request, not a browser fetch with an Origin/Referer header.
  function native(message) {
    const bridge=window.webkit?.messageHandlers?.wordpaperMenu;
    if (!bridge) return false;
    bridge.postMessage(message);return true;
  }
  function showMessage(message) {
    $('menu-message').textContent=message || '';$('menu-message').hidden=!message;
  }
  function updatePresentation(state) {
    const u=state.update || {}, current='v'+(u.current || state.version || '');
    if (!state.appMode) return {version:current,label:'',command:'',disabled:true};
    if (u.applying) return {version:current,label:'正在更新…',command:'',disabled:true};
    if (u.error) return {version:current+' · 更新失败',label:'重试',command:u.available?'update-apply':'update-check',disabled:false};
    if (u.available && u.latest) return {version:current,label:'更新到 v'+u.latest,command:'update-apply',disabled:false};
    return {version:current+(u.checked?' · 已是最新':''),label:'检查更新',command:'update-check',disabled:false};
  }
  function renderMenu(state) {
    if (!state?.ok) return;
    menuState=state;
    document.documentElement.dataset.theme=state.dark?'dark':'light';
    $('pet-toggle').dataset.command=state.pet?'pet-close':'pet-open';
    $('pet-toggle').querySelector('span').textContent=state.pet?'隐藏小词灵':'召唤小词灵';
    $('pet-mode').querySelector('span').textContent=state.petMode==='patrick'?'切换到词卡形态':'切换到派大星形态';
    const update=updatePresentation(state);
    $('version').textContent=update.version;$('update').textContent=update.label;
    $('update').hidden=!update.label;$('update').dataset.command=update.command;
    document.querySelectorAll('[data-command]').forEach(button=>{button.disabled=pendingCommands.has(button.dataset.command);});
    $('update').disabled=update.disabled || pendingCommands.has(update.command);
  }
  document.querySelectorAll('[data-command]').forEach(button=>button.addEventListener('click',()=>{
    const cmd=button.dataset.command;
    if (!cmd || pendingCommands.has(cmd)) return;
    stopPreview();showMessage('');
    if (!native({type:'command',cmd})) return showMessage('请从 WordPaper 状态栏打开');
    pendingCommands.add(cmd);button.disabled=true;
  }));
  async function refreshVoices() {
    const run=selectionGeneration;
    try {
      const data=await api('/pet-voices.json');
      voices=data.voices;document.documentElement.dataset.theme=data.dark?'dark':'light';
      if (!cards.size) voices.forEach(createCard);
      if (run===selectionGeneration) {selected=data.selected;savedSelection=data.selected;renderSelection();}
    } catch {showMessage('连接暂不可用，请重新打开菜单');}
  }
  window.WordPaperMenu={
    status:renderMenu,
    open(){showMessage('');refreshVoices();},
    close(){stopPreview();},
    complete(cmd,result){
      pendingCommands.delete(cmd);if(menuState)renderMenu(menuState);
      if (!result?.ok) showMessage(result?.error || '操作未完成，请重试');
    },
  };
  document.addEventListener('keydown',event=>{if(event.key==='Escape'){stopPreview();native({type:'close'});}});
  new ResizeObserver(()=>native({type:'resize',height:Math.ceil($('panel').getBoundingClientRect().height)})).observe($('panel'));
  audio.addEventListener('ended',()=>stopPreview('试听结束'));
  audio.addEventListener('error',()=>{if(activeVoice && audio.getAttribute('src'))stopPreview('试听暂不可用，请再试一次');});
  $('stop').addEventListener('click',()=>stopPreview('试听已停止'));
  document.addEventListener('visibilitychange',()=>{if(document.hidden)stopPreview();});
  window.addEventListener('pagehide',()=>stopPreview());
  refreshVoices();native({type:'ready'});
})();
