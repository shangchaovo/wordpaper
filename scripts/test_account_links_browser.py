#!/usr/bin/env python3
"""Run via node scripts/test_account_links.js --browser (isolated DB/providers)."""
import os
import sqlite3
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

BASE = os.environ['WORDPAPER_TEST_BASE_URL']
DATABASE = os.environ['WORDPAPER_TEST_DB']
OUT = Path(os.environ.get('WORDPAPER_TEST_SCREENSHOTS', '/tmp/wordpaper-account-links'))
OUT.mkdir(parents=True, exist_ok=True)

with sync_playwright() as p:
    try:
        browser = p.chromium.launch(headless=True)
    except Exception:
        browser = p.chromium.launch(channel='chrome', headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 900}, bypass_csp=True)
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    # Optional CDN spreadsheet importer is irrelevant to account tests.
    page.route('https://cdn.jsdelivr.net/**', lambda route: route.abort())
    page.goto(BASE + '/login.html', wait_until='networkidle')
    expect(page.get_by_role('button', name='使用 Google 继续')).to_be_enabled()
    expect(page.locator('#auth-wechat')).to_have_count(0)
    expect(page.get_by_text('微信')).to_have_count(0)
    assert '账号绑定' in page.locator('.card-heading').inner_text()
    page.screenshot(path=str(OUT / 'login.png'), full_page=True)

    created = context.request.post(BASE + '/api/auth/register', headers={'Origin': BASE}, data={
        'username': 'binding-browser', 'password': 'browser-link-password',
    })
    assert created.status == 201, created.text()
    user = created.json()['user']
    # The workspace polls its companion; wait for the account UI rather than
    # requiring the entire page to stop making background requests.
    page.goto(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_function('window.Store && Store.currentUser()')
    page.wait_for_function("document.querySelector('#sync-status').dataset.state === 'saved' && Store.getSeeded()")
    page.evaluate("Store.saveReminders([{id:'kept',text:'绑定前的提醒',time:'',done:false}])")
    page.wait_for_function('async () => await Store.flush()')
    page.get_by_role('button', name='账号绑定', exact=True).click()
    dialog = page.get_by_role('dialog', name='账号绑定')
    expect(dialog).to_be_visible()
    expect(dialog.get_by_text('当前账号：binding-browser · 保留原密码登录')).to_be_visible()
    dialog.get_by_role('button', name='绑定 Google', exact=True).click()
    expect(page.locator('#account-status')).to_contain_text('绑定成功', timeout=15000)
    expect(dialog.locator('[data-provider="google"]')).to_contain_text('google.one@example.test')
    assert page.evaluate('Store.currentUser().id') == user['id']
    assert page.evaluate('Store.getReminders()[0].text') == '绑定前的提醒'
    expect(dialog.locator('[data-provider="wechat"]')).to_have_count(0)
    expect(dialog.get_by_text('微信')).to_have_count(0)
    page.screenshot(path=str(OUT / 'account-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    bounds = dialog.bounding_box()
    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 390
    page.screenshot(path=str(OUT / 'account-mobile.png'), full_page=True)
    # Return focus to the mobile settings toggle when the account trigger is collapsed.
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    settings_button = page.locator('#workspace-tools-toggle')
    expect(settings_button).to_be_focused()
    settings_button.click()
    page.locator('#btn-account').click()
    expect(dialog).to_be_visible()
    page.keyboard.press('Escape')
    expect(settings_button).to_be_focused()
    page.set_viewport_size({'width': 1280, 'height': 900})

    # Simulate a long-lived session, then verify through the password form.
    def account_with_legacy_wechat(route):
        response = route.fetch()
        data = response.json()
        provider = next(row for row in data['providers'] if row['provider'] == 'wechat')
        provider.update(enabled=True, bound=True, label='微信用户 A')
        route.fulfill(response=response, json=data)

    with sqlite3.connect(DATABASE) as db:
        db.execute('UPDATE sessions SET authenticated_at = 0 WHERE user_id = ?', (user['id'],))
    page.route('**/api/account', account_with_legacy_wechat)
    page.locator('#btn-account').click()
    expect(page.locator('#account-password-form')).to_be_visible()
    expect(dialog.locator('[data-provider="google"]').get_by_role('button', name='更换绑定')).to_be_disabled()
    expect(dialog.get_by_text('微信')).to_have_count(0)
    page.unroute('**/api/account', account_with_legacy_wechat)
    page.locator('#account-password').fill('browser-link-password')
    page.locator('#account-password-form').get_by_role('button', name='验证', exact=True).click()
    expect(page.locator('#account-status')).to_contain_text('身份已验证')
    expect(page.locator('#account-verify')).not_to_be_visible()
    page.on('dialog', lambda prompt: prompt.accept())
    dialog.locator('[data-provider="google"]').get_by_role('button', name='更换绑定').click()
    expect(page.locator('#account-status')).to_contain_text('绑定成功', timeout=15000)
    page.keyboard.press('Escape')
    expect(page.locator('#btn-account')).to_be_focused()
    page.locator('#btn-logout').click()
    page.wait_for_url(BASE + '/login.html')
    page.get_by_role('button', name='使用 Google 继续').click()
    page.wait_for_url(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_function('window.Store && Store.currentUser()')
    assert page.evaluate('Store.currentUser().id') == user['id']
    assert page.evaluate('Store.getReminders()[0].text') == '绑定前的提醒'
    page.locator('#btn-account').click()
    dialog.locator('[data-provider="google"]').get_by_role('button', name='解除绑定').click()
    expect(page.locator('#account-status')).to_contain_text('已解除绑定')
    expect(dialog.locator('[data-provider="google"]')).to_contain_text('尚未绑定')
    page.keyboard.press('Escape')

    # Exercise the local Google UI contract while the fixture manages the
    # external browser's response. Password verification and saved data use
    # the real existing account, above.
    local_flow = {'purpose': '', 'approved': False, 'bound': False}

    def local_account(route):
        response = route.fetch()
        data = response.json()
        provider = next(row for row in data['providers'] if row['provider'] == 'google')
        provider.update(localDesktop=True, bound=local_flow['bound'], label='local-google@example.test')
        route.fulfill(response=response, json=data)

    def local_google(route, request):
        action = request.url.rsplit('/', 1)[-1]
        if action == 'start':
            local_flow['purpose'] = request.post_data_json['purpose']
            assert bool(request.headers.get('x-csrf-token')) == (local_flow['purpose'] != 'login')
        elif action == 'cancel':
            local_flow['purpose'] = ''
        elif not local_flow['approved']:
            route.fulfill(json={'pending': True})
            return
        elif local_flow['purpose'] == 'link':
            local_flow['bound'] = True
        elif local_flow['purpose'] == 'login':
            login = context.request.post(BASE + '/api/auth/login', headers={'Origin': BASE}, data={
                'identifier': 'binding-browser', 'password': 'browser-link-password',
            })
            assert login.ok
        route.fulfill(json={'ok': True})

    page.route('**/api/account', local_account)
    page.route('**/api/account/google/link', lambda route: route.abort())
    page.route('**/api/local-google/*', local_google)
    with sqlite3.connect(DATABASE) as db:
        db.execute('UPDATE sessions SET authenticated_at = 0 WHERE user_id = ?', (user['id'],))
    page.locator('#btn-account').click()
    link_google = dialog.get_by_role('button', name='绑定 Google', exact=True)
    expect(link_google).to_be_disabled()
    page.locator('#account-password').fill('browser-link-password')
    page.locator('#account-password-form').get_by_role('button', name='验证', exact=True).click()
    expect(link_google).to_be_enabled()
    link_google.click()
    expect(page.locator('#account-status')).to_contain_text('请在系统浏览器完成 Google 授权')
    dialog.get_by_role('button', name='取消授权', exact=True).click()
    expect(page.locator('#account-status')).to_contain_text('已取消 Google 授权')
    assert local_flow['purpose'] == '' and not local_flow['bound']
    local_flow['approved'] = True
    link_google.click()
    expect(page.locator('#account-status')).to_contain_text('绑定成功')
    expect(dialog.locator('[data-provider="google"]')).to_contain_text('local-google@example.test')
    assert page.evaluate('Store.currentUser().id') == user['id']
    page.keyboard.press('Escape')
    page.route('**/api/auth/providers', lambda route: route.fulfill(json={
        'localGoogle': {'enabled': True}, 'google': {'enabled': False}, 'wechat': {'enabled': False},
        'email': {'enabled': True, 'registrationEnabled': True}, 'paired': None, 'pairingAllowed': True,
    }))
    page.locator('#btn-logout').click()
    page.wait_for_url(BASE + '/login.html')
    expect(page.locator('#desktop-local-google-sign-in')).to_be_enabled()
    expect(page.locator('#desktop-sync')).to_be_visible()
    page.locator('#desktop-local-google-sign-in').click()
    page.wait_for_url(BASE + '/', wait_until='domcontentloaded')
    page.wait_for_function('window.Store && Store.currentUser()')
    assert page.evaluate('Store.currentUser().id') == user['id']
    assert page.evaluate('Store.getReminders()[0].text') == '绑定前的提醒'
    assert not errors, errors
    context.close()

    # Legacy provider metadata must not add login actions to an email-only UI.
    for wechat_enabled in (False, True):
        ctx = browser.new_context()
        tab = ctx.new_page()
        tab.route('**/api/auth/providers', lambda route, request, w=wechat_enabled: route.fulfill(json={
            'google': {'enabled': False}, 'wechat': {'enabled': w},
            'email': {'enabled': True, 'registrationEnabled': True}, 'paired': None, 'pairingAllowed': False,
        }))
        tab.goto(BASE + '/login.html', wait_until='networkidle')
        expect(tab.locator('#auth-google')).not_to_be_visible()
        expect(tab.locator('#auth-wechat')).to_have_count(0)
        expect(tab.locator('.auth-divider')).not_to_be_visible()
        ctx.close()
    browser.close()
print('PASS browser: Google web and local login, account binding, original data, focus and mobile layout, no WeChat entry points')
