#!/usr/bin/env python3
"""Real Cocoa/WKWebView + launcher startup/quit, isolated from personal state."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import socket
import shutil
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
const path=require('path'),fs=require('fs');
require(path.join(process.cwd(),'lib/updater.js')).latestRelease=async()=>({version:fs.readFileSync('VERSION','utf8').trim()});
""")
    manifest = json.loads((app / 'Contents/Resources/RELEASE_SHA256.json').read_text())
    assert manifest['bundleFiles']['MacOS/WordPaper'] == hashlib.sha256((app / 'Contents/MacOS/WordPaper').read_bytes()).hexdigest()
    print('PASS release manifest contains the exact native executable digest')
    env = {**os.environ, 'NODE_ENV': 'test', 'PORT': str(port), 'HOST': '127.0.0.1',
           'WORDPAPER_MODE': 'local', 'WORDPAPER_DATA_DIR': str(folder / 'data'),
           'WORDPAPER_LOG_DIR': str(folder / 'logs'), 'WORDPAPER_SKIP_COMPANION': '1',
           'WORDPAPER_COMPANION_AUTOSTART': '0', 'WORDPAPER_PUBLIC_ORIGIN': '',
           'WORDPAPER_NATIVE_TEST_REPORT': str(report), 'WORDPAPER_NATIVE_TEST_EXIT': '1',
           'NODE_OPTIONS': '--require=' + str(preload)}
    proc = subprocess.Popen([str(app / 'Contents/MacOS/WordPaper')], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        try:
            stdout, stderr = proc.communicate(timeout=35)
        except subprocess.TimeoutExpired as error:
            for log in (folder / 'logs').glob('*.log'):
                print(log.name + ':\n' + log.read_text(errors='replace')[-5000:], flush=True)
            if error.stderr:
                print(error.stderr.decode(errors='replace')[-3000:], flush=True)
            raise
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

    # A separate temporary bundle simulates the launcher's successful native
    # update handoff. Capture open only after the old Cocoa PID has exited.
    restart_app = folder / 'Restart Fixture.app'
    restart_macos = restart_app / 'Contents/MacOS'; restart_macos.mkdir(parents=True)
    shutil.copy2(app / 'Contents/MacOS/WordPaper', restart_macos / 'WordPaper')
    shutil.copy2(app / 'Contents/Info.plist', restart_app / 'Contents/Info.plist')
    restart_report = folder / 'relaunch.json'
    old_pid_file = folder / 'old-native-pid'
    fake_open = folder / 'capture-open.py'
    fake_open.write_text('''#!/usr/bin/python3
import json, os, sys
from pathlib import Path
try:
    os.kill(int(Path(os.environ['WP_OLD_NATIVE_PID_FILE']).read_text()), 0)
    old_alive = True
except ProcessLookupError:
    old_alive = False
Path(os.environ['WP_RELAUNCH_REPORT']).write_text(json.dumps({'args': sys.argv[1:], 'oldAlive': old_alive}))
''')
    fake_open.chmod(0o755)
    restart_env = {**env, 'WORDPAPER_NATIVE_TEST_EXIT': '0', 'WORDPAPER_NATIVE_TEST_RELAUNCHER': str(fake_open),
                   'WP_RELAUNCH_REPORT': str(restart_report), 'WP_OLD_NATIVE_PID_FILE': str(old_pid_file)}
    restart_env.pop('WORDPAPER_NATIVE_TEST_REPORT', None)
    for owns_service in (True, False):
        (restart_macos / 'launcher.sh').write_text('''#!/bin/bash
printf '{"url":"http://localhost:%s","owned":%s}' "$PORT" "''' + str(owns_service).lower() + '''" > "$WORDPAPER_NATIVE_READY_FILE"
sleep 1
exit 75
''')
        restart_report.unlink(missing_ok=True)
        proc = subprocess.Popen([str(restart_macos / 'WordPaper')], env=restart_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        old_pid_file.write_text(str(proc.pid))
        try:
            stdout, stderr = proc.communicate(timeout=15)
            assert proc.returncode == 0, stderr.decode(errors='replace')[-2000:]
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline and not restart_report.exists(): time.sleep(.05)
            assert restart_report.exists(), 'Native relaunch helper did not dispatch after exit'
            result = json.loads(restart_report.read_text())
            assert result['args'][:2] == ['-n', '-a'] and len(result['args']) == 3, result
            assert Path(result['args'][2]).samefile(restart_app) and result['oldAlive'] is False, result
            print('PASS successful update exits old Cocoa PID before reopening exact bundle; owned=' + str(owns_service))
        finally:
            if proc.poll() is None:
                proc.terminate()
                try: proc.wait(timeout=5)
                except subprocess.TimeoutExpired: proc.kill(); proc.wait()
