#!/usr/bin/env python3
"""Real SVG bounds and native scroll/click regression; uses only isolated fixtures."""
import argparse
import json
import platform
import re
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright, Error as PlaywrightError

ROOT = Path(__file__).resolve().parent.parent


def verify(out):
    subprocess.run(['node', 'scripts/test_quiz.js', '--fixtures', str(out)], cwd=ROOT, check=True)
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
            page.wait_for_load_state('networkidle')
            bounds = page.evaluate('''() => {
              const s = document.querySelector('svg');
              return {w:s.viewBox.baseVal.width, h:s.viewBox.baseVal.height,
                text:[...s.querySelectorAll('text')].map(t => {
                  const b=t.getBBox(); return {text:t.textContent, x:b.x, y:b.y, w:b.width, h:b.height};
                })};
            }''')
            overflow = [t for t in bounds['text'] if t['x'] < 5 or t['x'] + t['w'] > bounds['w'] - 5
                        or t['y'] < 0 or t['y'] + t['h'] > bounds['h']]
            assert not overflow, (svg.name, overflow)
            page.set_viewport_size({'width': int(bounds['w']) + 16, 'height': min(1200, int(bounds['h']) + 16)})
            page.locator('svg').screenshot(path=str(out / (svg.stem + '-browser.png')))
            print('PASS rendered text bounds:', svg.name, flush=True)
        browser.close()

    if platform.system() != 'Darwin':
        print('SKIP AppKit verification (macOS only)')
        return
    for name in ('collapsed', 'expanded'):
        subprocess.run(['sips', '-s', 'format', 'png', str(out / (name + '.svg')), '--out', str(out / (name + '.png'))], check=True, capture_output=True)

    calls = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            body = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            calls.append(json.loads(body) if body else {})
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    source = (out / 'patrick.jxa.js').read_text()
    start = source.index('  function makeCardWin(')
    end = source.index('  /* 抽查卡跟随派大星:', start)
    methods = source[start:end]
    compact = json.loads((out / 'collapsed.json').read_text())
    full = json.loads((out / 'expanded.json').read_text())
    compact['id'] = full['id'] = 'isolated-native-test'
    harness = '''ObjC.import('Cocoa');
function run() {
  $.NSApplication.sharedApplication.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var quizWin = null, quizGripView = null, quizScrollView = null, cardKind = 'quiz';
  var screen = $.NSScreen.mainScreen.frame;
  var M = {port: PORT, quizBtnSkipX1:145};
  var compact = COMPACT, full = FULL, lastQuizGeom = compact;
  METHODS
  function assert(ok, message) { if (!ok) throw new Error(message); }
  function tick() { $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.25)); }
  function click(top, x) {
    var p = quizGripView.convertPointToView($.NSMakePoint(x || 75, quizGripView.bounds.size.height - top), $());
    var e = $.NSEvent.mouseEventWithTypeLocationModifierFlagsTimestampWindowNumberContextEventNumberClickCountPressure(
      $.NSLeftMouseDown, p, 0, 0, quizWin.windowNumber, $(), 0, 1, 1);
    quizGripView.mouseDown(e); tick();
  }
  function snapshot(filename) {
    var v=quizWin.contentView, b=v.bounds;
    var rep=v.bitmapImageRepForCachingDisplayInRect(b);
    v.cacheDisplayInRectToBitmapImageRep(b,rep);
    rep.representationUsingTypeProperties($.NSPNGFileType,$({})).writeToFileAtomically(filename,true);
  }
  quizWin = makeCardWin(30,700,PNG,compact.w,compact.h); tick();
  click(compact.optTops[0] + 10); // A is shortened: expand, never answer.
  lastQuizGeom = full; syncQuizWinSize(); tick();
  assert(quizWin.frame.size.height <= $.NSScreen.mainScreen.visibleFrame.size.height - 16, 'window exceeds usable screen');
  assert(Math.round(quizGripView.frame.size.height) === full.h, 'document view not resized');
  assert(quizGripView.frame.size.height > quizWin.frame.size.height, 'fixture must really require scrolling');
  snapshot(TOP);
  quizGripView.scrollPoint($.NSMakePoint(0,0)); tick();
  quizGripView.setNeedsDisplay(true); tick();
  assert(quizScrollView.contentView.bounds.origin.y < 1, 'cannot reach bottom of definitions');
  click(full.optTops[3] + 10); // D after scrolling must still be answer index 3.
  click(full.chipTop + 10);   // Expanded chip must send collapse.
  snapshot(BOTTOM);
  lastQuizGeom = compact; syncQuizWinSize(); tick();
  assert(Math.round(quizWin.frame.size.height) === compact.h, 'collapse did not resize the window');
  assert(Math.round(quizGripView.frame.size.height) === compact.h, 'collapse left stale hit coordinates');
  click(compact.optTops[1] + 10);
  click(compact.btnTop + 10); // Disabled footer must do nothing.
  quizWin.orderOut($());
  return 'PASS native expand / scroll / hit areas / collapse';
}
'''
    replacements = {'PORT': str(server.server_port), 'COMPACT': json.dumps(compact), 'FULL': json.dumps(full),
                    'METHODS': methods, 'PNG': json.dumps(str(out / 'expanded.png')),
                    'TOP': json.dumps(str(out / 'native-top.png')), 'BOTTOM': json.dumps(str(out / 'native-bottom.png'))}
    for key, value in replacements.items():
        harness = re.sub(r'\b' + key + r'\b', lambda _: value, harness)
    script = out / 'native-test.jxa.js'
    script.write_text(harness)
    try:
        result = subprocess.run(['osascript', '-l', 'JavaScript', str(script)], capture_output=True, text=True, timeout=25)
        assert result.returncode == 0, result.stderr
        assert [c['action'] for c in calls] == ['expand', 'answer', 'collapse', 'answer'], calls
        assert [c['picked'] for c in calls if c['action'] == 'answer'] == [3, 1], calls
        assert all(c['quizId'] == 'isolated-native-test' for c in calls), calls
        print(result.stdout.strip(), flush=True)
    finally:
        server.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        verify(args.out.resolve())
    else:
        with tempfile.TemporaryDirectory(prefix='wordpaper-quiz-layout-') as temp:
            verify(Path(temp))
