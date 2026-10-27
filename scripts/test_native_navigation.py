#!/usr/bin/env python3
"""Exercise the real Cocoa window, deep links and navigation without personal state."""
import http.server
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[1]
GOOGLE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=wordpaper-navigation-test'
WECHAT = 'https://open.weixin.qq.com/connect/qrconnect?appid=wordpaper-navigation-test'


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        self.server.requests.append((self.headers.get('Host'), self.path))
        port = self.server.server_port
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == '/' and not parsed.query:
            script = "setTimeout(() => window.webkit.messageHandlers.nativeTest.postMessage('hide'), 250);"
        elif parsed.path == '/' and parsed.query == 'openMemory=1':
            alias = '127.0.0.1' if self.server.origin_host == 'localhost' else 'localhost'
            target = f'http://{alias}:{port}/alias-ipv4?value=a%20b#memory'
            script = f'setTimeout(() => location.assign({json.dumps(target)}), 250);'
        elif parsed.path == '/alias-ipv4':
            target = f'http://[::1]:{port}/alias-ipv6?keep=yes#done'
            script = f"setTimeout(() => {{ let a=document.createElement('a'); a.href={json.dumps(target)}; a.target='_blank'; document.body.append(a); a.click(); }}, 250);"
        elif parsed.path == '/alias-ipv6':
            target = f'http://127.0.0.1:{port}/bridge?value=x%2Fy#card'
            script = f'setTimeout(() => window.WordPaperDesktop.openExternal({json.dumps(target)}), 250);'
        elif parsed.path == '/bridge':
            script = f'''setTimeout(() => location.assign({json.dumps(GOOGLE)}), 250);
setTimeout(() => {{ let a=document.createElement('a'); a.href={json.dumps(WECHAT)}; a.target='_blank'; document.body.append(a); a.click(); }}, 500);
setTimeout(() => window.WordPaperDesktop.openExternal({json.dumps(self.server.external_loopback)}), 750);'''
        else:
            script = ''
        payload = ('<!doctype html><meta charset="utf-8"><title>WordPaper navigation test</title>'
                   '<main>Isolated navigation fixture</main><script>' + script + '</script>').encode()
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def events_at(report):
    if not report.exists():
        return []
    lines = report.read_text().split('\n')
    return [json.loads(line) for line in lines[:-1] if line]


def wait_for(report, proc, predicate, seconds=20):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        events = events_at(report)
        if predicate(events):
            return events
        assert proc.poll() is None, f'Native test App exited early: {events}'
        time.sleep(.05)
    raise AssertionError(f'Navigation did not finish: {events_at(report)}')


