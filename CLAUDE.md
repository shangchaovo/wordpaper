# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

WordPaper（原「每日壁纸」）— 把每日单词 + 当天提醒做成手机/电脑壁纸的多用户 Web 工具。浏览器仍是无构建的经典脚本 + canvas；`server.js` 同时提供账号认证、同源 API 和 SQLite 持久化。localStorage 只是按用户分区的缓存，服务端数据库才是权威数据源。

**V3 现状**（2026-08）：12 个内置词库（2 日语 JLPT 开放词表 + 8 个 ECDICT 分级库每库 1500–3000 核心词 + 法语 1155 / 西语 1400 高频词）+ 我的词库；日期/时钟已从壁纸移除（更干净、更专注）；**整个排版可视化拖拽**——单词块/提醒块/自定义文字都能在预览上按住拖到任意位置；字体风格（黑/宋/楷/圆/粗黑）+ 文字颜色可选；背景可上传**自定义照片**（cover-fit + 留白 scrim 保证可读）。

## Commands

```bash
npm start                      # 开发服务器 http://localhost:8770（端口占用时直接失败，不漂移 origin）
npm test                       # 账号隔离/重启持久化/安全边界 + SRS + companion 测试
python3 scripts/e2e.py         # 端到端验证（55 项断言，自带临时数据库/账号/端口，不碰 8770）
python3 scripts/render_v3.py   # v3 渲染验证：真渲染 PNG 到 scripts/out_v3/ 并做像素级断言
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

**实时壁纸 + 防误触**（`app.js` 的 `enterLive/setupAntiTouch`）：进入后 `body.live` 隐藏控制面板、`#live-overlay` 全屏 cover-fit 画布，并 `setTimeout` 到次日 00:00:05 自动翻页（叠加 `rotateEnabled` 的间隔刷新）。`antiTouch` 开启时按住满 `antiTouchMs` 才唤出 `#live-peek`（带环形进度），短按/抬起即取消。右上角 `#btn-exit-live` 始终可达。

**桌面伴侣 `companion.js`**（Node，零依赖）：起一个静态服务器（同网站）+ macOS 上 (a) 用 `buildSVG` 生成 SVG、`sips` 转 PNG、`osascript` 设为桌面壁纸（`pushWallpaper`，定时），(b) 做一个**无边框置顶小窗**（`startPet`，显示今日单词+提醒），(c) `/ocr` 端点走 Apple Vision OCR 供网页「截图导入」。它的 `buildSVG` 独立复刻 group 版面（已移除日期/时钟；大字海报版式已于 2026-08-16 删除）。配置 `companion-config.json` 首跑自动生成。

**版面位置同步**（2026-08-17 修复「翻页/点词后布局回默认」）：`buildSVG` 现在镜像 `render.js` 的 `anchorY`/`blockTopFor`，按 `anchorWords/offWords/anchorReminders/offReminders` 摆单词块与提醒块，不再写死。这四个字段由网页 `syncCompanionLearningContext()` 经 `/pet-sync.php` 推进 `CFG`（锚点校验 top/center/bottom、偏移 clamp 后存），布局变化触发 `pushWallpaper`；网页拖拽结束也会补一次同步。没同步前 `buildSettings()` 用 `loadConfig` 的默认（center/bottom + 零偏移）。

**伴侣重启的 TCC 坑**：`osascript → System Events` 设壁纸的「自动化」权限是授给**派生伴侣的那个进程**的。所以重启伴侣必须走 server 的 `/companion/start`（server 是用户已授权的 launchd 上下文）；**千万别从临时 shell `node companion.js` 直接起**——那样责任进程变成终端/claude，没授权会弹 TCC 同意框并把 System Events 的 AppleEvent 队列堵死（报 `-1712` 超时），壁纸设不动。已在 `/companion/start` 验证可正常 `desktop wallpaper updated`。

