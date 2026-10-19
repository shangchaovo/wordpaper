#!/usr/bin/env python3
"""Browser-level account migration and isolation checks.

Run against a disposable WordPaper server:
  WORDPAPER_TEST_BASE_URL=http://127.0.0.1:18991 python3 scripts/test_accounts_browser.py
"""

import os
import re
import time

from playwright.sync_api import expect, sync_playwright


BASE = os.environ.get("WORDPAPER_TEST_BASE_URL", "http://127.0.0.1:18991")
STAMP = str(int(time.time() * 1000))
FIRST_USER = "browser_a_" + STAMP[-8:] + "@example.test"
SECOND_USER = "browser_b_" + STAMP[-8:] + "@example.test"
THIRD_USER = "browser_c_" + STAMP[-8:] + "@example.test"
PASSWORD = "browser-test-password"
SECRET_REMINDER = "仅账号 A 可见的迁移提醒"


def register(page, username):
    page.goto(BASE + "/login.html", wait_until="domcontentloaded")
    page.click("#tab-register")
    page.fill("#username", username)
    page.click("#send-email-code")
    expect(page.locator("#email-code")).to_have_value(re.compile(r"^\d{6}$"), timeout=10_000)
    page.fill("#password", PASSWORD)
    page.fill("#password-confirm", PASSWORD)
    page.click("#submit-auth")
    page.wait_for_url(BASE + "/", timeout=15_000)
    page.wait_for_selector("#preview-canvas", timeout=20_000)


def login(page, username):
    page.goto(BASE + "/login.html", wait_until="domcontentloaded")
    page.fill("#username", username)
    page.fill("#password", PASSWORD)
    page.click("#submit-auth")
    page.wait_for_url(BASE + "/", timeout=15_000)
    page.wait_for_selector("#preview-canvas", timeout=20_000)


with sync_playwright() as playwright:
    try:
        browser = playwright.chromium.launch(headless=True)
    except Exception:
        browser = playwright.chromium.launch(channel="chrome", headless=True)
    context = browser.new_context()
    page = context.new_page()
    browser_errors = []
    page.on("pageerror", lambda error: browser_errors.append(str(error)))

    page.goto(BASE + "/login.html", wait_until="domcontentloaded")
    page.evaluate(
        """secret => {
          localStorage.setItem('wp:settings', JSON.stringify({library:'gre', layout:'poster'}));
          localStorage.setItem('wp:reminders', JSON.stringify([{id:'legacy-a', text:secret, time:'', done:false}]));
          localStorage.setItem('wp:seeded', JSON.stringify(true));
        }""",
        SECRET_REMINDER,
    )

    register(page, FIRST_USER)
    page.wait_for_function("document.querySelector('#sync-status').dataset.state === 'saved'", timeout=15_000)
    assert page.locator("#account-name").inner_text() == FIRST_USER
    assert SECRET_REMINDER in page.locator("#reminder-list").inner_text()
    assert page.evaluate("Store.getSettings().library") == "gre"

    page.reload(wait_until="domcontentloaded")
    page.wait_for_selector("#preview-canvas", timeout=20_000)
    assert SECRET_REMINDER in page.locator("#reminder-list").inner_text(), "A data disappeared after reload"

    page.click("#btn-logout")
    page.wait_for_url(BASE + "/login.html", timeout=15_000)
    register(page, SECOND_USER)
    assert page.locator("#account-name").inner_text() == SECOND_USER
    assert SECRET_REMINDER not in page.locator("#reminder-list").inner_text(), "B received A's local/server data"

    page.click("#btn-logout")
    page.wait_for_url(BASE + "/login.html", timeout=15_000)
    login(page, FIRST_USER)
    assert SECRET_REMINDER in page.locator("#reminder-list").inner_text(), "A data missing after account switch"

    # A normal login to an existing empty account must not claim unscoped legacy
    # localStorage from an unrelated/shared browser. Only its registration
    # session is allowed to perform that one-time migration.
    empty_context = browser.new_context()
    code_response = empty_context.request.post(
        BASE + "/api/auth/email/code",
        headers={"Origin": BASE},
        data={"email": THIRD_USER},
    )
    assert code_response.status == 200, code_response.text()
    verification_code = code_response.json().get("debugCode", "")
    assert len(verification_code) == 6 and verification_code.isdigit(), code_response.text()
    created = empty_context.request.post(
        BASE + "/api/auth/register",
        headers={"Origin": BASE},
        data={
            "email": THIRD_USER,
            "password": PASSWORD,
            "verificationCode": verification_code,
        },
    )
    assert created.status == 201, created.text()
    empty_context.close()

    shared_context = browser.new_context()
    shared_page = shared_context.new_page()
    shared_page.goto(BASE + "/login.html", wait_until="domcontentloaded")
    shared_page.evaluate(
        "secret => localStorage.setItem('wp:reminders', JSON.stringify([{id:'wrong-owner', text:secret}]))",
        "不应被普通登录认领的旧数据",
    )
    login(shared_page, THIRD_USER)
    assert "不应被普通登录认领的旧数据" not in shared_page.locator("#reminder-list").inner_text()
    assert shared_page.locator("#btn-import-legacy").is_visible(), "explicit legacy-import fallback was not offered"
    shared_page.evaluate("Store.flush()")
    shared_page.once("dialog", lambda dialog: dialog.accept())
    # 导入成功后页面会 location.reload()；旧页面上 #preview-canvas 早已存在，必须等重载完成再断言。
    with shared_page.expect_navigation(wait_until="domcontentloaded", timeout=20_000):
        shared_page.click("#btn-import-legacy")
    shared_page.wait_for_selector("#preview-canvas", timeout=20_000)
    assert "不应被普通登录认领的旧数据" in shared_page.locator("#reminder-list").inner_text()
    shared_context.close()

    assert not browser_errors, "browser errors: " + " | ".join(browser_errors)
    print("PASS browser safe auto-migration, explicit fallback migration, reload persistence, and A/B isolation")
    browser.close()
