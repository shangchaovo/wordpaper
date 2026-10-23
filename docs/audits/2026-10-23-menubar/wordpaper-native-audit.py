import os, json, time, socket, subprocess, tempfile, signal, urllib.request, http.cookiejar
from pathlib import Path
ROOT = '/Users/xieshangchao/daily-wallpaper'
T = Path(tempfile.mkdtemp(prefix='wordpaper-native-audit-'))
print('ARTIFACT_DIR', T, flush=True)
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
    env={**os.environ,'NODE_ENV':'test','PORT':str(p),'HOST':'127.0.0.1','WORDPAPER_MODE':'local','WORDPAPER_DATA_DIR':str(folder/'db'),'WORDPAPER_COMPANION_DATA_DIR':str(folder/'companion'),'WORDPAPER_COMPANION_PORT':str(c),'WORDPAPER_CONFIG_PATH':str(cfg),'WORDPAPER_COMPANION_SILENT':'1','WORDPAPER_COMPANION_AUTOSTART':'0','TMPDIR':str(folder/'tmp'),'WP_AUDIT_HOME':str(folder/'home'),'NODE_OPTIONS':'--require=/tmp/wordpaper-audit-preload.cjs','WP_AUDIT_FAIL_UPDATE':'1' if fail else '0','WP_AUDIT_LATEST':'9.9.9' if fail else '2.4.5'}
    env.pop('WORDPAPER_TEST_MODE',None)
    log=open(folder/'server.log','w')
    proc=subprocess.Popen(['node','server.js'],cwd=ROOT,env=env,stdout=log,stderr=log)
    base=f'http://127.0.0.1:{p}'; comp=f'http://127.0.0.1:{c}'
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def req(url, data=None, headers=None):
        return json.load(opener.open(urllib.request.Request(url,data=json.dumps(data).encode() if data is not None else None,headers=headers or {}),timeout=3))
    assert wait(lambda:req(base+'/healthz'))
    return proc,base,comp,req,folder
proc,base,comp,req,folder=start('failure',True)
try:
    print('UPDATE_START',req(base+'/api/update/apply-local',{}, {'X-WordPaper-Local':'1'}),flush=True)
    time.sleep(2.5)
    print('UPDATE_FAILURE_SERVER_EXIT_CODE',proc.poll(),flush=True)
    print('UPDATE_FAILURE_RESTART_FLAG', (folder/'home/.wordpaper/update-pending.json').exists(),flush=True)
finally:
    if proc.poll() is None: proc.terminate()
    proc.wait(timeout=5)
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
    print('INITIAL_UPDATE_STATE',status['update'],flush=True)
    req(comp+'/menu.php?cmd=pet-close',{}, {'X-WordPaper-Local':'1'})
    assert wait(lambda: not req(comp+'/status.json')['pet'])
    req(comp+'/menu.php?cmd=pet-open',{}, {'X-WordPaper-Local':'1'})
    assert wait(lambda:req(comp+'/status.json')['pet'])
    time.sleep(2)
    print('NATIVE_HIDE_REOPEN_PASS',flush=True)
    owned=list(set(owned+children(cp)))
    menus=[p for p in owned if 'dw_menubar' in subprocess.run(['ps','-p',str(p),'-o','command='],capture_output=True,text=True).stdout]
    print('MENU_CHILDREN',menus,flush=True)
    os.kill(cp,signal.SIGKILL)
    started=time.monotonic()
    gone=wait(lambda:not any(alive(p) for p in owned),35)
    print('ORPHAN_ALL_EXITED',bool(gone),'SECONDS',round(time.monotonic()-started,1),'SURVIVORS',[p for p in owned if alive(p)],flush=True)
    for p in owned:
        print('CHILD_PROCESS',subprocess.run(['ps','-p',str(p),'-o','pid=,ppid=,stat=,etime=,pcpu=,command='],capture_output=True,text=True).stdout,flush=True)
    print('COMPANION_LOG', (folder/'home/Library/Logs/daily-wallpaper-companion.log').read_text()[-6000:],flush=True)
finally:
    for p in owned+([cp] if cp else []):
        try: os.kill(p,signal.SIGTERM)
        except ProcessLookupError: pass
    if proc.poll() is None: proc.terminate()
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired: proc.kill(); proc.wait()
