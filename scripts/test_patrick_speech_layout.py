#!/usr/bin/env python3
"""Render real speech SVGs and exercise the generated AppKit bubble in isolation."""
import argparse
import json
import math
import platform
import re
import subprocess
import struct
import tempfile
import wave
from pathlib import Path
from playwright.sync_api import sync_playwright, Error as PlaywrightError

ROOT = Path(__file__).resolve().parent.parent


def verify(out):
    subprocess.run(['node', 'scripts/test_patrick_speech.js', '--fixtures', str(out)], cwd=ROOT, check=True)
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True)
        except PlaywrightError as exc:
            if "Executable doesn't exist" not in str(exc):
                raise
            browser = p.chromium.launch(channel='chrome', headless=True)
        page = browser.new_page()
        for svg in out.glob('*.svg'):
            page.set_content(svg.read_text())
            bounds = page.evaluate('''() => {
              const s=document.querySelector('svg');
              return {w:s.viewBox.baseVal.width, h:s.viewBox.baseVal.height,
                text:[...s.querySelectorAll('text')].map(t=>{
                  const b=t.getBBox();return {text:t.textContent,x:b.x,y:b.y,w:b.width,h:b.height};
                })};
            }''')
            overflow = [t for t in bounds['text'] if t['x'] < 5 or t['x'] + t['w'] > bounds['w'] - 5
                        or t['y'] < 0 or t['y'] + t['h'] > bounds['h']]
            assert not overflow, (svg.name, overflow)
            page.set_viewport_size({'width': 700, 'height': min(1200, int(bounds['h'] * 2) + 16)})
            page.locator('svg').screenshot(path=str(out / (svg.stem + '-browser.png')))
            print('PASS rendered speech bounds:', svg.name, flush=True)
        browser.close()

    if platform.system() != 'Darwin':
        print('SKIP native speech test (macOS only)')
        return
    for name in ('dark', 'long'):
        subprocess.run(['sips', '-s', 'format', 'png', str(out / (name + '.svg')), '--out', str(out / (name + '.png'))], check=True, capture_output=True)
    source = (out / 'patrick.jxa.js').read_text()
    methods = source[source.index('  // 朗读气泡独立于 quizWin'):source.index('  var answerHideAt = 0;')]
    click = source[source.index('  function handleClick(){'):source.index('  /* 组装某个词的语音气泡行')]
    sprite = source[source.index('  function drawSprite('):source.index('  /* 答题特效:')]
    grip_source = source[source.index("var GripClass = ObjC.registerSubclass({ name: 'DWPatrickGrip'"):]
    sprite_draw = grip_source[grip_source.index("    'drawRect:':"):grip_source.index("    'acceptsFirstMouse:'")]
    geom = json.loads((out / 'dark.json').read_text())
    with wave.open(str(out / 'silent.wav'), 'wb') as wav:
        wav.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        wav.writeframes(b'\0\0' * 48000)
    with wave.open(str(out / 'syllables.wav'), 'wb') as wav:
        wav.setparams((1,2,16000,0,'NONE','not compressed'))
        wav.writeframes(b''.join(struct.pack('<h',int(12000*math.sin(2*math.pi*220*i/16000))
            if .2<i/16000<.65 or 1<i/16000<1.5 or 1.8<i/16000<2.6 else 0) for i in range(48000)))
    harness = '''ObjC.import('Cocoa');ObjC.import('AVFoundation');
function run(){
  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var x=300,y=220,W=190,H=206,darkSkin=true,bubble=null,cardKind='quiz',lastClickAt=0;
  var st={quiz:true,frame:21},FR={happy0:15,front0:21,idle0:0,blink:2,wave0:5,wave1:14},lastQuizGeom={id:'native-quiz'},calls=[];
  var M={speakPng:PNG,speakShownUrl:'/shown',speakUrl:'/speak',speakFinishedUrl:'/finished'};
  var win=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(x,y,W,H),0,2,false);
  var quizWin=$.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer($.NSMakeRect(500,180,300,296),0,2,false);
  var CELL={w:192,h:208,cols:6},sheet=$.NSImage.alloc.initWithContentsOfFile(SHEET);
  SPRITE
  function drawFx(){} function drawBubble(){}
  ObjC.registerSubclass({name:'DWTestPet',superclass:'NSView',methods:{ SPRITEDRAW }});
  var grip=$.DWTestPet.alloc.initWithFrame($.NSMakeRect(0,0,W,H));win.contentView.addSubview(grip);
  win.opaque=false;win.backgroundColor=$.NSColor.clearColor;win.orderFrontRegardless;
  var reduced=false;
  function reduceMotion(){return reduced;}
  function rgba(r,g,b,a){return $.NSColor.colorWithSRGBRedGreenBlueAlpha(r,g,b,a);}
  function fontAt(s,b){return $.NSFont.systemFontOfSizeWeight(s,b?0.5:0);}
  function postUrl(u,b){calls.push({url:u,body:JSON.parse(b)});}
  function assert(ok,msg){if(!ok)throw new Error(msg);}
  function tick(seconds){ $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds || .35)); }
  function snapshot(file){
    var v=speakWin.contentView,b=v.bounds,rep=v.bitmapImageRepForCachingDisplayInRect(b);
    v.cacheDisplayInRectToBitmapImageRep(b,rep);
    rep.representationUsingTypeProperties($.NSPNGFileType,$({})).writeToFileAtomically(file,true);
  }
  METHODS
  CLICK
  assert(Object.keys(mouthMasks).length===5,'mouth texture masks did not load');
  // Render the actual native mouth layer in every animated pose for inspection.
  var faces=[0,2,5,14,21],contact=$.NSImage.alloc.initWithSize($.NSMakeSize(960,416));
  contact.lockFocus;rgba(.13,.10,.16,1).setFill;$.NSBezierPath.bezierPathWithRect($.NSMakeRect(0,0,960,416)).fill;
  faces.forEach(function(f,i){
    drawSprite(f,$.NSMakeRect(i*192,208,192,208));
    var r=$.NSMakeRect(i*192,0,192,208);drawSprite(f,r);speakMouth={open:.7,round:i===4?.8:.3};drawSpeechMouth(f,r);
  });
  contact.unlockFocus;
  var rep=$.NSBitmapImageRep.imageRepWithData(contact.TIFFRepresentation);
  rep.representationUsingTypeProperties($.NSPNGFileType,$({})).writeToFileAtomically(MOUTHSHOTS,true);
  speakMouth={open:0,round:0};
  handleClick();
  assert(calls.length===1 && calls[0].body.quizId==='native-quiz','quiz click does not request its own word');
  assert(st.listenTap>0,'click does not animate Patrick');
  handleSpeakCommand({cmd:'speak-card',id:'speech-one',quizId:'native-quiz',w:GEOM.w,h:GEOM.h,lines:GEOM.lines}); tick();
  assert(quizWin!==null && st.quiz && cardKind==='quiz','speech replaced the quiz');
  tickSpeakCard(speakSession.openedAt+300);
  assert(calls[1].body.id==='speech-one','missing shown acknowledgement');
  tickSpeakCard(speakSession.openedAt+8000);
  assert(speakWin!==null && !speakExitAt,'fixed timeout hid speech before audio completion');
  handleSpeakCommand({cmd:'speak-audio',id:'speech-one',part:0,phase:'word',file:AUDIO,cues:[]});
  assert(speakPlayer && speakPlayer.isPlaying,'native audio did not start');
  speakPlayer.volume=0;tickSpeakMotion(Date.now());tickSpeakMotion(Date.now()+100);
  assert(speakMotion.active && speakMotion.amount>0,'reading motion did not start');
  var f1=speakingFrame(speakMotion.started+100),f2=speakingFrame(speakMotion.started+2700);
  assert(f1!==f2,'reading does not keep changing gestures');
  st.frame=f2;grip.setNeedsDisplay(true);tick();
  speakPlayer.stop;tickSpeakCard(Date.now());
  assert(calls[calls.length-1].body.part===0 && speakMotion.active,'word completion interrupted the sentence motion');
  var cues=[{start:0,end:.6,from:0,to:3,text:'She'},{start:.6,end:1.6,from:38,to:44,text:'plunge'},{start:1.6,end:2.8,from:54,to:59,text:'clear'}];
  handleSpeakCommand({cmd:'speak-audio',id:'speech-one',part:1,phase:'example',file:SYLLABLES,cues:cues});
  speakPlayer.volume=0;speakPlayer.currentTime=1.05;tick(.1);tickSpeakCard(Date.now());tickSpeakMotion(Date.now());
  assert(speakSample.db>-40 && speakMouth.open>.1,'real voiced audio did not open the mouth');
  assert(speakActiveCue.from===38,'highlight does not follow audio currentTime');
  assert(speakSample.cue===speakActiveCue,'lips and highlight are not sharing the same playback sample');
  speakView.setNeedsDisplay(true); tick(); snapshot(SNAPSHOT);
  speakPlayer.currentTime=.7;tick(.07);tickSpeakCard(Date.now());
  assert(speakSample.db<-47,'silent audio gap is not measured as silence');
  for(var mi=0;mi<7;mi++)tickSpeakMotion(Date.now()+mi*50);
  assert(speakMouth.open===0,'mouth kept moving during a real silent gap');
  speakPlayer.currentTime=1.8;tickSpeakCard(Date.now());
  assert(speakActiveCue.from===54,'highlight does not advance with audio');
  speakPlayer.stop;tickSpeakCard(Date.now());
  assert(!speakMotion.active && calls[calls.length-1].body.part===1,'final audio did not stop reading motion');
  assert(speakMouth.open===0,'mouth did not close at audio completion');
  for(var i=0;i<20;i++)tickSpeakMotion(Date.now()+i*100);
  assert(speakMotion.amount===0,'reading motion did not settle back to idle');
  var f=speakWin.frame,q=quizWin.frame;
  assert(f.origin.x+f.size.width<=q.origin.x || f.origin.x>=q.origin.x+q.size.width ||
    f.origin.y+f.size.height<=q.origin.y || f.origin.y>=q.origin.y+q.size.height,'speech covers quiz');
  handleSpeakCommand({cmd:'speak-end',id:'older-id',reason:'done'});
  assert(speakCloseAt===0,'stale completion closed a newer speech');
  handleSpeakCommand({cmd:'speak-end',id:'speech-one',reason:'done'});
  assert(speakCloseAt>0,'completion did not schedule exit');
  tickSpeakCard(speakCloseAt+1); tick(); tickSpeakCard(speakExitAt+1);
  assert(speakWin===null && quizWin!==null,'exit did not preserve the quiz');
  reduced=true; M.speakPng=LONGPNG;
  showSpeakCard({id:'speech-long',quizId:'native-quiz',w:340,h:1600}); tick();
  assert(speakWin.frame.size.height<=440,'long speech is not scrollable within screen');
  assert(speakView.frame.size.height===1600,'long speech content was clipped');
  speakView.scrollPoint($.NSMakePoint(0,0)); tick();
  assert(speakView.visibleRect.origin.y<1,'cannot scroll to end of speech');
  hideSpeakCard(); quizWin.orderOut($());win.orderOut($());
  return 'PASS native audio / actual mouth metering and silence / shared word clock / all face poses / completion / replay / scrolling / reduced motion';
}'''
    for key, value in {'METHODS': methods, 'CLICK': click, 'GEOM': json.dumps(geom), 'SPRITE':sprite,'SPRITEDRAW':sprite_draw,
                       'AUDIO':json.dumps(str(out/'silent.wav')),'SHEET':json.dumps(str(ROOT/'assets/patrick/sheet.png')),
                       'SYLLABLES':json.dumps(str(out/'syllables.wav')),'MOUTHSHOTS':json.dumps(str(out/'mouth-poses.png')),
                       'LONGPNG': json.dumps(str(out / 'long.png')), 'PNG': json.dumps(str(out / 'dark.png')),
                       'SNAPSHOT': json.dumps(str(out / 'native-speech.png'))}.items():
        harness = re.sub(r'\b' + key + r'\b', lambda _: value, harness)
    script = out / 'native-speech.jxa.js'
    script.write_text(harness)
    result = subprocess.run(['osascript', '-l', 'JavaScript', str(script)], capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stderr
    print(result.stdout.strip(), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        verify(args.out.resolve())
    else:
        with tempfile.TemporaryDirectory(prefix='wordpaper-speech-layout-') as temp:
            verify(Path(temp))
