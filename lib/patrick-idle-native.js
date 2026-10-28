// Injected inside buildPatrickJXA.run. Keep native presentation out of the clock.
var idleSaved = {};
try {
  var idleText = $.NSString.stringWithContentsOfFileEncodingError(M.idleFile, $.NSUTF8StringEncoding, $());
  idleSaved = JSON.parse(idleText.js);
} catch (e) {}
var idleClock = createIdleClock(idleSaved), idleState = idleClock.snapshot();
var idleContextAt = 0, idleLocked = false, idleSleeping = false;
var idleHoverAt = 0, idleLeaveAt = 0, idleRevealAt = 0, idleShownId = '';
var idleNudgeAt = Date.now() + 300000, idleNudgeUntil = 0, idleLine = '', idleLineIndex = 0;
var idleLastPhase = idleState.phase, idleLastSecond = -1, idleRevealFxAt = 0;
var idleTimerWin = null, idleTimerView = null, idleNudgeWin = null, idleNudgeView = null;
var idleObservers = [];
function idleWatch(center, name, callback) {
  idleObservers.push(center.addObserverForNameObjectQueueUsingBlock(name, $(), $.NSOperationQueue.mainQueue, callback));
}
idleWatch($.NSDistributedNotificationCenter.defaultCenter, 'com.apple.screenIsLocked', function(){ idleLocked = true; });
idleWatch($.NSDistributedNotificationCenter.defaultCenter, 'com.apple.screenIsUnlocked', function(){ idleLocked = false; });
idleWatch($.NSWorkspace.sharedWorkspace.notificationCenter, $.NSWorkspaceWillSleepNotification, function(){ idleSleeping = true; saveIdleClock(); });
idleWatch($.NSWorkspace.sharedWorkspace.notificationCenter, $.NSWorkspaceDidWakeNotification, function(){ idleSleeping = false; });
idleWatch($.NSWorkspace.sharedWorkspace.notificationCenter, $.NSWorkspaceSessionDidResignActiveNotification, function(){ idleLocked = true; });
idleWatch($.NSWorkspace.sharedWorkspace.notificationCenter, $.NSWorkspaceSessionDidBecomeActiveNotification, function(){ idleLocked = false; });
function saveIdleClock() {
  $.NSString.stringWithString(JSON.stringify(idleClock.snapshot())).writeToFileAtomicallyEncodingError(M.idleFile, true, $.NSUTF8StringEncoding, $());
}
function updateIdleContext(value, now) {
  idleClock.context(value); idleContextAt = now; idleState = idleClock.snapshot();
}
function idleRectContains(r, p, pad) {
  return p.x >= r.origin.x-pad && p.x <= r.origin.x+r.size.width+pad && p.y >= r.origin.y-pad && p.y <= r.origin.y+r.size.height+pad;
}
function idleInteractionContains(p) {
  if (idleRectContains(win.frame, p, 0)) return true;
  if (!quizWin) return false;
  var a=win.frame,b=quizWin.frame;
  if (idleRectContains(b,p,5)) return true;
  // The short corridor between pet and card keeps a crossing pointer engaged.
  var left=Math.max(a.origin.x,b.origin.x),right=Math.min(a.origin.x+a.size.width,b.origin.x+b.size.width);
  var bottom=Math.max(a.origin.y,b.origin.y),top=Math.min(a.origin.y+a.size.height,b.origin.y+b.size.height);
  if (right<left && left-right<35 && top>bottom) return p.x>=right&&p.x<=left&&p.y>=bottom&&p.y<=top;
  if (top<bottom && bottom-top<35 && right>left) return p.x>=left&&p.x<=right&&p.y>=top&&p.y<=bottom;
  return false;
}
function makeIdleWindow(name, width, height, draw) {
  ObjC.registerSubclass({name:name,superclass:'NSView',methods:{'drawRect:':draw}});
  var w=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(0,0,width,height),0,2,false);
  w.opaque=false; w.backgroundColor=$.NSColor.clearColor; w.hasShadow=true;
  w.level=$.NSFloatingWindowLevel+1; w.ignoresMouseEvents=true;
  w.collectionBehavior=$.NSWindowCollectionBehaviorCanJoinAllSpaces|$.NSWindowCollectionBehaviorIgnoresCycle;
  var view=$[name].alloc.initWithFrame($.NSMakeRect(0,0,width,height));w.contentView.addSubview(view);
  return {win:w,view:view};
}
function drawIdlePanel(rect) {
  (darkSkin?rgba(.24,.12,.16,.98):rgba(1,.91,.87,.98)).setFill;
  var shape=$.NSBezierPath.bezierPathWithRoundedRectXRadiusYRadius(rect,13,13);shape.fill;
  rgba(.93,.39,.34,.8).setStroke;shape.lineWidth=1;shape.stroke;
}
function idleDrawText(text,rect,size,bold,color) {
  var attrs=$.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey(fontAt(size,bold),$.NSFontAttributeName);
  attrs.setObjectForKey(color,$.NSForegroundColorAttributeName);
  $.NSString.stringWithString(text).drawInRectWithAttributes(rect,attrs);
}
var idleTimerPair=makeIdleWindow('DWPatrickIdleTimer',132,66,function(){
  drawIdlePanel($.NSMakeRect(1,1,130,64));
  idleDrawText('未学习',$.NSMakeRect(12,41,108,16),10.5,false,darkSkin?rgba(1,.63,.57,1):rgba(.67,.22,.17,1));
  var text=idleClock.format(),size=text.length>5?19:25;
  var font=$.NSFont.monospacedDigitSystemFontOfSizeWeight(size,.4);
  var attrs=$.NSMutableDictionary.alloc.init;
  attrs.setObjectForKey(font,$.NSFontAttributeName);
  attrs.setObjectForKey(darkSkin?rgba(1,.93,.93,1):rgba(.20,.12,.18,1),$.NSForegroundColorAttributeName);
  $.NSString.stringWithString(text).drawInRectWithAttributes($.NSMakeRect(12,9,112,32),attrs);
});
idleTimerWin=idleTimerPair.win;idleTimerView=idleTimerPair.view;
var idleNudgePair=makeIdleWindow('DWPatrickIdleNudge',274,62,function(){
  drawIdlePanel($.NSMakeRect(1,1,272,60));
  idleDrawText(idleLine,$.NSMakeRect(14,9,246,43),12,false,darkSkin?rgba(1,.93,.93,1):rgba(.20,.12,.18,1));
});
idleNudgeWin=idleNudgePair.win;idleNudgeView=idleNudgePair.view;
function idleVisible(w, visible) {
  if (visible) { if (!w.isVisible) w.orderFrontRegardless; }
  else if (w.isVisible) w.orderOut($());
}
function idlePosition(w, above) {
  var sf=win.screen?win.screen.visibleFrame:screen,fw=w.frame.size.width,fh=w.frame.size.height;
  var minX=sf.origin.x+8,maxX=sf.origin.x+sf.size.width-fw-8,minY=sf.origin.y+8,maxY=sf.origin.y+sf.size.height-fh-8;
  var candidates=above?[{x:x+(W-fw)/2,y:y+H+8},{x:x+(W-fw)/2,y:y-fh-10}]:
    [{x:x+W+10,y:y+H*.20},{x:x-fw-10,y:y+H*.20},{x:x+(W-fw)/2,y:y-fh-10},{x:x+(W-fw)/2,y:y+H+8}];
  var blocks=[];if(quizWin)blocks.push(quizWin.frame);if(speakWin)blocks.push(speakWin.frame);if(above&&idleTimerWin.isVisible)blocks.push(idleTimerWin.frame);
  function clear(p){return blocks.every(function(b){return p.x+fw+5<=b.origin.x||p.x>=b.origin.x+b.size.width+5||p.y+fh+5<=b.origin.y||p.y>=b.origin.y+b.size.height+5;});}
  var chosen=null;
  for(var i=0;i<candidates.length;i++){
    var c=candidates[i];c.x=Math.max(minX,Math.min(maxX,c.x));c.y=Math.max(minY,Math.min(maxY,c.y));
    var overlapsPet=c.x<x+W&&c.x+fw>x&&c.y<y+H&&c.y+fh>y;
    if(!overlapsPet&&clear(c)){chosen=c;break;}
  }
  if(!chosen)chosen=candidates[0];
  w.setFrameOrigin($.NSMakePoint(Math.round(chosen.x),Math.round(chosen.y)));
}
function revealIdleQuiz(now) {
  if (!st.quiz || !lastQuizGeom || quizWin) return;
  bubble=null;st.target=null;st.mode='hover';idleRevealFxAt=now;idleRevealAt=now;
  playSeq([FR.wave0,FR.wave1,FR.wave0],100,true,null);
  showQuizCard();
}
function tickPatrickIdle(now, pointer) {
  var paused=idleLocked||idleSleeping||now-idleContextAt>5000;
  idleState=idleClock.tick(now,paused);
  if(idleState.phase!==idleLastPhase){
    idleLastPhase=idleState.phase;idleNudgeAt=now+700;idleNudgeUntil=0;
    if(!idleState.phase){saveIdleClock();idleLine='';}
  }
  var p=pointer||$.NSEvent.mouseLocation;
  st.hover=!paused&&idleRectContains(win.frame,p,0);
  if(st.hover){if(!idleHoverAt)idleHoverAt=now;}else idleHoverAt=0;
  if(!paused&&st.mode!=='drag'&&st.mode!=='jump'){
    if(st.hover&&st.quiz&&!quizWin&&now-idleHoverAt>=180)revealIdleQuiz(now);
    var engaged=idleInteractionContains(p);
    if(engaged)idleLeaveAt=0;else if(!idleLeaveAt)idleLeaveAt=now;
    if(quizWin&&cardKind==='quiz'&&!engaged&&now-idleLeaveAt>=700&&!speakWin&&now>speakPendingUntil&&!st.quizResultHideAt){
      hideQuizCard();st.mode='idle';st.target=null;st.animSeq=null;st.idleHoldUntil=now+900;
    }
    if(quizWin&&cardKind==='quiz'&&idleRevealAt&&now-idleRevealAt>=250&&lastQuizGeom&&idleShownId!==lastQuizGeom.id){
      idleShownId=lastQuizGeom.id;idleRevealAt=0;postUrl('http://127.0.0.1:'+M.port+'/pet-quiz-shown.php','');
    }
  }
  var timerVisible=!paused&&idleState.eligible&&idleState.phase===2;
  if(timerVisible){idlePosition(idleTimerWin,false);var second=Math.floor(idleState.elapsedMs/1000);if(second!==idleLastSecond){idleLastSecond=second;idleTimerView.setNeedsDisplay(true);}}
  idleVisible(idleTimerWin,timerVisible);
  var quiet=!paused&&idleState.eligible&&!st.hover&&!quizWin&&!speakWin&&!bubble&&st.mode!=='drag';
  if(quiet&&idleState.phase&&now>=idleNudgeAt){
    var lines=idleState.phase===2?['你的单词没动，我的血压在动。','再不背，我就把单词写在裤衩上了！']:['我都走三圈了，你还没背一个词。','你是不是忘了，桌面上还有一位知识分子？'];
    idleLine=lines[idleLineIndex++%lines.length];idleNudgeUntil=now+4500;idleNudgeAt=now+(idleState.phase===2?120000:90000);idleNudgeView.setNeedsDisplay(true);
  }
  idleVisible(idleNudgeWin,quiet&&now<idleNudgeUntil);
  if(idleNudgeWin.isVisible)idlePosition(idleNudgeWin,true);
}
// Redraw only the pink skin pixels, keeping eyes, outline and shorts intact.
var idleSkinMasks={};
function prepareIdleSkinMasks(){
  try{
    var text=$.NSString.stringWithContentsOfFileEncodingError(M.idleMasksPath,$.NSUTF8StringEncoding,$());
    var frames=JSON.parse(text.js);
    Object.keys(frames).forEach(function(idx){
      var mask=$.NSBezierPath.bezierPath;
      frames[idx].forEach(function(r){mask.appendBezierPathWithRect($.NSMakeRect(r[0],r[1],r[2],r[3]));});
      idleSkinMasks[idx]=mask;
    });
  }catch(e){idleSkinMasks={};}
}
prepareIdleSkinMasks();
function drawIdleMood(idx,R){
  if(idleState.phase===1&&idleState.eligible&&st.mode==='idle'){
    var sigh=reduceMotion()?.5:(Date.now()%3600)/3600;
    rgba(.64,.55,.67,Math.sin(sigh*Math.PI)*.8).setFill;
    for(var d=0;d<3;d++)$.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(W*.77+d*5,H*.40+sigh*9,2.5,2.5)).fill;
  }
  if(idleState.phase===2&&idleState.eligible){
    $.NSGraphicsContext.saveGraphicsState;
    var tr=$.NSAffineTransform.transform;tr.translateXByYBy(R.origin.x,R.origin.y);tr.scaleXByYBy(R.size.width/CELL.w,R.size.height/CELL.h);tr.concat;
    rgba(.95,.20,.18,.44).setFill;if(idleSkinMasks[idx])idleSkinMasks[idx].fill;
    $.NSGraphicsContext.restoreGraphicsState;
    rgba(.93,.40,.34,.75).setStroke;
    for(var i=0;i<3;i++){
      var steam=$.NSBezierPath.bezierPath,age=reduceMotion()?.5:((Date.now()/1700+i/3)%1);
      var sx=R.origin.x+R.size.width*(.39+i*.10),sy=H*.86+age*H*.07;
      steam.moveToPoint($.NSMakePoint(sx,sy));steam.curveToPointControlPoint1ControlPoint2($.NSMakePoint(sx,sy+H*.07),$.NSMakePoint(sx-4,sy+H*.025),$.NSMakePoint(sx+4,sy+H*.05));steam.lineWidth=2;steam.stroke;
    }
  }
  var age=(Date.now()-idleRevealFxAt)/650;
  if(age>=0&&age<1&&!reduceMotion()){
    rgba(1,.64,.78,1-age).setStroke;var radius=W*(.28+age*.18);
    var ring=$.NSBezierPath.bezierPathWithOvalInRect($.NSMakeRect(W/2-radius,H/2-radius,radius*2,radius*2));ring.lineWidth=2;ring.stroke;
    for(var j=0;j<5;j++){var a=j*Math.PI*2/5,px=W/2+Math.cos(a)*radius,py=H/2+Math.sin(a)*radius;var star=$.NSBezierPath.bezierPath;star.moveToPoint($.NSMakePoint(px-4,py));star.lineToPoint($.NSMakePoint(px+4,py));star.moveToPoint($.NSMakePoint(px,py-4));star.lineToPoint($.NSMakePoint(px,py+4));star.stroke;}
  }
}
