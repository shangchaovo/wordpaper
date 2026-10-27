# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

WordPaper（原「每日壁纸」）— 把每日单词 + 当天提醒做成**电脑桌面**壁纸的多用户 Web 工具（不面向手机：尺寸档只有桌面/平板，默认 1920×1080）。浏览器仍是无构建的经典脚本 + canvas；`server.js` 同时提供账号认证、同源 API 和 SQLite 持久化。localStorage 只是按用户分区的缓存，服务端数据库才是权威数据源。

**V3 现状**（2026-08）：12 个内置词库（2 日语 JLPT 开放词表 + 8 个 ECDICT 分级库每库 1500–3000 核心词 + 法语 1155 / 西语 1400 高频词）+ 我的词库；日期/时钟已从壁纸移除（更干净、更专注）；**整个排版可视化拖拽**——单词块/提醒块/自定义文字都能在预览上按住拖到任意位置；字体风格（黑/宋/楷/圆/粗黑）+ 文字颜色可选；界面主题 4 个（糖果/校样/Liquid/暗夜），壁纸「墨璃」暗色玻璃配色与暗夜界面联动；背景可上传**自定义照片**（cover-fit + 留白 scrim 保证可读）。

**小词灵 2.0（2026-10，v2.5.0）——两种形态**：
- **词卡形态**（原 card）：SVG 渲 PNG 的学习卡，点词记首轮，见下文「桌面伴侣 companion.js」各节。
- **派大星形态**（patrick）：透明无边框 JXA 小窗 + 精灵图状态机。资产 `assets/patrick/sheet.png`(+flip) 由 `scripts/build_patrick_sheet.py` 从源精灵图重切（6×4 帧，FRAME_MAP 与 `companion.js` 的 `PATRICK_FRAME` 必须同步）。50ms tick 驱动 idle(眨眼/张望)/walk(8 帧循环走向随机目标)/hover(挥手+气泡)/jump/drag/quiz 状态机；`petRoam`/`petRoamInterval` 可关散步。**JXA 三个坑**：registerSubclass 返回值不可用要 `$类名.alloc`；JXA 没有 setTimeout（用 tick 时间戳）；窗口必须显式 `win.orderFrontRegardless` 否则进程活着但永不上屏。
- **本地 TTS**：`say`（Samantha en / Tingting zh）+ `afplay`，`ttsEnqueue` 串行队列 24 条上限。**抽查期间有硬锁**：`patrickQuizState` 存在时 `ttsEnqueue` 只放行卡上被考的那个词，其余一律丢弃；出题调 `ttsStopNow()`（SIGKILL 在播的 afplay/edge-tts + 换代际作废排队中的合成）；播放由派大星窗在卡片滑入停稳后 POST `/pet-quiz-shown.php` 触发，音频经 `ttsPrewarm` 预合成到 `RUNTIME_ROOT/tts-cache/`（sha1(语音|语速|文本) 为键）以便零延迟出声；作答只放对/错音效、不念词。**只朗读屏幕上看得见的文本**：`ttsEnqueue` 用 `displayedSpeechTexts()` 守卫——当前页 6 个词 + 各自英文例句 + 屏上卡片（抽查/朗读/回答卡）印着的词；不在集合里的一律丢弃并记日志（这就是「幽灵单词朗读」的修复）。调用方可用 `opts.allow` 显式放行屏上文字，`scope:'ui'` 放行 `Nice!/Oops.` 这类反馈词。答题反馈只读英文，不读中文释义。例句来自 `data/examples_*.json`（`scripts/build_examples.py` 用 macOS 词典服务 DCSCopyTextDefinition 经 ctypes 预生成，词典头行要过滤、只留 ▸ 后的例句）。
- **桌面抽查**：网页 45s 把 SRS 到期词推 `/pet-quiz.php`（90s 节流）→ 派大星弹 4 选 1 卡（quiz 子窗点行作答）→ 事件流 `action:'quiz'` 带回 → 网页 `Review.reviewWord` 同一条艾宾浩斯链。offer 需要 patrick 形态；TEST_MODE 放行 gate 供端点测试。
- **形态切换**：`CFG.petMode`('card'|'patrick')，入口 = 词卡 ⭐ / 网页下拉 / 菜单栏 / `/pet-mode.php`。切换与窗口重建同步（同步 POST 返回时旧窗才消失，不闪屏）。

## Commands

```bash
npm start                      # 开发服务器 http://localhost:8770（端口占用时直接失败，不漂移 origin）
npm test                       # 账号隔离/重启持久化/安全边界 + SRS + companion 测试
python3 scripts/e2e.py         # 端到端验证（73 项断言，自带临时数据库/账号/端口，不碰 8770）
python3 scripts/render_v3.py   # v3 渲染验证：真渲染 PNG 到 scripts/out_v3/ 并做像素级断言
python3 scripts/build_patrick_sheet.py  # 从源精灵图重切 assets/patrick/（换派大星皮肤时用）
python3 scripts/build_examples.py       # 用 macOS 词典服务重生成 data/examples_*.json（重建词库后跑）
python3 scripts/build_wordlibs.py  # 从 ECDICT 重新生成 data/words_*.json（需 /tmp/ecdict.csv）
```

