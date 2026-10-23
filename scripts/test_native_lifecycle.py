#!/usr/bin/env python3
"""macOS-only native smoke; isolated server owns companion, wallpaper/hotkeys off."""
import os, json, time, socket, subprocess, tempfile, signal, urllib.request, http.cookiejar, shutil
from pathlib import Path
SOURCE = Path(__file__).resolve().parents[1]
T = Path(tempfile.mkdtemp(prefix='wordpaper-native-audit-'))
ROOT = T / 'WordPaper.app/Contents/Resources'
ROOT.mkdir(parents=True)
for name in ['companion.js', 'server.js', 'VERSION', 'package.json', 'index.html', 'login.html']:
    shutil.copy2(SOURCE / name, ROOT / name)
for name in ['lib', 'js', 'css', 'data', 'assets']:
    shutil.copytree(SOURCE / name, ROOT / name)
preload = T / 'preload.cjs'
preload.write_text('''
const os=require('os');os.homedir=()=>process.env.WP_AUDIT_HOME;
const {EventEmitter}=require('events');
require('https').get=(url,opts,cb)=>{if(typeof opts==='function')cb=opts;const req=new EventEmitter();req.destroy=()=>{};process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;res.resume=()=>{};cb(res);res.emit('data',require('fs').readFileSync(process.env.WP_NATIVE_VERSION,'utf8'));res.emit('end');});return req;};
''')
def port():
    with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]
def alive(pid):
    try: os.kill(pid,0); return True
    except ProcessLookupError: return False
def children(pid):
    r=subprocess.run(['pgrep','-P',str(pid)],capture_output=True,text=True)
    return [int(p) for p in r.stdout.split()]
def wait(fn, seconds=10):
    end=time.monotonic()+seconds
    while time.monotonic()<end:
        try:
            v=fn()
            if v: return v
        except Exception: pass
        time.sleep(.2)
    return False
def start(label, fail=False):
    folder=T/label; folder.mkdir(); (folder/'tmp').mkdir()
    cfg=folder/'config.json'; cfg.write_text(json.dumps({'petEnabled':True,'autoSetWallpaper':False,'hotkeyEnabled':False,'autoStart':False}))
    p,c=port(),port()
    env={**os.environ,'NODE_ENV':'test','PORT':str(p),'HOST':'127.0.0.1','WORDPAPER_MODE':'local','WORDPAPER_DATA_DIR':str(folder/'db'),'WORDPAPER_COMPANION_DATA_DIR':str(folder/'companion'),'WORDPAPER_COMPANION_PORT':str(c),'WORDPAPER_CONFIG_PATH':str(cfg),'WORDPAPER_COMPANION_SILENT':'1','WORDPAPER_COMPANION_AUTOSTART':'0','TMPDIR':str(folder/'tmp'),'WP_AUDIT_HOME':str(folder/'home'),'NODE_OPTIONS':'--require='+str(preload),'WP_NATIVE_VERSION':str(ROOT/'VERSION'),'WP_AUDIT_FAIL_UPDATE':'1' if fail else '0','WP_AUDIT_LATEST':'9.9.9' if fail else '2.4.5'}
    env.pop('WORDPAPER_TEST_MODE',None)
    log=open(folder/'server.log','w')
    proc=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
    base=f'http://127.0.0.1:{p}'; comp=f'http://127.0.0.1:{c}'
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def req(url, data=None, headers=None):
        return json.load(opener.open(urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=headers or {}),timeout=3))
    assert wait(lambda:req(base+'/healthz'))
    return proc,base,comp,req,folder
proc,base,comp,req,folder=start('native')
owned=[]; cp=None
try:
    req(base+'/api/auth/register',{'username':'audituser','password':'audit-password-123'}, {'Origin':base,'Content-Type':'application/json'})
    session=req(base+'/api/session')
    print('NATIVE_START',req(base+'/companion/start',{}, {'Origin':base,'X-CSRF-Token':session['csrfToken']}),flush=True)
    st=wait(lambda: (s if (s:=req(comp+'/status.json'))['pet'] and s['menuBar'] else False))
    assert st, 'native pet/menu process did not start'
    status=req(comp+'/menu-status.json',headers={'X-WordPaper-Local':'1'}); cp=status['ownerPid']
    owned=children(cp)
    time.sleep(3)
    print('NATIVE_ALIVE', {k:req(comp+'/status.json')[k] for k in ['pet','menuBar']}, 'CHILDREN',owned,flush=True)
    assert status['appMode'] and status['update']['current']
    assert wait(lambda:req(comp+'/menu-status.json',headers={'X-WordPaper-Local':'1'})['update']['checked'], 12)
    print('PASS initial menu update state synchronized',flush=True)
    req(comp+'/menu.php?cmd=pet-close',{}, {'X-WordPaper-Local':'1'})
    assert wait(lambda: not req(comp+'/status.json')['pet'])
    req(comp+'/menu.php?cmd=pet-open',{}, {'X-WordPaper-Local':'1'})
    assert wait(lambda:req(comp+'/status.json')['pet'])
    time.sleep(2)
    print('NATIVE_HIDE_REOPEN_PASS',flush=True)
    owned=list(set(owned+children(cp)))
    menus=[p for p in owned if 'dw_menubar' in subprocess.run(['ps','-p',str(p),'-o','command='],capture_output=True,text=True).stdout]
    print('MENU_CHILDREN',menus,flush=True)
    assert len(menus)==1
    os.kill(menus[0],signal.SIGTERM)
    def replacement_menu():
        return [p for p in children(cp) if p != menus[0] and 'dw_menubar' in subprocess.run(['ps','-p',str(p),'-o','command='],capture_output=True,text=True).stdout]
    assert wait(replacement_menu, 12), 'menu child was not restarted'
    owned=list(set(owned+children(cp)))
    print('PASS menu subprocess crash recovers',flush=True)
    os.kill(cp,signal.SIGKILL)
    started=time.monotonic()
    old_owned=owned[:]
    req(base+'/companion/start',{}, {'Origin':base,'X-CSRF-Token':session['csrfToken']})
    cp=req(comp+'/menu-status.json',headers={'X-WordPaper-Local':'1'})['ownerPid']
    time.sleep(2)
    owned=list(set(owned+children(cp)))
    gone=wait(lambda:not any(alive(p) for p in old_owned),12)
    assert gone, 'orphan native subprocesses survived owner replacement'
    print('PASS SIGKILL + same-port replacement: old native children exited in',round(time.monotonic()-started,1),'seconds',flush=True)

finally:
    for p in owned+([cp] if cp else []):
        try: os.kill(p,signal.SIGTERM)
        except ProcessLookupError: pass
    if proc.poll() is None: proc.terminate()
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired: proc.kill(); proc.wait()
    assert wait(lambda:not any(alive(p) for p in owned),5), 'test cleanup left native children'
    shutil.rmtree(T)
