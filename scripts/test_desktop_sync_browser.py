#!/usr/bin/env python3
import os
os.makedirs('/tmp/wordpaper-account-links', exist_ok=True)
from playwright.sync_api import sync_playwright, expect

BASE = os.environ['WORDPAPER_TEST_BASE_URL']
CLOUD = os.environ['WORDPAPER_TEST_CLOUD']
with sync_playwright() as p:
    try:
        browser = p.chromium.launch(headless=True)
    except Exception:
        browser = p.chromium.launch(channel='chrome', headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 900}, bypass_csp=True)
    context.route('https://cdn.jsdelivr.net/**', lambda route: route.abort())
    app = context.new_page()
    errors = []
    app.on('pageerror', lambda error: errors.append(str(error)))
    app.goto(BASE + '/login.html', wait_until='domcontentloaded')
    expect(app.locator('#desktop-sync')).to_be_visible()
    app.locator('#desktop-origin').fill(CLOUD)
    with context.expect_page() as popup:
        app.get_by_role('button', name='Google 登录', exact=True).click()
    authorize = popup.value
    authorize.wait_for_url(CLOUD + '/connect.html?code=*', wait_until='domcontentloaded')
    expect(authorize.locator('#connect-approve')).to_be_enabled()
    assert authorize.locator('#connect-code').inner_text() == app.locator('#desktop-sync-code').inner_text()
    authorize.locator('#connect-approve').click()
    app.wait_for_url(BASE + '/', wait_until='domcontentloaded', timeout=20000)
    app.wait_for_function('window.Store && Store.currentUser() && Store.getSeeded()')
    app.wait_for_function('async () => await Store.flush()')
    remote_session = context.request.get(CLOUD + '/api/session').json()
    remote = context.request.get(CLOUD + '/api/state').json()
    value = [{'id': 'shared', 'text': '浏览器改动同步到 App', 'done': False, 'time': ''}]
    response = context.request.put(CLOUD + '/api/state/reminders', headers={
        'Origin': CLOUD, 'X-CSRF-Token': remote_session['csrfToken'],
    }, data={'value': value, 'expectedRevision': remote['revisions'].get('reminders', 0)})
    assert response.status == 200, response.text()
    app.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(app.locator('#reminder-list')).to_contain_text('浏览器改动同步到 App', timeout=15000)
    app.locator('#btn-account').click()
    expect(app.get_by_role('button', name='打开账号中心')).to_be_visible()
    app.screenshot(path='/tmp/wordpaper-account-links/synced-app.png', full_page=True)
    assert not errors, errors
    browser.close()
print('PASS desktop browser handoff, code confirmation, automatic return, live cloud changes and shared account management')