- **没有前端构建器，也没有第三方 npm 运行依赖**。`js/` 是浏览器经典脚本（IIFE）；`package.json` 只提供启动/测试入口并约束 Node 22.23.2+ / 24（需要内置 `node:sqlite`）。
- `scripts/e2e.py` 自包含：在**临时空闲端口**拉起自己的 `server.js`，跑完即杀。首次需 `pip install playwright && playwright install chromium`。末尾断言无 `pageerror` / `console.error`。
- 常驻（可选）：`cp launchd/com.daily-wallpaper.server.plist ~/Library/LaunchAgents/ && launchctl load -w ...`（推荐直接用 `scripts/install_macos_service.sh`，它从模板生成并注册 `com.wordpaper.server`）

**开机自启（Wallpaper-Engine 式，2026-08-24）**：plist 注入 `WORDPAPER_COMPANION_AUTOSTART=1` 时，server（local 模式）监听后 3s 自动派生 companion，并每 60s 看门狗探活重拉（`ensureCompanionRunning`）。自动派生走与手动 `/companion/start` 完全相同的 server→companion 链，TCC 授权继续有效；**不要给 companion 单独建 LaunchAgent**（责任进程变更会重新弹 TCC 授权）。自启派生带 `WORDPAPER_COMPANION_SILENT=1`，companion 跳过 `open` 浏览器（对应 WE 的 `-silent`）。整机开关：`companion-config.json` 的 `"autoStart": false`（server 每次探活前实时读，无需重启）。dev/e2e 没有该环境变量，不会误起伴侣。

## Architecture — 跨文件才看得懂的点

**运行时模型**：无打包器、无 ESM。`index.html` 按固定顺序加载
`store → words → importer → ocr → reminders → review → render → engine → app`；
每个文件是 IIFE，向外暴露一个具名全局（`Store / Words / Importer / OCR / Reminders / Review / Render / Engine / App`），彼此直接读全局。**改加载顺序或把某文件改成 ESM 会破坏这条链。** SheetJS（Excel 导入）走 CDN `defer`，是**可选**的——没有它 CSV/粘贴导入照常工作。

**核心数据流**：`app.js` 的 `refresh(manual)` 是唯一渲染入口。它向 `Engine.current(settings)`（或手动时 `Engine.reshuffle`）要「当前该显示哪些词」，拿到 `{dateStr, words}` 后交给 `Render.render({width,height,layout,page,theme,words,reminders,settings,dateStr})` 画到一个离屏 canvas，再 `drawImage` 进 `#preview-canvas`（预览）和 `#live-canvas`（实时模式）。**任何设置变更都走 `commit()` → `saveSettings()` + `refresh()`，别绕过它单独重画。**

**每日选词的确定性**（`words.js`）：`pickForDate(list, count, dateStr, order)` 用日期字符串做种子（FNV 哈希 + mulberry32 PRNG），所以**同一天无论哪台设备、刷新多少次，得到的是同一组词**。`sequential` 按 epoch 天偏移顺序切片，`random` 按种子洗牌。想加新选词模式，保持「同日同结果」这条不变量。`engine.js` 的定时轮换把一天按 `rotateMinutes` 切成 bucket，每个 bucket 一个种子，因此**轮换间隔内稳定、跨间隔自动前进**。

**canvas 渲染的版面**（`render.js` v3）：
- **背景**：`settings.bgImage`（解码后的 `Image`，由 app.js 注入，**不存进 settings 对象**——settings 里只存 dataURL 字符串）存在时 cover-fit 铺照片 + 浅 scrim；否则走主题渐变 + 纹理。
- **文字**：`fontStack(settings)` 选系统字体族（hei/song/kai/yuan/heiti），`ink()/subInk()` 解析正文/次要颜色（`settings.inkOverride` 覆盖主题色）。**只用本地系统字体栈，不引网络字体**（否则下载的 PNG 换机器会变样）。
- **单词组 `renderGroup`**：行高 `rowH` 按**内容**定（≈ `wordFs*3.0`），不强制填满整条自由带——所以单词块比自由空间小，**锚点（靠上/居中/靠下）+ 拖拽偏移才能真正移动它**。行高够高时单词+释义堆叠，不够时（横屏/词多）自动单行横排。`blockTopFor(anchor, offY, top, bottom, blockH, H)` 把「锚点基准 + 分数偏移」解析成最终 Y。
- **提醒块**：`remindersHeight()` 预估高度，同样走 `blockTopFor` + `offReminders`，可与单词块各自独立摆。
- **自定义文字 `drawCustomBlocks`**：title/footer 是**自由浮动块**，位置存 `settings.custom.pos[key] = {x, y, scale}`（0..1 分数），居中绘制在该点。
- 新增会被画出来的字段，空值时要跳过（词库 schema 本就省略空字段）。

**可视化拖拽**（`app.js` 的 `bindDrag`/`hitTestBlock`）：`pointerdown` 命中测试决定抓的是哪块（自定义文字优先，其次按 `remindersSplitY()` 分单词/提醒），按下即 `applyDisplaySize(disp, disp, true)` **把预览缩到视口内**（整个壁纸都在视野里，拖哪儿都看得见），`pointermove` 把位移写回 `offWords/offReminders`（分数偏移，x clamp ±0.5、y clamp ±1.0）或 `custom.pos[key]`（绝对分数位置，clamp 0.02..0.98），重画用 **rAF 合帧**（一帧只重画一次，拖拽顺滑）。拖拽期间 `dragHl={kind,key}` 传入渲染，`render.js` 的 `drawHlRect` 画主题色**虚线框**标出正在拖的块；抬起后 `dragHl` 清空、预览恢复大尺寸、`saveSettings()`。偏移都是**分数**（相对 W/H），换尺寸不漂移。`render.js` 的 `blockTopFor` 只把块钳在「至少露出一部分」的范围内，**不再限制在自由带内**——可以拖到画布任意位置（含压到提醒块上）。

