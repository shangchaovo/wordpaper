/* Shared key definitions for the settings UI, companion and native pet. */
(function (root, factory) {
  const api = factory(); api.createShortcuts = factory;
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PatrickShortcuts = api;
})(typeof globalThis === 'object' ? globalThis : this, function createShortcuts() {
  const codes = {KeyA:0,KeyS:1,KeyD:2,KeyF:3,KeyH:4,KeyG:5,KeyZ:6,KeyX:7,KeyC:8,KeyV:9,
    KeyB:11,KeyQ:12,KeyW:13,KeyE:14,KeyR:15,KeyY:16,KeyT:17,Digit1:18,Digit2:19,Digit3:20,Digit4:21,
    Digit6:22,Digit5:23,Equal:24,Digit9:25,Digit7:26,Minus:27,Digit8:28,Digit0:29,BracketRight:30,KeyO:31,
    KeyU:32,BracketLeft:33,KeyI:34,KeyP:35,Enter:36,KeyL:37,KeyJ:38,Quote:39,KeyK:40,Semicolon:41,
    Backslash:42,Comma:43,Slash:44,KeyN:45,KeyM:46,Period:47,Tab:48,Space:49,Backquote:50,Backspace:51,
    Escape:53,F5:96,F6:97,F7:98,F3:99,F8:100,F9:101,F11:103,F10:109,F12:111,Home:115,PageUp:116,
    Delete:117,F4:118,End:119,F2:120,PageDown:121,F1:122,ArrowLeft:123,ArrowRight:124,ArrowDown:125,ArrowUp:126};
  const names = {Backspace:'Delete',Delete:'Fn Delete',Enter:'Enter',Space:'空格',Escape:'Esc',ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓',
    Equal:'=',Minus:'-',BracketRight:']',BracketLeft:'[',Quote:"'",Semicolon:';',Backslash:'\\',Comma:',',Slash:'/',Period:'.',Backquote:'`'};
  const definitions = [
    ['answer0','选项 A','study','KeyA'],['answer1','选项 B','study','KeyS'],['answer2','选项 C','study','KeyD'],['answer3','选项 D','study','KeyF'],
    ['remember','标熟 / 已熟悉','study','Backspace'],['next','下一个单词','study','Enter'],
    ['example-prev','上一条例句','study','ArrowLeft'],['example-next','下一条例句','study','ArrowRight'],
    ['replay','重听单词和例句','study','Space'],['expand','展开 / 收起释义','study','KeyE'],['sentence','答题后造句','study','KeyG'],
    ['scrollUp','向上滚动卡片','study','ArrowUp'],['scrollDown','向下滚动卡片','study','ArrowDown'],
    ['moveLeft','向左走','roam','ArrowLeft'],['moveRight','向右走','roam','ArrowRight'],['moveUp','向上走','roam','ArrowUp'],['moveDown','向下走','roam','ArrowDown'],
    ['pause','暂停 / 恢复散步','roam','Space'],['start','开始背单词','roam','Enter'],
    ['dismiss','收起卡片','all','Escape'],['chat','打开聊天','all','KeyC'],['help','快捷键帮助','all','Slash'],['settings','快捷键设置','all','KeyK'],
  ].map(row => ({id:row[0],label:row[1],group:row[2],code:row[3]}));
  const defaults = Object.fromEntries(definitions.map(d=>[d.id,{code:d.code,mods:0}]));
  function label(binding) {
    return ((binding.mods & 2)?'⌃':'')+((binding.mods & 4)?'⌥':'')+((binding.mods & 1)?'⇧':'')+((binding.mods & 8)?'⌘':'')
      +(names[binding.code] || binding.code.replace(/^(Key|Digit)/,''));
  }
  function validate(value) {
    if (!value || typeof value!=='object' || Array.isArray(value)) return {ok:false,error:'快捷键设置格式不正确'};
    if (Object.keys(value).some(id=>!defaults[id])) return {ok:false,error:'包含未知快捷键操作'};
    const bindings = {};
    for (const d of definitions) {
      const b = value[d.id] || defaults[d.id];
      if (!b || !Object.hasOwn(codes,b.code) || !Number.isInteger(b.mods) || b.mods<0 || b.mods>15) return {ok:false,error:d.label+'：请选择一个有效按键'};
      if ((b.mods & 8) && ['KeyQ','KeyW','KeyH','KeyM','Space','Tab'].includes(b.code)) return {ok:false,error:label(b)+' 是系统常用快捷键，请选择其他按键'};
      bindings[d.id]={code:b.code,mods:b.mods};
    }
    for (const group of ['study','roam']) {
      const used = new Map();
      for (const d of definitions.filter(d=>d.group===group || d.group==='all')) {
        const b=bindings[d.id], aliases=[codes[b.code]+':'+b.mods];
        if (d.id.startsWith('move') && !(b.mods & 1)) aliases.push(codes[b.code]+':'+(b.mods|1));
        if (d.id==='help' && b.code==='Slash' && !b.mods) aliases.push('44:1');
        if (b.code==='Backspace') aliases.push('117:'+b.mods);
        for (const token of aliases) {
          if (used.has(token)) return {ok:false,error:label(b)+' 冲突：「'+used.get(token)+'」与「'+d.label+'」在同一场景中重复'};
          used.set(token,d.label);
        }
      }
    }
    return {ok:true,bindings};
  }
  function normalize(value) {const checked=validate(value || {});return checked.ok?checked.bindings:validate({}).bindings;}
  function actionFor(bindings, code, mods, group) {
    for (const d of definitions) {
      if (d.group!==group && d.group!=='all') continue;
      const b=bindings[d.id], key=codes[b.code];
      if (code!==key && !(b.code==='Enter' && code===76) && !(b.code==='Backspace' && code===117)) continue;
      if (mods===b.mods || (d.id.startsWith('move') && mods===(b.mods|1)) || (d.id==='help' && b.code==='Slash' && !b.mods && mods===1)) return d.id;
    }
    return '';
  }
  return {codes,definitions,defaults,label,validate,normalize,actionFor};
});
