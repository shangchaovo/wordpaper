#!/usr/bin/env python3
"""Guest entry, cold reopen and cloud-account isolation in disposable browser profiles."""
import argparse
import json
import os
import sqlite3
import subprocess
import tempfile
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlsplit

from playwright.sync_api import expect
from e2e import ROOT, PlaywrightError, free_port, sync_playwright, wait_up


GUEST_NOTE = '只在这个浏览器保存的游客提醒'
ACCOUNT_NOTE = '仅在测试云账号保存的提醒'
USERNAME = 'guest_test_owner'
PASSWORD = 'guest-browser-test-password'


@contextmanager
def server(folder, mode, desktop_cloud=None):
    folder.mkdir(exist_ok=True)
    port = free_port()
    env = {key: value for key, value in os.environ.items() if not key.startswith('WORDPAPER_')}
    env.update(HOST='127.0.0.1', PORT=str(port), NODE_ENV='test', WORDPAPER_MODE=mode,
               WORDPAPER_DATA_DIR=str(folder), WORDPAPER_COMPANION_PORT=str(free_port()),
               WORDPAPER_COMPANION_AUTOSTART='0', WORDPAPER_COMPANION_ENABLED='0')
    if desktop_cloud:
        env.update(WORDPAPER_DESKTOP_CLOUD='1', WORDPAPER_TEST_DESKTOP_CLOUD_ORIGIN=desktop_cloud)
    with (folder / 'server.log').open('w+') as log:
        child = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            assert wait_up(port), 'isolated WordPaper server did not start'
            yield f'http://127.0.0.1:{port}'
        finally:
            child.terminate()
            child.wait(timeout=10)


@contextmanager
def profile(engine, path, desktop=False):
    options = dict(headless=True, viewport={'width': 1460, 'height': 980})
    executable = os.environ.get('WORDPAPER_TEST_BROWSER_EXECUTABLE')
    if executable:
        options['executable_path'] = executable
    try:
        context = engine.launch_persistent_context(path, **options)
    except PlaywrightError as error:
        if executable or engine.name != 'chromium' or "Executable doesn't exist" not in str(error):
            raise
        context = engine.launch_persistent_context(path, channel='chrome', **options)
    try:
        context.route('https://cdn.jsdelivr.net/**', lambda route: route.fulfill(status=200, body=''))
        if desktop:
            context.add_init_script('window.WordPaperDesktop = Object.freeze({});')
        yield context
    finally:
        context.close()


def watch_guest_requests(page, base):
    host = urlsplit(base).netloc
    unexpected = []
    def record(request):
        url = urlsplit(request.url)
        if url.scheme not in ('http', 'https'):
            return
        if url.netloc != host or request.method != 'GET' or url.path.startswith(('/api/', '/companion/')) or (
            url.path.endswith(('.php', '.json')) and not url.path.startswith('/data/')
        ):
            unexpected.append(f'{request.method} {url.path}')
    page.on('request', record)
    return unexpected


def enter(page, base):
    page.goto(base + '/login.html')
    return choose_guest(page, '#auth-guest')


def choose_guest(page, selector):
    button = page.locator(selector)
    expect(button).to_be_enabled()
    requests = watch_guest_requests(page, page.url)
    button.click()
    page.wait_for_url('**/guest')
    page.wait_for_selector('#preview-canvas[data-wallpaper-w]')
    assert page.evaluate('Store.isGuest() && !Store.currentUser()')
    return requests


def leave(page):
    logout = page.locator('#btn-logout')
    if not logout.is_visible():
        page.locator('#workspace-tools-toggle').click()
    logout.click()
    page.wait_for_url('**/login.html**', wait_until='domcontentloaded')


def add_reminder(page, text):
    page.locator('#inp-reminder').fill(text)
    page.locator('#btn-add-reminder').click()
    expect(page.locator('#reminder-list')).to_contain_text(text)


