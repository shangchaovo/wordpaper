#!/usr/bin/env python3
"""Daily goals through the real UI/API with isolated accounts and replay data."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from e2e import ROOT, PlaywrightError, free_port, sync_playwright, wait_up
from playwright.sync_api import expect


def main():
    def sync_activity(page):
        page.evaluate('''async () => {
          for (let i=0; i<20 && !window.__learningTicks.length; i++) await new Promise(r => setTimeout(r, 50));
          for (let i=0; i<3; i++) {
            await Store.flush();
            for (const sync of window.__learningTicks) await sync();
            await new Promise(r => setTimeout(r, 100));
          }
        }''')
    port = free_port()
    base = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='wordpaper-learning-ui-') as temp:
        env = dict(os.environ, PORT=str(port), HOST='127.0.0.1', WORDPAPER_MODE='local',
                   WORDPAPER_DATA_DIR=temp, WORDPAPER_COMPANION_ENABLED='0', NODE_ENV='test')
        with tempfile.TemporaryFile(mode='w+') as log:
            server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                assert wait_up(port)
                with sync_playwright() as p:
                    try:
                        browser = p.chromium.launch()
                    except PlaywrightError as exc:
                        if "Executable doesn't exist" not in str(exc):
                            raise
                        browser = p.chromium.launch(channel='chrome')
                    context = browser.new_context(viewport={'width': 1460, 'height': 1050}, timezone_id='Asia/Taipei')
                    context.route('https://cdn.jsdelivr.net/**', lambda r: r.fulfill(status=200, body=''))
                    context.route('**/api/update/check*', lambda r: r.fulfill(json={'supported': False, 'available': False}))
                    context.route('**/pet-celebrate.php', lambda r: r.fulfill(json={'ok': True}))
                    account = context.request.post(base + '/api/auth/register', headers={'Origin': base},
                        data={'username': 'activity_user', 'password': 'isolated-learning-password'}).json()
                    headers = {'Origin': base, 'X-CSRF-Token': account['csrfToken']}
                    now = int(time.time() * 1000)
                    date = datetime.now(ZoneInfo('Asia/Taipei'))
                    today, yesterday = date.strftime('%Y-%m-%d'), (date - timedelta(days=1)).strftime('%Y-%m-%d')
                    word = {'word': 'repeat', 'meaning': '重复'}
                    review = {'ielts': {'words': {'repeat|重复': {'word': word, 'stage': 0,
                        'due': now - 1000, 'learnedAt': now - 86400000, 'reviewCount': 0, 'events': []}}}}
                    for namespace, value in {
                        'dailyPlan': {'dailyGoal': 10, 'learnedByDay': {today: 2}, 'checkins': {yesterday: 1}, 'activityStartedAt': now - 10000},
                        'review': review,
                        'settings': {'library': 'ielts', 'srsEnabled': False, 'petWallpaperSync': False},
                    }.items():
                        assert context.request.put(base + '/api/state/' + namespace, headers=headers,
                            data={'value': value, 'expectedRevision': 0}).ok
                    events = [{'id': i, 'action': 'quiz', 'word': word, 'library': 'ielts', 'at': now,
                               'correct': False, 'srsApplied': True, 'userId': account['user']['id']} for i in range(1, 4)]
                    events += [
                        {'id': 4, 'action': 'sentence', 'word': word, 'library': 'cet4', 'at': now, 'score': 1},
                        {'id': 5, 'action': 'quiz', 'word': word, 'library': 'ielts', 'at': now - 86400000, 'srsApplied': True, 'userId': account['user']['id']},
                        {'id': 6, 'action': 'sentence', 'word': word, 'library': 'ielts', 'at': now, 'userId': account['user']['id'] + 100},
                        {'id': 7, 'action': 'learn', 'word': word, 'library': 'ielts', 'at': now - 20000},
                        {'id': 8, 'action': 'learn', 'word': {'word': 'practice', 'meaning': '练习'}, 'library': 'ielts', 'at': now},
                    ]
                    # Deliberately replay the same events every time, including
                    # a duplicate snapshot and an old first-pass credit.
                    context.route('**/pet-memory-events.json?*', lambda r: r.fulfill(json={
                        'streamId': 'fixture', 'lastId': 8, 'reset': True, 'events': events, 'snapshot': [events[7]]}))
                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.add_init_script('''window.__learningTicks = [];
                      Object.defineProperty(window.crypto, 'randomUUID', { value: undefined });
                      const original = window.setInterval;
                      window.setInterval = function(fn, ms, ...args) {
                        if (fn.name === 'syncPetMemoryEvents') window.__learningTicks.push(fn);
                        return original(fn, ms, ...args);
                      };''')
                    page.goto(base, wait_until='domcontentloaded')
                    page.wait_for_selector('#library-cards .lib-card')
                    sync_activity(page)
                    expect(page.locator('#plan-count-total')).to_have_text('7', timeout=12000)
                    assert page.locator('#plan-count-recite').inner_text() == '6'
                    assert page.locator('#plan-count-sentence').inner_text() == '1'
                    assert page.locator('#plan-streak').inner_text() == '1 天'
                    assert page.locator('#btn-plan-checkin').is_disabled()
                    assert page.locator('#plan-dict-eta').count() == 0
                    assert page.evaluate('Store.getReview().ielts.words["repeat|重复"].stage') == 0
                    for _ in range(2):
                        page.evaluate('async () => { for (const sync of window.__learningTicks) await sync(); await Store.flush(); }')
                    expect(page.locator('#plan-count-total')).to_have_text('7')
                    page.reload(wait_until='domcontentloaded')
                    page.wait_for_selector('#library-cards .lib-card')
                    sync_activity(page)
                    expect(page.locator('#plan-count-total')).to_have_text('7', timeout=12000)
                    assert page.evaluate('async () => await Store.flush()')
                    assert page.evaluate("Store.getReview().ielts.words['practice|练习'] || null") is None
                    page.check('#chk-srs')
                    sync_activity(page)
                    assert page.evaluate("!!Store.getReview().ielts.words['practice|练习']"), 'enabling SRS must recover first-pass actions collected while disabled'
                    expect(page.locator('#plan-count-total')).to_have_text('7')

                    # All three goals are selectable; only the chosen action counts.
                    page.select_option('#sel-plan-metric', 'sentence')
                    page.fill('#inp-plan-daily', '2'); page.locator('#inp-plan-daily').press('Tab')
                    assert page.locator('#btn-plan-checkin').is_disabled()
                    assert page.locator('#plan-progress-text').inner_text() == '1/2 次'
                    page.fill('#inp-plan-daily', '1'); page.locator('#inp-plan-daily').press('Tab')
                    page.click('#btn-plan-checkin')
                    assert page.locator('#plan-streak').inner_text() == '2 天'
                    assert page.locator('#btn-plan-checkin').inner_text() == '今日已打卡 ✓'
                    page.select_option('#sel-plan-metric', 'recite')
                    assert page.locator('#plan-progress-text').inner_text() == '6/1 次'
                    assert '造句次数 1 次' in page.locator('#plan-checkin-note').inner_text()

                    # Notebook grades count equally and undo restores both SRS
                    # and the daily count.
                    page.click('#btn-open-memory')
                    page.click('.memory-answer.forgot')
                    expect(page.locator('#plan-count-total')).to_have_text('8')
                    assert page.evaluate('Store.getReview().ielts.words["repeat|重复"].stage') == 0
                    page.click('.memory-undo')
                    expect(page.locator('#plan-count-total')).to_have_text('7')
                    page.click('.memory-answer.fuzzy')
                    expect(page.locator('#plan-count-total')).to_have_text('8')
                    page.click('.memory-undo')
                    page.click('.memory-answer.remembered')
                    expect(page.locator('#plan-count-total')).to_have_text('8')
                    assert page.evaluate('Store.getReview().ielts.words["repeat|重复"].stage') == 1
                    page.click('.memory-undo')
                    expect(page.locator('#plan-count-total')).to_have_text('7')
                    page.locator('#memory-modal .modal-close').click()
                    expect(page.locator('#memory-modal')).to_be_hidden()

                    # Simulate another device writing while this browser has a
                    # pending event. The server merges; Store receives both.
                    page.evaluate('''async () => {
                      await Store.flush();
                      const snap = await (await fetch('/api/state')).json();
                      const mine = LearningActivity.record(Store.read('learningActivity', {}), { action:'quiz', activityId:'tab', at:Date.now() });
                      Store.write('learningActivity', mine);
                      const remote = LearningActivity.record(snap.state.learningActivity, { action:'sentence', activityId:'remote', at:Date.now() });
                      await fetch('/api/state/learningActivity', { method:'PUT', headers:{'Content-Type':'application/json','X-CSRF-Token':Store.csrfToken()}, body:JSON.stringify({value:remote,expectedRevision:snap.revisions.learningActivity}) });
                      await Store.flush();
                    }''')
                    assert page.evaluate("LearningActivity.totals(Store.read('learningActivity'), LearningActivity.dayKey(), 2).total") == 9
                    page.select_option('#sel-plan-metric', 'total')
                    page.fill('#inp-plan-daily', '10'); page.locator('#inp-plan-daily').press('Tab')
                    assert page.locator('#plan-progress-text').inner_text() == '9/10 次'
                    assert page.evaluate('async () => await Store.flush()')
                    output = Path(ROOT) / 'scripts/out_learning'
                    output.mkdir(exist_ok=True)
                    for theme in ['liquid', 'darkliquid', 'editorial', 'anime']:
                        page.evaluate('(theme) => document.documentElement.dataset.uiTheme = theme', theme)
                        page.locator('#module-plan').screenshot(path=str(output / f'goal-{theme}.png'), animations='disabled')
                    for width in [390, 768, 1460]:
                        page.set_viewport_size({'width': width, 'height': 1050})
                        assert page.locator('#module-plan').evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'), f'goal overflow at {width}'
                    assert not errors, errors
                    browser.close()
                    print('PASS daily goal UI: all metrics, legacy/history, replay/reload, date/account isolation, SRS disabled, wrong/fuzzy/pass/undo, concurrent writes, four themes and three widths')
            finally:
                server.terminate()
                try:
                    server.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait()


if __name__ == '__main__':
    main()
