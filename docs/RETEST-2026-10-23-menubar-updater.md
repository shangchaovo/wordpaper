# WordPaper v2.4.5 回测与交接复核

> 本文记录修复前基线。后续已按用户要求修复下述主要缺口；最新结果见 [修复交接](FIX-HANDOFF-2026-10-23.md)。下文的失败与“没有修改产品代码”仅描述首次审查阶段。

日期：2026-10-23（UTC+8）。审查基线：`b1f5ec7`，实现范围 `0afe671..9ba709e`。检查了用户粘贴的会话记录及完整原 handoff。环境 Node 22.23.2、macOS、Python 3.13。

**结论：常规网页功能基本通过；菜单栏更新、更新结果恢复和原生孤儿进程回收仍有明确缺口，不能按原 handoff 的“全部完成、全绿”验收。**

本次没有修改产品代码、提交、推送、发布或更新 `/Applications/WordPaper.app`。只增加本报告和回测证据。只读检查发现：仓库/本地 DMG 是 **2.4.5**，已安装 App 的 Resources/VERSION 仍是 **2.4.4**。

外盘已经挂载，UUID 为 `2AA45A36-F3AF-4818-BD38-BF9A293ABBA9`。本项目实际仍是 `/Users/xieshangchao/daily-wallpaper` 的目录，并非外盘符号链接；依照既有项目路径规则未迁移。

## 验证结果

| 验证 | 结果 | 实际覆盖范围 |
|---|---|---|
| `npm test` | **失败，exit 1** | 账号、持久化、OAuth、SRS、伴侣学习、配对、菜单 API、updater 单测、更新 API、记忆本滚动均跑过；最后 Node 执行 `.py` 报错 |
| `python3 scripts/e2e.py` | **73/73** | 网页主流程；可选 SheetJS CDN 连接失败被测试显式排除 |
| `python3 scripts/render_v3.py` | **9/9** | 真实画布渲染、字体、背景、偏移、自定义文字和深色主题 |
| `node scripts/test_companion_layout.js` | **通过** | SVG 单词 Y 中位 632.26→850.26，最小 X 115→307 |
| `python3 scripts/test_assets_static.py` | **单独补跑通过** | 仓库服务 favicon=200，icns=404，目录穿越=404 |
| 非 TEST_MODE 原生冒烟 | **部分通过** | 临时主服务通过 `/companion/start` 派生伴侣；pet/menuBar 为 true；隐藏、召回正常 |
| 强杀伴侣后孤儿退出 | **失败，重复两次** | 分别等 24 秒、35 秒，菜单栏和小词灵 osascript 仍存在；第二次确认 PPID=1、STAT=S，非僵尸 |
| 更新失败生命周期 | **失败，重复两次** | 注入安装前下载失败；请求先返回 started，约 1.2 秒后 server 退出，未写重启旗标 |
| 网页成功更新后的恢复 | **失败，两个场景** | 快速重启/一次断线后恢复，均不刷新，最终误报“更新卡住” |
| 壁纸锁 | **通过所测分支** | 活持有者拒绝、死持有者接管、释放；不代表已保证单实例 |
| 3 个现有 DMG 只读检查 | **源码/清单通过，资源缺项** | 镜像校验、2.4.5、39 个 payload 文件一致、内部清单摘要、双架构 stub；全部缺 assets/favicon-32.png |
| 真实 hdiutil + rsync 安装 | **核心替换通过，元数据缺项** | 临时 App 2.4.4→2.4.5，写出正确旗标；manifest 仍是旧版，launcher 保留旧内容 |
| 启动器端口选择 | **未复用已有端口** | 保存端口 56122 已监听时，实际选择 8776，后续版本闸门不会探测原端口 |

日志及隔离探针位于 [audits/2026-10-23-menubar](audits/2026-10-23-menubar)。原生探针会短暂显示测试窗口，但关闭了自动壁纸和热键；数据、配置、渲染临时目录、Node home 路径均独立。测试结束只清理测试自己创建的 PID。

## 必须优先修复

### 1. P1：菜单栏没有初始“检查更新”入口

位置：`companion.js:1493`、`companion.js:1437`。

初始 `updateState` 没有 `current`。生成菜单时只有 `u.current` 为真才加“检查更新”；而填充 `current` 又只能由 `update-check` 命令触发。没有启动查询或定时同步打破这个循环。即使主服务已经检查到新版本，伴侣状态也不会自动更新。

使用真实服务返回的初始状态运行源码菜单生成片段，得到五个入口：隐藏小词灵、换一组词、记忆复习本、打开控制面板、退出。**没有检查更新，也没有一键更新。** 原生状态与源码探针一致。另一个问题：即便外部调用接口检查过，`checked=true` 时检查入口变成无 action 的“已是最新”，不能再次检查。

建议：初始化 `current=BUNDLED_VERSION`；独立版始终保留可点击的检查更新项；启动时同步主服务更新状态，并对检查失败和“确认为最新”分别展示。补从全新状态生成菜单、一次检查后仍可再次检查的测试。