**持久化**：`lib/storage.js` 使用 SQLite 的 `users / sessions / user_state`；`user_state` 主键是 `(user_id, namespace)`，路由只从 session 取 user id。`store.js` 在 `App.init()` 最前面 `await Store.init()`，把服务器状态 hydrate 到内存，随后保持原有同步 getter API；write 乐观更新并带 revision 异步 PUT。localStorage 使用 `wp:user:<id>:<key>`，旧版全局 `wp:*` 仅在首次创建账号时迁入一次。改 namespace 时必须同时改前后端 allowlist，并补 A/B 隔离测试。

**服务边界**：`server.js` 只允许静态访问 `index/login/css/js/data`，源码、`.git`、数据库和伴侣状态绝不能加入白名单。`public` 模式只开放同一个 Web/API 端口并禁用本机 companion 控制；8771 只能是 Mac 用户机器上的 loopback companion。端口占用必须 fail-fast，不能恢复自动 `+1`。
- **SIGTERM 关停必须走 `hardExit`**（2026-09-18 修复，ADR 0003）：`process.exit` 会等 libuv 线程池排空；`checkForUpdate` 直连 GitHub 的 `getaddrinfo` 在无代理/被污染网络可永不返回（`req.destroy()` 撤不掉线程池任务），会让 exit 永久阻塞、launchd 都杀不动。`hardExit` 等线程池最多 3s，否则自我 `SIGKILL`；勿改回裸 `process.exit`。

**实时壁纸 + 防误触**（`app.js` 的 `enterLive/setupAntiTouch`）：进入后 `body.live` 隐藏控制面板、`#live-overlay` 全屏 cover-fit 画布，并 `setTimeout` 到次日 00:00:05 自动翻页（叠加 `rotateEnabled` 的间隔刷新）。`antiTouch` 开启时按住满 `antiTouchMs` 才唤出 `#live-peek`（带环形进度），短按/抬起即取消。右上角 `#btn-exit-live` 始终可达。

**桌面伴侣 `companion.js`**（Node，零依赖）：起一个静态服务器（同网站）+ macOS 上 (a) 用 `buildSVG` 生成 SVG、`sips` 转 PNG、`osascript` 设为桌面壁纸（`pushWallpaper`，定时），(b) 做一个**无边框置顶小窗**（`startPet`，显示今日单词+提醒），(c) `/ocr` 端点走 Apple Vision OCR 供网页「截图导入」。它的 `buildSVG` 独立复刻 group 版面（已移除日期/时钟；大字海报版式已于 2026-08-16 删除）。配置 `companion-config.json` 首跑自动生成。

**版面位置同步**（2026-08-17 修复「翻页/点词后布局回默认」）：`buildSVG` 现在镜像 `render.js` 的 `anchorY`/`blockTopFor`，按 `anchorWords/offWords/anchorReminders/offReminders` 摆单词块与提醒块，不再写死。这四个字段由网页 `syncCompanionLearningContext()` 经 `/pet-sync.php` 推进 `CFG`（锚点校验 top/center/bottom、偏移 clamp 后存），布局变化触发 `pushWallpaper`；网页拖拽结束也会补一次同步。没同步前 `buildSettings()` 用 `loadConfig` 的默认（center/bottom + 零偏移）。

**伴侣重启的 TCC 坑**：`osascript → System Events` 设壁纸的「自动化」权限是授给**派生伴侣的那个进程**的。所以重启伴侣必须走 server 的 `/companion/start`（server 是用户已授权的 launchd 上下文）；**千万别从临时 shell `node companion.js` 直接起**——那样责任进程变成终端/claude，没授权会弹 TCC 同意框并把 System Events 的 AppleEvent 队列堵死（报 `-1712` 超时），壁纸设不动。已在 `/companion/start` 验证可正常 `desktop wallpaper updated`。

**小窗为什么不用 WKWebView**：实测 WKWebView 会吞掉鼠标事件，`movableByWindowBackground` / 盖透明把手都拖不动窗口（也踩过本机 JXA `ObjC.registerSubclass` 的 protocol 崩溃坑）。所以小窗改成 `buildPetSVG` 把卡片渲成 SVG → `rasterizeSVG`(sips) 出 PNG → JXA 里 `registerSubclass` 一个 `DWGrip`：**自定义拖动**（`mouseDown:/mouseDragged:/mouseUp:` + `NSEvent.mouseLocation` + `setFrameOrigin`，按住任意位置即拖，右上角 ✕ 区域则 `orderOut` + `terminate` 关闭小窗并写 `pet-closed` 标记），`drawRect:` 把 PNG 画出来。位置每 3s 存 `pet-position.json`，重启留在原位；`pet-closed` 在伴侣启动时清掉，所以**重启伴侣即可恢复小窗**。

**桌面小词灵首轮**：`companion-state.json` 的 `petGroup` 保存当前封闭词组及其已点词。点击词卡只做一次**首轮学习**：该词立即从小窗移除，不以新词补位；整组清空后，才从未首轮学习过的词里自动生成下一组。事件通过 `/pet-memory-events.json` 传给网页记忆本。`bump` 与 `/next.php`/`/prev.php` 仍只用于手动换壁纸/全局热键，不干扰小词灵的首轮进度。小词灵右下角保持圆形缩放把手，空白处可拖动。

