# HANDOFF — WordPaper 菜单栏 + 应用内更新重写（2026-10-23 会话）

> 交接对象：Codex 回测/复核。本文档是本会话全部改动的地图：改了什么、为什么、
> 怎么验证、已知薄弱点在哪。**回测时请逐条核对「验证」小节，而不是只读代码**——
> 本会话的核心教训是几个 bug 都藏在「测试盲区 × 平台行为」的交叉处。
>
> 起点提交 `0afe671`（v2.3.9）→ 终点 `9ba709e`（v2.4.5），11 个提交、5 个 Release。

## 0. 本会话解决了什么（用户视角）

用户报告的症状链（全部来自真实使用）：
1. App 在后台运行无任何可见指示；小词灵点 ✕ 后无法召回，只能重启软件。
2. 应用内「一键更新」多次失败（先报「下载安装包失败」，后报 rsync `Not a directory`）。
3. 更新后菜单栏出现两个 WordPaper 图标；小词灵出现两个、来回跳动；点词后壁纸被旧词盖回。
4. 菜单栏「换一组词」点击无反应。

最终交付：菜单栏常驻「词」图标（召唤/隐藏小词灵、换一组、记忆本、控制面板、
检查更新/一键更新、退出）；应用内更新三层根因修复 + 菜单栏直通；一整套
「单实例纪律」（进程归属校验、壁纸互斥、孤儿窗口自毁）。

## 1. 提交地图（0afe671 → 9ba709e）

| 提交 | 内容 | 版本 |
|---|---|---|
| b5c1c49 | 菜单栏图标 + server 新端点 + launcher wait 对象改 server + follow-server | 2.4.0 |
| 7e89f2a | 记忆本滚动修复（backdrop 重采样）+ 顶栏更新徽标 | — |
| 41785d3 | test_memory_scroll.py 入 npm test | — |
| 0da9de1 | Codex 同步：小词灵「书页+轨道」徽记、品牌图标统一、动效克制 | — |
| b557289 | **rsync 单文件尾斜杠修复** + 回归锁 | 2.4.1 |
| 803996d | 「换一组」真实翻页 + 小词灵头像统一 | 2.4.2 |
| 44f3bed | 菜单栏 ownerPid 校验 + 壁纸互斥锁 | 2.4.3 |
| a8a3724 | 菜单栏 stderr 管道冻结 + followServer 用 127.0.0.1 | 2.4.3 |
| 5f0a0fb | `child.stderr` 为 null 崩溃修复（2.4.3 回归） | 2.4.4 |
| b46530d | VERSION/CHANGELOG 2.4.4 | 2.4.4 |
| 9ba709e | 孤儿窗口归属心跳 + 死进程壁纸锁接管 | 2.4.5 |

## 2. 关键设计（跨文件才看得懂的部分）

### 2.1 服务链生命周期（launcher ↔ server ↔ companion）
- `launcher.sh`（scripts/package_app.py 内嵌 LAUNCHER）现在 **wait SERVER_PID**
  而非伴侣；server 退出后给伴侣 15s 收尾（`followServer` 3×5s 探测），超时强杀。
- `companion.js` 的 `followServer()`：独立版（APP_MODE，路径含 WordPaper.app）恒开；
  开发目录手动跑不开启。**探测一律 127.0.0.1，绝不用 localhost**——Node 双栈解析
  先试 `::1`，而 server 只听 127.0.0.1，曾导致伴侣在主服务健康时误判自杀。
- 应用内更新链：`/api/update/apply` → rsync 替换 Resources → 写
  `~/.wordpaper/update-pending.json` → server hardExit → launcher wait 返回 →
  读旗标 → `exec $0` 重入 → 新版本上线。伴侣跟随退出、菜单栏/窗口自毁。

### 2.2 菜单栏（companion.js buildMenuBarJXA）
- 每个伴侣把 **PID 烙进独立脚本副本** `dw_menubar-<pid>.jxa.js`（不共用 /tmp 同名
  文件——共享文件曾让旧图标读到新实例状态，永不自毁）。