证据：`wordpaper-codex-ui.log`、`wordpaper-codex-native-repeat.log`。

### 2. P1：更新失败仍会退出整个 App

位置：`server.js:1130–1140`；网页 `/api/update/apply` 在 `server.js:1084–1098` 也有同样问题，后者是原有缺陷。

`applyUpdate().then(success).catch(error).then(shutdown)` 中，catch 处理完后 Promise 恢复为 fulfilled，最后的 shutdown 无论成败都会执行。下载失败、校验失败或 rsync 失败都可能导致服务被关闭。失败时 updater 没写 `update-pending.json`，launcher 无从自动重启。

隔离进程注入安装前失败，得到：`started:true` → server exit code 0 → `restart_flag:false`。这不是网络推测，失败分支已经实际跑通两次。

建议：只在成功回调内安排 shutdown；失败保留服务和错误状态，允许重试；网页和菜单栏使用同一份安装状态机，避免复制分支后再次不一致。

证据：`wordpaper-codex-native.log`、`wordpaper-codex-native-repeat.log`。

### 3. P1：新版已上线，网页仍会误报更新卡住

位置：`js/app.js:2547–2583`。

成功版本检查只写在 fetch 抛错的 catch 内。主服务恢复后，`/api/update/status` 正常返回 `current=目标版本, applying=false, error=''`，代码既不检查 current，也不进入 catch，于是永远无法确认成功。只有“status 请求失败，但紧接着 check 请求恰好成功”的窄时间窗口才会刷新。

对真实 `bindUpdateUI` 源码做确定性探针，分别模拟无断线可见的快速重启、断线一次后恢复；两者刷新次数都是 0，361 轮后均显示“更新卡住了”。探针加速了计时，不声称实际等待了六分钟。

建议：每次成功获取 status 也比较 `st.current===target` 并完成刷新；重连逻辑只负责连接错误，不承担唯一成功判定。补这两种时间顺序的行为测试。

证据：`wordpaper-codex-ui.log`。

### 4. P1：原生孤儿进程没有按 handoff 承诺回收

位置：小词灵 `companion.js:1214–1231`；菜单栏 `companion.js:1453–1464`。

非 TEST_MODE，主服务正常运行，通过主服务派生伴侣；确认菜单和窗口子进程存在并完成隐藏/召回；只 SIGKILL 这个测试伴侣。第一次 24 秒后两个子进程仍存活；第二次 35 秒后仍存活：

```text
70019  PPID=1 STAT=S  .../dw_menubar-70009.jxa.js
70079  PPID=1 STAT=S  .../dw_pet.jxa.js ... 70009
```

因此不能接受“失联 15/16 秒，20 秒内窗口进程消失”的结论。**这里证实的是进程未退出，未凭进程状态断言屏幕上仍显示图标或窗口。** 定时器、回调或退出调用的具体失效环节尚需继续插桩定位，不能把 handoff 的归因当作已证实事实。测试最后手动清理了这些测试 PID。

建议：给 JXA 心跳/退出加独立文件诊断，验证 timer 实际触发、退出实际到达；给父进程与原生窗口建立可验证的归属生命周期；验收同时检查 HTTP 失联、进程消失及 UI 消失，覆盖 SIGTERM、SIGKILL、同端口替换。仅检查 `/status.json` 的布尔值无法证明窗口后续健康。

证据：`wordpaper-codex-native-repeat.log`。

## 其他已确认缺口

### 5. P2：单实例保护仍存在启动路径漏洞

位置：`scripts/package_app.py:211–224,262–276`。

启动器先找可绑定的端口，再判断有没有旧服务。已经运行的保存端口当然无法绑定，于是第二次启动会选新口；随后的 `server_up` 和版本闸门查的是新口，错过原实例。隔离执行原端口选择片段确认：保存端口 56122 被占用时选择了 8776。后续可能进入启动新 server、清理旧伴侣的路径，不能等同于“重复双击只回到已有应用”。端口选择问题在审查起点前已经存在，本轮增强清理仍未解决它。

`sweep_old_bundle_instances` 还依赖命令行包含 `WordPaper.app/Contents/Resources`：Slim 使用缓存/系统 Node 且参数是相对的 `server.js` 时可能匹配不到。壁纸 O_EXCL 锁只阻止同一时刻写入；两个活伴侣交错写入仍然都能获得锁，不能代替唯一实例所有权。

建议：先验证保存端口的服务身份和版本，再决定复用/接管/选口；增加整个应用的实例锁。测试同版本双击、版本不同覆盖启动、Slim 缓存运行时与旧服务端口漂移。

证据：`wordpaper-codex-launcher.log`；锁分支检查见 `wordpaper-codex-lock.log`。

### 6. P2：测试入口失败，且 updater 测试没有完整隔离