**宠物可拉伸 / 自适应形状**：宠物窗口右下角有圆形缩放把手（`PET_RESIZE`）；拖动时实时重渲，松手把尺寸存进 `state.petSize`。词卡数每次变化会重建透明小窗，使原生命中网格与当前剩余词数一致。`buildPetSVG` 按 `W/H` 比例（`petMode()`）自动切换排列：`tall`（≤0.75）= 逐行堆叠、`square`（0.75–1.5）= 两列网格、`wide`（≥1.5）= 自适应多行网格。尺寸范围 `MIN_PET_W/H`–`MAX_PET`。

**一键启用（仅 local 模式）**：网页 POST `/companion/start` 后，主服务要求请求来自「这台机器自己」（`isSameMachineRequest`：回环或本机网卡 IP）。**同机多账号共享**（2026-08-17 起）：伴侣驱动的是这台 Mac 的桌面（物理共享资源），任何登录账号在本机都能启用/控制它，不再有「切换账号」；用户间数据隔离不受影响——settings/review 等服务端状态仍按账号分命名空间，共享的只是「桌面显示什么」。`companion_owner_user_id` 仍记录首个使用者（仅信息，不再是闸门）。`public` 模式绝不在云主机 probe/spawn 8771，端点返回 404；公网用户需在自己的 Mac 安装伴侣。主 server 的 companion 端口来自 `WORDPAPER_COMPANION_PORT`，不再与应用端口自动漂移冲突。

**AI 对话浮窗**（`pet-chat.html`，v2.5.1）：点击派大星 → `/pet-chat-window.php?action=toggle` → 伴侣 spawn 一个 JXA 进程，**用 WKWebView 加载 `http://127.0.0.1:<port>/pet-chat.html`**。原生 NSTextField 路线已被证伪：launchd 派生的 osascript 拿不到输入法（`IMKCFRunLoopWakeUpReliable` 报错），中文根本打不进去；把 activationPolicy 改成 Regular 又会被 SIGKILL。页面 POST `/pet-chat.php`，历史存 `state.chatHistory` 并由 `/pet-chat-history.json` 回填。**`pet-chat.html` 是根目录单文件，必须同时出现在三处 payload 清单里**（`companion.js` 的 `serveStatic` 根页白名单、`scripts/package_app.py` 的 `PAYLOAD_FILES`、`lib/updater.js` 的 `PAYLOAD_FILES`），否则独立版/自更新后浮窗 404。伴侣侧 `chatWithMagpie` 按 `magpie.json` 的 `models`/`fallbackModels` 顺序尝试，429/503 自动换下一个模型，其它错误经 `magpieErrorText()` 翻成人话回给浮窗（之前全被吞成 `empty`）。

**v2.4.5→2.4.7 的坑（新功能必须规避）**：① 任何渲染到 `/tmp` 的产物都要带 `process.pid`——sips 异步、并发写同一文件会留半张空白图，两个实例还会互相覆盖（2.4.6 修过，卡片走 `CARD_PNG`）；② 宠物派生的所有窗口必须在 `stopPetAll()` 里一起收掉，否则隐藏宠物后浮窗变成幽灵窗；③ 状态开关不要无条件写时间戳（`stopSentenceWindow()` 曾因此让切形态卡住抽查 2.5s）。另外 v2.4.6 的更新失败保活 / 菜单栏 5s 状态同步与 10s 重拉 / 启动器端口复用+互斥锁、v2.4.7 的动效、ADR 0003 的 `hardExit`、端口 fail-fast 都已复核有效，改动这些区域时要跑 `npm test` + `npm run test:motion` + `python3 scripts/test_{launcher,native_lifecycle,package_update}.py`。

**绝不可以在绘制期改窗口**（v2.5.17）：气泡窗懒创建 + 在 `drawBubble()` 期间 `orderFrontRegardless` → AppKit `_crashOnException` → **SIGTRAP**，派大星一启动就崩。所有子窗必须在启动时建好（隐藏），悬停只 `orderFrontRegardless`；尺寸变化先 `orderOut` → 改 frame → 再显示。`drawRect:` 内只贴图 + try/catch。另：JXA 桥**没有 `setFrame`**，要用 `setFrameDisplay`。

**悬停状态气泡是 SVG 渲染卡**（v2.5.16）：伴侣侧 `buildStatusBubbleSVG()`（与抽查卡同配色）→ `sips` → `/tmp/dw_status_bubble-<pid>.png` → 派大星子窗按 mtime 轮询换图。倒计时带艾宾浩斯进度条（stage/8）。触发：`scheduleStatusBubble()`（`bumpPetWordEpoch`/SRS 写回后 2s）+ 5 分钟兜底（dueInMs 文本会过期）。`currentWordStatus()` 与 `/pet-word-status.json` 共用一套分类逻辑。

**悬停气泡必须在独立窗口里画**（v2.5.15）：派大星窗口只有 190×206，气泡(宽可达 340、锚窗口顶)画在 `drawRect` 里会被整个裁掉——这就是「气泡不显示」的根因（旧词卡窗口大所以以前看得见）。气泡走 `bubbleWin`（borderless 子窗，锚派大星头顶上方，`layoutBubbleWin()` 在拖动/走路 tick 里跟随）。`mouseEntered` 事件本身没问题（最小复现已验证 tracking area 正常）。