- JXA 每 10s 拉 `/menu-status.json`（带 `X-WordPaper-Local: 1` 头），响应含
  `ownerPid`；**归属不符即摘除图标自杀**；失联 15s 也自毁（`$.exit(0)` 兜底）。
- **stdio 必须 `['ignore','ignore','ignore']`**：pipe 的 stderr 在父进程死后没人
  读，JXA 写满 64KB 缓冲会冻死整个脚本（定时器停摆→自毁永不触发）。且 ignore 时
  `child.stderr` 为 null，**不能再 `.on('data')`**（2.4.4 修的启动崩溃）。
- `registerSubclass` 的方法必须显式 `types: ['void', ['id']]`，否则 JXA 报 -2700；
  注册的类挂在 `$.DWMenuBarTarget` 全局，不能用返回值（与 DWGrip 同）。
- nil 是 `$()` 不是 `$('')`。

### 2.3 小词灵窗口归属心跳（buildPetJXA）
- spawn 时第 7 个参数传伴侣 PID；窗口每 2s GET `/pet-owner.json`（返回
  `ownerPid`）。**自毁判定用本地 `missTicks` 计数**（timer 自身递增，网络回调只
  清零）：对死端口 sendAsynchronousRequest 的回调可能永远不来，靠回调数失联
  凑不满。~16s（8 tick）失联自毁；ownerPid 不符立即自毁。
- **心跳 timer 必须注册在 `var win` 声明之后**：回调引用了 win，早注册会在首次
  触发时 ReferenceError 被静默吞掉，自毁永不生效（实测踩坑）。
- 服务端 500ms 节流、`trustedLocalMutation`、`/remember.php` 的 stale-key 409
  等原有行为未动。

### 2.4 壁纸互斥锁（跨进程）
- `pushWallpaper` 入口 `acquireWallpaperLock()`：O_EXCL 锁文件
  `/tmp/dw_wallpaper.lock`（内容 `{pid, at}`）；拿不到 → 跳过本次渲染并日志
  「双实例保护」。所有出口（短路/渲染失败/autoSet off/set 完成）都 `releaseWallpaperLock()`。
- 接管条件：锁龄 >30s **或持锁进程已死**（`process.kill(pid,0)` 探测）——SIGKILL
  留下的锁必须立即被接管，否则新伴侣渲染被吞（实测：layout 测试挂过）。
- 自持锁可重入（串行渲染队列）。

### 2.5 「换一组词」语义（runAdvance）
- 旧实现只 `bumpDelta`（随机种子）；`petWallpaperSync=true` 时壁纸词源是小词灵
  **当前页**，种子不参与选词 → 签名不变 → pushWallpaper 短路 → 点击无反应。
- 新实现：宠物窗口活着时走 `navigatePetPage(dir)`（与网页「换一组」同一原子
  操作）+ `syncWallpaperToPet()` + `refreshPetInPlace`；窗口不在时才退回种子推进。

### 2.6 server 新端点（回环 + `X-WordPaper-Local: 1` 头，public 模式拒绝）
- `POST /api/update/apply-local`：菜单栏更新入口，无 session（先经 check 拿 latest，
  服务端仍做棘轮/互斥）。`POST /api/quit`：菜单栏退出（MODE==='local' 才响应）。
- `GET /api/update/check?refresh=1` 30s 限速未变。
- `spawnCompanion` 现注入 `WORDPAPER_FOLLOW_SERVER=1`。

### 2.7 更新器（lib/updater.js）
- rsync 白名单循环：**目录加尾斜杠**（`--delete` 语义），**单文件绝不加**——macOS
  rsync 对 `file/` 报 `(l)stat: Not a directory`。这是 2.3.x/2.4.0 更新必失败的
  第三根因；回归锁在 test_updater_positive.js 的 stub rsync（文件+尾斜杠必报错）。
- 注意：**运行中的旧 updater 修不了自己**——2.4.0 用户必须 DMG 覆盖装 2.4.1+。

## 3. 验证清单（回测请逐条跑）

