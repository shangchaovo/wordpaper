# ADR 0002: 桌面伴侣必须由 server 派生,不设独立 LaunchAgent

- 状态:已接受
- 日期:2026-08-17(2026-09-18 补录)

## 背景

macOS 上 companion 需要两类系统能力:用 `osascript → System Events` 设壁纸(「自动化」权限)、
Apple Vision OCR。macOS 的 TCC 把这类授权记给**责任进程(responsible process)**——
即派生伴侣的那个进程,而不是伴侣二进制本身。

## 决策

- companion 的一切启动都走 server 的 `/companion/start`(local 模式,且要求请求来自本机)。
- 开机自启不给 companion 单独建 LaunchAgent;而是在 server 的 plist 注入
  `WORDPAPER_COMPANION_AUTOSTART=1`,由 server 监听后 3s 自动派生 + 60s 看门狗探活,
  走与手动启动完全相同的 server→companion 链。
- 禁止从临时 shell 直接 `node companion.js`(责任进程变成终端,未授权会弹 TCC 框并堵死
  System Events 的 AppleEvent 队列,报 -1712 超时)。

## 理由

- 用户只需对 server(launchd 上下文)授权一次;任何绕过 server 的启动路径都会触发重复授权弹窗。
- 单一启动链让看门狗、版本替换、静默模式(`WORDPAPER_COMPANION_SILENT=1`)只有一处实现。

## 备选方案(已否决)

- companion 独立 LaunchAgent:责任进程变更会重新弹 TCC 授权,否决。
- WKWebView 小窗:实测吞鼠标事件导致无法拖动,改用 SVG→PNG + JXA `registerSubclass`
  自定义拖动(详见 CLAUDE.md「小窗为什么不用 WKWebView」)。
