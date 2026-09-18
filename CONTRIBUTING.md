# 参与贡献

感谢你对 WordPaper 的兴趣!这是一个个人开源项目,欢迎 Issue 和 Pull Request。

## 环境要求

- **Node.js**:`>=22.23.2 <23` 或 `>=24 <25`(依赖内置 `node:sqlite`,见 `docs/adr/0001-zero-runtime-dependencies.md`)
- **Python 3**:仅打包/渲染测试等脚本需要(`scripts/*.py`)
- 桌面伴侣相关功能需要 macOS(用到 `sips`/`osascript`/Apple Vision OCR),但 **server 与全部 `npm test` 用例跨平台**

## 常用命令

```bash
npm start                 # 启动 server(默认 127.0.0.1:8770)
npm test                  # 全部 Node 测试:账号隔离/OAuth/SRS/伴侣学习/卫星配对
python3 scripts/e2e.py    # 端到端(55 项断言,需先 pip install playwright && playwright install chromium)
python3 scripts/render_v3.py  # 像素级渲染断言
```

## 约定

- **零第三方 npm 运行依赖**——这是硬约束,不是偏好;引入依赖前请先开 Issue 讨论。
- `VERSION` 是唯一版本源,改动面向用户的行为时请同步 bump 并更新 `CHANGELOG.md`。
- `server.js` 的静态访问白名单只允许 `index/login/css/js/data`;源码、`.git`、数据库、伴侣状态绝不能加入白名单。
- SIGTERM 关停必须走 `hardExit` 语义(见 `docs/adr/0003-hard-exit-shutdown.md`),不要改回裸 `process.exit`。
- 提交信息使用中文 + 约定式前缀(`feat/fix/docs/ci/refactor`),与仓库历史保持一致。

## 提交流程

1. Fork 并新建 feature 分支
2. 提交前确保 `npm test` 全绿
3. 发起 Pull Request,CI(node 22/24 矩阵测试 + python 脚本编译检查)通过后合入

## 报告安全问题

请通过 [GitHub Security Advisories](../../security/advisories) 私下报告,不要开公开 Issue,详见 `SECURITY.md`。
