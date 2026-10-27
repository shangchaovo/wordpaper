#!/usr/bin/env python3
"""Real Cocoa/WKWebView + launcher startup/quit, isolated from personal state."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix='wordpaper-native-window-') as directory:
    folder = Path(directory)
    configured = os.environ.get('WORDPAPER_TEST_APP')
    if configured:
        app = Path(configured)
    else:
        spec = importlib.util.spec_from_file_location('package_app', ROOT / 'scripts/package_app.py')
        package = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(package)
        app = folder / 'WordPaper.app'
        package.build_app(str(app), None)
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    report = folder / 'native-report.json'
    preload = folder / 'offline-update.cjs'
    preload.write_text("""
const {EventEmitter}=require('events');
require('https').get=(url,opts,cb)=>{
 const req=new EventEmitter();req.destroy=()=>{};
 process.nextTick(()=>{const res=new EventEmitter();res.statusCode=200;res.resume=()=>{};cb(res);res.emit('data',require('fs').readFileSync('VERSION','utf8'));res.emit('end');});return req;
};
""")
    env = {**os.environ, 'NODE_ENV': 'test', 'PORT': str(port), 'HOST': '127.0.0.1',
           'WORDPAPER_MODE': 'local', 'WORDPAPER_DATA_DIR': str(folder / 'data'),
           'WORDPAPER_LOG_DIR': str(folder / 'logs'), 'WORDPAPER_SKIP_COMPANION': '1',
           'WORDPAPER_COMPANION_AUTOSTART': '0', 'WORDPAPER_PUBLIC_ORIGIN': '',
           'WORDPAPER_NATIVE_TEST_REPORT': str(report), 'WORDPAPER_NATIVE_TEST_EXIT': '1',
           'NODE_OPTIONS': '--require=' + str(preload)}
    proc = subprocess.Popen([str(app / 'Contents/MacOS/WordPaper')], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        stdout, stderr = proc.communicate(timeout=35)
        assert proc.returncode == 0, stderr.decode()[-2000:]
        assert report.exists(), 'No WebKit report: ' + stderr.decode()[-2000:]
        result = json.loads(report.read_text())
        assert result['bridge'] and result['cloudLogin'] and result['visible'], result
        assert 'WordPaper' in result['title'], result
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            try:
                opener.open(f'http://127.0.0.1:{port}/healthz', timeout=1)
            except Exception:
                break
            time.sleep(.2)
        else:
            raise AssertionError('Closing the native App left its owned server running')
        assert not (folder / 'logs/companion.log').exists(), 'Native smoke unexpectedly launched the companion'
        print('PASS native Cocoa window + WKWebView, desktop login bridge, launcher readiness and owned-server shutdown')
    finally:
        if proc.poll() is None:
            proc.terminate()
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired: proc.kill(); proc.wait()
