#!/usr/bin/env python3
"""Exercise foreground state deltas with a draft goal, a scrolled notebook and an undo."""
import os
import subprocess
import tempfile
import time

from e2e import ROOT, free_port, sync_playwright, wait_up
from playwright.sync_api import expect


def check(browser, base):
    context = browser.new_context(viewport={'width': 1300, 'height': 820})
    account = context.request.post(base + '/api/auth/register', headers={'Origin': base},
                                   data={'username': 'desktop_live', 'password': 'test-password-desktop-live'})
    assert account.status == 201, account.text()
    headers = {'Origin': base, 'X-CSRF-Token': account.json()['csrfToken']}

    def edit(key, change):
        snapshot = context.request.get(base + '/api/state').json()
        value = snapshot['state'].get(key, {})
        response = context.request.put(base + '/api/state/' + key, headers=headers,
                                       data={'expectedRevision': snapshot['revisions'].get(key, 0), 'value': change(value)})
        assert response.ok, response.text()

    def word(i, due):
        name = f'word-{i:03d}'
        meaning = '释义 ' + str(i)
        return name + '|' + meaning, {'word': {'word': name, 'meaning': meaning}, 'stage': 0, 'due': due,
                                      'learnedAt': due - 1200000, 'reviewCount': 0, 'events': []}

    now = int(time.time() * 1000)
    words = dict(word(i, now - 20000 + i) for i in range(80))
    edit('review', lambda _: {'ielts': {'groups': {}, 'words': words}})
    page = context.new_page()
    deltas = []
    page.on('response', lambda r: deltas.append(r) if r.url == base + '/api/state'
            and 'x-wordpaper-revisions' in r.request.headers else None)
    page.goto(base)
    expect(page.locator('#srs-grace-table')).to_contain_text('宽限')
    def wait_visible(locator, text):
        deadline = time.monotonic() + 6.5
        while time.monotonic() < deadline:
            if text in locator.inner_text():
                return
            time.sleep(0.05)
        raise AssertionError('waiting for ' + text)
    goal = page.locator('#inp-plan-daily')
    goal.fill('86')
    started = time.monotonic()
    edit('dailyPlan', lambda plan: {**plan, 'dailyGoal': 23})
    wait_visible(page.locator('#plan-progress-text'), '/23 ')
    print(f'PASS remote goal → visible progress in {(time.monotonic() - started)*1000:.0f} ms with draft untouched', flush=True)
    expect(goal).to_have_value('86')
    expect(goal).to_be_focused()
    goal.press('Tab')
    expect(page.locator('#plan-progress-text')).to_contain_text('/86 ')
    page.locator('#btn-open-memory').click()
    listing = page.locator('#memory-notebook-list')
    card = listing.locator('.memory-entry.due').first
    first_word = card.locator('b').inner_text()
    card.locator('.remembered').click()
    revealed = listing.locator('.memory-entry.answered')
    expect(revealed.locator('.memory-meaning')).to_have_text('释义 0')
    assert page.evaluate('() => Store.flush()')
    page.locator('#memory-search-input').focus()
    listing.evaluate("""el => {
      el.scrollTop = 700;
      window.liveAnchor = [...el.querySelectorAll('.memory-entry')].find(n => n.getBoundingClientRect().bottom > el.getBoundingClientRect().top);
      window.liveAnchorTop = window.liveAnchor.getBoundingClientRect().top;
      window.liveUndo = el.querySelector('.memory-undo');
    }""")
    started = time.monotonic()
    def add(review):
        key, item = word(99, now - 25000)
        review['ielts']['words'][key] = item
        return review
    edit('review', add)
    wait_visible(listing, 'word-099')
    print(f'PASS remote word → open notebook in {(time.monotonic() - started)*1000:.0f} ms', flush=True)
    expect(page.locator('#memory-search-input')).to_be_focused()
    expect(revealed.locator('.memory-meaning')).to_have_text('释义 0')
    assert page.evaluate('() => window.liveUndo.isConnected && window.liveAnchor.isConnected && Math.abs(window.liveAnchorTop-window.liveAnchor.getBoundingClientRect().top)<3')
    revealed.locator('.memory-undo').click()
    expect(listing.locator('.memory-entry.due b').filter(has_text=first_word)).to_have_count(1)
    page.wait_for_timeout(3300)
    bodies = [r.json() for r in deltas]
    assert any('dailyPlan' in body['state'] for body in bodies)
    assert any('review' in body['state'] for body in bodies)
    assert any(not r.json()['state'] and r.request.headers.get('x-wordpaper-passive') == '1' for r in deltas)
    assert all(body.get('partial') and 'settings' not in body['state'] for body in bodies)
    print('PASS partial responses, unchanged payload empty, preserved search focus, card, scroll anchor and working undo')
    context.close()


def main():
    port = free_port()
    with tempfile.TemporaryDirectory() as data_dir:
        env = dict(os.environ, HOST='127.0.0.1', PORT=str(port), WORDPAPER_MODE='local',
                   WORDPAPER_DATA_DIR=data_dir, WORDPAPER_COMPANION_ENABLED='0', NODE_ENV='test')
        with tempfile.TemporaryFile() as log:
            server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
            try:
                assert wait_up(port)
                with sync_playwright() as pw:
                    try:
                        browser = pw.chromium.launch()
                    except Exception:
                        browser = pw.chromium.launch(channel='chrome')
                    try:
                        check(browser, f'http://127.0.0.1:{port}')
                    finally:
                        browser.close()
            finally:
                server.terminate()
                server.wait(timeout=10)


if __name__ == '__main__':
    main()