```bash
npm test                    # 145 项：含 test_menubar.js(15) + test_updater_positive(回归锁)
python3 scripts/e2e.py      # 73 项
python3 scripts/render_v3.py
python3 scripts/test_memory_scroll.py
node scripts/test_companion_layout.js
```

进程级实测（回测重点，都是真实跑过的场景）：
1. **更新链**：正确命名 `WordPaper.app` 的目录里起旧版（applyUpdate 自检要求路径
   含 `WordPaper.app`）→ `/api/update/apply` → 等 healthz 版本翻转 + launcher 日志
   `update applied: restarting service chain`。仓库 VERSION 必须先 push（版本源是
   GitHub main 的 raw）。
2. **孤儿窗口**：伴侣（petEnabled=true）起窗口后 `kill -9`，20s 内窗口进程
   （`pgrep -f dw_pet.jxa.js`）应消失。
3. **双实例锁**：两个不同端口伴侣同时 `/next.php`，后者日志出「双实例保护」。
4. **菜单栏**：伴侣死后图标 15s 内消失；`pgrep -f dw_menubar | wc -l` 恒 ≤1。
5. **发布**：`python3 scripts/dist/verify_release.py`（要求 VERSION 已提交）→
   `gh release create companion-vX.Y.Z`（4 资产：3 DMG + SHA256SUMS.txt）。

## 4. 已知薄弱点 / 回测建议

- **TEST_MODE 盲区**：`WORDPAPER_TEST_MODE=1` 跳过菜单栏/宠物/壁纸子进程，
  2.4.3 的启动崩溃因此漏测。建议：回测时至少跑一次非 TEST_MODE 隔离伴侣
  （独立 config + 随机端口 + WORDPAPER_COMPANION_SILENT=1），断言
  `/status.json` 的 `menuBar:true, pet:true`。
- **弹窗阻塞 launcher**：launcher 启动失败路径的 `wp_alert` 是阻塞 dialog；
  若有人 kill 它，launcher 退出。2.4.5 未改此行为（低频）。
- **`spawnCompanion` 注入 FOLLOW_SERVER 后**，server 派生的伴侣在 server 死时
  会自杀——dev 环境直接 `node server.js` + 网页「启用伴侣」会观察到伴侣随
  Ctrl+C 一起退（预期，但和旧行为不同，别当 bug 报）。
- `menu.php`/`menu-status.json`/`pet-owner.json` 的信任边界是「回环来源 +
  共享密钥头」，与伴侣其它 mutation 端点同级（本机其它用户/进程可伪造）。
  如需加固可换 launchd 生成的 per-boot secret。
- 更新等待 UI（app.js startPolling）断线重连逻辑只试 5 分钟；更长的重启窗口
  会落到「更新后服务没有回来」文案（可接受，未实测极慢盘）。

## 5. 本机现状（2026-10-23 收尾时）

- `/Applications/WordPaper.app`：Resources 已热修为 2.4.4 内容 + RELEASE_SHA256
  同步；服务链健康（8775/8771，单图标单伴侣）。
- 用户尚未在本机点 2.4.4→2.4.5 的应用内更新（发布已就绪，探测 available:true）。
- 系统里另有 `node server.js`（cwd=仓库，public 模式，8773）与本项目无关，勿动。

## 6. 发布流程备忘（下次发版照抄）

1. 改代码 → `VERSION` bump → CHANGELOG → commit → `git push origin main`
   （**push 必须先于 release**：旧版 check 读 GitHub main 的 VERSION）。
2. `python3 scripts/package_app.py`（三 DMG）→ `python3 scripts/dist/verify_release.py`
3. `shasum -a 256 scripts/dist/*.dmg > scripts/dist/SHA256SUMS.txt`
4. `gh release create companion-vX.Y.Z --title ... --notes-file scripts/dist/RELEASE_NOTES.md scripts/dist/*.dmg scripts/dist/SHA256SUMS.txt`
5. `git tag companion-vX.Y.Z && git push origin companion-vX.Y.Z`
6. 验证 asset 可下载（HTTP 206）+ 本机 check available。
