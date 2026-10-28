#!/usr/bin/env python3
"""Exercise the actual generated Cocoa pet in an isolated process and data dir."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'scripts/build/idle-check'
OUT.mkdir(parents=True, exist_ok=True)
subprocess.run(['node', 'scripts/test_patrick_idle.js', '--fixtures', str(OUT)], cwd=ROOT, check=True)
if sys.platform != 'darwin':
    raise SystemExit(0)
subprocess.run(['node', 'scripts/test_quiz.js', '--fixtures', str(OUT)], cwd=ROOT, check=True)
subprocess.run(['sips', '-s', 'format', 'png', str(OUT/'normal.svg'), '--out', str(OUT/'normal.png')], check=True, capture_output=True)
source = (OUT/'patrick-idle.jxa.js').read_text()
geom = json.loads((OUT/'normal.json').read_text())
geom['id'] = 'idle-native-quiz'
test = r'''
  M.ownerPid=0; M.idleFile=IDLEFILE; M.quizPng=QUIZPNG;
  var assertions=0;
  function check(ok,msg){if(!ok)throw new Error(msg);assertions++;}
  function snapshot(view,file){
    view.display;
    var bounds=view.bounds,rep=view.bitmapImageRepForCachingDisplayInRect(bounds);
    view.cacheDisplayInRectToBitmapImageRep(bounds,rep);
    rep.representationUsingTypeProperties($.NSPNGFileType,$({})).writeToFileAtomically(file,true);
  }
  function seed(ms){
    idleClock=createIdleClock({userKey:'native-test',studyAt:1,elapsedMs:ms});
    updateIdleContext({userKey:'native-test',studyAt:1,eligible:true},Date.now());
  }
  x=80;y=180;setFrame();
  var outside={x:screen.origin.x+screen.size.width-1,y:screen.origin.y+screen.size.height-1};
  check(Object.keys(idleSkinMasks).length===22,'missing native skin masks');
  seed(1080000);tickPatrickIdle(Date.now(),outside);
  check(idleTimerWin.isVisible,'15-minute clock did not appear');
  check(idleClock.format()==='18:00','clock did not retain total elapsed time');
  st.frame=FR.angry0;snapshot(grip,HOTPET);snapshot(idleTimerView,TIMER);
  idleLine='你的单词没动，我的血压在动。';snapshot(idleNudgeView,NUDGE);
  var before=idleTimerWin.frame.origin.x;
  x+=30;setFrame();tickPatrickIdle(Date.now(),outside);
  check(Math.abs(idleTimerWin.frame.origin.x-before-30)<1,'timer does not follow pet');
  seed(480000);st.frame=FR.sad0;snapshot(grip,SADPET);
  seed(120000);st.frame=FR.idle0;snapshot(grip,CALMPET);
  seed(1080000);st.quiz=true;lastQuizGeom=GEOM;st.quizResultHideAt=0;speakPendingUntil=0;
  var now=Date.now();
  tickPatrickIdle(now,outside);check(!quizWin,'pending question opened without hover');
  var pointer={x:x+W/2,y:y+H/2};tickPatrickIdle(now+50,pointer);tickPatrickIdle(now+250,pointer);
  check(!!quizWin,'hover did not reveal pending question');
  check(idleRevealFxAt>0,'hover sparkle was not triggered');
  tickPatrickIdle(now+300,pointer);
  var q=quizWin.frame,t=idleTimerWin.frame;
  check(t.origin.x+t.size.width<=q.origin.x||t.origin.x>=q.origin.x+q.size.width||t.origin.y+t.size.height<=q.origin.y||t.origin.y>=q.origin.y+q.size.height,'timer overlaps question');
  var onCard={x:q.origin.x+q.size.width/2,y:q.origin.y+q.size.height/2};
  tickPatrickIdle(now+500,onCard);check(!!quizWin,'moving onto question hid it');
  tickPatrickIdle(now+600,outside);tickPatrickIdle(now+1350,outside);
  check(!quizWin&&st.quiz,'leaving must hide the card while keeping its question');
  seed(1080000);idleLocked=true;tickPatrickIdle(now+1400,outside);tickPatrickIdle(now+2400,outside);
  check(idleClock.snapshot().elapsedMs===1080000&&!idleTimerWin.isVisible,'lock must pause timer and hide overlays');idleLocked=false;
  updateIdleContext({userKey:'native-test',studyAt:2,eligible:true},Date.now());tickPatrickIdle(Date.now(),outside);
  check(idleClock.snapshot().elapsedMs===0&&!idleTimerWin.isVisible,'learning did not clear and hide timer');
  // Exercise the real 20 fps walk branch with a pending but hidden question.
  st.mode='walk';st.target=x+40;st.targetY=y;st.walkFromX=x;st.walkFromY=y;st.walkStart=Date.now();st.walkDur=1000;st.walkDist=40;
  var from=x;$.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(.25));
  check(x>from,'pending question still freezes walking');
  saveIdleClock();check($.NSFileManager.defaultManager.fileExistsAtPath(M.idleFile),'clock was not persisted');
  hideQuizCard();idleTimerWin.orderOut($());idleNudgeWin.orderOut($());win.orderOut($());
  return 'PASS '+assertions+' native idle checks';
'''
tokens = {'IDLEFILE':str(OUT/'idle-state.json'),'QUIZPNG':str(OUT/'normal.png'),
          'HOTPET':str(OUT/'hot.png'),'CALMPET':str(OUT/'calm.png'),'SADPET':str(OUT/'sad.png'),
          'TIMER':str(OUT/'timer.png'),'NUDGE':str(OUT/'nudge.png'),'GEOM':geom}
import re
test = re.sub(r'\b('+'|'.join(tokens)+r')\b',lambda m:json.dumps(tokens[m.group()]),test)
source=source.replace('  $.NSApplication.sharedApplication.run;',test)
(OUT/'native-test.jxa.js').write_text(source)
result=subprocess.run(['osascript','-l','JavaScript',str(OUT/'native-test.jxa.js')],capture_output=True,text=True,timeout=45)
print(result.stdout, result.stderr, flush=True)
if result.returncode:
    raise SystemExit(result.returncode)
