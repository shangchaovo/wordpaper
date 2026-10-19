# 更新日志

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 与语义化版本。
`VERSION` 文件是唯一版本源。

## [2.2.2] - 2026-10-19

### 修复
- macOS 壁纸刷新改为原位复用固定文件,避免「系统设置 → 墙纸 → 你的照片」不断新增重复条目。
- 壁纸与小词灵渲染串行执行,连续点词合并更新,定时刷新原位更新小窗,减少闪烁和重复渲染。
- 壁纸读写使用系统自带的 JXA/AppKit,无需安装 Swift 或 Xcode 命令行工具。
- Intel 完整包的内置运行时文件名与启动器保持一致,确保无需下载即可离线启动。
- 清理壁纸渲染与 OCR 临时文件,减少磁盘占用。

### 优化
- 预览、主题切换和拖拽动效更流畅,点词即可调整排版,背景照片支持拖动取景。
- 超大背景照片最长边压缩至 2560 像素,减少保存和同步开销。
- 桌面伴侣统一从预览上方的小词灵入口启用或下载,网页实时壁纸入口移至预览工具栏。

## [2.2.1] - 2026-09-18

### 修复
- **SIGTERM 关停永久挂起**:`checkForUpdate` 直连 GitHub 的 DNS 查询在被污染/无代理网络下可永不返回
  (`req.destroy()` 无法撤销线程池中的 `getaddrinfo`),而 `process.exit` 会等 libuv 线程池排空,
  导致退出被永久阻塞、launchd 重启杀不动进程。`shutdown` 改为 `hardExit`:最多等线程池 3s,
  超时则自我 `SIGKILL`,保证 SIGTERM 语义(详见 `docs/adr/0003-hard-exit-shutdown.md`)。

### 新增
- 补全开源社区文件:LICENSE(MIT)、CONTRIBUTING、SECURITY、CHANGELOG、ADR 目录
- GitHub Actions CI:Node 22/24 矩阵测试 + Python 脚本编译检查

## [2.2.0] - 2026-08-24

### 新增
- 开机自启伴侣(Wallpaper-Engine 式):plist 注入 `WORDPAPER_COMPANION_AUTOSTART=1`,
  server 监听后自动派生 + 60s 看门狗探活重拉,整机开关 `companion-config.json` 的 `autoStart`
- Liquid Glass 默认主题,壁纸默认 pearl 主题

## [2.1.x] - 2026-08

- 2.1.5:新增法语/西班牙语词库
- 2.1.4:同机多账号共享桌面小词灵;GitHub 开源链接
- 2.1.3:统一 SVG 图标体系;模块隐藏/恢复;平滑拖拽;伴侣布局同步修复
- 2.1.2:记忆本分区大白话标注(还在记 vs 已经记住)
- 2.1.1:私有网络配对——LAN/Tailscale/mDNS 允许 http 直连主账号

## [2.0.x] - 2026-08

- 主账号镜像(卫星模式):另一台 Mac 直接共用主账号,离线缓存 + 补推
- WordPaper.app + DMG 三种分发包(Apple Silicon / Intel / Slim 国内加速版)
- 桌面伴侣 v2:自更新、UI 主题、性能工具

---

更早历史见 `git log`。