**小窗为什么不用 WKWebView**：实测 WKWebView 会吞掉鼠标事件，`movableByWindowBackground` / 盖透明把手都拖不动窗口（也踩过本机 JXA `ObjC.registerSubclass` 的 protocol 崩溃坑）。所以小窗改成 `buildPetSVG` 把卡片渲成 SVG → `rasterizeSVG`(sips) 出 PNG → JXA 里 `registerSubclass` 一个 `DWGrip`：**自定义拖动**（`mouseDown:/mouseDragged:/mouseUp:` + `NSEvent.mouseLocation` + `setFrameOrigin`，按住任意位置即拖，右上角 ✕ 区域则 `orderOut` + `terminate` 关闭小窗并写 `pet-closed` 标记），`drawRect:` 把 PNG 画出来。位置每 3s 存 `pet-position.json`，重启留在原位；`pet-closed` 在伴侣启动时清掉，所以**重启伴侣即可恢复小窗**。

**桌面小词灵首轮**：`companion-state.json` 的 `petGroup` 保存当前封闭词组及其已点词。点击词卡只做一次**首轮学习**：该词立即从小窗移除，不以新词补位；整组清空后，才从未首轮学习过的词里自动生成下一组。事件通过 `/pet-memory-events.json` 传给网页记忆本。`bump` 与 `/next.php`/`/prev.php` 仍只用于手动换壁纸/全局热键，不干扰小词灵的首轮进度。小词灵右下角保持圆形缩放把手，空白处可拖动。

**宠物可拉伸 / 自适应形状**：宠物窗口右下角有圆形缩放把手（`PET_RESIZE`）；拖动时实时重渲，松手把尺寸存进 `state.petSize`。词卡数每次变化会重建透明小窗，使原生命中网格与当前剩余词数一致。`buildPetSVG` 按 `W/H` 比例（`petMode()`）自动切换排列：`tall`（≤0.75）= 逐行堆叠、`square`（0.75–1.5）= 两列网格、`wide`（≥1.5）= 自适应多行网格。尺寸范围 `MIN_PET_W/H`–`MAX_PET`。

**一键启用（仅 local 模式）**：网页 POST `/companion/start` 后，主服务要求请求来自「这台机器自己」（`isSameMachineRequest`：回环或本机网卡 IP）。**同机多账号共享**（2026-08-17 起）：伴侣驱动的是这台 Mac 的桌面（物理共享资源），任何登录账号在本机都能启用/控制它，不再有「切换账号」；用户间数据隔离不受影响——settings/review 等服务端状态仍按账号分命名空间，共享的只是「桌面显示什么」。`companion_owner_user_id` 仍记录首个使用者（仅信息，不再是闸门）。`public` 模式绝不在云主机 probe/spawn 8771，端点返回 404；公网用户需在自己的 Mac 安装伴侣。主 server 的 companion 端口来自 `WORDPAPER_COMPANION_PORT`，不再与应用端口自动漂移冲突。

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
- **图标体系**（2026-08-17 起，告别"单字当图标"）：`index.html` `<body>` 开头有一个隐藏的 SVG sprite，所有图标是 24×24 线性 `<symbol id="i-…">`（fill:none + stroke:currentColor，**自动跟随三个界面主题着色**）。引用统一为 `<svg class="ic"><use href="#i-…"/></svg>`，尺寸由 CSS 按容器定（`.h-emoji .ic` 15px / `.lib-icon .ic` 16px / `.it-icon .ic` 24px）。**加新图标 = sprite 里加一个 `<symbol>` + 引用一行**；词库图标在 `LIBRARIES[].icon` 填键名。日语两库用鸟居/樱花、初中书包、高中博士帽、四级考卷、六级奖章、考研登顶旗、雅思地球、托福纸飞机、GRE 灯泡、我的词库文件夹+。模块标题（含弹窗标题）也都走这套，不再用汉字或 emoji。
- **改提醒呈现**：`render.js` 的 `drawReminders` + `remindersHeight` 要**一起改**（预估高度必须与实际逐行高度一致，否则吸底错位）。

## 验证矩阵

`scripts/e2e.py`（55 项）覆盖主路径 + v3 控件存在性 + 完整可迁移伴侣 zip + 一键启用端点 + 记忆复习（SRS）；`scripts/render_v3.py`（7 项）真渲染 PNG 并做像素级断言（字体栈写入、文字颜色持久化、背景照片铺满且非主题色、**锚点真的移动单词块**、自定义文字拖拽位置持久化、海报+楷体）。账号/隔离/重启/静态目录安全另由 `scripts/test_server.js` 与 `scripts/test_accounts_browser.py` 覆盖。

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