**新词 vs 倒计时词区分**（v2.5.13）：`GET /pet-word-status.json` 按 SRS 库给桌面当前页每个词标 `new/countdown/due/mastered`（键 = word 小写）。派大星悬停气泡（每 60s 拉一次缓存）分三段展示：❗ 该复习 / ⏳ 第 N 轮剩多久 / 🆕 还没背。注意 hover 气泡曾断线（`showHoverBubble` 无人调用），由 `st.hoverBubbleAt` 在 tick 里到点触发。

**抽查与桌面词联动**（v2.5.12）：`offerQuiz` 优先从 `petFirstPassWords()`（桌面/小词灵当前页）过滤到期词，屏上的问完才退回全量；`answerQuiz` 作答后把该词从当前页**原位换成新词**（与 `completePetFirstPass` 同一套补位），并 `pushPatrickCmd({cmd:'words'})` + `syncWallpaperToPet()`。注意 petWordKey 是 `word|meaning`——测试里伪造的 word 对象 meaning 必须与页面词一致，否则 findIndex 不中。忘了的词 20 分钟后回来考时它已不在屏上，自然落入全量池。

**srsDueWords 的 stage/due 在 item 上**（v2.5.20 踩过）：它返回 `{key, item}`，`item.word` 只是词条，**`stage`/`due` 在 `item` 本身**。只取 `item.word` 会把所有词判成新词、复习到期永远排不上队。传下去时要 `Object.assign({}, item.word, {stage, due})`。

**复习到期抢占**（v2.5.20）：`autoQuizTick` 每 15s 检查——当前挂着新词卡且有复习到期词时，撤卡换复习题（仅 `pickedIndex < 0` 未作答时抢占）。卡片小旗标「⏰ 复习到期」/「🆕 桌面新词」，复习类附「第 N/8 轮 · X 后复习」。

**出题优先级**（v2.5.19）：① 艾宾浩斯复习到期（`stage>0` 或 `due<=now`）**插队**优先；② 桌面当前页的新词；③ 其它到期词。气泡按类型标注「⏰ 该复习了」/「📖 学新词」。

**到期即出题**（v2.5.18）：`autoQuizTick` 查到到期词就**立刻** `offerQuiz`——之前有 300s 节流，423 个到期词也要等 5 分钟才出一道。节流现在只控制「无到期词时」的空转（15s 轮询）。作答停留 `QUIZ_RESULT_DWELL_MS = 4500`。题目上屏时 push `bubble`「⏰ 到点啦」+ `playSfx('correct')` 做播报。

**抽查排队机制**（v2.5.3）：`quizBusyReason()` 判定「用户正忙」——已有题在答 / 作答后卡片停留 8s（`quizResultUntil`）/ 造句窗开着（`sentenceWinChild`）/ 刚关窗 2.5s 缓冲。忙时 `offer` 与自动抽查节拍都走 `queueQuiz()` 攒队列（只留最新一批），`flushPendingQuiz()` 在空下来时补出（由逗留计时器、关窗、`skip`、每分钟节拍触发）。卡片底部两颗按钮：左「下一个」走 `action:'skip'`（700ms 后放行），右「造个句子」弹窗——不是每个词都必须造句。`/status.json` 的 `quizQueue` 暴露 `{queued, reason, sentenceOpen, resultUntil}`。

**造句窗响应提速**（v2.5.11）：开窗次序 = 先 spawn 窗口、输入法切换（两次 osascript execFile）并行在后——次序反了会白等 0.6–1.6s。入场保底定时器 0.05s（entranceStarted 挡重复）。批改等待用骨架屏（shimmer 三行 + 按钮按压态），DeepSeek 限流重试可达数秒，必须有即时反馈。osascript 进程启动 ~500ms 是地板。

**学习进度导入**（v2.5.5）：`POST /api/import/progress`（`{payload, dryRun}`）。`normalizeImportedReview()` 认三种格式：progress JSON（`raw` 或 `words[]` 反查 library）、`wordpaper-backup` 的 `state.review`、裸 review 对象。合并规则：stage 高者胜、`due` 取更早、计数取 max、事件按 `at|type` 去重。**dryRun 时也必须照常统计**（只是不落库），否则预览永远显示 0——这是踩过的坑。镜像模式下 409 拒绝。

**多定时器竞态也是崩点**（v2.5.14）：同一窗口里多个 NSTimer（3s 存位置 + 2s 心跳）在快速开关窗口时交替重入 `$` 桥 → `objc_retain` 段错误。修法：**合并为单定时器**（位置隔次落盘），回调开头 `if (!win.isVisible) return;`——窗口关闭后完全不碰桥。

**JXA bridge 重入是 SIGSEGV 来源**（v2.5.10，排查 10 例 osascript 崩溃得出）：NSTimer 高频回调里读写 `$` 桥（`win.alphaValue`、`$.getppid()` 等）会在 `objc_retain` 上撞野指针。**入场/滑入动画一律用 `win.animator.xxx`（AppKit 在 ObjC 层插值），JS 只发一次指令**；心跳里要用的系统值（getppid）启动时取一次存 JS 变量。睡眠唤醒瞬间 `NSScreen.mainScreen` 可能为 nil——JXA 里读 `screen.origin` 会抛 TypeError，`$.NSScreen.mainScreen.frame` 判空给兜底矩形；伴侣侧对「窗口连续异常退出」做指数退避（≥3 次 1s×2^n，上限 10 分钟），否则唤醒后是崩溃风暴空转整夜。

