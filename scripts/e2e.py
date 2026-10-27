#!/usr/bin/env python3
"""End-to-end checks for WordPaper (daily-wallpaper).

Self-contained: launches its own server.js on a free port, runs Playwright
assertions, then kills the server. Covers v1 paths plus v2: library cards,
background patterns, typography controls, anchors, page cycling, drag nudge,
screenshot-import affordance, and the desktop-companion buttons. Ends by
asserting no pageerror / console.error.
"""
import os
import socket
import subprocess
import sys
import tempfile
import time
import shutil

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

try:
    from playwright.sync_api import Error as PlaywrightError, sync_playwright
except ImportError:
    print("需要 playwright:  pip install playwright && playwright install chromium")
    sys.exit(1)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); port = s.getsockname()[1]; s.close(); return port


def wait_up(port, timeout=10):
    import urllib.request
    end = time.time() + timeout
    while time.time() < end:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/", timeout=1); return True
        except Exception:
            time.sleep(0.2)
    return False


def main():
    port = free_port()
    data_dir = tempfile.mkdtemp(prefix="wordpaper-e2e-")
    env = dict(os.environ, PORT=str(port), HOST="127.0.0.1", WORDPAPER_MODE="local",
               WORDPAPER_DATA_DIR=data_dir, NODE_ENV="test",
               WORDPAPER_COMPANION_PORT=str(free_port()), WORDPAPER_COMPANION_AUTOSTART="0")
    server = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if not wait_up(port):
        print("server failed to start"); server.kill(); sys.exit(1)

    base = f"http://127.0.0.1:{port}"
    results = []
    errors = []

    def check(name, cond):
        results.append((name, bool(cond)))
        print(("PASS  " if cond else "FAIL  ") + name)

    try:
        with sync_playwright() as p:
            try:
                browser = p.chromium.launch()
            except PlaywrightError as exc:
                # Local development may have Playwright installed without its
                # bundled browser. Keep the suite runnable with system Chrome,
                # while preserving real launch failures.
                if "Executable doesn't exist" not in str(exc):
                    raise
                browser = p.chromium.launch(channel="chrome")
            context = browser.new_context(viewport={"width": 1460, "height": 980})
            account = context.request.post(base + "/api/auth/register", headers={"Origin": base}, data={
                "username": "e2e_user_" + str(port), "password": "wordpaper-e2e-password",
            })
            if account.status != 201:
                raise RuntimeError("test account registration failed: " + account.text())
            page = context.new_page()
            page.on("pageerror", lambda e: errors.append("pageerror: " + str(e)))
            page.on("console", lambda m: errors.append(
                "console.error: " + m.text + (" @ " + m.location.get("url", "") if m.location else "")
            ) if m.type == "error" else None)
            # 末尾断言前过滤掉可选 CDN(SheetJS)加载失败:离线/代理环境下
            # 该资源连不上是网络噪音,页面本就声明"没有它功能照常"。
            errors_before_final = len(errors)

            page.goto(base, wait_until="domcontentloaded")
            page.wait_for_selector("#preview-canvas")
            page.wait_for_timeout(700)

            check("页面标题", "WordPaper" in page.title())
            check("换一组按钮", page.locator("#btn-refresh2").count() == 1)

            # library cards (v3) — 12 built-in libraries (2 日语 + 初/高中 + 四六/研/雅/托/GRE + 法语/西语) + 我的词库
            check("词库卡片渲染(13张)", page.locator("#library-cards .lib-card").count() == 13)
            # 词书搜索:输入关键词过滤卡片,清空恢复。
            page.fill("#library-filter", "雅思")
            page.wait_for_timeout(200)
            check("词书搜索过滤(雅思)", page.locator("#library-cards .lib-card").count() == 1
                  and "雅思" in page.inner_text("#library-cards"))
            page.fill("#library-filter", "")
            page.wait_for_timeout(200)
            check("清空搜索恢复全部词书", page.locator("#library-cards .lib-card").count() == 13)
            # default canvas size desktop 1920x1080 (本软件不面向手机)
            # 预览按屏幕像素绘制，壁纸的逻辑尺寸标在 data-wallpaper-w/h 上
            dims = page.evaluate("() => { const c=document.querySelector('#preview-canvas'); return {w:+c.dataset.wallpaperW,h:+c.dataset.wallpaperH}; }")
            check("默认电脑画布 1920×1080", dims["w"] == 1920 and dims["h"] == 1080)

            # switch library via the cet4 card (locate by text, not index)
            page.locator("#library-cards .lib-card", has_text="四级").first.click()
            page.wait_for_timeout(400)
            check("点卡片切四级词库", "四级" in page.inner_text("#meta") or "CET4" in page.inner_text("#meta"))

            # background pattern picker
            page.locator("#pattern-picker .pattern-chip").nth(2).click()  # dots
            page.wait_for_timeout(300)
            check("背景纹理切换", page.locator("#pattern-picker .pattern-chip").nth(2).evaluate("e=>e.classList.contains('on')"))

            # Typography lives beside the selected canvas word, not in a
            # duplicate sidebar. Five words may scale freely; six or more use
            # automatic fitting. Select a real word before using the controls.
            page.locator("#inp-count").fill("5")
            page.locator("#inp-count").dispatch_event("change")
            page.wait_for_timeout(400)
            box = page.locator("#preview-canvas").bounding_box()
            for fy in (0.28, 0.34, 0.40, 0.46, 0.52, 0.58, 0.64, 0.70):
                page.mouse.click(box["x"] + box["width"] * .5,
                                 box["y"] + box["height"] * fy)
                if not page.locator("#word-inspector").evaluate("e=>e.hidden"):
                    break
            check("点击画布单词打开就地排版", not page.locator("#word-inspector").evaluate("e=>e.hidden"))

            page.locator("#sel-word-scale").fill("1.3")
            page.wait_for_timeout(400)
            check("字号缩放实时生效", page.eval_on_selector("#sel-word-scale-number", "e=>e.value") == "130"
                  and page.evaluate("() => Store.getSettings().fontScale") == 1.3)

            page.select_option("#sel-word-weight", "800")
            page.wait_for_timeout(300)
            check("字重切换", page.eval_on_selector("#sel-word-weight", "e=>e.value") == "800")

            page.select_option("#sel-word-font", "song")
            page.wait_for_timeout(300)
            check("字体风格切换(宋体)", page.eval_on_selector("#sel-word-font", "e=>e.value") == "song")
            page.select_option("#sel-word-font", "hei")  # restore

            page.locator("#sel-word-color").fill("#8a3f2d")
            page.locator("#sel-word-color").dispatch_event("input")
            page.wait_for_timeout(300)
            check("文字颜色选择生效", page.evaluate("() => Store.getSettings().inkOverride") == "#8a3f2d")
            page.click("#btn-reset-word-style")
            page.wait_for_timeout(200)
            check("整组样式恢复默认", page.evaluate("() => Store.getSettings().inkOverride") == "")

            # v3: date & clock checkboxes removed from the appearance card
            check("日期/时间开关已移除", page.locator("#chk-date").count() == 0 and page.locator("#chk-clock").count() == 0)

            # v3: background photo control present (upload tile + clear hidden until set)
            check("背景照片上传入口", page.locator("#file-bgphoto").count() == 1)

            # 位置布局(锚点预设)卡片已移除，拖拽即可
            check("锚点预设卡片已移除", page.locator('#anchor-words').count() == 0)

            # desktop size
            page.select_option("#sel-size", "desktop-1920x1080")
            page.wait_for_timeout(400)
            dims2 = page.evaluate("() => { const c=document.querySelector('#preview-canvas'); return {w:+c.dataset.wallpaperW,h:+c.dataset.wallpaperH}; }")
            check("切桌面 1920×1080", dims2["w"] == 1920 and dims2["h"] == 1080)

            # paste import -> custom library card (import UI now lives in a button-triggered modal)
            check("导入按钮存在", page.locator("#btn-open-import").count() == 1)
            page.click("#btn-open-import")
            page.wait_for_timeout(200)
            check("导入弹窗打开", page.locator("#import-modal").evaluate("e=>!e.hidden"))
            page.fill("#txt-paste", "serendipity, /ˌserənˈdɪpəti/, n., 意外发现珍奇事物的本领\nephemeral, /ɪˈfemərəl/, adj., 短暂的")
            page.click("#btn-paste-import")
            page.wait_for_timeout(400)
            check("粘贴导入切到我的词库", page.locator("#library-cards .lib-card").last.evaluate("e=>e.classList.contains('on')"))
            check("我的词库卡片有计数", "2词" in page.inner_text("#library-cards"))

            # screenshot import affordance present (inside modal)
            check("截图导入入口", page.locator("#file-screenshot").count() == 1)
            # close modal (关闭带落回动画，hidden 在动画结束后置位)
            page.click("#btn-close-import")
            check("导入弹窗可关闭", page.locator("#import-modal").evaluate(
                """e => new Promise(resolve => {
                  const started = performance.now();
                  (function poll() {
                    if (e.hidden) { resolve(true); return; }
                    if (performance.now() - started > 800) { resolve(false); return; }
                    requestAnimationFrame(poll);
                  })();
                })"""))

            # add reminder
            page.fill("#inp-reminder", "下午 3 点开组会")
            page.click("#btn-add-reminder")
            page.wait_for_timeout(200)
            check("提醒出现在列表", "开组会" in page.inner_text("#reminder-list"))

            # manual refresh keeps canvas
            page.click("#btn-refresh2")
            page.wait_for_timeout(400)
            check("换一组后仍有画布", page.evaluate("() => document.querySelector('#preview-canvas').width > 0"))

            # visual drag: press on the words block and pull down -> offWords.y changes
            box = page.locator("#preview-canvas").bounding_box()
            before = page.evaluate("() => (Store.getSettings().offWords||{}).y")
            cx, cy = box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.35
            page.keyboard.down("Shift")
            page.mouse.move(cx, cy); page.mouse.down()
            for i in range(6):
                page.mouse.move(cx, cy + 20 * (i + 1), steps=3); page.wait_for_timeout(20)
            page.mouse.up(); page.keyboard.up("Shift")
            page.wait_for_timeout(250)
            after = page.evaluate("() => (Store.getSettings().offWords||{}).y")
            check("预览拖动单词块", before != after)

            # PNG download
            with page.expect_download() as dl:
                page.click("#btn-download2")
            check("PNG 下载", dl.value.suggested_filename.endswith(".png"))
            with open(dl.value.path(), "rb") as f:
                png_head = f.read(24)
            png_w, png_h = int.from_bytes(png_head[16:20], "big"), int.from_bytes(png_head[20:24], "big")
            check("下载的 PNG 是壁纸原尺寸(非预览分辨率)",
                  (png_w, png_h) == (int(dims2["w"]), int(dims2["h"])))

            # SRS (艾宾浩斯) — 记忆复习 card. Switch to a stable built-in fixture (四级)
            # before exercising the notebook; custom libraries use the same SRS path.
            check("记忆复习卡片存在", page.locator("#btn-open-memory").count() == 1)
            page.locator("#library-cards .lib-card", has_text="四级").first.click()
            page.wait_for_timeout(500)
            lib = page.evaluate("() => Store.getSettings().library")
            check("切到内置词库(四级)", lib == "cet4")
            before = page.evaluate("l => window.Review.stats(l).total", lib)
            page.evaluate("l => window.Review.rememberWord(l, {word:'e2e-memory-word', meaning:'回归测试释义', pos:'n.'})", lib)
            page.locator("#chk-srs").dispatch_event("change")
            page.wait_for_timeout(500)
            after = page.evaluate("l => window.Review.stats(l).total", lib)
            check("记住单词登记复习", after == before + 1)
            check("复习倒计时出现", page.eval_on_selector("#srs-countdown", "e=>!e.hidden"))
            page.click("#btn-open-memory")
            check("记忆本打开", page.locator("#memory-modal:not([hidden])").count() == 1)
            check("记忆本遮盖中文", page.locator("#memory-notebook-list .memory-meaning.locked").count() >= 1)
            page.click("#btn-close-memory")

            # 到期词必须显式选择“还没记住 / 记住了”。首次同步事件不能冒充复习通过。
            memory_word = {"word": "e2e-memory-word", "meaning": "回归测试释义", "pos": "n."}
            def force_review_state(stage=0):
                page.evaluate("""p => {
                  const all = Store.getReview(), key = Review.wordKey(p.word);
                  all[p.lib].words[key].stage = p.stage;
                  all[p.lib].words[key].due = Date.now() - 1000;
                  Store.saveReview(all);
                }""", {"lib": lib, "word": memory_word, "stage": stage})

            force_review_state(0)
            page.click("#btn-open-memory")
            check("到期词显示双向作答", page.locator(".memory-answer.forgot").count() >= 1 and page.locator(".memory-answer.remembered").count() >= 1)
            page.locator(".memory-entry", has_text="e2e-memory-word").locator(".memory-answer.forgot").click()
            forgot_state = page.evaluate("p => Review.getWord(p.lib, p.word)", {"lib": lib, "word": memory_word})
            check("没记住后重置第一周期", forgot_state["stage"] == 0 and forgot_state["failCount"] == 1 and forgot_state["due"] > page.evaluate("Date.now()"))
            check("没记住后展示中文", page.locator(".memory-entry", has_text="e2e-memory-word").locator(".memory-meaning.locked").count() == 0)
            page.wait_for_timeout(2200)
            check("作答中文不会自动消失", page.locator(".memory-entry", has_text="e2e-memory-word").locator(".memory-meaning.locked").count() == 0)
            page.click("#btn-close-memory")

            # 重复的桌面小词灵首轮事件只能记一条 duplicate-learn，不能推进到期阶段。
            force_review_state(0)
            page.evaluate("p => Review.rememberWord(p.lib, p.word)", {"lib": lib, "word": memory_word})
            duplicate_state = page.evaluate("p => Review.getWord(p.lib, p.word)", {"lib": lib, "word": memory_word})
            check("重复首轮事件不推进周期", duplicate_state["stage"] == 0 and duplicate_state["due"] <= page.evaluate("Date.now()"))

            page.click("#btn-open-memory")
            page.locator(".memory-entry", has_text="e2e-memory-word").locator(".memory-answer.remembered").click()
            passed_state = page.evaluate("p => Review.getWord(p.lib, p.word)", {"lib": lib, "word": memory_word})
            check("记住了推进下一周期", passed_state["stage"] == 1 and passed_state["due"] > page.evaluate("Date.now()"))
            page.click("#btn-close-memory")

            force_review_state(len(page.evaluate("Review.INTERVALS_MIN")) - 1)
            page.click("#btn-open-memory")
            page.locator(".memory-entry", has_text="e2e-memory-word").locator(".memory-answer.remembered").click()
            mastered_state = page.evaluate("p => Review.getWord(p.lib, p.word)", {"lib": lib, "word": memory_word})
            check("全部周期后才真正巩固", mastered_state["stage"] == len(page.evaluate("Review.INTERVALS_MIN")) and mastered_state["due"] is None)
            page.click("#btn-close-memory")

            page.uncheck("#chk-srs")
            page.wait_for_timeout(300)
            check("关闭艾宾浩斯后倒计时隐藏", page.eval_on_selector("#srs-countdown", "e=>e.hidden"))
            page.check("#chk-srs")  # restore
            page.wait_for_timeout(200)

            # page-cycling checkbox reveals interval row (自动与轮换 card is a collapsed <details> — open it first)
            page.locator("details.card summary", has_text="自动与轮换").click()
            page.wait_for_timeout(150)
            page.check("#chk-cycle")
            page.wait_for_timeout(200)
            check("周期切换间隔行显示", page.eval_on_selector("#cycle-sec-row", "e=>e.style.display") != "none")

            # The desktop actions have one visible home in the preview header
            # and pet dock; the old duplicate desktop module remains hidden.
            check("设为桌面壁纸按钮", page.locator("#btn-set-wallpaper2").is_visible())
            check("小词灵主入口", page.locator("#btn-pet-dock").is_visible()
                  and page.locator("#btn-pet-memory").is_visible())
            pet_box = page.locator("#pet-dock").bounding_box()
            stage_box = page.locator("#preview-stage").bounding_box()
            pet_button_box = page.locator("#btn-pet-dock").bounding_box()
            check("小词灵已整合在预览上方且可点击",
                  pet_box is not None and stage_box is not None and pet_button_box is not None
                  and pet_box["width"] > 500 and pet_box["y"] < stage_box["y"]
                  and page.evaluate("""() => {
                    const b = document.querySelector('#btn-pet-dock').getBoundingClientRect();
                    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                    return hit === document.querySelector('#btn-pet-dock') || document.querySelector('#btn-pet-dock').contains(hit);
                  }"""))

            # 同一台 Mac 上的第二个账号:小词灵直接可用(共享本机桌面伴侣),
            # 学习记录仍按账号各自独立保存。
            other_context = browser.new_context(viewport={"width": 1460, "height": 980})
            other_account = other_context.request.post(base + "/api/auth/register", headers={"Origin": base}, data={
                "username": "e2e_pet_share_" + str(port), "password": "wordpaper-e2e-password",
            })
            check("小词灵共享测试账号创建", other_account.status == 201)
            other_page = other_context.new_page()
            other_page.goto(base, wait_until="domcontentloaded")
            other_page.wait_for_selector("#preview-canvas")
            other_page.wait_for_timeout(900)
            other_status = other_context.request.get(base + "/status.json").json()
            check("同机第二个账号伴侣状态可用", other_status.get("available") is True)
            check("同机第二个账号直接看到可用的小词灵入口",
                  other_page.locator("#pet-dock").is_visible()
                  and other_page.locator("#btn-pet-dock").is_visible()
                  and other_page.locator("#btn-pet-dock").get_attribute("data-action") in ("start", "control"))
            # 点击主入口会尝试启用/控制伴侣(不再被踢去登录);拦截请求避免碰到真实伴侣进程。
            share_requests = []
            def record_share_request(request):
                if any(path in request.url for path in ("/companion/start", "/pet.php")):
                    share_requests.append(request.url)
            other_page.on("request", record_share_request)
            other_context.route("**/companion/start", lambda route: route.fulfill(
                status=200, content_type="application/json", body='{"ok":true,"already":true}'))
            other_context.route("**/pet.php*", lambda route: route.fulfill(
                status=200, content_type="application/json", body='{"ok":true,"pet":true}'))
            other_page.click("#btn-pet-dock")
            other_page.wait_for_timeout(500)
            check("点击直接启用/控制小词灵而不踢去登录",
                  len(share_requests) >= 1 and "/login.html" not in other_page.url)
            other_context.close()

            # companion one-click zip route serves a real zip with launcher + data
            import zipfile, io
            zip_response = context.request.get(base + "/companion.zip")
            zdata = zip_response.body()
            zf = zipfile.ZipFile(io.BytesIO(zdata))
            names = zf.namelist()
            check("伴侣一键包(zip含启动器+当前词库)",
                  any(n.endswith("启动伴侣.command") for n in names)
                  and any(n.endswith("companion.js") for n in names)
                  and any(n.endswith("server.js") for n in names)
                  and any(n.endswith("login.html") for n in names)
                  and any(n.endswith("lib/storage.js") for n in names)
                  and any(n.endswith("js/app.js") for n in names)
                  and any(n.endswith("css/styles.css") for n in names)
                  and sum(1 for n in names if n.startswith("每日壁纸伴侣/data/words_")) >= 8
                  and any(n.endswith("words_jlpt_n5.json") for n in names)
                  and any(n.endswith("words_jlpt_n4.json") for n in names))
            launcher = next(i for i in zf.infolist() if i.filename.endswith(".command"))
            check("启动器可执行(+x)", (launcher.external_attr >> 16) & 0o111 != 0)

            # one-click enable endpoint: POST /companion/start (dry mode for tests)
            dryr = context.request.post(base + "/companion/start?dry=1", headers={"Origin": base})
            dryj = dryr.json()
            check("一键启用端点(dry)", dryj.get("ok") is True and dryj.get("dry") is True)
            check("一键启用非POST返回405", context.request.get(base + "/companion/start").status == 405)

            # companion's own server carries the same endpoints (page is served from 8771 too)
            with open(os.path.join(ROOT, "companion.js"), encoding="utf-8") as f:
                companion_src = f.read()
            check("伴侣服务同款一键/下载端点",
                  "'/companion/start'" in companion_src and "'/companion.zip'" in companion_src
                  and "freshWallpaperFile" in companion_src)

            # All three interface themes remain selectable. Liquid gets
            # per-surface optical filters in Chromium and persists on reload.
            # 主题切换先播放圆形铺满的过渡，盖满后才真正换主题，所以等属性落定再断言。
            # 页面 CSP 禁止 unsafe-eval，字符串形式的 wait_for_function 会直接报错，所以在这边轮询。
            def switch_ui_theme(theme):
                page.locator(f'.ui-theme-option[data-ui-theme="{theme}"]').click()
                for _ in range(40):
                    if page.eval_on_selector("html", "e=>e.dataset.uiTheme") == theme:
                        break
                    page.wait_for_timeout(50)
            switch_ui_theme("anime")
            check("动漫主题可切换", page.eval_on_selector("html", "e=>e.dataset.uiTheme") == "anime")
            switch_ui_theme("editorial")
            check("校样主题可切换", page.eval_on_selector("html", "e=>e.dataset.uiTheme") == "editorial")
            switch_ui_theme("liquid")
            page.wait_for_timeout(500)
            check("Liquid Glass 主题可切换", page.eval_on_selector("html", "e=>e.dataset.uiTheme") == "liquid")
            check("Liquid 壁纸配色已加入并自动联动",
                  page.locator("#theme-swatches .swatch").count() == 9
                  and page.locator('#theme-swatches .swatch[title="珍珠"]').evaluate("e=>e.classList.contains('on')")
                  and page.locator('#pattern-picker .pattern-chip').last.evaluate("e=>e.classList.contains('on')"))
            check("Liquid 光学折射已挂载", page.locator(".liquid-refraction-ready").count() >= 3
                  and page.locator("#wp-liquid-optics filter").count() >= 3)
            stage_optics = page.eval_on_selector(".stage", """e => ({
              optic: e.dataset.liquidOptic,
              ready: e.classList.contains('liquid-refraction-ready'),
              filter: getComputedStyle(e).backdropFilter || getComputedStyle(e).webkitBackdropFilter
            })""")
            # 大面板(.stage)光学稳定:不建 SVG 折射滤镜、不加 backdrop blur(面积占屏最大,
            # 折射+模糊每帧对背景重采样是卡顿主因)。只用 shell 渐变+静态高光,保留玻璃感
            # 但消除全屏重采样。optic 仍标记为 deep(供 CSS 区分层级),但不挂 refraction。
            check("中央展示板光学稳定(大面板免折射,性能优化)", stage_optics["optic"] == "deep"
                  and stage_optics["ready"] is False
                  and "url(" not in stage_optics["filter"])

            # Pointer light, gentle parallax and liquid press feedback are
            # functional states, rather than a static glass-coloured skin.
            page.eval_on_selector(".stage", """e => {
              const r = e.getBoundingClientRect();
              e.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'mouse'}));
              e.dispatchEvent(new PointerEvent('pointermove', {
                bubbles:true, pointerType:'mouse', clientX:r.left+r.width*.78, clientY:r.top+r.height*.22
              }));
            }""")
            page.wait_for_timeout(180)
            stage_motion = page.eval_on_selector(".stage", """e => ({
              lit: e.classList.contains('liquid-illuminated'),
              x: e.style.getPropertyValue('--glass-x'),
              tilt: e.style.getPropertyValue('--glass-tilt-y')
            })""")
            # 大面板(.stage)静态高光+不倾斜:只点亮(不闪),不跟手高光/倾斜——这是
            # 为消除大面积 backdrop 每帧重采样的性能取舍。
            check("Liquid 大面板点亮且静态高光(性能优化)", stage_motion["lit"] is True)

            # 跟随光与轻微视差保留在小控件上(工具条),那里面积小、代价可忽略。
            # 高光/视差变量由 rAF 合帧驱动;首屏渲染繁忙时 rAF 可能延迟数百毫秒,
            # 所以重试几次而不是一次定生死(功能本身 lit 类是同步点亮的)。
            toolbar_motion = {"lit": False, "x": "", "tilt": ""}
            for _attempt in range(6):
                page.eval_on_selector(".meta-actions", """e => {
                  const r = e.getBoundingClientRect();
                  e.dispatchEvent(new PointerEvent('pointerover', {bubbles:true, pointerType:'mouse'}));
                  e.dispatchEvent(new PointerEvent('pointermove', {
                    bubbles:true, pointerType:'mouse', clientX:r.left+r.width*.7, clientY:r.top+r.height*.4
                  }));
                }""")
                page.wait_for_timeout(220)
                toolbar_motion = page.eval_on_selector(".meta-actions", """e => ({
                  lit: e.classList.contains('liquid-illuminated'),
                  x: e.style.getPropertyValue('--glass-sheen-x'),
                  tilt: e.style.getPropertyValue('--glass-tilt-y')
                })""")
                if toolbar_motion["x"] != "" and toolbar_motion["tilt"] not in ("", "0deg", "0.000deg"):
                    break
                page.wait_for_timeout(280)
            check("Liquid 小控件跟随光与轻微视差可用", toolbar_motion["lit"] is True
                  and toolbar_motion["x"] != ""
                  and toolbar_motion["tilt"] not in ("", "0deg", "0.000deg"))

            refresh_button = page.locator("#btn-refresh2")
            refresh_button.dispatch_event("pointerdown", {"pointerType": "mouse", "button": 0})
            check("Liquid 控件按压产生弹性状态",
                  refresh_button.evaluate("e=>e.classList.contains('liquid-control-pressed')")
                  and page.locator(".meta-actions").evaluate("e=>e.classList.contains('liquid-pressed')"))
            page.locator("body").dispatch_event("pointerup", {"pointerType": "mouse", "button": 0})
            check("Liquid 控件松开恢复",
                  not refresh_button.evaluate("e=>e.classList.contains('liquid-control-pressed')"))
            # SheetJS is an optional CDN script; do not let a slow external CDN
            # make a local persistence assertion wait forever.
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#preview-canvas")
            check("界面主题刷新后保持", page.eval_on_selector("html", "e=>e.dataset.uiTheme") == "liquid"
                  and page.locator('.ui-theme-option[data-ui-theme="liquid"]').get_attribute("aria-pressed") == "true")

            # 暗夜(dark liquid):第 4 个界面主题,深色材质 + 联动「墨璃」壁纸配色,
            # 刷新后保持。光学控件结构与 Liquid 共用,但配色走暗色变量。
            switch_ui_theme("darkliquid")
            page.wait_for_timeout(500)
            check("暗夜主题可切换", page.eval_on_selector("html", "e=>e.dataset.uiTheme") == "darkliquid"
                  and page.locator('.ui-theme-option[data-ui-theme="darkliquid"]').get_attribute("aria-pressed") == "true")
            check("暗夜联动墨璃壁纸配色",
                  page.locator('#theme-swatches .swatch[title="墨璃"]').evaluate("e=>e.classList.contains('on')"))
            check("暗夜界面呈深色材质", page.evaluate("""() => {
              // The shared glass material now paints a dark solid base under
              // translucent highlights. Check the actual background and text
              // contrast instead of requiring the former gradient structure.
              const style = getComputedStyle(document.body);
              const channels = value => value.slice(value.indexOf('(') + 1, value.indexOf(')')).split(',').map(Number);
              const bg = channels(style.backgroundColor), ink = channels(style.color);
              return bg.length >= 3 && bg.slice(0, 3).every(v => v < 50)
                && ink.length >= 3 && ink.slice(0, 3).every(v => v > 180);
            }"""))
            check("暗夜光学控件已点亮结构就绪", page.locator(".liquid-refraction-ready").count() >= 3)
            page.reload(wait_until="domcontentloaded")
            page.wait_for_selector("#preview-canvas")
            page.wait_for_timeout(300)
            check("暗夜主题刷新后保持", page.eval_on_selector("html", "e=>e.dataset.uiTheme") == "darkliquid")
            switch_ui_theme("liquid")
            page.wait_for_timeout(300)

            cdn_noise = [e for e in errors if "cdn.jsdelivr.net" in e]
            real_errors = [e for e in errors if "cdn.jsdelivr.net" not in e]
            check("无 pageerror / console.error(可选 CDN 失败不计)", len(real_errors) == 0)
            browser.close()
    finally:
        server.kill()
        shutil.rmtree(data_dir, ignore_errors=True)

    print("\n==== 结果 ====")
    failed = [n for n, ok in results if not ok]
    print(f"通过 {len(results) - len(failed)}/{len(results)}")
    if errors:
        print("\n捕获错误:")
        for e in errors:
            print("  " + e)
    if failed:
        print("失败项:")
        for n in failed:
            print("  - " + n)
        sys.exit(1)
    print("全部通过 ✅")


if __name__ == "__main__":
    main()