def test_public(engine, base, temp):
    user_profile = temp / 'browser'
    with profile(engine, user_profile) as context:
        page = context.new_page()
        requests = enter(page, base)
        context.set_offline(True)
        page.locator('#btn-open-import').click()
        page.locator('#txt-paste').fill('guest-only, /gest/, n., 游客词条')
        page.locator('#btn-paste-import').click()
        page.locator('#btn-close-import').click()
        expect(page.locator('#import-modal')).to_be_hidden()
        canvas = page.locator('#preview-canvas')
        size = canvas.bounding_box()
        canvas.click(position={'x': size['width'] * .5, 'y': size['height'] * .36})
        expect(page.locator('#selected-word-label')).to_have_text('guest-only')
        page.locator('#btn-guest-remember').click()
        expect(page.locator('#btn-guest-remember')).to_be_disabled()
        add_reminder(page, GUEST_NOTE)
        context.set_offline(False)
        page.locator('#file-bgphoto').set_input_files(Path(ROOT) / 'assets' / 'favicon-128.png')
        expect(page.locator('#bgphoto-preview')).to_have_js_property('hidden', False)
        photo = page.evaluate('Store.getSettings().bgImage')
        assert photo.startswith('data:image/png;base64,')
        assert page.evaluate('Store.flush()')
        with sqlite3.connect(temp / 'cloud' / 'wordpaper.sqlite') as db:
            for table in ('users', 'sessions', 'user_state'):
                assert db.execute('SELECT count(*) FROM ' + table).fetchone()[0] == 0, table
        assert not requests, requests

    # Closing every browser process tests committed on-device storage, including
    # the selected login option; a live tab's in-memory cache cannot satisfy it.
    with profile(engine, user_profile) as context:
        page = context.new_page()
        requests = watch_guest_requests(page, base)
        page.goto(base)
        expect(page.locator('#reminder-list')).to_contain_text(GUEST_NOTE)
        assert page.evaluate('Store.isGuest() && !Store.currentUser()')
        assert page.evaluate('Store.getSettings().bgImage') == photo
        assert page.evaluate('Store.getCustomWords()[0].word') == 'guest-only'
        assert 'guest-only' in json.dumps(page.evaluate('Store.getReview()'))
        assert 'guest-only' in json.dumps(page.evaluate("Store.read('learningActivity', {})"))
        page.evaluate("window.dispatchEvent(new Event('focus'))")
        page.locator('#btn-open-memory').click()
        expect(page.locator('#memory-notebook-list')).to_contain_text('guest-only')
        page.locator('#btn-close-memory').click()
        assert not requests, requests
        leave(page)
        creds = {'username': USERNAME, 'password': PASSWORD}
        account = context.request.post(base + '/api/auth/register', data=creds, headers={'Origin': base})
        assert account.status == 201, account.text()
        # Cleared reminders on an account without a seeded flag stay empty.
        token = context.request.get(base + '/api/session').json()['csrfToken']
        saved = context.request.put(base + '/api/state/reminders', data={'value': [], 'expectedRevision': 0},
                                   headers={'Origin': base, 'X-CSRF-Token': token})
        assert saved.ok, saved.text()
        page.goto(base)
        expect(page.locator('#account-name')).to_have_text(USERNAME)
        page.wait_for_function('Store.getSeeded()')
        assert page.evaluate('Store.getReminders()') == []
        add_reminder(page, ACCOUNT_NOTE)
        assert page.evaluate('Store.flush()')
        cloud_state = context.request.get(base + '/api/state').json()['state']
        serialized = json.dumps(cloud_state, ensure_ascii=False)
        assert ACCOUNT_NOTE in serialized and GUEST_NOTE not in serialized
        assert 'guest-only' not in serialized and photo not in serialized
        # Explicit guest entry must work even with an existing valid session.
        page.locator('#workspace-tools-toggle').click()
        requests = choose_guest(page, '#btn-switch-guest')
        expect(page.locator('#reminder-list')).to_contain_text(GUEST_NOTE)
        expect(page.locator('#reminder-list')).not_to_contain_text(ACCOUNT_NOTE)
        assert not requests, requests
        assert context.request.get(base + '/api/session').json()['user']['username'] == USERNAME

    with profile(engine, temp / 'unavailable') as context:
        context.add_init_script("Object.defineProperty(window, 'indexedDB', {value: undefined})")
        page = context.new_page()
        page.goto(base + '/login.html')
        page.locator('#auth-guest').click()
        expect(page.locator('#guest-error')).to_contain_text('本地存储')
        assert '/login.html' in page.url
        assert context.request.get(base + '/api/session').status == 401
        page.locator('#username').fill(USERNAME)
        page.locator('#password').fill(PASSWORD)
        page.locator('#submit-auth').click()
        expect(page.locator('#account-name')).to_have_text(USERNAME)

        # An old, readable preference can survive a later storage policy change.
        page.evaluate("localStorage.setItem('wp:guest:selected', '1')")
        context.add_init_script('''const remove = Storage.prototype.removeItem;
          Storage.prototype.removeItem = function (key) {
            if (key === 'wp:guest:selected') throw new DOMException('read-only', 'SecurityError');
            return remove.call(this, key);
          };''')
        page.goto(base + '/login.html?next=%2F%23account')
        expect(page.locator('#account-dialog')).to_be_visible()
        context.clear_cookies()
        page.goto(base + '/login.html?next=%2F')
        page.locator('#username').fill(USERNAME)
        page.locator('#password').fill(PASSWORD)
        page.locator('#submit-auth').click()
        expect(page.locator('#account-name')).to_have_text(USERNAME)
        assert page.url == base + '/?account=1'
        assert not page.evaluate('Store.isGuest()')