**浮窗出场动效**（v2.5.7）：两个 WebView 窗都从派大星位置弹出——`alphaValue=0` 上屏 → 以派大星中心为锚偏移 16–18pt → `easeOutBack` 过冲回落到目标位(对话 260ms / 造句 220ms)，alpha 走 `easeOutCubic(p/0.55)` 提前拉满。**必须先等 `webView:didFinishNavigation:` 再播**，否则淡入的是空白页(保底 260ms 定时器)。派大星点击是「蓄力下沉 90ms → 弹起+挥手+请求开窗」，配 400ms 防连点。窗口尺寸 520×600(抽屉展开后主区仍 334pt)、抽屉默认 `hidden`——400 宽 + 抽屉会竖排。

**对话管理**（v2.5.5）：`state.chatSessions = [{id,title,createdAt,updatedAt,messages[]}]`，老 `state.chatHistory` 在 `chatSessions()` 里一次性迁移并删除旧字段。端点 `/pet-chat-session.php`（new/select/rename/delete/clear）与 `/pet-chat-export`（md 默认 / json，`?id=` 单个，不带导全部）。**`action:'new'` 必须真正新建会话**，只有当前会话为空时才复用——早期实现复用并清空消息，会把正在聊的内容销毁。

**数据导出**（v2.5.4）：`GET /api/export/progress?format=csv|json`，只导 `review` namespace（不含设置/凭据）。CSV 带 BOM + RFC4180 转义，列含轮次/到期/各计数。伴侣不实现业务 API，页面在 8771 时经 `proxyToMainApi()` 把 `/api/export/*` 原样透传 Cookie 到 `serverBase()`。回归锁 `scripts/test_export_progress.js`（401、BOM 字节、逗号引号转义、JSON 形状、账号隔离）。注意 `fetch().text()` 会吞 BOM，验 BOM 必须读 arrayBuffer。

**输入法切换**（v2.5.4）：造句窗自动切英文。TIS/Carbon API 走一个临时 JXA（`TIS_JXA`），**关键坑：`TISGetInputSourceProperty` 返回 CFTypeRef，必须 `ObjC.castRefToObject()` 才能 `ObjC.unwrap`/`TISSelectInputSource`**，直接对返回值调方法会得到 function。打开造句窗记下当前输入源（`imeRestoreTo`），关窗 `selectInputSource(back)` 切回；页面 focus 时 POST `/pet-ime.php?lang=en` 再确认一次。

**学习规划 + 三档作答**（v2.5.8）：`dailyPlan` namespace（`dailyGoal / learnedByDay / checkins`）由 `countDailyLearn()`（learn 事件、eventId 去重）累计，`renderPlanModule()` 画进度/打卡/14 天格子/词典通关预测（按最近 7 天日均，无数据时用 dailyGoal）。`Review.reviewWord(lib, word, grade)` 第三参数现在是三档 `'remembered'|'fuzzy'|'forgot'`（布尔兼容）——fuzzy=停留当前档、按档位一半再考。派大星考过走 `Review.markPetQuiz()`（幂等，`item.petQuiz.count/firstAt`），记忆本卡片据此显示 🐾/🆕 标注。达标庆祝：网页 `pet-celebrate.php` → `cmd:'celebrate'`（连跳 + 撒星复用 fx 粒子 + playSfx('correct')）。

**造句错题集**（v2.5.6）：批改后 `score < 5` 或 `used === false` 的句子自动进 `state.sentenceNotes`（满分不收，避免冲淡）。`kind` 判定：`used===false` → `unused`；`score<=2` → `error`；否则 `awkward`。上限 500，星标不参与淘汰。端点 `/pet-sentence-notes.json|php|-export`。UI 在 `pet-sentence.html` 的「错题集」标签页（筛选 / 收藏 / 笔记 / 删除 / 复制改法）。

**造句练习**（v2.5.2）：抽查作答后卡片底部点亮「用它造个句子」（`QUIZ_BTN_TOP/BOTTOM` 与 `buildQuizSVG` 的按钮矩形必须同步；卡高 280）。点它 → `/pet-sentence-window.php?action=open` → 另一个 WKWebView JXA 进程加载 `pet-sentence.html`，数据来自 `/pet-sentence.json`（`state.lastQuiz`，作答时写入）。提交 `POST /pet-sentence.php` → `askMagpie` 按固定 JSON 格式批改（score 1–5 / used / fixed / feedback / example），返回里 `example` 优先取 `exampleForWord()` 的词典原句、`example2` 是模型新造的一句。结果以 `action:'sentence'` 进 `petMemoryEvents`（网页只统计、不改艾宾浩斯阶段）。卡片撤除延到 8s 且造句窗开着时不撤。`pet-sentence.html` 同样要进三处 payload 清单。

