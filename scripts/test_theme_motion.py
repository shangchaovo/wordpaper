#!/usr/bin/env python3
"""Isolated browser regression for composed theme transitions and interruption."""
import argparse
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright, Error as PlaywrightError

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--output', default='/tmp/wordpaper-theme-motion')
parser.add_argument('--browser', choices=('chromium', 'webkit'), default='chromium')
parser.add_argument('--executable-path')
args = parser.parse_args()
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)

PROBE = """(() => {
  window.motionRuns = [];
  window.motionErrors = [];
  window.motionLongTasks = [];
  window.motionClicks = [];
  document.addEventListener('click', e => motionClicks.push(e.target.closest('.ui-theme-option')?.dataset.uiTheme || e.target.tagName));
  window.addEventListener('unhandledrejection', e => motionErrors.push(String(e.reason)));
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    new PerformanceObserver(list => motionLongTasks.push(...list.getEntries().map(e => ({start: e.startTime, duration: e.duration})))).observe({type: 'longtask', buffered: true});
  }
  const start = document.startViewTransition.bind(document);
  document.startViewTransition = update => {
    const run = {start: performance.now()}; motionRuns.push(run);
    const transition = start(update);
    transition.ready.then(() => {
      run.ready = performance.now();
      run.opacityDuration = getComputedStyle(document.documentElement, '::view-transition-old(root)').animationDuration;
      if (motionRuns.length === 1) run.snapshot = document.getElementById('preview-canvas').toDataURL();
    }, error => {run.skipped = true; run.reason = String(error);});
    transition.finished.then(() => {run.finished = performance.now();}, () => {run.finished = performance.now();});
    return transition;
  };
})();"""

