#!/usr/bin/env python3
"""Companion SRS writeback and an already-open browser, sharing a temporary DB."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from e2e import ROOT, PlaywrightError, free_port, sync_playwright, wait_up


def main():
    # This test drives the companion's real sips-rendered native question.
    # Cross-platform browser/API coverage lives in test_learning_activity.py.
    if sys.platform != 'darwin':
        print('SKIP native quiz writeback: requires the macOS companion rasterizer')
        return
    port, companion_port = free_port(), free_port()
    base = f'http://127.0.0.1:{port}'
    companion_base = f'http://127.0.0.1:{companion_port}'
    with tempfile.TemporaryDirectory(prefix='wordpaper-quiz-sync-') as temp:
        env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', WORDPAPER_MODE='local',
                   WORDPAPER_DATA_DIR=temp, WORDPAPER_COMPANION_DATA_DIR=temp,
                   WORDPAPER_STATE_PATH=str(Path(temp) / 'state.json'), WORDPAPER_CONFIG_PATH=str(Path(temp) / 'config.json'),
                   WORDPAPER_CUSTOM_WORDS_PATH=str(Path(temp) / 'custom.json'),
                   WORDPAPER_COMPANION_PORT=str(companion_port), WORDPAPER_COMPANION_AUTOSTART='0', NODE_ENV='test')
        with tempfile.TemporaryFile(mode='w+') as log:
            server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
            companion = None
            try:
                assert wait_up(port), 'server failed to start'
                companion = subprocess.Popen(['node', 'companion.js'], cwd=ROOT,
                    env=dict(env, WORDPAPER_TEST_MODE='1', WORDPAPER_PORT=str(companion_port)), stdout=log, stderr=log)
                with sync_playwright() as p:
                    try:
                        browser = p.chromium.launch()
                    except PlaywrightError as exc:
                        if "Executable doesn't exist" not in str(exc):
                            raise
                        browser = p.chromium.launch(channel='chrome')
                    context = browser.new_context()
                    context.route('https://cdn.jsdelivr.net/npm/xlsx@*/**', lambda route: route.fulfill(status=200, body=''))
                    context.route('**/api/update/check*', lambda route: route.fulfill(status=200,
                        content_type='application/json', body='{"supported":false,"available":false}'))
                    for _ in range(80):
                        try:
                            if context.request.get(companion_base + '/status.json').ok:
                                break
                        except Exception:
                            pass
                        time.sleep(.05)
                    account = context.request.post(base + '/api/auth/register', headers={'Origin': base},
                        data={'username': 'quiz_sync_user', 'password': 'isolated-quiz-sync-password'})
                    assert account.status == 201, account.text()
                    auth = account.json()
                    headers = {'Origin': base, 'X-CSRF-Token': auth['csrfToken']}
                    word = {'word': 'commute', 'meaning': '通勤', 'phonetic': '/kəˈmjuːt/'}
                    key = 'commute|通勤'
                    initial = {'ielts': {'words': {key: {'word': word, 'stage': 0,
                        'due': int(time.time() * 1000) - 1000, 'learnedCount': 1, 'reviewCount': 0, 'events': []}}}}
                    assert context.request.put(base + '/api/state/review', headers=headers,
                        data={'value': initial, 'expectedRevision': 0}).ok
                    probe = context.request.post(base + '/pet-sync.php', headers=headers,
                        data={'library': 'ielts', 'webOrigin': base, 'petWallpaperSync': False}, timeout=5000)
                    assert probe.ok, probe.text()
                    page = context.new_page()
                    errors = []
                    pending = set()
                    counts = {}
                    def track(request):
                        pending.add(request.url)
                        counts[request.url] = counts.get(request.url, 0) + 1
                    page.on('request', track)
                    page.on('requestfinished', lambda request: pending.discard(request.url))
                    page.on('requestfailed', lambda request: pending.discard(request.url))
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.add_init_script('''window.__quizTimers = [];
                      const original = window.setInterval;
                      window.setInterval = function(fn, ms, ...args) {
                        if (fn.name === 'syncPetMemoryEvents') window.__quizTimers.push(fn);
                        return original(fn, ms, ...args);
                      };''')
                    try:
                        page.goto(base, wait_until='networkidle', timeout=12000)
                    except PlaywrightError:
                        print('Pending requests:', sorted(pending), 'Repeated requests:', {k:v for k,v in counts.items() if v>2}, 'Page errors:', errors, flush=True)
                        log.seek(0); print(log.read()[-5000:], flush=True)
                        raise
                    page.wait_for_selector('#library-cards .lib-card')
                    page.wait_for_function('window.__quizTimers.length > 0')
                    assert page.evaluate("Store.getReview().ielts.words['commute|通勤'].stage") == 0
                    assert context.request.post(base + '/pet-mode.php?mode=patrick', headers=headers).ok
                    offer = context.request.post(base + '/pet-quiz.php', headers=headers,
                        data={'action': 'offer', 'library': 'ielts', 'words': [{**word, 'stage': 0, 'due': 1}]}).json()
                    assert offer.get('offered'), offer
                    for _ in range(100):
                        geom = context.request.get(companion_base + '/pet-patrick.json').json().get('quizGeom')
                        if geom:
                            break
                        time.sleep(.05)
                    assert geom, 'no rendered question'
                    invalid = context.request.post(base + '/pet-quiz.php', headers=headers,
                        data={'action': 'answer', 'picked': None, 'quizId': geom['id']})
                    assert invalid.status == 400
                    stale = context.request.post(base + '/pet-quiz.php', headers=headers,
                        data={'action': 'answer', 'picked': 0, 'quizId': 'old-card'})
                    assert stale.status == 409
                    answer = context.request.post(base + '/pet-quiz.php', headers=headers,
                        data={'action': 'answer', 'picked': 0, 'quizId': geom['id']}).json()
                    assert answer['ok'], answer
                    remote = context.request.get(base + '/api/state').json()['state']['review']['ielts']['words'][key]
                    if remote['reviewCount'] != 1:
                        log.seek(0); print(log.read()[-4000:])
                    assert remote['reviewCount'] == 1, (answer, remote)
                    assert remote['stage'] == (1 if answer['correct'] else 0)
                    assert remote['petQuiz']['count'] == 1
                    activity = context.request.get(base + '/api/state').json()['state']['learningActivity']
                    assert sum(len(events) for events in activity['days'].values()) == 1
                    for _ in range(2):
                        page.evaluate('async () => { for (const sync of window.__quizTimers) await sync(); }')
                    cached = page.evaluate("Store.getReview().ielts.words['commute|通勤']")
                    assert cached == remote, (cached, remote)
                    assert page.locator('#plan-count-total').inner_text() == '1', 'native and browser replay must count one practice'
                    assert page.locator('#plan-count-recite').inner_text() == '1'
                    # A subsequent edit must use the new server revision, avoiding 409.
                    assert page.evaluate("async () => { const all=Store.getReview(); all.ielts.cursor=7; Store.saveReview(all); return await Store.flush(); }")
                    final = context.request.get(base + '/api/state').json()['state']['review']['ielts']
                    assert final['cursor'] == 7 and final['words'][key]['reviewCount'] == 1
                    assert not errors, errors
                    browser.close()
                    print('PASS native answer persists once, browser refreshes value/revision, stale/invalid clicks rejected')
            finally:
                if companion:
                    companion.kill(); companion.wait()
                server.terminate()
                try:
                    server.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait()


if __name__ == '__main__':
    main()
