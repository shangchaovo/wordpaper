// Injected into buildPatrickJXA.run. Local events only: typing in another app,
// chat or sentence window never controls the pet or changes learning records.
var walkKeys = {}, shortcutKeys = {}, keyboardPaused = false, keyboardFast = false;
var keyboardLastTick = 0, keyboardDistance = 0, keyboardPending = false;
var keyboardHelpWin = null, keyboardHelpUntil = 0, keyboardHideUntil = 0;
var keyboardBindings = shortcutApi.normalize(M.shortcuts);
function keyboardLabel(id) { return shortcutApi.label(keyboardBindings[id]); }
function samePatrickWindow(a, b) {
  return !!a && !!b && Number(a.windowNumber) === Number(b.windowNumber);
}
function patrickKeyboardFocused() {
  return !!(win.isKeyWindow || (quizWin && quizWin.isKeyWindow) || (speakWin && speakWin.isKeyWindow));
}
function focusPatrickWindow(window) {
  if (!window) return;
  window.makeKeyAndOrderFront($());
  var view = samePatrickWindow(window, win) ? grip : samePatrickWindow(window, quizWin) ? quizGripView : speakView;
  if (view) window.makeFirstResponder(view);
  keyboardHideUntil = 0;
}
function returnPatrickFocus(window) {
  if (window && window.isKeyWindow) focusPatrickWindow(win);
}
function walkKeysActive() { return Object.keys(walkKeys).length > 0; }
function walkingDirection(action) { return Object.keys(walkKeys).some(function(code){ return walkKeys[code] === action; }) ? 1 : 0; }
function clearWalkKeys() {
  walkKeys = {}; keyboardFast = false;
  if (st.mode === 'keyboard') {
    st.mode = 'idle'; st.target = null; st.frame = FR.idle0;
    st.idleHoldUntil = Date.now() + 1800;
    savePos();
  }
}
function keyboardStudying() { return !!((quizWin && cardKind === 'quiz') || speakWin || Date.now() < speakPendingUntil); }
function keyboardContext(action) {
  var context = { action: action };
  if (quizWin && cardKind === 'quiz' && lastQuizGeom) context.quizId = lastQuizGeom.id;
  else if (speakSession) {
    if (speakSession.quizId) context.quizId = speakSession.quizId;
    else {
      context.wordKey = speakSession.wordKey; context.index = speakSession.wordIndex;
      context.exampleIndex = speakSession.exampleIndex;
    }
  }
  return context;
}
function sendPatrickKey(action, extra) {
  if (keyboardPending) return;
  var payload = keyboardContext(action);
  if (extra) Object.keys(extra).forEach(function(key){ payload[key] = extra[key]; });
  keyboardPending = true;
  if (action === 'replay' || action === 'example-prev' || action === 'example-next' || action === 'example-generate') {
    stopSpeakAudio(); speakPendingUntil = Date.now() + 5000;
  }
  var req = $.NSMutableURLRequest.alloc.initWithURL($.NSURL.URLWithString('http://127.0.0.1:' + M.port + '/pet-key.php'));
  req.setHTTPMethod('POST'); req.setTimeoutInterval(5);
  req.setValueForHTTPHeaderField('application/json', 'Content-Type');
  req.setHTTPBody($.NSString.stringWithString(JSON.stringify(payload)).dataUsingEncoding($.NSUTF8StringEncoding));
  $.NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, $.NSOperationQueue.mainQueue, function(resp, data, err){
    keyboardPending = false;
    try {
      var result = data && JSON.parse($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js);
      if (result && result.mastered) showKeyboardHelp(false, result.word + ' 已标熟 · 不再安排复习');
      else if (result && result.empty) showKeyboardHelp(false, '当前没有其他待学单词');
      else if (!result || !result.ok) showKeyboardHelp(false, '词卡已变化，请重试');
    } catch (e) { showKeyboardHelp(false, '操作未完成，请重试'); }
  });
}
function hideKeyboardHelp() {
  if (keyboardHelpWin) keyboardHelpWin.orderOut($());
  keyboardHelpUntil = 0;
}
function showKeyboardHelp(full, message) {
  if (keyboardHelpWin) keyboardHelpWin.orderOut($());
  var k = keyboardLabel;
  var rows = full ? [
    '背词：' + k('remember') + ' 标熟 · ' + k('next') + ' 下一个',
    [0,1,2,3].map(function(i){return k('answer'+i);}).join(' / ') + ' 选择 A / B / C / D',
    k('example-prev') + ' / ' + k('example-next') + ' 换例句 · ' + k('replay') + ' 重听',
    k('expand') + ' 展开释义 · ' + k('sentence') + ' 答题后造句',
    k('scrollUp') + ' / ' + k('scrollDown') + ' 滚动长卡片',
    '走动：' + ['moveUp','moveDown','moveLeft','moveRight'].map(k).join(' ') + ' · Shift 加速',
    k('pause') + ' 暂停散步 · ' + k('start') + ' 开始背词',
    k('chat') + ' 聊天 · ' + k('dismiss') + ' 收起卡片',
    k('settings') + ' 自定义快捷键 · ' + k('help') + ' 收起帮助'
  ] : [message || '已选中派大星 · ' + k('start') + ' 背词 · Shift 加速走动',
    k('chat') + ' 聊天 · ' + k('help') + ' 帮助 · ' + k('settings') + ' 自定义快捷键'];
  var width = 420, wrapped = [], attributes = $.NSMutableDictionary.alloc.init;
  attributes.setObjectForKey(fontAt(12,false),$.NSFontAttributeName);
  rows.forEach(function(row){
    var line='';
    Array.from(row).forEach(function(letter){
      if(line && $.NSString.stringWithString(line+letter).sizeWithAttributes(attributes).width > width-32){wrapped.push(line);line='';}
      line+=letter;
    });
    if(line)wrapped.push(line);
  });
  rows=wrapped;
  var height = rows.length * 24 + 42;
  var pair = makeIdleWindow('DWPatrickKeys' + Date.now(), width, height, function(){
    (darkSkin ? rgba(.15,.12,.18,.98) : rgba(1,.97,.97,.98)).setFill;
    $.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius($.NSMakeRect(1,1,width-2,height-2),14,14).fill;
    var ink = darkSkin ? rgba(1,.93,.96,1) : rgba(.24,.15,.20,1);
    idleDrawText(full ? '派大星快捷键' : '键盘控制', $.NSMakeRect(16,height-29,width-32,19),13,true,ink);
    rows.forEach(function(line,i){idleDrawText(line,$.NSMakeRect(16,height-55-i*24,width-32,20),12,false,ink);});
  });
  keyboardHelpWin = pair.win; idlePosition(keyboardHelpWin, true);
  keyboardHelpWin.orderFrontRegardless;
  keyboardHelpUntil = Date.now() + (full ? 60000 : 5000);
}
function handlePatrickKey(code, down, repeat, flags) {
  if (!down) {
    delete shortcutKeys[code]; delete walkKeys[code];
    if (!walkKeysActive()) clearWalkKeys();
    return false;
  }
  keyboardFast = !!(flags & (1 << 17));
  var mods = (keyboardFast?1:0) | ((flags & (1<<18))?2:0) | ((flags & (1<<19))?4:0) | ((flags & (1<<20))?8:0);
  var study = keyboardStudying(), action = shortcutApi.actionFor(keyboardBindings, code, mods, study ? 'study' : 'roam');
  if (!action) return false;
  if (action.indexOf('move') === 0) {
    walkKeys[code] = action; st.target = null; st.animSeq = null; bubble = null;
    keyboardHideUntil = 0; hideKeyboardHelp(); return true;
  }
  if (repeat || shortcutKeys[code]) return true; // One press cannot mark several consecutive words.
  shortcutKeys[code] = true;
  if (action === 'dismiss') {
    clearWalkKeys(); hideKeyboardHelp();
    if (study) sendPatrickKey('dismiss');
    hideSpeakCard(); hideQuizCard(); bubble = null;
    st.mode = 'idle'; st.target = null; st.animSeq = null; st.idleHoldUntil = Date.now() + 1000;
    keyboardHideUntil = Date.now() + 1500;
    return true;
  }
  if (action === 'help') {
    if (keyboardHelpUntil > Date.now()) hideKeyboardHelp(); else showKeyboardHelp(true);
    return true;
  }
  if (action === 'chat' || action === 'settings') {
    clearWalkKeys(); hideKeyboardHelp();
    postUrl('http://127.0.0.1:' + M.port + (action === 'chat' ? '/pet-chat-window.php?action=open' : '/pet-shortcuts-window.php'), '');
    return true;
  }
  if (action === 'next' || action === 'start') {
    clearWalkKeys(); hideKeyboardHelp();
    if (!study && st.quiz && lastQuizGeom) revealIdleQuiz(Date.now());
    else sendPatrickKey(study ? 'next' : 'start');
    return true;
  }
  if (action === 'replay' || action === 'pause') {
    if (action === 'replay') sendPatrickKey('replay');
    else {
      clearWalkKeys(); keyboardPaused = !keyboardPaused;
      st.mode = 'idle'; st.target = null; st.animSeq = null;
      showKeyboardHelp(false, keyboardPaused ? '已暂停自动散步 · 方向键仍可控制' : '已恢复自动散步');
    }
    return true;
  }
  if (!study) return false;
  if (action === 'scrollUp' || action === 'scrollDown') {
    var view = speakWin ? speakView : quizGripView;
    if (view) {
      var bounds = view.visibleRect, top = Math.max(0, view.frame.size.height - bounds.size.height);
      view.scrollPoint($.NSMakePoint(0, Math.max(0, Math.min(top, bounds.origin.y + (action === 'scrollUp' ? 70 : -70)))));
    }
  } else if (action.indexOf('answer') === 0) sendPatrickKey('answer', {picked:Number(action.slice(-1))});
  else sendPatrickKey(action);
  return true;
}
function tickPatrickKeyboard(now) {
  var dt = Math.max(0, Math.min(80, now - (keyboardLastTick || now))); keyboardLastTick = now;
  if (!patrickKeyboardFocused() || idleLocked || idleSleeping) {
    clearWalkKeys(); shortcutKeys = {}; hideKeyboardHelp(); return false;
  }
  if (keyboardHelpUntil && now > keyboardHelpUntil) hideKeyboardHelp();
  if (keyboardStudying() || st.mode === 'drag' || st.mode === 'jump') { clearWalkKeys(); return false; }
  if (!walkKeysActive()) return false;
  var dx = walkingDirection('moveRight') - walkingDirection('moveLeft');
  var dy = walkingDirection('moveUp') - walkingDirection('moveDown');
  var length = Math.sqrt(dx * dx + dy * dy), step = (keyboardFast ? 240 : 130) * dt / 1000;
  st.mode = 'keyboard'; st.target = null; st.animSeq = null; bubble = null;
  if (length) {
    var f = screenForPet(), oldX = x, oldY = y;
    x = Math.max(f.origin.x+4, Math.min(x+dx/length*step, f.origin.x+f.size.width-W-4));
    y = Math.max(f.origin.y+4, Math.min(y+dy/length*step, f.origin.y+f.size.height-H-4));
    keyboardDistance += Math.sqrt((x-oldX)*(x-oldX)+(y-oldY)*(y-oldY));
    if (dx) st.facing = dx > 0 ? 1 : -1;
    st.frame = reduceMotion() ? FR.idle0 : (st.facing === 1 ? FR.walkR0 : FR.walkL0) + Math.floor(keyboardDistance / 22) % 4;
    win.setFrameOrigin($.NSMakePoint(x,y));
  }
  return true;
}
function patrickKeyEvent(event, down) {
  if (!patrickKeyboardFocused()) return;
  handlePatrickKey(Number(event.keyCode), down, !!event.isARepeat, Number(event.modifierFlags));
}
function patrickFlagsChanged(event) {
  keyboardFast = !!(Number(event.modifierFlags) & (1 << 17));
  // Releasing modifiers also releases any movement chord that required them.
  var flags=Number(event.modifierFlags),mods=(keyboardFast?1:0)|((flags&(1<<18))?2:0)|((flags&(1<<19))?4:0)|((flags&(1<<20))?8:0);
  Object.keys(walkKeys).forEach(function(code){if(!shortcutApi.actionFor(keyboardBindings,Number(code),mods,'roam'))delete walkKeys[code];});
  if(!walkKeysActive())clearWalkKeys();
}
grip.toolTip = '单击选中后可用键盘控制 · 快捷键可在主窗口的「快捷键设置」中修改';
