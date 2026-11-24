#!/usr/bin/env python3
import os
from urllib.parse import urlsplit
os.makedirs('/tmp/wordpaper-account-links', exist_ok=True)
from playwright.sync_api import sync_playwright, expect

BASE = os.environ['WORDPAPER_TEST_BASE_URL']
CLOUD = os.environ['WORDPAPER_TEST_CLOUD']
PREVIEW = os.environ['WORDPAPER_TEST_PREVIEW']


def connect_desktop(context, app, button_name):
    with context.expect_page() as popup:
        app.get_by_role('button', name=button_name, exact=True).click()
    authorize = popup.value
    authorize.wait_for_url(CLOUD + '/connect.html?code=*', wait_until='domcontentloaded')
    expect(authorize.locator('#connect-approve')).to_be_enabled()
    assert authorize.locator('#connect-code').inner_text() == app.locator('#desktop-sync-code').inner_text()
    authorize.locator('#connect-approve').click()
    expect(authorize.get_by_role('heading', name='已允许同步')).to_be_visible()
    expect(authorize.locator('#connect-status')).to_contain_text('回到 WordPaper App')
    expect(authorize.locator('#connect-code')).to_be_hidden()
    app.wait_for_url(BASE + '/', wait_until='domcontentloaded', timeout=20000)
    app.wait_for_function('window.Store && Store.currentUser() && Store.getSeeded()')
    app.wait_for_function('async () => await Store.flush()')


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
    expect(app.locator('[data-cloud-provider="wechat"]')).to_have_count(0)
    expect(app.get_by_text('微信')).to_have_count(0)
    app.locator('#desktop-origin').fill(PREVIEW)
    app.get_by_role('button', name='Google 登录', exact=True).click()
    expect(app.locator('#desktop-sync-status')).to_contain_text('未提供 WordPaper 账号同步')
    app.locator('#desktop-origin').fill(CLOUD)
    connect_desktop(context, app, 'Google 登录')
    remote_session = context.request.get(CLOUD + '/api/session').json()
    remote = context.request.get(CLOUD + '/api/state').json()
    value = [{'id': 'shared', 'text': '浏览器改动同步到 App', 'done': False, 'time': ''}]
    response = context.request.put(CLOUD + '/api/state/reminders', headers={
        'Origin': CLOUD, 'X-CSRF-Token': remote_session['csrfToken'],
    }, data={'value': value, 'expectedRevision': remote['revisions'].get('reminders', 0)})
    assert response.status == 200, response.text()
    app.evaluate("window.dispatchEvent(new Event('focus'))")
    expect(app.locator('#reminder-list')).to_contain_text('浏览器改动同步到 App', timeout=15000)
    snapshot = context.request.get(BASE + '/api/state').json()
    app.route('**/api/state', lambda route: route.fulfill(json=snapshot))
    for state, label in [('offline', '主账号离线'), ('reauth', '主账号需验证'), ('ok', '已同步')]:
        snapshot['upstream'] = state
        app.evaluate('Store.refreshRemote()')
        expect(app.locator('#sync-status')).to_have_text(label)
    app.unroute('**/api/state')
    app.locator('#btn-account').click()
    center = app.get_by_role('link', name='打开账号中心')
    expect(center).to_have_attribute('href', CLOUD + '/login.html?next=%2F%23account')
    with context.expect_page() as opened:
        center.click()
    account = opened.value
    expect(account.locator('#account-dialog')).to_be_visible()
    expect(account.locator('#account-identity')).to_contain_text(remote_session['user']['username'])
    expect(account.locator('#account-dialog').get_by_text('微信')).to_have_count(0)
    github = account.locator('#account-dialog [data-provider="github"]')
    github.get_by_role('button', name='绑定 GitHub', exact=True).click()
    expect(github.locator('.account-provider-state')).to_have_text('已绑定', timeout=15000)
    assert account.url.startswith(CLOUD + '/')
    expect(app.locator('#account-dialog')).to_be_visible()
    # A Mac's default browser can have a different session from its WKWebView.
    clean = browser.new_context()
    clean.route('https://cdn.jsdelivr.net/**', lambda route: route.abort())
    login = clean.new_page()
    login.goto(center.get_attribute('href'))
    expect(login.locator('#auth-google')).to_be_enabled()
    login.locator('#auth-google').click()
    expect(login.locator('#account-dialog')).to_be_visible()
    expect(login.locator('#account-identity')).to_contain_text(remote_session['user']['username'])
    clean.close()
    app.screenshot(path='/tmp/wordpaper-account-links/synced-app.png', full_page=True)
    app.locator('#btn-close-account').click()
    app.evaluate("window.WordPaperDesktop = { openExternal() { throw Error('old native bridge') } }")
    app.route('**/api/account/open-center', lambda route: route.fulfill(
        status=503, content_type='application/json', body='{"error":"系统浏览器未能打开"}'))
    app.locator('#btn-account').click()
    launch = app.get_by_role('button', name='打开账号中心')
    launch.click()
    expect(app.locator('#account-status')).to_contain_text('系统浏览器未能打开')
    expect(app.get_by_role('textbox', name='账号中心地址')).to_have_value(CLOUD + '/login.html?next=%2F%23account')
    expect(app.get_by_role('textbox', name='账号中心地址')).to_be_visible()
    expect(launch).to_be_enabled()
    desktop = browser.new_context()
    desktop.add_init_script('window.WordPaperDesktop = { openExternal() { throw Error("unused legacy bridge"); } };')
    reconnect = desktop.new_page()
    reconnect.route('**/api/desktop/open', lambda route: route.fulfill(status=503, json={'error': '系统浏览器未能打开'}))
    reconnect.goto(BASE + '/login.html?sync=1')
    expect(reconnect.locator('#auth-github')).to_be_hidden()
    expect(reconnect.locator('[data-cloud-provider="github"]')).to_be_visible()
    reconnect.locator('#desktop-origin').fill(CLOUD)
    reconnect.locator('[data-cloud-provider="email"]').click()
    fallback = reconnect.get_by_role('textbox', name='浏览器授权地址')
    expect(fallback).to_be_visible()
    assert fallback.input_value() == reconnect.locator('#desktop-sync-open').get_attribute('href')
    expect(reconnect.locator('#desktop-sync-code')).to_be_visible()
    reconnect.locator('#desktop-sync-cancel').click()
    expect(fallback).to_be_hidden()
    desktop.close()

    # A fresh browser login to the same account should reuse its mirror.
    original_local_user = context.request.get(BASE + '/api/session').json()['user']
    assert context.request.get(CLOUD + '/api/session').json()['user']['id'] == remote_session['user']['id']
    assert context.request.delete(CLOUD + '/api/session', headers={
        'Origin': CLOUD, 'X-CSRF-Token': remote_session['csrfToken'],
    }).ok
    assert context.request.get(CLOUD + '/api/session').status == 401
    app.goto(BASE + '/login.html?sync=1', wait_until='domcontentloaded')
    expect(app.locator('#desktop-origin')).to_have_value(CLOUD)
    with context.expect_event('request', predicate=lambda request: urlsplit(request.url).path == '/github/authorize'):
        connect_desktop(context, app, 'GitHub 登录')
    assert context.request.get(CLOUD + '/api/session').json()['user']['id'] == remote_session['user']['id']
    local_session = context.request.get(BASE + '/api/session').json()
    assert local_session['mirrored'] and local_session['user']['id'] == original_local_user['id']
    expect(app.locator('#reminder-list')).to_contain_text(value[0]['text'])
    # A simultaneous same-field edit produces a recoverable copy. Restore
    # through the visible dialog, then verify the cloud's actual value.
    latest = context.request.get(CLOUD + '/api/state').json()
    cloud_value = [dict(value[0], text='云端同时编辑')]
    response = context.request.put(CLOUD + '/api/state/reminders', headers={
        'Origin': CLOUD, 'X-CSRF-Token': context.request.get(CLOUD + '/api/session').json()['csrfToken'],
    }, data={'value': cloud_value, 'expectedRevision': latest['revisions']['reminders']})
    assert response.ok
    app.evaluate("""async () => {
        const list = Store.getReminders().map(item => ({...item, text:'本机待取回的编辑'}));
        Store.saveReminders(list); await Store.flush();
    }""")
    app.locator('#btn-sync-conflicts').click()
    copies = app.locator('#sync-conflict-list section').filter(has=app.get_by_role('heading', name='提醒', exact=False)).last
    expect(copies).to_be_visible()
    with app.expect_download() as downloaded:
        copies.get_by_role('button', name='下载 JSON').click()
    import json
    with open(downloaded.value.path()) as f:
        assert json.load(f)['value'][0]['text'] == '本机待取回的编辑'
    app.once('dialog', lambda dialog: dialog.accept())
    with app.expect_navigation(wait_until='domcontentloaded'):
        copies.get_by_role('button', name='恢复这个版本').click()
    assert context.request.get(CLOUD + '/api/state').json()['state']['reminders'][0]['text'] == '本机待取回的编辑'

    # The web client also merges a stale PUT against its original revision.
    cloud_web = context.new_page()
    cloud_web.goto(CLOUD + '/', wait_until='domcontentloaded')
    cloud_web.wait_for_function('window.Store && Store.currentUser() && Store.getSeeded()')
    cloud_web.evaluate('Store.refreshKey("reminders")')
    state = context.request.get(CLOUD + '/api/state').json()
    direct = [*state['state']['reminders'], {'id': 'independent', 'text': '另一台设备'}]
    assert context.request.put(CLOUD + '/api/state/reminders', headers={
        'Origin': CLOUD, 'X-CSRF-Token': context.request.get(CLOUD + '/api/session').json()['csrfToken'],
    }, data={'value': direct, 'expectedRevision': state['revisions']['reminders']}).ok
    cloud_web.evaluate("""() => {
        Store.saveReminders(Store.getReminders().map(item => item.id === 'shared' ? {...item, text:'网页刚刚编辑'} : item));
    }""")
    # A successful conditional retry can follow a 409 on the next task.
    # Observe the authoritative response rather than a Promise in the page.
    import time
    deadline = time.monotonic() + 15
    while True:
        cloud_web.evaluate('Store.flush()')
        merged = context.request.get(CLOUD + '/api/state').json()['state']['reminders']
        by_id = {r['id']: r['text'] for r in merged}
        if by_id.get('shared') == '网页刚刚编辑' and by_id.get('independent') == '另一台设备':
            break
        assert time.monotonic() < deadline, by_id
        time.sleep(.1)
    cloud_web.close()

    # Service errors must never hydrate unscoped sample data or seed defaults.
    outage = context.new_page()
    outage.route('**/api/session', lambda route: route.fulfill(status=503, content_type='text/html', body='maintenance'))
    outage.goto(BASE + '/', wait_until='domcontentloaded')
    expect(outage.locator('#sync-status')).to_have_text('账号数据暂不可用')
    assert not outage.evaluate('Store.isLocalMode()')
    expect(outage.locator('#btn-sync-retry')).to_be_visible()
    outage.close()
    assert not errors, errors
    browser.close()
print('PASS Google and GitHub desktop handoff to the same account, cloud changes and account center, no WeChat entry points')