def pair_before_upgrade(engine, folder, upstream):
    with server(folder, 'local') as base, profile(engine, folder / 'initial-login') as context:
        pair = context.request.post(base + '/api/pair', headers={'Origin': base}, data={
            'url': upstream, 'identifier': USERNAME, 'password': PASSWORD})
        assert pair.ok, pair.text()
        user_id = context.request.get(base + '/api/session').json()['user']['id']
        # Source/self-host installations keep their existing workspace after session expiry.
        context.clear_cookies()
        page = context.new_page()
        page.goto(base + '/login.html')
        page.get_by_role('button', name='继续进入工作区', exact=True).click()
        expect(page.locator('#account-name')).to_have_text(USERNAME)
        assert context.request.get(base + '/api/session').json()['user']['id'] == user_id
        return user_id


def test_paired(engine, base, original_user_id, temp):
    with profile(engine, temp / 'desktop', desktop=True) as context:
        # The machine keeps its pairing when this browser's session expires.
        context.clear_cookies()
        page = context.new_page()
        requests = enter(page, base)
        expect(page.locator('#reminder-list')).not_to_contain_text(ACCOUNT_NOTE)
        add_reminder(page, '独立的桌面游客记录')
        assert page.evaluate('Store.flush()')
        assert not requests, requests
        leave(page)
        expect(page.locator('#desktop-resume')).to_contain_text(USERNAME)
        page.locator('#desktop-resume').click()
        expect(page.locator('#reminder-list')).to_contain_text(ACCOUNT_NOTE)
        expect(page.locator('#reminder-list')).not_to_contain_text('独立的桌面游客记录')
        session = context.request.get(base + '/api/session').json()
        assert session['mirrored'] and session['user']['id'] == original_user_id


def test_retired_connection(engine, base, temp):
    with profile(engine, temp / 'old-private', desktop=True) as context:
        page = context.new_page()
        posts = []
        page.on('request', lambda request: posts.append(urlsplit(request.url).path) if request.method == 'POST' else None)
        page.goto(base + '/')
        expect(page.locator('#auth-google')).to_be_enabled()
        expect(page.locator('#auth-github')).to_be_enabled()
        expect(page.locator('#auth-guest')).to_be_enabled()
        expect(page.locator('#desktop-resume')).to_be_hidden()
        expect(page.locator('#local-account-options')).to_be_hidden()
        expect(page.locator('#desktop-origin, #pair-card, #btn-pair, #btn-unpair')).to_have_count(0)
        page.evaluate("localStorage.setItem('wp:sync-origin','http://100.83.152.67:8770')")
        for selector in ['#auth-google', '#auth-github', '#desktop-cloud-email']:
            page.locator(selector).click()
            dialog = page.get_by_role('dialog')
            expect(dialog).to_contain_text(USERNAME)
            dialog.get_by_role('button', name='取消').click()
            expect(dialog).to_be_hidden()
        assert posts == [], posts
        assert page.evaluate("localStorage.getItem('wp:sync-origin')") == 'http://100.83.152.67:8770'
        choose_guest(page, '#auth-guest')
        add_reminder(page, '旧连接保留期间的游客记录')
        assert page.evaluate('Store.flush()')
        leave(page)
        expect(page.locator('#desktop-legacy-disconnect')).to_be_visible()
        page.locator('#desktop-legacy-disconnect').click()
        page.get_by_role('button', name='允许断开', exact=True).click()
        expect(page.locator('#desktop-sync-status')).to_contain_text('旧连接已断开')
        assert posts == ['/api/desktop/disconnect-legacy'], posts
        assert page.evaluate("localStorage.getItem('wp:sync-origin')") is None
        page.reload()
        expect(page.locator('#auth-google')).to_be_enabled()
        expect(page.locator('#desktop-legacy-disconnect')).to_be_hidden()
        expect(page.locator('#desktop-resume')).to_be_hidden()
        choose_guest(page, '#auth-guest')
        expect(page.locator('#reminder-list')).to_contain_text('旧连接保留期间的游客记录')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', choices=['chromium', 'webkit'], default='chromium')
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='wordpaper-guest-') as folder, sync_playwright() as playwright:
        temp = Path(folder)
        with server(temp / 'cloud', 'public') as cloud:
            engine = getattr(playwright, args.browser)
            test_public(engine, cloud, temp)
            official_folder = temp / 'already-connected'
            old_user = pair_before_upgrade(engine, official_folder, cloud)
            with server(official_folder, 'local', desktop_cloud=cloud) as local:
                test_paired(engine, local, old_user, temp)
            legacy_folder = temp / 'legacy-private'
            pair_before_upgrade(engine, legacy_folder, cloud)
            with server(legacy_folder, 'local', desktop_cloud='https://official.example.test') as local:
                test_retired_connection(engine, local, temp)
    print(f'PASS {args.browser}: guest cold reopen, photo and learning data, no guest API traffic, account and desktop pairing isolation, legacy disconnect consent')


if __name__ == '__main__':
    main()
