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
    expect(page.get_by_role('button', name='使用微信继续')).to_be_enabled()
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
    dialog.get_by_role('button', name='绑定 微信', exact=True).click()
    expect(page.locator('#account-status')).to_contain_text('绑定成功', timeout=15000)
    expect(dialog.locator('[data-provider="wechat"]')).to_contain_text('微信用户 A')
    page.screenshot(path=str(OUT / 'account-desktop.png'), full_page=True)
    page.set_viewport_size({'width': 390, 'height': 844})
    bounds = dialog.bounding_box()
    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 390
    page.screenshot(path=str(OUT / 'account-mobile.png'), full_page=True)
    # Native dialog keeps keyboard focus inside and returns it on Escape.
    page.keyboard.press('Escape')
    expect(dialog).not_to_be_visible()
    expect(page.locator('#btn-account')).to_be_focused()
    page.set_viewport_size({'width': 1280, 'height': 900})

    # Simulate a long-lived session, then verify through the password form.
    with sqlite3.connect(DATABASE) as db:
        db.execute('UPDATE sessions SET authenticated_at = 0 WHERE user_id = ?', (user['id'],))
    page.locator('#btn-account').click()
    expect(page.locator('#account-password-form')).to_be_visible()
    expect(dialog.locator('[data-provider="google"]').get_by_role('button', name='更换绑定')).to_be_disabled()
    page.locator('#account-password').fill('browser-link-password')
    page.locator('#account-password-form').get_by_role('button', name='验证', exact=True).click()
    expect(page.locator('#account-status')).to_contain_text('身份已验证')
    expect(page.locator('#account-verify')).not_to_be_visible()
    page.on('dialog', lambda prompt: prompt.accept())
    dialog.locator('[data-provider="google"]').get_by_role('button', name='更换绑定').click()
    expect(page.locator('#account-status')).to_contain_text('绑定成功', timeout=15000)
    dialog.locator('[data-provider="google"]').get_by_role('button', name='解除绑定').click()
    expect(page.locator('#account-status')).to_contain_text('已解除绑定')
    expect(dialog.locator('[data-provider="google"]')).to_contain_text('尚未绑定')
    page.keyboard.press('Escape')
    page.locator('#btn-logout').click()
    page.wait_for_url(BASE + '/login.html')
    page.get_by_role('button', name='使用微信继续').click()
    page.wait_for_url(lambda url: url in [BASE + '/', BASE + '/#wechat_redirect'], wait_until='domcontentloaded')
    page.wait_for_function('window.Store && Store.currentUser()')
    assert page.evaluate('Store.currentUser().id') == user['id']
    assert page.evaluate('Store.getReminders()[0].text') == '绑定前的提醒'
    assert not errors, errors
    context.close()

    # Provider discovery must handle both unconfigured and WeChat-only setups.
    for google_enabled, wechat_enabled in [(False, False), (False, True)]:
        ctx = browser.new_context()
        tab = ctx.new_page()
        tab.route('**/api/auth/providers', lambda route, request, g=google_enabled, w=wechat_enabled: route.fulfill(json={
            'google': {'enabled': g}, 'wechat': {'enabled': w},
            'email': {'enabled': True, 'registrationEnabled': True}, 'paired': None, 'pairingAllowed': False,
        }))
        tab.goto(BASE + '/login.html', wait_until='networkidle')
        expect(tab.locator('#auth-google')).not_to_be_visible()
        if wechat_enabled:
            expect(tab.locator('#auth-wechat')).to_be_visible()
            expect(tab.locator('.auth-divider')).to_be_visible()
        else:
            expect(tab.locator('#auth-wechat')).not_to_be_visible()
            expect(tab.locator('.auth-divider')).not_to_be_visible()
        ctx.close()
    browser.close()
print('PASS browser: login providers, existing-account binding, replacement, unlink, password verification, original data, focus and mobile layout')
