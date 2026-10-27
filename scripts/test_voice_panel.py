#!/usr/bin/env python3
"""Exercise the real voice UI against deterministic, silent audio in a browser."""
import argparse
import io
import json
import mimetypes
import os
import platform
import re
import subprocess
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs
from playwright.sync_api import sync_playwright, expect, Error as PlaywrightError

ROOT = Path(__file__).resolve().parent.parent
VOICES = [
    dict(id='aria',name='Aria',accent='美式英语',tone='清澈 · 亲切',gender='女声',color='rose'),
    dict(id='guy',name='Guy',accent='美式英语',tone='温暖 · 沉稳',gender='男声',color='sage'),
    dict(id='sonia',name='Sonia',accent='英式英语',tone='柔和 · 从容',gender='女声',color='lilac'),
    dict(id='ryan',name='Ryan',accent='英式英语',tone='明朗 · 自然',gender='男声',color='amber'),
]


def verify(out):
    sample = 'Every little step brings you closer to your goal.'
    cues = [dict(start=i*.4,end=i*.4+.37,from_=m.start(),to=m.end())
            for i,m in enumerate(re.finditer(r'\w+',sample))]
    for cue in cues:
        cue['from'] = cue.pop('from_')
    audio = io.BytesIO()
    with wave.open(audio,'wb') as wav:
        wav.setparams((1,2,16000,0,'NONE','not compressed'))
        wav.writeframes(b'\0\0'*64000)
    state = dict(selected='aria',dark=True,fail=False,preview=0,fallback=False)
    errors = []

    def handle(route):
        url = urlparse(route.request.url)
        payload = route.request.post_data_json if route.request.method == 'POST' else {}
        status = 200
        if url.path == '/pet-voices.json':
            data = dict(ok=True,voices=VOICES,selected=state['selected'],dark=state['dark'])
        elif url.path == '/pet-voice.php':
            if state['fail']:
                status=503;data=dict(ok=False,error='test save failure')
            else:
                state['selected']=payload['voiceId'];data=dict(ok=True,selected=state['selected'])
        elif url.path == '/pet-voice-preview.php':
            if payload.get('action') == 'stop':
                data=dict(ok=True)
            else:
                state['preview']+=1
                data=dict(ok=True,id=str(state['preview']),url='/audio.wav',cues=[] if state['fallback'] else cues,fallback=state['fallback'])
        elif url.path == '/audio.wav':
            return route.fulfill(status=200,content_type='audio/wav',body=audio.getvalue(),headers={'Accept-Ranges':'bytes'})
        elif url.path in ('/pet-voices.html','/js/pet-voices.js','/css/pet-voices.css'):
            file=ROOT/('assets/pet-voices.html' if url.path=='/pet-voices.html' else url.path.lstrip('/'))
            return route.fulfill(status=200,content_type=mimetypes.guess_type(str(file))[0],body=file.read_bytes())
        else:
            return route.fulfill(status=404)
        route.fulfill(status=status,content_type='application/json',body=json.dumps(data))

    with sync_playwright() as p:
        try:
            browser=p.chromium.launch(headless=True)
        except PlaywrightError as exc:
            if "Executable doesn't exist" not in str(exc): raise
            browser=p.chromium.launch(channel='chrome',headless=True)
        page=browser.new_page(viewport=dict(width=304,height=600),device_scale_factor=2)
        page.add_init_script("window.__nativeMessages=[];window.webkit={messageHandlers:{wordpaperMenu:{postMessage:message=>window.__nativeMessages.push(message)}}};")
        page.on('pageerror',lambda error:errors.append(str(error)))
        page.route('http://wordpaper.test/**',handle)
        page.goto('http://wordpaper.test/pet-voices.html');page.wait_for_load_state('networkidle')
        page.evaluate("WordPaperMenu.status({ok:true,pet:true,petMode:'patrick',appMode:true,version:'2.6.2',dark:true,update:{checked:true}})")
        expect(page.get_by_role('radio')).to_have_count(4)
        expect(page.locator('#voice-aria')).to_be_checked()
        expect(page.locator('#preview')).to_be_hidden()
        assert page.locator('main').bounding_box()['height']<460
        page.get_by_role('button',name='记忆复习本').click()
        assert page.evaluate("__nativeMessages.some(m=>m.cmd==='workspace-memory')")
        page.evaluate("WordPaperMenu.complete('workspace-memory',{ok:true})")
        page.get_by_role('button',name='检查更新').click()
        assert page.evaluate("__nativeMessages.some(m=>m.cmd==='update-check')")
        page.evaluate("WordPaperMenu.complete('update-check',{ok:true})")
        page.screenshot(path=str(out/'voices-dark.png'),full_page=True)
        page.locator('label[for="voice-sonia"]').click()
        expect(page.locator('#save-status')).to_contain_text('已保存')
        expect(page.locator('#voice-sonia')).to_be_checked();assert state['selected']=='sonia'
        page.get_by_role('button',name='试听 Guy').click()
        expect(page.locator('.token.active')).to_have_text('Every',timeout=5000)
        page.wait_for_function("document.querySelector('.token.active')?.textContent==='little'",polling=20,timeout=3000)
        expect(page.locator('#voice-sonia')).to_be_checked()
        page.screenshot(path=str(out/'voices-playing.png'),full_page=True)
        expect(page.locator('#play-status')).to_contain_text('试听结束',timeout=6000)
        expect(page.locator('#preview')).to_be_hidden()
        expect(page.locator('.token.active')).to_have_count(0)
        print('PASS voice cards / saved selection / independent audition / audio-synchronized highlights',flush=True)

        page.get_by_role('button',name='试听 Aria').click()
        expect(page.locator('#play-status')).to_contain_text('正在试听')
        page.get_by_role('button',name='试听 Ryan').click()
        expect(page.locator('.voice.previewing .voice-name strong')).to_have_text('Ryan')
        page.get_by_role('button',name='停止试听').click()
        expect(page.locator('.voice.previewing')).to_have_count(0)
        expect(page.locator('.token.active')).to_have_count(0)
        state['fail']=True
        page.locator('label[for="voice-aria"]').click()
        expect(page.locator('#save-status')).to_contain_text('未保存')
        expect(page.locator('#voice-sonia')).to_be_checked()
        state['fail']=False
        page.locator('#voice-sonia').focus();page.keyboard.press('ArrowRight')
        expect(page.locator('#voice-ryan')).to_be_checked();expect(page.locator('#save-status')).to_contain_text('已保存')
        page.reload();expect(page.locator('#voice-ryan')).to_be_checked()
        print('PASS replay replacement / stop cleanup / failed save rollback / keyboard / reload',flush=True)

        state['dark']=False;state['fallback']=True
        page.emulate_media(reduced_motion='reduce');page.set_viewport_size(dict(width=304,height=600))
        page.reload();page.wait_for_load_state('networkidle')
        page.get_by_role('button',name='试听 Aria').click()
        expect(page.locator('#play-status')).to_contain_text('系统声音')
        expect(page.locator('.token.active')).to_have_count(0)
        assert page.locator('.bars i').first.evaluate('(el)=>getComputedStyle(el).animationName')=='none'
        assert page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        page.screenshot(path=str(out/'voices-light.png'),full_page=True)
        page.get_by_role('button',name='停止试听').click()
        page.get_by_role('button',name='试听 Guy').click()
        expect(page.locator('#play-status')).to_contain_text('系统声音')
        page.evaluate('WordPaperMenu.close()')
        expect(page.locator('#preview')).to_be_hidden()
        expect(page.locator('.voice.previewing')).to_have_count(0)
        page.keyboard.press('Escape')
        assert page.evaluate("__nativeMessages.some(m=>m.type==='close')")
        assert not errors,errors
        print('PASS light / narrow window / reduced motion / honest fallback / no page errors',flush=True)
        browser.close()
    if platform.system() == 'Darwin':
        verify_native(out,audio.getvalue(),cues)


