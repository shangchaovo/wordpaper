# ADR 0001: 零第三方 npm 运行依赖(内置 node:sqlite + 无构建器前端)

- 状态:已接受
- 日期:2026-08(2026-09-18 补录)

## 背景

WordPaper 的分发形态包括:自带 Node 运行时的 DMG(Apple Silicon/Intel)、
首启从 npmmirror 下载运行时的 Slim 包、以及 Docker。server 需要持久化
(多用户、会话、SRS 复习、配对状态),前端需要可维护的多模块结构。

## 决策

- 持久层使用 Node 内置的 `node:sqlite`(`DatabaseSync`),不引入 better-sqlite3 等原生模块。
- `package.json` 只提供启动/测试入口并约束 Node 版本(`>=22.23.2 <23 || >=24 <25`),没有任何第三方运行依赖。
- 前端 `js/` 是浏览器经典脚本(IIFE),`index.html` 固定顺序加载,无打包器、无转译。

## 理由

- **分发**:原生 npm 模块需要按平台 ABI 预编译,会破坏「单一 Node 运行时即可跑」的分发模型;
  Slim 包首启下载官方运行时 tarball,无法附带任何原生二进制。
- **可审计**:零依赖意味着供应链面只有 Node 本身,DMG 内容可完全枚举。
- **部署**:Docker/云主机/本地开发同一份代码,无 install 步骤差异。

## 代价与约束

- `node:sqlite` 仍是 experimental(启动有警告),API 可能变动——因此 Node 版本被严格锁定,
  升级 Node 前必须跑全量 `npm test`。
- 前端 IIFE 的加载顺序是隐性契约,改跨模块功能时需按 CLAUDE.md 的触点清单同步修改;
  模块边界继续恶化时,再评估引入最小构建器(届时重开 ADR)。

## 备选方案(已否决)

- better-sqlite3:性能更好但需原生编译,否决(分发模型)。
- Electron/Tauri 桌面壳:体积与复杂度远超 companion 方案,否决。
