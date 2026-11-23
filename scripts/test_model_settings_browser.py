#!/usr/bin/env python3
"""Isolated real UI: node scripts/test_model_accounts.js --browser."""
import os
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

base = os.environ['WORDPAPER_TEST_BASE_URL']
model_url = os.environ['WORDPAPER_TEST_MODEL_URL']
companion_url = os.environ['WORDPAPER_TEST_COMPANION_URL']
out = Path(__file__).resolve().parent / 'build' / 'model-account-check'
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    try:
        browser = p.chromium.launch(headless=True)
    except Exception:
        browser = p.chromium.launch(channel='chrome', headless=True)
    context = browser.new_context(viewport={'width': 1280, 'height': 900})
    response = context.request.post(base + '/api/auth/register', headers={'Origin': base}, data={
        'username': 'model-browser', 'password': 'model-browser-password',
    })
    assert response.status == 201
    page = context.new_page()
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.route('https://cdn.jsdelivr.net/**', lambda route: route.abort())
    # Workspace background polling never becomes network-idle; await the UI.
    page.goto(base + '/#model', wait_until='domcontentloaded')
    expect(page.locator('#model-dialog')).to_be_visible()
    expect(page.locator('#model-identity')).to_contain_text('model-browser')
    page.locator('#model-deepseek').click()
    expect(page.locator('#model-base-url')).to_have_value('https://api.deepseek.com')
    expect(page.locator('#model-name')).to_have_value('deepseek-flash')
    page.locator('#model-base-url').fill(model_url)
    page.locator('#model-name').fill('test-model')
    page.locator('#model-key').fill('browser-private-key')
    page.locator('#model-save').click()
    expect(page.locator('#model-status')).to_contain_text('已绑定当前账号')
    expect(page.locator('#model-key')).to_have_value('')
    assert 'browser-private-key' not in page.content()
    assert 'browser-private-key' not in page.evaluate('JSON.stringify(localStorage)')
    page.screenshot(path=str(out / 'model-settings-desktop.png'), full_page=True)
    page.locator('#model-test').click()
    expect(page.locator('#model-status')).to_contain_text('连接测试成功')
    page.locator('#model-name').fill('error-403')
    page.locator('#model-save').click()
    expect(page.locator('#model-status')).to_contain_text('账号受限')
    page.keyboard.press('Escape')
    expect(page.locator('#workspace-tools-toggle')).to_be_focused()
    page.locator('#workspace-tools-toggle').click()
    page.locator('#btn-model').click()
    expect(page.locator('#model-name')).to_have_value('test-model')
    page.set_viewport_size({'width': 390, 'height': 844})
    bounds = page.locator('#model-dialog').bounding_box()
    assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= 390
    page.screenshot(path=str(out / 'model-settings-mobile.png'), full_page=True)
    page.locator('#model-remove').click()
    expect(page.locator('#model-status')).to_contain_text('已解除模型绑定')
    expect(page.locator('#model-remove')).to_be_disabled()
    page.goto(companion_url + '/pet-sentence.html', wait_until='networkidle')
    expect(page.locator('#model-settings')).to_be_visible()
    page.locator('#s').fill('i hear hum')
    page.locator('#send').click()
    expect(page.locator('#result')).to_contain_text('I hear a hum.')
    page.screenshot(path=str(out / 'sentence-graded.png'), full_page=True)
    assert not errors, errors
    browser.close()
print('PASS UI: bind/test/failed replacement/unlink, empty key field/cache, mobile layout, focus and real sentence submit')
