#!/usr/bin/env python3
"""Actual AppKit key events in a temporary Patrick window; no user data or TCC."""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'scripts/build/shortcut-check'
OUT.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', 'scripts/test_patrick_shortcuts.js', '--fixtures', str(OUT)], cwd=ROOT, check=True)
if sys.platform != 'darwin':
    raise SystemExit(0)
subprocess.run(['node', 'scripts/test_quiz.js', '--fixtures', str(OUT)], cwd=ROOT, check=True)
subprocess.run(['sips', '-s', 'format', 'png', str(OUT/'normal.svg'), '--out', str(OUT/'normal.png')], check=True, capture_output=True)
geom = json.loads((OUT/'normal.json').read_text())
geom['id'] = 'keyboard-native-quiz'
source = (OUT/'patrick.jxa.js').read_text()
test = r'''
  M.ownerPid=0;M.port=0;M.idleFile=IDLEFILE;M.posFile=POSFILE;M.quizPng=QUIZPNG;
  var previousApp=$.NSWorkspace.sharedWorkspace.frontmostApplication;
  var checks=0,calls=[];
  function check(ok,msg){if(!ok)throw new Error(msg);checks++;}
  function settle(){ $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(.12)); }
  postUrl=function(url,body){calls.push({url:url,body:body});};
  sendPatrickKey=function(action,extra){calls.push({action:action,context:keyboardContext(action),extra:extra});};
  function key(code,down,repeat,flags,target){
    var event=$.NSEvent.keyEventWithTypeLocationModifierFlagsTimestampWindowNumberContextCharactersCharactersIgnoringModifiersIsARepeatKeyCode(
      down?$.NSEventTypeKeyDown:$.NSEventTypeKeyUp,$.NSMakePoint(0,0),flags||0,0,(target||win).windowNumber,$(),$(''),$(''),!!repeat,code);
    $.NSApplication.sharedApplication.sendEvent(event);
  }
  function press(code,flags){key(code,true,false,flags);key(code,false,false,flags);}
  x=200;y=200;setFrame();st.quiz=false;st.hover=false;keyboardPaused=true;
  focusPatrickWindow(win);settle();
  check(win.canBecomeKeyWindow&&win.isKeyWindow&&patrickKeyboardFocused(),'borderless pet cannot take keyboard focus: can='+win.canBecomeKeyWindow+' key='+win.isKeyWindow+' active='+$.NSApplication.sharedApplication.isActive);
  var now=Date.now(),fromX=x,fromY=y;keyboardLastTick=now;
  key(124,true);tickPatrickKeyboard(now+50);tickPatrickKeyboard(now+100);
  check(x>fromX&&Math.abs(y-fromY)<1&&st.facing===1,'right key did not move right');
  key(126,true);var diagonalX=x,diagonalY=y;tickPatrickKeyboard(now+150);
  check(x>diagonalX&&y>diagonalY,'held diagonal movement failed');
  check(Math.abs(Math.hypot(x-diagonalX,y-diagonalY)-6.5)<.1,'diagonal movement is faster than straight movement');
  key(124,false);key(126,false);var stoppedX=x,stoppedY=y;
  tickPatrickKeyboard(now+200);check(x===stoppedX&&y===stoppedY,'release did not stop walking');
  key(123,true,false,1<<17);tickPatrickKeyboard(now+250);key(123,false);
  check(stoppedX-x>10&&st.facing===-1,'Shift speed or left-facing pose failed');
  var frame=screenForPet();x=frame.origin.x+frame.size.width-W-5;key(124,true);tickPatrickKeyboard(now+300);key(124,false);
  check(x+W<=frame.origin.x+frame.size.width-4,'keyboard movement escaped the screen');
  x=200;y=200;setFrame();
  st.quiz=true;lastQuizGeom=GEOM;showQuizCard();focusPatrickWindow(quizWin);settle();
  check(quizWin.isKeyWindow&&patrickKeyboardFocused(),'quiz cannot take keyboard focus');
  lastQuizGeom.h+=20;syncQuizWinSize();settle();check(quizWin.isKeyWindow,'resizing the answer card lost keyboard focus');
  var outside={x:screen.origin.x+screen.size.width-1,y:screen.origin.y+screen.size.height-1};
  tickPatrickIdle(now+350,outside);tickPatrickIdle(now+1300,outside);
  check(!!quizWin,'keyboard-focused quiz disappeared when pointer left');
  key(51,true);key(51,true,true);key(51,true,true);key(51,false);
  check(calls.filter(function(c){return c.action==='remember';}).length===1,'held Delete marks multiple words');
  check(calls[calls.length-1].context.quizId==='keyboard-native-quiz','Delete lost the visible quiz identity');
  press(117);press(36);press(76);press(123);press(124);press(49);press(0);press(1);press(2);press(3);press(14);press(5);
  ['remember','next','example-prev','example-next','replay','answer','expand','sentence'].forEach(function(a){
    check(calls.some(function(c){return c.action===a;}),'missing shortcut: '+a);
  });
  check(calls.filter(function(c){return c.action==='answer';}).map(function(c){return c.extra.picked;}).join(',')==='0,1,2,3','ASDF keys select wrong answer');
  keyboardBindings.answer0={code:'KeyJ',mods:0};count=calls.length;press(0);press(38);
  check(calls.length===count+1&&calls[calls.length-1].extra.picked===0,'custom answer binding did not replace A immediately');
  keyboardBindings.answer0={code:'KeyJ',mods:8};count=calls.length;press(38,1<<20);
  check(calls.length===count+1&&calls[calls.length-1].extra.picked===0,'custom Command chord was not delivered');
  keyboardBindings=shortcutApi.normalize({});
  check(x===200&&y===200,'example arrows moved the pet while studying');
  var count=calls.length;press(51,1<<20);press(36,1<<19);
  check(calls.length===count,'Command/Option shortcuts changed learning');
  press(44);check(keyboardHelpWin&&keyboardHelpWin.isVisible,'help shortcut did not show its native panel');
  var view=keyboardHelpWin.contentView,bounds=view.bounds,rep=view.bitmapImageRepForCachingDisplayInRect(bounds);
  view.display;view.cacheDisplayInRectToBitmapImageRep(bounds,rep);
  rep.representationUsingTypeProperties($.NSPNGFileType,$({})).writeToFileAtomically(HELPSHOT,true);
  press(44);check(!keyboardHelpWin.isVisible,'help cannot be toggled off');
  press(53);check(!quizWin&&!speakWin&&win.isKeyWindow,'Escape did not return focus to the roaming pet');
  st.quiz=false;press(49);check(!keyboardPaused,'Space did not resume roaming');press(49);check(keyboardPaused,'Space did not pause roaming');
  key(124,true);tickPatrickKeyboard(now+1400);
  var editor=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(120,120,260,100),$.NSWindowStyleMaskTitled,2,false);
  var field=$.NSTextField.alloc.initWithFrame($.NSMakeRect(10,20,240,26));editor.contentView.addSubview(field);
  editor.makeKeyAndOrderFront($());editor.makeFirstResponder(field);settle();
  count=calls.length;var beforeX=x;
  key(51,true,false,0,editor);key(36,true,false,0,editor);key(123,true,false,0,editor);tickPatrickKeyboard(now+1500);
  check(calls.length===count,'editing keys reached pet shortcuts');
  check(!walkKeysActive()&&x===beforeX,'focus loss did not stop walking');
  editor.orderOut($());focusPatrickWindow(win);press(36);
  check(calls[calls.length-1].action==='start','Enter in roaming did not start study');
  hideKeyboardHelp();hideQuizCard();hideSpeakCard();win.orderOut($());
  idleTimerWin.orderOut($());idleNudgeWin.orderOut($());
  if(previousApp)previousApp.activateWithOptions(0);
  return 'PASS '+checks+' native keyboard checks';
'''
values={'IDLEFILE':str(OUT/'idle.json'),'POSFILE':str(OUT/'position.json'),
        'QUIZPNG':str(OUT/'normal.png'),'HELPSHOT':str(OUT/'keyboard-help.png'),'GEOM':geom}
test=re.sub(r'\b('+'|'.join(values)+r')\b',lambda m:json.dumps(values[m.group()]),test)
wrapped = '''
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(.25,false,function(){
    var result;
    try { result=(function(){ TESTBODY })(); }
    catch(error){ result='FAIL '+String(error); }
    $.NSString.stringWithString(result).writeToFileAtomicallyEncodingError(RESULTFILE,true,$.NSUTF8StringEncoding,$());
    $.exit(result.indexOf('PASS ')===0?0:1);
  });
  $.NSApplication.sharedApplication.run;
'''.replace('TESTBODY',test).replace('RESULTFILE',json.dumps(str(OUT/'native-result.txt')))
source=source.replace('  $.NSApplication.sharedApplication.run;',wrapped)
script=OUT/'native-test.jxa.js'
script.write_text(source)
(OUT/'native-result.txt').unlink(missing_ok=True)
result=subprocess.run(['osascript','-l','JavaScript',str(script)],capture_output=True,text=True,timeout=35)
print(result.stdout,result.stderr,flush=True)
if (OUT/'native-result.txt').exists():
    print((OUT/'native-result.txt').read_text(),flush=True)
if result.returncode:
    raise SystemExit(result.returncode)
