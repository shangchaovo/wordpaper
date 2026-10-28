#!/usr/bin/env python3
"""Real browser/API regression for overdue schedules and per-day word records."""
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
    port = free_port()
    base = f'http://127.0.0.1:{port}'
    with tempfile.TemporaryDirectory(prefix='wordpaper-policy-ui-') as temp:
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
                    context = browser.new_context(viewport={'width': 1460, 'height': 1050}, timezone_id='Asia/Shanghai', reduced_motion='reduce')
                    context.route('https://cdn.jsdelivr.net/**', lambda r: r.fulfill(status=200, body=''))
                    context.route('**/api/update/check*', lambda r: r.fulfill(json={'supported': False, 'available': False}))
                    context.route('**/pet-celebrate.php', lambda r: r.fulfill(json={'ok': True}))
                    account = context.request.post(base + '/api/auth/register', headers={'Origin': base},
                        data={'username': 'policy_user', 'password': 'isolated-policy-password'}).json()
                    headers = {'Origin': base, 'X-CSRF-Token': account['csrfToken']}
                    now = int(time.time() * 1000)
                    date = datetime.now(ZoneInfo('Asia/Shanghai'))
                    today, yesterday = date.strftime('%Y-%m-%d'), (date - timedelta(days=1)).strftime('%Y-%m-%d')
                    intervals = [20, 60, 540, 1440, 2880, 4320, 8640, 17280]

                    def record(word, meaning, stage, due):
                        return {'word': {'word': word, 'meaning': meaning}, 'stage': stage, 'due': due,
                                'learnedAt': due - intervals[stage] * 60000 if due else now - 86400000,
                                'reviewCount': 3, 'failCount': 0, 'events': []}

                    words = {'late|逾期': record('late', '逾期', 3, now - 40 * 3600000),
                             'soon|即将': record('soon', '即将', 1, now - 60000),
                             'floor|第一轮': record('floor', '第一轮', 0, now - 7200000),
                             'done|完成': record('done', '完成', 8, None)}
                    values = {
                        'review': {'ielts': {'words': words}},
                        'dailyPlan': {'dailyGoal': 1, 'metric': 'recite', 'activityStartedAt': now - 10000},
                        'settings': {'library': 'ielts', 'srsEnabled': True, 'petWallpaperSync': False},
                        'learningActivity': {'days': {yesterday: {'yesterday-sentence': {
                            'kind': 'sentence', 'at': now - 86400000, 'library': 'ielts',
                            'word': {'word': 'yesterday', 'meaning': '昨天'}, 'nextDue': now + 86400000}}}},
                    }
                    for namespace, value in values.items():
                        assert context.request.put(base + '/api/state/' + namespace, headers=headers,
                            data={'value': value, 'expectedRevision': 0}).ok
                    saved = context.request.get(base + '/api/state').json()
                    remote = saved['state']['review']['ielts']['words']
                    assert remote['late|逾期']['stage'] == 2
                    assert remote['soon|即将']['stage'] == 1
                    assert remote['floor|第一轮']['stage'] == 0 and remote['done|完成']['stage'] == 8
                    assert remote['late|逾期']['failCount'] == 0 and remote['late|逾期']['reviewCount'] == 3
                    assert remote['late|逾期']['due'] == words['late|逾期']['due'], 'do not postpone overdue work'
                    assert context.request.get(base + '/api/state').json()['revisions']['review'] == saved['revisions']['review']

                    page = context.new_page()
                    errors = []
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(base, wait_until='domcontentloaded')
                    page.wait_for_selector('#library-cards .lib-card')
                    expect(page.locator('#srs-overdue')).to_contain_text('还剩')
                    expect(page.locator('#srs-overdue')).to_contain_text('降至第 1 轮')
                    expect(page.locator('#srs-overdue')).to_contain_text('已从第 4 轮降至第 3 轮')
                    expect(page.locator('#srs-overdue')).to_contain_text('保持第 1 轮')
                    expect(page.locator('#plan-count-total')).to_have_text('0')
                    output = Path(ROOT) / 'scripts/out_learning'
                    output.mkdir(exist_ok=True)
                    page.locator('#module-srs').screenshot(path=str(output / 'overdue-status.png'), animations='disabled')

                    # A warning links to the matching word. Completing it records
                    # exactly one practice and its actual new due time.
                    page.locator('#srs-overdue button').filter(has_text='late').click()
                    card = page.locator('.memory-entry[data-review-key="late|逾期"]')
                    expect(card.locator('.memory-overdue')).to_contain_text('第 4 轮降至第 3 轮')
                    for theme in ['liquid', 'darkliquid', 'editorial', 'anime']:
                        page.evaluate('(t) => document.documentElement.dataset.uiTheme = t', theme)
                        assert card.evaluate('e => e.querySelector(".memory-actions").getBoundingClientRect().top >= e.querySelector(".memory-overdue").getBoundingClientRect().bottom'), theme
                    page.evaluate('document.documentElement.dataset.uiTheme = "liquid"')
                    card.screenshot(path=str(output / 'overdue-due-card.png'), animations='disabled')
                    card.locator('.memory-answer.remembered').click()
                    expect(page.locator('#plan-count-total')).to_have_text('1')
                    expect(card.locator('.memory-schedule')).to_contain_text('下次复习：')
                    assert '现在可复习' not in card.locator('.memory-schedule').inner_text()
                    result = page.evaluate('Store.getReview().ielts.words["late|逾期"]')
                    assert result['stage'] == 3 and abs(result['due'] - int(time.time() * 1000) - 86400000) < 5000
                    assert page.evaluate('async () => await Store.flush()')
                    card.screenshot(path=str(output / 'overdue-answered.png'), animations='disabled')
                    card.locator('.memory-undo').click()
                    expect(page.locator('#plan-count-total')).to_have_text('0')
                    assert page.evaluate('Store.getReview().ielts.words["late|逾期"].stage') == 2
                    card.locator('.memory-answer.remembered').click()
                    expect(page.locator('#plan-count-total')).to_have_text('1')
                    page.locator('#memory-modal .modal-close').click()
                    expect(page.locator('#memory-modal')).to_be_hidden()
                    page.click('#btn-plan-checkin')
                    expect(page.locator('#plan-records')).to_have_attribute('open', '')
                    expect(page.locator('#plan-word-records')).to_contain_text('late')
                    expect(page.locator('#plan-word-records')).to_contain_text('背诵 1 次 · 造句 0 次')
                    expect(page.locator('#plan-word-records')).to_contain_text('下次复习：')
                    expected_time = page.evaluate('new Date(Store.getReview().ielts.words["late|逾期"].due).toLocaleString("zh-CN", {month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false})')
                    expect(page.locator('#plan-word-records')).to_contain_text(expected_time)
                    page.locator('#module-plan').screenshot(path=str(output / 'daily-word-records.png'), animations='disabled')
                    page.fill('#plan-record-date', yesterday)
                    expect(page.locator('#plan-word-records')).to_contain_text('yesterday')
                    expect(page.locator('#plan-word-records')).to_contain_text('背诵 0 次 · 造句 1 次')
                    expect(page.locator('#plan-count-total')).to_have_text('1')
                    page.fill('#plan-record-date', today)
                    for width in [390, 768, 1460]:
                        page.set_viewport_size({'width': width, 'height': 1050})
                        for selector in ['#module-plan', '#module-srs']:
                            assert page.locator(selector).evaluate('(e) => e.scrollWidth <= e.clientWidth + 1'), (selector, width)
                    assert page.evaluate('async () => await Store.flush()')
                    page.reload(wait_until='domcontentloaded')
                    expect(page.locator('#plan-count-total')).to_have_text('1')
                    page.locator('#plan-records summary').click()
                    expect(page.locator('#plan-word-records')).to_contain_text(expected_time)
                    restored = page.evaluate('Store.getReview().ielts.words["late|逾期"]')
                    assert restored['stage'] == 3 and restored['due'] > int(time.time() * 1000)
                    assert len([e for e in restored['events'] if e['type'] == 'overdue-demotion']) == 1
                    assert not errors, errors
                    browser.close()
                    print('PASS overdue UI/API: old backlog one-step, grace countdown, floor/mastered, no false activity, answer/undo/next due, daily word history, check-in, reload and responsive layout')
            finally:
                server.terminate()
                try:
                    server.wait(timeout=6)
                except subprocess.TimeoutExpired:
                    server.kill(); server.wait()


if __name__ == '__main__':
    main()