def verify_native(out,audio,cues):
    state=dict(selected='aria',commands=[])
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def do_POST(self): self.respond()
        def do_GET(self): self.respond()
        def do_HEAD(self): self.respond()
        def respond(self):
            url=urlparse(self.path);body={}
            if self.command=='POST':body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))) or '{}')
            data=None;content_type='application/json'
            if url.path=='/pet-voices.json':data=dict(ok=True,voices=VOICES,selected=state['selected'],dark=True)
            elif url.path=='/menu-status.json':data=dict(ok=True,ownerPid=os.getpid(),pet=True,petMode='patrick',appMode=True,version='2.6.2',dark=True,update=dict(checked=True))
            elif url.path=='/menu.php':
                assert self.headers.get('X-WordPaper-Local')=='1'
                assert not self.headers.get('Origin') and not self.headers.get('Referer')
                state['commands'].append(parse_qs(url.query)['cmd'][0]);data=dict(ok=True)
            elif url.path=='/pet-voice.php':state['selected']=body['voiceId'];data=dict(ok=True,selected=state['selected'])
            elif url.path=='/pet-voice-preview.php':data=dict(ok=True,id='native',url='/audio.wav',cues=cues,fallback=False)
            elif url.path=='/audio.wav':content_type='audio/wav';data=audio
            elif url.path in ('/pet-voices.html','/css/pet-voices.css','/js/pet-voices.js'):
                file=ROOT/('assets/pet-voices.html' if url.path=='/pet-voices.html' else url.path.lstrip('/'));content_type=mimetypes.guess_type(str(file))[0];data=file.read_bytes()
                if url.path=='/js/pet-voices.js':data=data.replace(b'const audio = new Audio();',b'const audio = new Audio(); window.__testAudio=audio; window.__testFrames=0; const originalRAF=requestAnimationFrame; window.requestAnimationFrame=fn=>originalRAF(t=>{window.__testFrames++;fn(t);});')
            else:self.send_error(404);return
            if not isinstance(data,bytes):data=json.dumps(data).encode()
            size=len(data);range_value=self.headers.get('Range') if url.path=='/audio.wav' else None
            if range_value:
                start,end=range_value.removeprefix('bytes=').split('-');start=int(start or 0);end=min(size-1,int(end or size-1))
                data=data[start:end+1];self.send_response(206);self.send_header('Content-Range',f'bytes {start}-{end}/{size}')
            else:self.send_response(200)
            self.send_header('Accept-Ranges','bytes');self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(data)));self.end_headers()
            if self.command!='HEAD':self.wfile.write(data)
    server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
    threading.Thread(target=server.serve_forever,daemon=True).start()
    try:
        subprocess.run(['node','scripts/test_patrick_speech.js','--fixtures',str(out)],cwd=ROOT,check=True,capture_output=True)
        source=(out/'menu.jxa.js').read_text()
        source=re.sub(r"var PORT = '\d+';",f"var PORT = '{server.server_port}';",source)
        source=re.sub(r"var OWNER = '\d+';",f"var OWNER = '{os.getpid()}';",source)
        tests='''
  var phase=0,pendingTest=false,done=false,failure='',deadline=Date.now()+15000,observed=[],lastState='',timeline=[];
  function js(code,fn){web.evaluateJavaScriptCompletionHandler(code,function(value,error){
    if(error && !error.isNil()){failure=String(error.localizedDescription.js);done=true;return;}
    fn(value && !value.isNil()?ObjC.unwrap(value):null);
  });}
  $.NSTimer.scheduledTimerWithTimeIntervalRepeatsBlock(.1,true,function(tm){
    if(done){tm.invalidate;popover.performClose($());$.NSStatusBar.systemStatusBar.removeStatusItem(item);console.log(failure || 'PASS native status-bar popover / selection / audio highlights / close cleanup / reopen / native commands');$.exit(failure?1:0);return;}
    if(Date.now()>deadline){failure='native voice panel timeout at phase '+phase+' '+lastState+' observed='+JSON.stringify(observed)+' native='+[popover.shown,popover.contentSize.width,popover.contentSize.height,web.isHiddenOrHasHiddenAncestor]+' timeline='+JSON.stringify(timeline);done=true;return;}
    if(pendingTest)return;pendingTest=true;
    js("JSON.stringify({hidden:document.getElementById('preview')?.hidden,selected:document.querySelector('input:checked')?.value,cards:document.querySelectorAll('.voice').length,saved:document.getElementById('save-status')?.textContent,active:document.querySelector('.token.active')?.textContent,status:document.getElementById('play-status')?.textContent,time:window.__testAudio?.currentTime,paused:window.__testAudio?.paused,frames:window.__testFrames,visibility:document.visibilityState})",function(raw){
      pendingTest=false;lastState=raw;var s=JSON.parse(raw || '{}');
      if(phase===2 && timeline.length<10)timeline.push(s);
      if(phase===0 && s.cards===4){showMenu();phase=1;js("document.getElementById('voice-sonia').click();true",function(){});}
      else if(phase===1 && s.saved.indexOf('已保存')>=0){phase=2;
        js("document.querySelector('button[aria-label=\\\"试听 Guy\\\"]').click();true",function(){});
      }else if(phase===2 && s.active){
        if(observed.indexOf(s.active)<0)observed.push(s.active);
        if(observed.length>=2){phase=3;
          web.takeSnapshotWithConfigurationCompletionHandler($(),function(image,error){
            if(error && !error.isNil())failure='snapshot failed';
            else {var rep=$.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
              rep.representationUsingTypeProperties($.NSPNGFileType,$({})).writeToFileAtomically(SNAPSHOT,true);}
            popover.performClose($());phase=4;
          });
        }
      }else if(phase===4 && s.paused && s.hidden && !s.active && !popover.shown){
        if(popover.contentSize.width!==304 || popover.contentSize.height>460){failure='popover not compact';done=true;return;}
        showMenu();phase=5;
      }else if(phase===5 && popover.shown && s.selected==='sonia'){
        phase=6;js("document.querySelector('[data-command=workspace-memory]').click();true",function(){});
      }else if(phase===6 && !popover.shown){done=true;}
    });
  });
  $.NSApplication.sharedApplication.run;
'''
        tests=tests.replace('SNAPSHOT',json.dumps(str(out/'voices-native.png')))
        source=source.replace('  $.NSApplication.sharedApplication.run;',tests)
        script=out/'voice-native-test.jxa.js';script.write_text(source)
        result=subprocess.run(['osascript','-l','JavaScript',str(script)],capture_output=True,text=True,timeout=25)
        assert result.returncode==0,result.stderr
        assert state['selected']=='sonia'
        assert state['commands']==['workspace-memory'],state
        print((result.stdout or result.stderr).strip(),flush=True)
    finally:
        server.shutdown();server.server_close()


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--out',type=Path);args=parser.parse_args()
    if args.out:
        args.out.mkdir(parents=True,exist_ok=True);verify(args.out.resolve())
    else:
        with tempfile.TemporaryDirectory(prefix='wordpaper-voice-panel-') as temp:verify(Path(temp))
