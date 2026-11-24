#!/usr/bin/env python3
"""Check native guest storage in fresh Cocoa/WKWebView processes on changing ports."""
import http.server
import os
import plistlib
import queue
import subprocess
import sys
import tempfile
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PAGE = b"""<!doctype html><meta charset="utf-8"><script src="/js/guest.js"></script>
<script>
async function verify(phase) {
  if (!window.webkit?.messageHandlers?.wordPaperGuest) return 'missing-bridge';
  if (location.pathname === '/') {
    location.replace('/login.html');
    return;
  }
  if (location.pathname === '/login.html') {
    try { await GuestWorkspace.load(); return 'login-read-allowed'; } catch {}
    await GuestWorkspace.enter();
    location.replace(GuestWorkspace.url());
    return;
  }
  if (!GuestWorkspace.onGuestPage() || !GuestWorkspace.selected()) return 'wrong-workspace';
  const original = await GuestWorkspace.load();
  if (phase === 'write') {
    if (Object.keys(original).length) return 'expected-empty';
    GuestWorkspace.write('reminders', [{text:'native-round-trip'}]);
    GuestWorkspace.write('review', {custom:{words:{fixture:{stage:3}}}});
    if (!await GuestWorkspace.flush()) return 'failed-flush';
  } else {
    if (original.reminders?.[0]?.text !== 'native-round-trip') return 'missing-reminder';
    if (original.review?.custom?.words?.fixture?.stage !== 3) return 'missing-review';
    await GuestWorkspace.leave();
  }
  return 'ok';
}
verify('PHASE').catch(() => 'bridge-error').then(flag => {
  if (flag) fetch('/receipt/' + flag, {method:'POST'});
});
</script>"""


class Fixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == '/js/guest.js':
            body = (ROOT / 'js/guest.js').read_bytes()
            mime = 'application/javascript'
        elif self.path in ('/', '/login.html', '/guest'):
            self.server.visits.append(self.path)
            body = PAGE.replace(b'PHASE', self.server.phase.encode())
            mime = 'text/html'
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header('Content-Type', mime)
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if not self.path.startswith('/receipt/'):
            self.send_error(404)
            return
        self.send_response(204)
        self.end_headers()
        self.server.receipts.put(self.path.removeprefix('/receipt/'))


@contextmanager
def loopback():
    with http.server.ThreadingHTTPServer(('127.0.0.1', 0), Fixture) as server:
        server.receipts = queue.Queue()
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            yield server
        finally:
            server.shutdown()
            thread.join()


def build(folder):
    contents = folder / 'Guest Storage Test.app' / 'Contents'
    executable = contents / 'MacOS' / 'WordPaper'
    executable.parent.mkdir(parents=True)
    with (contents / 'Info.plist').open('wb') as output:
        plistlib.dump({
            'CFBundleIdentifier': 'org.wordpaper.guesttest.' + uuid.uuid4().hex,
            'CFBundleName': 'Guest Storage Test', 'CFBundleExecutable': executable.name,
            'CFBundlePackageType': 'APPL', 'CFBundleVersion': '1',
            'NSAppTransportSecurity': {'NSAllowsLocalNetworking': True},
        }, output)
    subprocess.run(['clang', '-O2', '-fobjc-arc', '-mmacosx-version-min=13.0',
                    '-framework', 'Cocoa', '-framework', 'WebKit', '-o', str(executable),
                    str(ROOT / 'scripts/native_app.m')], check=True)
    return executable


def launch(executable, folder, server, phase, expected):
    server.phase = phase
    server.visits = []
    env = {key: value for key, value in os.environ.items() if not key.startswith('WORDPAPER_')}
    env.update(NODE_ENV='test', WORDPAPER_DATA_DIR=str(folder / 'data'),
               WORDPAPER_NATIVE_TEST_URL=f'http://127.0.0.1:{server.server_port}',
               # Enables the app's nonpersistent WKWebsiteDataStore on every launch.
               WORDPAPER_NATIVE_NAVIGATION_REPORT=str(folder / f'{phase}.jsonl'))
    with (folder / f'{phase}.log').open('wb') as log:
        proc = subprocess.Popen([str(executable)], env=env, stdout=log, stderr=log)
        try:
            try:
                flag = server.receipts.get(timeout=25)
            except queue.Empty:
                raise AssertionError(f'{phase} timed out, visited {server.visits}, exit={proc.poll()}') from None
            assert server.visits == expected, f'{phase}: visited {server.visits}, expected {expected}'
            assert flag == 'ok', f'{phase}: {flag}'
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


if __name__ == '__main__':
    if sys.platform != 'darwin':
        sys.exit('This test requires macOS and a Cocoa window session.')
    with tempfile.TemporaryDirectory(prefix='wordpaper-guest-native-') as directory, loopback() as first, loopback() as second:
        folder = Path(directory)
        executable = build(folder)
        launch(executable, folder, first, 'write', ['/', '/login.html', '/guest'])
        launch(executable, folder, second, 'reopen', ['/guest'])
        launch(executable, folder, first, 'reenter', ['/', '/login.html', '/guest'])
    print('PASS: native guest records survived process exit, port change, leaving and reentering.')