with tempfile.TemporaryDirectory(prefix='wordpaper-native-navigation-') as directory:
    folder = Path(directory)
    app = folder / 'WordPaper Navigation Test.app'
    macos = app / 'Contents/MacOS'
    macos.mkdir(parents=True)
    bundle_id = 'org.wordpaper.navigationtest.' + uuid.uuid4().hex
    with (app / 'Contents/Info.plist').open('wb') as output:
        plistlib.dump({
            'CFBundleIdentifier': bundle_id, 'CFBundleName': 'WordPaper Navigation Test',
            'CFBundleExecutable': 'WordPaper', 'CFBundlePackageType': 'APPL',
            'CFBundleVersion': '1', 'CFBundleShortVersionString': '1.0',
            'LSMinimumSystemVersion': '13.0', 'NSHighResolutionCapable': True,
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
            'CFBundleURLTypes': [{'CFBundleURLName': 'Isolated WordPaper test', 'CFBundleURLSchemes': ['wordpaper']}],
        }, output)
    subprocess.run(['clang', '-O2', '-fobjc-arc', '-mmacosx-version-min=13.0',
                    '-framework', 'Cocoa', '-framework', 'WebKit',
                    '-o', str(macos / 'WordPaper'), str(ROOT / 'scripts/native_app.m')], check=True)
    second_app = folder / 'Other WordPaper Navigation Test.app'
    shutil.copytree(app, second_app)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    other = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
    server.requests = []
    other.requests = []
    server.external_loopback = f'http://127.0.0.1:{other.server_port}/connect?device=test'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    threading.Thread(target=other.serve_forever, daemon=True).start()
    try:
        for origin_host in ('localhost', '127.0.0.1'):
            server.origin_host = origin_host
            request_start = len(server.requests)
            origin = f'http://{origin_host}:{server.server_port}'
            report = folder / (origin_host + '.jsonl')
            log = folder / (origin_host + '.log')
            env = {**os.environ, 'NODE_ENV': 'test', 'WORDPAPER_NATIVE_TEST_URL': origin,
                   'WORDPAPER_NATIVE_NAVIGATION_REPORT': str(report),
                   'WORDPAPER_SKIP_COMPANION': '1', 'WORDPAPER_COMPANION_AUTOSTART': '0',
                   'WORDPAPER_DATA_DIR': str(folder / 'data'), 'WORDPAPER_LOG_DIR': str(folder / 'logs')}
            for name in ('WORDPAPER_NATIVE_TEST_REPORT', 'WORDPAPER_NATIVE_TEST_EXIT', 'WORDPAPER_SELFTEST'):
                env.pop(name, None)
            with log.open('wb') as output:
                proc = subprocess.Popen([str(macos / 'WordPaper')], env=env, stdout=output, stderr=output)
                try:
                    initial = wait_for(report, proc, lambda values: any(e['event'] == 'hidden' for e in values))
                    hidden = next(e for e in initial if e['event'] == 'hidden')
                    assert not hidden['visible'], hidden
                    deep_link = 'wordpaper://open?path=' + urllib.parse.quote('/?openMemory=1', safe='')
                    # Explicit App path and unique bundle ID cannot target the installed WordPaper.
                    subprocess.run(['/usr/bin/open', '-a', str(app), deep_link], check=True, timeout=10)
                    expected_external = {GOOGLE, WECHAT, server.external_loopback}
                    events = wait_for(report, proc, lambda values: expected_external <= {
                        e['url'] for e in values if e['event'] == 'external'})
                    expected_loaded = [origin + '/?openMemory=1', origin + '/alias-ipv4?value=a%20b#memory',
                                       origin + '/alias-ipv6?keep=yes#done', origin + '/bridge?value=x%2Fy#card']
                    loaded = [e for e in events if e['event'] == 'loaded']
                    assert [e['url'] for e in loaded] == [origin + '/'] + expected_loaded, events
                    assert all(e['pid'] == proc.pid and e['windowNumber'] == hidden['windowNumber'] for e in events), events
                    assert all(e['visible'] for e in loaded[1:]), events
                    external = [e for e in events if e['event'] == 'external']
                    assert {e['url'] for e in external} == expected_external, events
                    assert all(e['workspaceURL'] == expected_loaded[-1] for e in external), events
                    assert not other.requests, 'An external authorization was loaded inside WKWebView'
                    assert all(host == f'{origin_host}:{server.server_port}' for host, _ in server.requests[request_start:]), server.requests
                    print(f'PASS {origin_host}: same window reopens via deep link; aliases keep original origin; Google/WeChat/other-port OAuth dispatch externally')
                except Exception:
                    print(log.read_text(errors='replace')[-4000:])
                    raise
                finally:
                    if proc.poll() is None:
                        proc.terminate()
                        try:
                            proc.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            proc.kill(); proc.wait()
        # Duplicate installations retain the same bundle identifier. The explicit
        # registered path must select the intended running process, not whichever
        # copy LaunchServices most recently encountered.
        copies = []
        try:
            for number, copy_app in enumerate((app, second_app)):
                copy_report = folder / f'copy-{number}.jsonl'
                copy_log = (folder / f'copy-{number}.log').open('wb')
                copy_env = {**env, 'WORDPAPER_NATIVE_NAVIGATION_REPORT': str(copy_report)}
                copy_proc = subprocess.Popen([str(copy_app / 'Contents/MacOS/WordPaper')],
                                             env=copy_env, stdout=copy_log, stderr=copy_log)
                copies.append((copy_app, copy_proc, copy_report, copy_log))
                wait_for(copy_report, copy_proc, lambda values: any(e['event'] == 'hidden' for e in values))
            assert copies[0][1].pid != copies[1][1].pid
            for selection in (0, 1, 0):
                selected_app, selected_proc, selected_report, _ = copies[selection]
                before = [events_at(copy[2]) for copy in copies]
                target_path = f'/?openMemory=1&copy={selection}&event={len(before[selection])}'
                target_url = origin + target_path
                deep_link = 'wordpaper://open?path=' + urllib.parse.quote(target_path, safe='')
                subprocess.run(['/usr/bin/open', '-a', str(selected_app), deep_link], check=True, timeout=10)
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    after = [events_at(copy[2]) for copy in copies]
                    recipients = [index for index, values in enumerate(after)
                                  if any(e['event'] == 'loaded' and e['url'] == target_url for e in values)]
                    if recipients:
                        break
                    assert all(copy[1].poll() is None for copy in copies), after
                    time.sleep(.05)
                else:
                    raise AssertionError(f'Neither running copy received {target_url}: {after}')
                assert recipients == [selection], f'open -a selected copy {selection}, but copies {recipients} received it: {after}'
                assert after[1 - selection] == before[1 - selection], after
                received = next(e for e in after[selection] if e['event'] == 'loaded' and e['url'] == target_url)
                assert received['pid'] == selected_proc.pid and received['visible'], received
                assert received['windowNumber'] == before[selection][0]['windowNumber'], received
            print('PASS duplicate bundle ID: exact App path routes each deep link to its own existing PID/window')
        finally:
            for _, copy_proc, _, copy_log in copies:
                if copy_proc.poll() is None:
                    copy_proc.terminate()
                    try:
                        copy_proc.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        copy_proc.kill(); copy_proc.wait()
                copy_log.close()
        assert not (folder / 'logs').exists(), 'Test unexpectedly started a service or companion'
    finally:
        server.shutdown(); server.server_close()
        other.shutdown(); other.server_close()
        # Remove only this temporary registration; never select a global scheme handler.
        register = Path('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister')
        if register.exists():
            for temporary_app in (app, second_app):
                subprocess.run([str(register), '-u', str(temporary_app)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