位置：`package.json:12`、`scripts/test_updater_positive.js:120–129`。

`npm test` 最后是 `node scripts/test_assets_static.py`，Node 22.23.2 抛 `ERR_UNKNOWN_FILE_EXTENSION`。正确的 Python 调用单独补跑通过；整条 npm 命令仍然是失败，不能记为全绿。这个解释器问题是基线已有缺陷。

正向 updater 测试直接写入并删除 `os.homedir()/.wordpaper/update-pending.json`，不是临时用户目录。首次按 handoff 执行 npm test 时也走了这一行为；此后所有新增更新探针均隔离 Node home 路径。现有测试还通过 `Boolean(newManifest)` 判断“清单同步成功”，只证明文件存在，旧清单同样通过。

建议：改用 Python 解释器；把 flags、home、TMPDIR 和端口全部隔离；用准确的目标版本和摘要断言清单；不要把“只请求接口返回 ok”当作完整原生行为验收。

证据：`wordpaper-codex-npm-test.log`、`wordpaper-codex-assets.log`。

### 7. P2：安装包遗漏网页图标，更新器也不同步完整应用元数据

位置：`scripts/package_app.py:70–71,467–475`；`lib/updater.js:242–252`。

三个 2.4.5 DMG 的白名单 payload 全部与仓库一致，但都没有 `Resources/assets/favicon-32.png`。源码服务 assets 测试通过，不代表打包 App 的 assets 存在；发布验收本身也没把 assets 纳入检查。

用真实 hdiutil 和 rsync 安装到临时 App：VERSION 正确变为 2.4.5，旧 `RELEASE_SHA256.json.version` 仍是 2.4.4，旧 launcher 哨兵保持原样。源码注释称清单会带上，实际上白名单不含它。Info.plist、launcher、原生 stub、运行时均不属于当前热更新范围；因此依赖这些文件的修复无法通过现有“一键更新”交付。

建议：打包和 updater 共用完整资源清单，纳入 assets 与目标 manifest；明确应用整体更新策略，区分可热换的 payload 与必须更新的启动器/运行时。至少验收“从上一版本真实安装后”而不只是检查新 DMG。

证据：`wordpaper-codex-packages.log`、`wordpaper-codex-install.log`。

## 后续优化顺序

1. 先修菜单入口、失败退出和成功确认，三者补确定性回归；同时定位原生自毁未退出的问题。
2. 再修端口复用与单实例所有权，取消多个活伴侣轮流改桌面的可能性。菜单栏子进程退出后目前也没有自动重建机制，可一起补恢复策略。
3. 更新安装改为暂存、完整校验、切换、失败回滚。现在逐个 rsync，途中失败可能留下新旧文件混合；本次未进行中途断电/磁盘满故障注入。
4. 版本探测与已发布资产就绪绑定。现在先推 main/VERSION 再上传 Release，会产生“已提示更新但 DMG 还不存在”的窗口；新包内自带摘要只能检查内容一致性，不能独立证明发行者身份。
5. 改正测试入口、清理硬编码本机路径、更新 AGENTS.md/旧 handoff 的过时说明。尤其不要继续写“无应用内更新”或“已验证 20 秒孤儿回收”。

## 本次没有覆盖、不能据此宣称通过的部分

- 未实际升级用户已安装的 2.4.4 App，未走生产账号完整 launcher→下载→安装→重启链。已验证的是临时副本安装阶段和隔离的失败生命周期。
- 未设置用户真实桌面壁纸，未测试真实热键/TCC 权限，也未同时拉起两份会设置桌面的伴侣。
- 未重新构建或发布 DMG，未验证 GitHub 当前资产下载、Slim 两种架构在线首次下载或 Intel 硬件运行。
- 未视觉确认原生孤儿图标是否已被隐藏；已确认存活的进程并非 zombie。
- e2e 的 SheetJS CDN 错误被原测试排除，不能视为 Excel CDN 在线链路通过。

## 留存探针

`docs/audits/2026-10-23-menubar/` 包含完整日志及以下探针源文件。源文件按本机项目绝对路径编写，迁移机器时先调整路径；原生探针依赖 `/tmp/wordpaper-audit-preload.cjs`，重跑前需把同名留存文件复制到该位置。它们属于诊断证据，未加入 npm test。

- `wordpaper-native-audit.py` + `wordpaper-audit-preload.cjs`：隔离下载失败、主服务派生、真实原生窗口、SIGKILL 回收。
- `wordpaper-ui-audit.cjs`：执行当前源码菜单生成与 bindUpdateUI，输出初始菜单及两种重连顺序。
- `wordpaper-package-audit.py`：只读 DMG 校验与 payload/manifest 比对。
- `wordpaper-real-install-audit.cjs`：本地 DMG 输入、真实 hdiutil/rsync、临时 App 安装与元数据检查。

诊断脚本会打印失败现象；不能只看它们的进程退出码就判断产品行为全部通过。
