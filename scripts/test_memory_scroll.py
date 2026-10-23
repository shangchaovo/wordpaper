#!/usr/bin/env python3
"""Memory notebook scrolling regressions, with an isolated server and account.

Run: python3 scripts/test_memory_scroll.py
Checks real wheel scrolling, scroll boundaries, small viewports, repeated entry
animations, and the persistence of an answered word's revealed meaning.
"""
import os
import subprocess
import tempfile

from e2e import ROOT, PlaywrightError, free_port, sync_playwright, wait_up


THEMES = ("liquid", "darkliquid", "editorial", "anime")
VIEWPORTS = ((1460, 980), (390, 650), (900, 500))


def main():
    port = free_port()
    base = f"http://127.0.0.1:{port}"
    failures = []
    errors = []

    def check(name, passed, detail=None):
        print(("PASS  " if passed else "FAIL  ") + name, flush=True)
        if not passed:
            failures.append(name)
            if detail is not None:
                print(f"      {detail}", flush=True)

    with tempfile.TemporaryDirectory(prefix="wordpaper-memory-scroll-") as data_dir:
        env = dict(os.environ, PORT=str(port), HOST="127.0.0.1",
                   WORDPAPER_MODE="local", WORDPAPER_DATA_DIR=data_dir,
                   WORDPAPER_COMPANION_PORT="1", WORDPAPER_COMPANION_AUTOSTART="0",
                   NODE_ENV="test")
        with tempfile.TemporaryFile(mode="w+") as server_log:
            server = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env,
                                      stdout=server_log, stderr=subprocess.STDOUT)
            try:
                if not wait_up(port):
                    server_log.seek(0)
                    raise RuntimeError("test server failed to start: " + server_log.read())
                with sync_playwright() as playwright:
                    try:
                        browser = playwright.chromium.launch()
                    except PlaywrightError as exc:
                        if "Executable doesn't exist" not in str(exc):
                            raise
                        browser = playwright.chromium.launch(channel="chrome")
                    try:
                        context = browser.new_context(viewport={"width": 1460, "height": 980})
                        # Excel import is unrelated to this suite. Supply its optional
                        # CDN script locally so offline runs still catch real errors.
                        context.route("https://cdn.jsdelivr.net/npm/xlsx@*/**",
                                      lambda route: route.fulfill(status=200,
                                          content_type="text/javascript", body=""))
                        account = context.request.post(base + "/api/auth/register",
                            headers={"Origin": base}, data={
                                "username": "memory_scroll_" + str(port),
                                "password": "wordpaper-memory-scroll-password",
                            })
                        if account.status != 201:
                            raise RuntimeError("test account registration failed: " + account.text())
                        page = context.new_page()
                        page.on("pageerror", lambda error: errors.append("pageerror: " + str(error)))
                        page.on("console", lambda message: errors.append(
                            "console.error: " + message.text) if message.type == "error" else None)
                        page.goto(base, wait_until="domcontentloaded")
                        page.wait_for_selector("#library-cards .lib-card")
                        page.wait_for_timeout(800)

                        for theme in THEMES:
                            page.set_viewport_size({"width": 1460, "height": 980})
                            page.locator(f'.ui-theme-option[data-ui-theme="{theme}"]').click()
                            page.wait_for_timeout(1000)
                            for width, height in VIEWPORTS:
                                label = f"{theme} {width}×{height}"
                                page.set_viewport_size({"width": width, "height": height})
                                page.evaluate("""() => {
                                  const library = Store.getSettings().library;
                                  const now = Date.now();
                                  const words = {};
                                  for (let i = 0; i < 96; i++) {
                                    const word = {word: 'scroll-word-' + String(i).padStart(3, '0'),
                                      meaning: '滚动测试中文释义 ' + i};
                                    words[Review.wordKey(word)] = {word, learnedAt: now - 7200000,
                                      stage: i < 88 ? 0 : 8, due: i < 88 ? now - 60000 + i : null,
                                      learnedCount: 1, reviewCount: i < 88 ? 0 : 8, events: []};
                                  }
                                  Store.saveReview({[library]: {cursor: 0, groups: {}, words}});
                                  const modal = document.querySelector('#memory-modal');
                                  if (window.memoryAnimationListener) {
                                    modal.removeEventListener('animationstart', window.memoryAnimationListener);
                                  }
                                  window.memoryAnimationStarts = [];
                                  window.memoryAnimationListener = event => {
                                    if (event.target.matches('.memory-entry')) {
                                      window.memoryAnimationStarts.push({
                                        word: event.target.querySelector('b').textContent,
                                        name: event.animationName,
                                      });
                                    }
                                  };
                                  modal.addEventListener('animationstart', window.memoryAnimationListener);
                                }""")
                                page.locator("#btn-open-memory").click()
                                page.wait_for_selector("#memory-modal .memory-entry")
                                page.wait_for_timeout(1200)
                                animations = page.evaluate("() => window.memoryAnimationStarts")
                                counts = {}
                                for event in animations:
                                    counts[event["word"]] = counts.get(event["word"], 0) + 1
                                check(label + " 词卡打开后不重复播放进场动画",
                                      all(count <= 1 for count in counts.values()),
                                      [event for event in animations if counts[event["word"]] > 1][:4])

                                close = page.locator("#btn-close-memory")
                                check(label + " 关闭按钮完整可见且可点击", close.evaluate("""element => {
                                  const r = element.getBoundingClientRect();
                                  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
                                  return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight &&
                                    r.right <= innerWidth && (element === hit || element.contains(hit));
                                }"""))

                                card = page.locator("#memory-notebook-list .memory-entry.due").first
                                answered_word = card.locator("b").inner_text()
                                card.locator(".memory-answer.remembered").click()
                                meaning = page.locator("#memory-notebook-list .memory-entry.answered .memory-meaning").inner_text()
                                page.wait_for_timeout(400)
                                background_before = background_scroll(page)
                                listing = page.locator("#memory-notebook-list")
                                listing.evaluate("element => { element.scrollTop = 0; }")
                                point_to_list(page, listing)
                                page.mouse.wheel(0, 450)
                                page.wait_for_timeout(250)
                                check(label + " 滚轮能滚动词卡列表",
                                      listing.evaluate("element => element.scrollTop") > 0)
                                for delta in (100000, 2000, 2000):
                                    page.mouse.wheel(0, delta)
                                    page.wait_for_timeout(150)
                                check(label + " 可滚到最后一张词卡", listing.evaluate("""element => {
                                  const last = element.querySelector('.memory-entry:last-child');
                                  const viewport = element.getBoundingClientRect();
                                  const r = last.getBoundingClientRect();
                                  return element.scrollHeight - element.clientHeight - element.scrollTop < 2 &&
                                    r.bottom <= Math.min(viewport.bottom, innerHeight) + 1 && r.bottom > viewport.top;
                                }"""))
                                check(label + " 底部继续滚动不带动背景页面",
                                      background_scroll(page) == background_before)
                                for delta in (-100000, -2000, -2000):
                                    page.mouse.wheel(0, delta)
                                    page.wait_for_timeout(150)
                                check(label + " 顶部继续滚动不带动背景页面",
                                      background_scroll(page) == background_before)
                                answered = page.locator("#memory-notebook-list .memory-entry.answered")
                                check(label + " 滚动后已回答中文保持显示",
                                      answered.count() == 1 and answered.locator("b").inner_text() == answered_word
                                      and answered.locator(".memory-meaning").inner_text() == meaning
                                      and not answered.locator(".memory-meaning").evaluate(
                                          "element => element.classList.contains('locked')"))
                                close.click()
                                # 关闭现在带一段落回动画，hidden 在动画结束后置位；轮询等待而不是立即断言。
                                closed_hidden = page.locator("#memory-modal").evaluate(
                                    """element => new Promise(resolve => {
                                      const started = performance.now();
                                      (function poll() {
                                        if (element.hidden) { resolve(true); return; }
                                        if (performance.now() - started > 800) { resolve(false); return; }
                                        requestAnimationFrame(poll);
                                      })();
                                    })""")
                                check(label + " 可正常关闭记忆本", closed_hidden)
                        check("浏览器无 pageerror / console.error", not errors, errors)
                        context.close()
                    finally:
                        browser.close()
            finally:
                server.terminate()
                try:
                    server.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=5)
    if failures:
        raise SystemExit(f"{len(failures)} memory notebook regression check(s) failed")
    print("PASS  memory notebook scrolling across four themes and three viewport sizes")


def background_scroll(page):
    return page.evaluate("""() => ({x: scrollX, y: scrollY,
      panels: [...document.querySelectorAll('.panel-col')].map(element => element.scrollTop)})""")


def point_to_list(page, listing):
    box = listing.bounding_box()
    page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)


if __name__ == "__main__":
    main()