with tempfile.TemporaryDirectory(prefix='wordpaper-motion-test-') as temp:
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        port = sock.getsockname()[1]
    base = f'http://127.0.0.1:{port}'
    env = {**os.environ, 'PORT': str(port), 'HOST': '127.0.0.1', 'WORDPAPER_MODE': 'public',
           'WORDPAPER_DATA_DIR': temp, 'WORDPAPER_COMPANION_AUTOSTART': '0', 'NODE_ENV': 'test'}
    with open(Path(temp) / 'server.log', 'w') as log:
        server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            for _ in range(100):
                try:
                    urllib.request.urlopen(base + '/healthz', timeout=1).close()
                    break
                except OSError:
                    time.sleep(.1)
            else:
                raise AssertionError('test server did not start')
            with sync_playwright() as p:
                try:
                    browser = getattr(p, args.browser).launch(**({'executable_path': args.executable_path} if args.executable_path else {}))
                except PlaywrightError as error:
                    if args.browser != 'chromium' or args.executable_path or "Executable doesn't exist" not in str(error):
                        raise
                    browser = p.chromium.launch(channel='chrome')
                context = browser.new_context(viewport={'width': 1460, 'height': 980}, device_scale_factor=1)
                context.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(status=200, body=''))
                context.add_init_script(PROBE)
                response = context.request.post(base + '/api/auth/register', headers={'Origin': base},
                                                data={'username': 'motion_test', 'password': 'motion-test-password'})
                assert response.status == 201
                page = context.new_page()
                errors = []
                page.on('pageerror', lambda error: errors.append(str(error)))
                # App polling intentionally outlives page load; the first painted
                # canvas is the readiness condition, not a permanently idle network.
                page.goto(base, wait_until='domcontentloaded')
                page.wait_for_selector('#preview-canvas[data-wallpaper-w]')
                page.wait_for_timeout(800)
                assert page.locator('.ui-theme-option').count() == 4
                page.screenshot(path=str(output / '01-liquid.png'))

                def wait_js(expression, arg=None):
                    for _ in range(120):
                        if page.evaluate(expression, arg):
                            return
                        page.wait_for_timeout(50)
                    raise AssertionError('condition timed out: ' + expression + '\n' + str(page.evaluate("({runs: motionRuns.map(({snapshot, ...r}) => r), clicks: motionClicks, theme: document.documentElement.dataset.uiTheme})")))

                def settled(theme):
                    wait_js("theme => document.documentElement.dataset.uiTheme === theme && !document.documentElement.classList.contains('theme-snapshot')", arg=theme)
                    assert page.locator(f'.ui-theme-option[data-ui-theme="{theme}"]').get_attribute('aria-pressed') == 'true'
                    assert page.locator('.ui-theme-option[aria-pressed="true"]').count() == 1

                def choose(theme):
                    page.locator(f'.ui-theme-option[data-ui-theme="{theme}"]').click()
                    settled(theme)

                page.locator('.ui-theme-option[data-ui-theme="darkliquid"]').click()
                wait_js('motionRuns[0]?.ready')
                page.screenshot(path=str(output / '02-dissolve.png'), animations='allow')
                settled('darkliquid')
                page.screenshot(path=str(output / '03-dark.png'))
                assert page.evaluate("motionRuns[0].opacityDuration") == '0.46s'
                assert page.evaluate("motionRuns[0].snapshot === document.getElementById('preview-canvas').toDataURL()"), 'canvas must finish before destination capture'
                assert not page.evaluate("document.getAnimations().some(a => ['wp-drop','wp-rise','wp-card-enter'].includes(a.animationName) && a.playState === 'running')"), 'theme switch must not replay page entrances'
                print('PASS composed dissolve includes finished wallpaper; no entrance replay', flush=True)

                for theme in ('editorial', 'anime', 'liquid', 'darkliquid', 'liquid'):
                    choose(theme)
                before = page.evaluate('motionRuns.length')
                choose('liquid')
                assert page.evaluate('motionRuns.length') == before, 'same theme should do nothing'
                print('PASS all themes settle and repeated selection is a no-op', flush=True)

                # Use real mouse clicks while the snapshot is visible: the overlay
                # must not swallow clicks and the last requested theme must win.
                page.locator('.ui-theme-option[data-ui-theme="darkliquid"]').click()
                wait_js('motionRuns.at(-1).ready')
                for theme in ('editorial', 'anime', 'liquid'):
                    box = page.locator(f'.ui-theme-option[data-ui-theme="{theme}"]').bounding_box()
                    page.mouse.click(box['x'] + box['width']/2, box['y'] + box['height']/2)
                settled('liquid')
                assert page.evaluate('motionRuns.length') <= before + 2, 'intermediate clicks must not queue a slideshow'
                print('PASS real rapid clicks remain interactive; only final request is queued', flush=True)

                # A duplicate snapshot name forces native capture to skip. State
                # must still commit, release CSS, and permit the next transition.
                page.add_style_tag(content='.theme-snapshot .logo { view-transition-name: theme-picker; }')
                choose('darkliquid')
                assert page.evaluate('motionRuns.at(-1).skipped')
                page.locator('style').last.evaluate('(el) => el.remove()')
                choose('liquid')
                print('PASS skipped native capture recovers without unhandled rejection', flush=True)

                page.emulate_media(reduced_motion='reduce')
                before = page.evaluate('motionRuns.length')
                choose('darkliquid')
                assert page.evaluate('motionRuns.length') == before
                assert page.locator('#ui-theme-picker').evaluate("e => getComputedStyle(e, '::before').transitionDuration") == '0s'
                print('PASS reduced motion bypasses snapshots and indicator animation', flush=True)
                metrics = page.evaluate("({runs: motionRuns.map(({snapshot, ...r}) => r), longTasks: motionLongTasks})")
                (output / 'timings.json').write_text(json.dumps(metrics, indent=2))

                page.emulate_media(reduced_motion='no-preference')
                page.evaluate('document.startViewTransition = undefined')
                choose('editorial')
                page.wait_for_timeout(550)
                assert not page.locator('html').evaluate("e => e.classList.contains('theme-switching')")
                page.reload(wait_until='domcontentloaded')
                page.wait_for_selector('#preview-canvas[data-wallpaper-w]')
                settled('editorial')
                print('PASS unsupported browser fallback and persisted theme after reload', flush=True)

                page.set_viewport_size({'width': 390, 'height': 844})
                choose('darkliquid')
                page.screenshot(path=str(output / '04-mobile.png'))
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                assert not errors, errors
                assert not page.evaluate('motionErrors'), page.evaluate('motionErrors')
                print('PASS mobile layout and no JavaScript errors', flush=True)
                context.close()
                browser.close()
        finally:
            server.terminate()
            try:
                server.wait(timeout=8)
            except subprocess.TimeoutExpired:
                server.kill(); server.wait()