**下载独立版**：对外分发走 **WordPaper.app + DMG**(`scripts/package_app.py` 一条命令出三种包)：AppleSilicon/Intel 完整包（自带 Node v24.19.0 运行时，约 44/45MB)+ Slim 国内加速版（1.6MB，首启从 npmmirror 下载运行时，SHA256 与官方 tarball 钉死一致）。启动器运行时解析顺序：包内 → `~/.wordpaper/runtime` 缓存 → 系统 Node(22–24) → 下载；测试钩子 `WORDPAPER_SELFTEST/FORCE_DOWNLOAD/SKIP_COMPANION/RUNTIME_DIR`。图标由 `scripts/make_icon.py`(favicon W 标 → Playwright → iconutil）生成，产物 `assets/icon.icns` 已入库。DMG 托管 GitHub Releases(`companion-v2.0.0`，网站下载弹窗指 `releases/latest/download/`)，因 CF Pages 单文件 ~25MiB 上限不能走静态站。App **未签名**：macOS 15+ 首次需「系统设置 → 隐私与安全性 → 仍要打开」（右键打开已被苹果移除），说明书与下载弹窗都写了指引。本地 `/companion.zip`(`serveCompanionZip` → `scripts/package_companion.py`）保留为兜底。

**主账号镜像(卫星模式)**(`lib/upstream.js`,v2.1.0):另一台 Mac 的独立版可在登录页「连接到主账号」,与主力机共用同一工作区。**pull 模型**:卫星持有上游会话(cookie+csrf 存 app_meta `upstream_pairing`),读=先 flushQueue 再 pull 覆盖本地缓存、写=在线直推上游/断网落本地+排队补推、上游 409 上游赢、上游会话过期转 `reauth`(本机缓存仍可离线)。上游账号映射为本机**影子账号**(口令哈希 `mirror$…` 永不可本地登录,FK 级联供 unpair 整棵删除)。路由:`/api/pair`(可重复调用=重新验证/换绑)、`/api/unpair`、`/api/auth/resume`(回环免密恢复本机会话)——全部仅 local 模式+回环+Origin+限流;配对后 `/api/auth/register|login` 403 让位。`/api/state` GET/PUT 在 `mirroring()` 时走代理;后台 45s 节拍收敛两端。providers 带 `paired/pairingAllowed`,登录页据此渲染「已连接卡片」或配对表单;store.js 把 `session.mirrored+upstream!=='ok'` toast 出来。**坑**:`test_server.js`/`test_oauth.js` 对 `/api/auth/providers` 做 deepEqual,加字段必须同步改断言。上游 URL：公网仅允许 https；私有网络（LAN 10/8、172.16/12、192.168/16、Tailscale CGNAT 100.64/10、`.local` mDNS、`.ts.net`、链路本地/IPv6 ULA）与回环允许 http——真实使用走私有网络，公网只做展示。

**版本与更新提示**:仓库根 `VERSION` 是唯一版本源(`package_app.py` 读它并打进 bundle);server.js 在 local 模式且存在 VERSION 时,每天与 GitHub main 的 VERSION 比对,`/api/session.update.latest` 带给页面 toast「重新下载即可更新」。独立版没有自动更新,内容/代码更新都要出新 DMG。

**两条设计纪律**：
- 壁纸正文只用本地系统字体栈（PingFang SC / Hiragino / Microsoft YaHei / Noto Sans CJK SC / Songti / Kaiti 等），**不引入网络字体**。
- 强调色/印泥红 `#B3402A` 只用于「沙·暖」主题 accent 和 `.btn.danger`，别挪作普通按钮强调（普通强调用 `#17503F`）。

## 改东西时的多文件触点

- **加一套主题**：`app.js` 的 `THEMES` 加 `{name,bg,bg2,ink,sub,accent,accentSoft,line,blob}` 一项即可（swatch 由 `renderThemeSwatches` 自动生成）。
- **加一个尺寸**：`app.js` 的 `SIZES` 加 `{w,h,label}`，`fillSizeSelect` 自动进下拉。
- **加一种字体风格**：`render.js` 的 `FONT_STACKS` 加一族，`index.html` 的 `#sel-fontstyle` 加一个 `<option>`（值 = 该键）。
- 版式:只剩单词组(group)一种(大字海报 poster 已于 2026-08-16 整体删除,含 `#layout-switch` UI/renderPoster/engine.js 词数特判/companion buildSVG 分支)。旧数据里的 layout: poster 不需要迁移,渲染分发自动落到 group。
- **加一个内置词库**：`scripts/build_wordlibs.py` 的 `CAPS`/`TAG_TO_ID`/`LIB_META` 加一项并跑一遍生成 `data/words_<id>.json`；`app.js` 的 `LIBRARIES` 加一项（`icon` 填 sprite 里的图标键，没有就先在 sprite 画一个）；e2e 的卡片总数断言 +1。
- **法语/西班牙语库走另一条管线**（2026-08-17 起）：`scripts/build_romance_libs.py`（不走 ECDICT）——收词顺序用 hermitdave/FrequencyWords（OpenSubtitles 词频），法语释义反查 CFDICT（CC BY-SA 3.0）并用「现有英语库释义里的现代汉语词」白名单过滤文言/方言头词，西语释义直接用 X2CNDICT 西汉词典；两库的高频功能词/不规则动词都在脚本里的 `FR_OVERRIDES`/`ES_OVERRIDES` 人工校对，变位形式进 `*_SKIP`（词卡背原形，不背变位）。改释义优先级：先改 OVERRIDES 再重建，别手改 JSON。
- **图标体系**（2026-08-17 起，告别"单字当图标"）：`index.html` `<body>` 开头有一个隐藏的 SVG sprite，所有图标是 24×24 线性 `<symbol id="i-…">`（fill:none + stroke:currentColor，**自动跟随界面主题着色**）。引用统一为 `<svg class="ic"><use href="#i-…"/></svg>`，尺寸由 CSS 按容器定（`.h-emoji .ic` 15px / `.lib-icon .ic` 16px / `.it-icon .ic` 24px）。**加新图标 = sprite 里加一个 `<symbol>` + 引用一行**；词库图标在 `LIBRARIES[].icon` 填键名。日语两库用鸟居/樱花、初中书包、高中博士帽、四级考卷、六级奖章、考研登顶旗、雅思地球、托福纸飞机、GRE 灯泡、我的词库文件夹+。模块标题（含弹窗标题）也都走这套，不再用汉字或 emoji。
- **改提醒呈现**：`render.js` 的 `drawReminders` + `remindersHeight` 要**一起改**（预估高度必须与实际逐行高度一致，否则吸底错位）。

## 验证矩阵

`scripts/e2e.py`（73 项）覆盖主路径 + v3 控件存在性 + 完整可迁移伴侣 zip + 一键启用端点 + 记忆复习（SRS）；`scripts/render_v3.py`（9 项）真渲染 PNG 并做像素级断言（字体栈写入、文字颜色持久化、背景照片铺满且非主题色、**锚点真的移动单词块**、自定义文字拖拽位置持久化、海报+楷体、**墨璃深夜壁纸**）。账号/隔离/重启/静态目录安全另由 `scripts/test_server.js` 与 `scripts/test_accounts_browser.py` 覆盖。

## 模块整理

顶部「↕️ 整理模块」进入有序拖放模式。可移动模块由 `MODULE_DEFAULTS`（`app.js`）定义：词库、提醒、记忆复习、自动轮换、版式外观、自定义文字。拖拽把手只能将卡片插入左/右面板的纵向槽位，保证统一间距与列对齐；布局以 `moduleLayout` namespace 保存（本地镜像为 `wp:user:<id>:moduleLayout`），恢复默认会重建该顺序。预览画布固定居中，避免主工作区失去稳定性。

**拖拽要平滑**（2026-08-17 重写）：别在 mousemove 里把被拖卡真实插回 DOM + 对每张卡 `getBoundingClientRect`（整列每帧 reflow、卡片只 teleport 不跟手 → 很卡）。现在是「浮动拖拽」：`startModuleFloatDrag` 起拖时卡片 `position:fixed` 跟指针走（`transform` 合成，不触发 reflow），原位插一个同高 `.module-placeholder` 虚线块顶住防塌陷；`stepModuleFloatDrag` 每帧 rAF 只算一次落点，占位块要移位时 `flipMovePlaceholder` 用 FLIP 让其它卡平滑让位；松手 `dropModuleFloatDrag` 把卡插到占位块处并保存。

**隐藏 / 恢复模块**（2026-08-17）：有些功能不是每个用户都需要，全堆在侧栏太乱。整理模式下每张 `.module-card`（含 `module-typography`/`module-desktop` 这两个不在 `MODULE_DEFAULTS` 排序集里的）右上角注入「✕」隐藏按钮，被隐藏的模块加 `.module-hidden`（`display:none`），收进左栏顶部的 `#module-tray` 恢复托盘，点「+」一键还原。隐藏集合存 `hiddenModules` namespace（前后端 allowlist 都已注册）。隐藏只是不显示，不影响该模块背后的设置/逻辑；隐藏按钮只在 `body.layout-editing` 时出现，托盘只在整理模式且有隐藏模块时显示。details 卡的按钮要放进 `summary`（否则收起时被一并隐藏），section 卡直接挂到卡片（`.card` 是 `position:relative`）。

## 记忆复习（艾宾浩斯 SRS）

`review.js` 是**按「单词」做的间隔重复**。只有桌面小词灵的词卡点击会调用 `Review.rememberWord(lib, word)` 建立记录（`stage=0`，20 分钟后首次到期）；壁纸预览点击只用于选中样式。到期后在「📖 艾宾浩斯记忆本」再次确认，才会推进下一档。间隔（分钟）：`[20, 60, 540, 1440, 2880, 4320, 8640, 17280]` = 20分钟/1小时/9小时/1天/2天/3天/6天/15天，走完 8 档即「记牢」。

- **状态**：账号的 `review` namespace，按词库分桶 `{[libId]:{words:{[word|meaning]:{word,learnedAt,stage,due,learnedCount,reviewCount,events}}}}`；本地仅缓存为 `wp:user:<id>:review`，旧的 `groups` 数据会在读取时兼容迁移。
- **UI**：`index.html` 的「🧠 记忆复习」卡片（`#chk-srs` / `#srs-status` / `#btn-open-memory` / `#srs-countdown`）只提供状态与唯一入口。记忆本中未确认的中文释义使用遮盖条；用户点击到期词卡后才显示。`updateSrsUI()` 做边沿提醒，`startSrsTicker()` 每 30 秒刷新。
- **我的词库（custom）同样参与轮换**：网页通过 `/pet-sync.php` 原子同步自定义词条，伴侣与记忆本都按 `custom` 独立分桶。
- **联动桌面小词灵**：伴侣的 `/remember.php?i=n&key=...` 只记录首轮点击；已点词会立刻移出当前页并自动补位，实体「上一页 / 下一页」用于切换首轮词页。网页轮询 `/pet-memory-events.json`，用流 ID、游标和快照补偿把首次记录幂等写入同一词书的 `Review`。后续复习只在网页记忆本通过「还没记住 / 记住了」确认，直到所有周期结束才标记为已巩固；小词灵始终展示释义，记忆本在作答后持续显示中文至本次关闭。
- 开关存 `settings.srsEnabled`（默认 true）。
