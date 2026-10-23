#!/usr/bin/env python3
"""Isolated real launcher: repeat opens, saved port, and update restart chain."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_app', ROOT / 'scripts/package_app.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)

def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]

def wait_for(fn, timeout=30):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            if fn(): return
        except (OSError, ValueError): pass
        time.sleep(.15)
    raise AssertionError('timed out')

with tempfile.TemporaryDirectory(prefix='wordpaper-launcher-test-') as folder:
    temp = Path(folder)
    app = temp / 'WordPaper.app'
    res = app / 'Contents/Resources'
    macos = app / 'Contents/MacOS'
    res.mkdir(parents=True); macos.mkdir()
    for name in package.PAYLOAD_FILES: shutil.copy2(ROOT / name, res / name)
    for name in package.PAYLOAD_DIRS: shutil.copytree(ROOT / name, res / name)
    launcher = macos / 'launcher.sh'
    launcher.write_text(package.LAUNCHER); launcher.chmod(0o755)
    state = temp / 'state'; state.mkdir()
    logs = temp / 'logs'; logs.mkdir()
    scratch = temp / 'tmp'; scratch.mkdir()
    fakebin = temp / 'bin'; fakebin.mkdir()
    (fakebin / 'open').write_text('#!/bin/sh\necho "$@" >> "$WORDPAPER_LOG_DIR/open.log"\n')
    (fakebin / 'open').chmod(0o755)
    port, comp = free_port(), free_port()
    (state / 'port.json').write_text(json.dumps({'port': port}))
    config = temp / 'config.json'
    config.write_text(json.dumps({'autoSetWallpaper': False, 'petEnabled': False, 'hotkeyEnabled': False}))
    preload = temp / 'preload.cjs'
    preload.write_text('''
const {EventEmitter}=require('events');
require('https').get=(url,opts,cb)=>{
  if(typeof opts==='function') cb=opts;
  const req=new EventEmitter(); req.destroy=()=>{};
  process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;res.resume=()=>{};cb(res);res.emit('data','99.0.0');res.emit('end');});return req;
};
const fs=require('fs'),path=require('path');
require(path.join(process.env.WP_LAUNCH_TEST_ROOT,'lib/updater.js')).applyUpdate=async()=>{
  fs.writeFileSync(path.join(process.env.WP_LAUNCH_TEST_ROOT,'VERSION'),'99.0.0');
  fs.writeFileSync(path.join(process.env.WORDPAPER_DATA_DIR,'update-pending.json'),'{}');
};
''')
    env = {**os.environ, 'PATH': str(fakebin) + os.pathsep + os.environ['PATH'],
           'WORDPAPER_DATA_DIR': str(state), 'WORDPAPER_LOG_DIR': str(logs),
           'WORDPAPER_COMPANION_DATA_DIR': str(temp / 'companion'), 'WORDPAPER_CONFIG_PATH': str(config),
           'WORDPAPER_COMPANION_PORT': str(comp), 'WORDPAPER_COMPANION_AUTOSTART': '0',
           'WORDPAPER_COMPANION_SILENT': '1', 'WORDPAPER_TEST_MODE': '1', 'NODE_ENV': 'test',
           'TMPDIR': str(scratch), 'NODE_OPTIONS': '--require=' + str(preload), 'WP_LAUNCH_TEST_ROOT': str(res)}
    for key in ['PORT', 'WORDPAPER_WEB_ORIGIN', 'WORDPAPER_SELFTEST', 'WORDPAPER_SKIP_COMPANION', 'WORDPAPER_FORCE_DOWNLOAD']:
        env.pop(key, None)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    base = f'http://127.0.0.1:{port}'
    def health(): return json.load(opener.open(base + '/healthz', timeout=1))
    proc = subprocess.Popen(['/bin/bash', str(launcher)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        wait_for(lambda: health()['ok'])
        wait_for(lambda: not (state / 'startup.lock').exists())
        before = subprocess.check_output(['lsof', '-nP', f'-tiTCP:{port}', '-sTCP:LISTEN'], text=True).strip()
        marker = state / 'update-pending.json'; marker.write_text('preserve-on-reopen')
        reopen = subprocess.run(['/bin/bash', str(launcher)], env=env, capture_output=True, timeout=15)
        assert reopen.returncode == 0, reopen.stderr
        assert proc.poll() is None
        assert json.loads((state / 'port.json').read_text())['port'] == port
        assert subprocess.check_output(['lsof', '-nP', f'-tiTCP:{port}', '-sTCP:LISTEN'], text=True).strip() == before
        assert marker.read_text() == 'preserve-on-reopen'
        marker.unlink()
        print('PASS repeat open reuses saved server and preserves pending update flag', flush=True)
        request = urllib.request.Request(base + '/api/update/apply-local', data=b'{}', headers={'X-WordPaper-Local': '1'})
        assert json.load(opener.open(request, timeout=3))['started']
        wait_for(lambda: health()['version'] == '99.0.0', timeout=35)
        assert 'update applied: restarting service chain' in (logs / 'server.log').read_text()
        assert proc.poll() is None
        print('PASS update restarts complete launcher/server/companion chain on same port', flush=True)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait()
