#!/usr/bin/env python3
"""Isolated launcher: native registration/readiness, reuse, and update restart."""
import http.server
import importlib.util
import json
import os
from pathlib import Path
import shutil
import shlex
import signal
import socket
import subprocess
import tempfile
import threading
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
    # Registration validates the bundle executable, but this test only runs
    # launcher.sh; the fixture must never start a Cocoa window.
    (macos / 'WordPaper').write_text('#!/bin/sh\nexit 0\n')
    (macos / 'WordPaper').chmod(0o755)
    state = temp / 'state'; state.mkdir()
    logs = temp / 'logs'; logs.mkdir()
    scratch = temp / 'tmp'; scratch.mkdir()
    fakebin = temp / 'bin'; fakebin.mkdir()
    (fakebin / 'open').write_text('#!/bin/sh\necho "$@" >> "$WORDPAPER_LOG_DIR/open.log"\n')
    (fakebin / 'open').chmod(0o755)
    fake_dialog = fakebin / 'osascript'
    fake_dialog.write_text('#!/bin/sh\nprintf "%s\\n" "$WP_MSG" >> "$WORDPAPER_LOG_DIR/dialog.log"\n')
    fake_dialog.chmod(0o755)
    launcher = macos / 'launcher.sh'
    # wp_alert uses an absolute osascript path, so PATH alone cannot isolate it.
    # Replace only the dialog executable in this temporary launcher copy.
    launcher.write_text(package.LAUNCHER.replace('/usr/bin/osascript', shlex.quote(str(fake_dialog))))
    launcher.chmod(0o755)
    port, comp = free_port(), free_port()
    (state / 'port.json').write_text(json.dumps({'port': port}))
    config = temp / 'config.json'
    config.write_text(json.dumps({'autoSetWallpaper': False, 'petEnabled': False, 'hotkeyEnabled': False}))
    preload = temp / 'preload.cjs'
    preload.write_text('''
const fs=require('fs'),path=require('path');
const updater=require(path.join(process.env.WP_LAUNCH_TEST_ROOT,'lib/updater.js'));
updater.latestRelease=async()=>({version:'99.0.0'});
updater.applyUpdate=async(current,target)=>{
  const control=JSON.parse(fs.readFileSync(process.env.WP_LAUNCH_UPDATE_CONTROL,'utf8'));
  if(control.fail) throw new Error('simulated install failure');
  fs.writeFileSync(path.join(process.env.WP_LAUNCH_TEST_ROOT,'VERSION'),target);
  fs.writeFileSync(path.join(process.env.WORDPAPER_DATA_DIR,'update-pending.json'),JSON.stringify({nativeReplaced:control.nativeReplaced===true}));
};
''')
    control = temp / 'update-control.json'; control.write_text('{}')
    ready = temp / 'native-ready.json'
    env = {**os.environ, 'PATH': str(fakebin) + os.pathsep + os.environ['PATH'],
           'WORDPAPER_DATA_DIR': str(state), 'WORDPAPER_LOG_DIR': str(logs),
           'WORDPAPER_COMPANION_DATA_DIR': str(temp / 'companion'), 'WORDPAPER_CONFIG_PATH': str(config),
           'WORDPAPER_COMPANION_PORT': str(comp), 'WORDPAPER_COMPANION_AUTOSTART': '0',
           'WORDPAPER_COMPANION_SILENT': '1', 'WORDPAPER_TEST_MODE': '1', 'NODE_ENV': 'test',
           'WORDPAPER_NATIVE_UI': '1', 'WORDPAPER_NATIVE_READY_FILE': str(ready),
           'WP_LAUNCH_UPDATE_CONTROL': str(control),
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
        assert proc.poll() is None, 'Launcher exited before registration completed'
        assert json.loads(ready.read_text()) == {'url': f'http://localhost:{port}', 'owned': True}
        registered = json.loads(config.read_text())
        assert registered['desktopAppPath'] == str(app.resolve()), registered
        assert registered['webOrigin'] == f'http://localhost:{port}', registered
        assert not (logs / 'open.log').exists(), 'Native startup opened a browser'
        print('PASS fresh native launcher registers the exact App and origin before readiness', flush=True)
        before = subprocess.check_output(['lsof', '-nP', f'-tiTCP:{port}', '-sTCP:LISTEN'], text=True).strip()
        companion_base = f'http://127.0.0.1:{comp}'
        def companion_status():
            request = urllib.request.Request(companion_base + '/menu-status.json', headers={'X-WordPaper-Local': '1'})
            return json.load(opener.open(request, timeout=2))
        companion_before = companion_status()['ownerPid']
        # Simulate a companion previously claimed by a different App/origin.
        # Reopening must update the existing process, not rely on its startup env.
        other_app = temp / 'Previous WordPaper.app'
        other_macos = other_app / 'Contents/MacOS'; other_macos.mkdir(parents=True)
        other_resources = other_app / 'Contents/Resources'; other_resources.mkdir()
        shutil.copy2(macos / 'WordPaper', other_macos / 'WordPaper')
        (other_resources / 'server.js').write_text('// registration fixture\n')
        request = urllib.request.Request(companion_base + '/desktop/register',
            data=json.dumps({'appPath': str(other_app), 'webOrigin': 'http://localhost:18126'}).encode(),
            headers={'Content-Type': 'application/json', 'X-WordPaper-Local': '1'})
        assert json.load(opener.open(request, timeout=2))['nativeNavigation'] == 1
        assert companion_status()['web'] == 'http://localhost:18126'
        ready.unlink()
        marker = state / 'update-pending.json'; marker.write_text('preserve-on-reopen')
        reopen = subprocess.run(['/bin/bash', str(launcher)], env=env, capture_output=True, timeout=15)
        assert reopen.returncode == 0, reopen.stderr
        assert proc.poll() is None
        assert json.loads((state / 'port.json').read_text())['port'] == port
        assert subprocess.check_output(['lsof', '-nP', f'-tiTCP:{port}', '-sTCP:LISTEN'], text=True).strip() == before
        assert companion_status()['ownerPid'] == companion_before
        assert json.loads(ready.read_text()) == {'url': f'http://localhost:{port}', 'owned': False}
        registered = json.loads(config.read_text())
        assert registered['desktopAppPath'] == str(app.resolve()), registered
        assert registered['webOrigin'] == f'http://localhost:{port}', registered
        assert not (logs / 'open.log').exists(), 'Native reopen opened a browser'
        assert marker.read_text() == 'preserve-on-reopen'
        marker.unlink()
        print('PASS native reopen re-registers App/origin on existing processes and preserves pending update flag', flush=True)
        ready.unlink()
        request = urllib.request.Request(base + '/api/update/apply-local', data=b'{}', headers={'X-WordPaper-Local': '1'})
        assert json.load(opener.open(request, timeout=3))['started']
        wait_for(lambda: health()['version'] == '99.0.0', timeout=35)
        wait_for(lambda: ready.exists() and not (state / 'startup.lock').exists())
        assert 'update applied: restarting service chain' in (logs / 'server.log').read_text()
        assert proc.poll() is None
        assert json.loads(ready.read_text()) == {'url': f'http://localhost:{port}', 'owned': True}
        assert json.loads(config.read_text())['desktopAppPath'] == str(app.resolve())
        print('PASS update restarts complete launcher/server/companion chain on same port', flush=True)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait()

    # A failed install keeps the service alive; only a successful native-binary
    # update exits with the Cocoa relaunch protocol and preserves its marker.
    (res / 'VERSION').write_text(package.VERSION)
    ready.unlink(missing_ok=True)
    control.write_text(json.dumps({'fail': True}))
    def previous_service_stopped():
        with socket.socket() as probe:
            probe.settimeout(.2)
            return probe.connect_ex(('127.0.0.1', port)) != 0
    wait_for(previous_service_stopped)
    proc = subprocess.Popen(['/bin/bash', str(launcher)], env={**env, 'PORT': str(port)}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
    try:
        wait_for(lambda: ready.exists() and not (state / 'startup.lock').exists())
        request = urllib.request.Request(base + '/api/update/apply-local', data=b'{}', headers={'X-WordPaper-Local': '1'})
        assert json.load(opener.open(request, timeout=3))['started']
        def update_status():
            request = urllib.request.Request(base + '/api/update/status-local', headers={'X-WordPaper-Local': '1'})
            return json.load(opener.open(request, timeout=2))
        wait_for(lambda: 'simulated install failure' in update_status().get('error', ''))
        assert proc.poll() is None and health()['ok']
        assert not (state / 'update-pending.json').exists()
        print('PASS failed update leaves native launcher/services running without a restart marker', flush=True)
        control.write_text(json.dumps({'nativeReplaced': True}))
        assert json.load(opener.open(request, timeout=3))['started']
        assert proc.wait(timeout=35) == 75, 'Native replacement must request a full App restart'
        assert json.loads((state / 'update-pending.json').read_text())['nativeReplaced'] is True
        assert 'update applied: restarting native App' in (logs / 'server.log').read_text()
        assert not (state / 'startup.lock').exists()
        assert not (logs / 'open.log').exists(), 'Launcher must let Cocoa relaunch the App'
        print('PASS successful native update exits with relaunch code 75 and preserves its marker', flush=True)
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try: proc.wait(timeout=8)
            except subprocess.TimeoutExpired: os.killpg(proc.pid, signal.SIGKILL); proc.wait()

    translocated = temp / 'AppTranslocation/fixture/d/WordPaper.app/Contents'
    (translocated / 'MacOS').mkdir(parents=True)
    (translocated / 'Resources').mkdir()
    translocated_launcher = translocated / 'MacOS/launcher.sh'
    translocated_launcher.write_text(launcher.read_text())
    result = subprocess.run(['/bin/bash', str(translocated_launcher)], env=env, capture_output=True, timeout=10)
    assert result.returncode != 0
    assert b'command not found' not in result.stderr
    assert '请先把左侧的 WordPaper 拖到右边' in (logs / 'dialog.log').read_text()
    assert not (logs / 'open.log').exists(), 'Translocation error unexpectedly opened Finder'
    print('PASS DMG translocation shows its instruction without opening a random Finder folder', flush=True)

    # Use HTTP fixtures for malformed/old companion registration responses.
    # The launcher executes its actual reuse branch without spawning any service.
    for label, registration_body, registration_status, accepted in [
        ('missing capability', b'{"ok":true}', 200, False),
        ('unsupported capability', b'{"ok":true,"nativeNavigation":0}', 200, False),
        ('failed registration', b'{"ok":false,"nativeNavigation":1}', 200, False),
        ('non-JSON success status', b'not json', 200, False),
        ('old companion without registration endpoint', b'not found', 404, False),
        ('confirmed native capability', b'{"ok":true,"nativeNavigation":1}', 200, True),
    ]:
        case = temp / label.replace(' ', '-'); case.mkdir()
        case_logs = case / 'logs'; case_logs.mkdir()
        case_ready = case / 'ready.json'
        observed = []
        class Fixture(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_args): pass
            def send_payload(self, code, payload):
                self.send_response(code)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            def do_GET(self):
                if self.path == '/healthz':
                    self.send_payload(200, json.dumps({'ok': True, 'mode': 'local',
                        'version': (res / 'VERSION').read_text().strip()}, separators=(',', ':')).encode())
                elif self.path == '/status.json': self.send_payload(200, b'{"mac":true}')
                else: self.send_payload(404, b'{}')
            def do_POST(self):
                if self.path != '/desktop/register':
                    return self.send_payload(404, b'{}')
                observed.append({'body': json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0)))),
                    'local': self.headers.get('X-WordPaper-Local'), 'origin': self.headers.get('Origin'),
                    'earlyReady': case_ready.exists()})
                self.send_payload(registration_status, registration_body)
        fixtures = [http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture) for _ in range(2)]
        for fixture in fixtures:
            threading.Thread(target=fixture.serve_forever, daemon=True).start()
        fixture_port, fixture_companion = [fixture.server_address[1] for fixture in fixtures]
        case_env = {**env, 'PORT': str(fixture_port), 'WORDPAPER_COMPANION_PORT': str(fixture_companion),
            'WORDPAPER_DATA_DIR': str(case / 'state'), 'WORDPAPER_LOG_DIR': str(case_logs),
            'WORDPAPER_NATIVE_READY_FILE': str(case_ready)}
        try:
            result = subprocess.run(['/bin/bash', str(launcher)], env=case_env, capture_output=True, timeout=15)
            assert len(observed) == 1, (label, observed, result.stderr)
            assert observed[0] == {'body': {'appPath': str(app.resolve()), 'webOrigin': f'http://localhost:{fixture_port}'},
                'local': '1', 'origin': None, 'earlyReady': False}, (label, observed)
            if accepted:
                assert result.returncode == 0, (label, result.stderr)
                assert json.loads(case_ready.read_text()) == {'url': f'http://localhost:{fixture_port}', 'owned': False}
            else:
                assert result.returncode != 0, (label, result.stderr)
                assert not case_ready.exists(), label + ' incorrectly published native readiness'
                assert '桌面入口连接失败' in (case_logs / 'dialog.log').read_text()
            assert not (case_logs / 'open.log').exists(), label + ' unexpectedly opened browser'
            assert not (case_logs / 'server.log').exists(), label + ' unexpectedly spawned service'
            assert not (case_logs / 'companion.log').exists(), label + ' unexpectedly spawned companion'
            assert not (case / 'state/startup.lock').exists(), label + ' leaked startup lock'
            print('PASS native readiness protocol: ' + label, flush=True)
        finally:
            for fixture in fixtures:
                fixture.shutdown(); fixture.server_close()
