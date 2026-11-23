# ADR 0004 · 云端账号 API 的运行环境

2026-11-23。WordPaper 云端账号 API 采用 Node 容器与 Supabase Postgres。桌面继续使用内置 SQLite；`pg` 仅由公网服务的 Postgres 适配器加载。此决策更新 [ADR 0001](0001-zero-runtime-dependencies.md) 中 Docker 的依赖约束。

## 运行时验证

在 Mac 上创建的一次性 Postgres 18.7 数据库中，Node 生成了与旧版相同格式的合成 scrypt 凭据。Deno 2.7.5 使用 `N=32768, r=8, p=1` 校验通过，单次耗时 171 ms。Deno 中的异步 `pg` 连接提交了 revision 写入，HTTP 302 响应保留了两条独立的 Set-Cookie。该测量来自本地测试机。

当前存储适配使用 `node:worker_threads` 的独立 Worker 保持同步调用契约。Supabase 托管 Edge 限制了 Web Worker 与多线程 Node 库，移植需要将存储访问和事务改为异步，重新实现路由和后台维护，再验证完整的旧会话和桌面授权流程。[Supabase Edge 运行限制](https://supabase.com/docs/guides/functions/limits)

## 部署与验收

Node 的隔离回归使用真实 Postgres、受限服务角色和两个 API 进程，覆盖原格式密码、模拟 Google 回调关联既有身份、设备授权的原子领取、revision 并发、学习记录去重与撤销、登录限流、数据库失联后恢复，以及重启后保留原账号。可通过 [数据库集成测试](../../scripts/test_postgres_backend.js) 复验。正式部署还需在目标域名、实际 Google 账号和安装包上验收。

公网服务固定 `WORDPAPER_STORAGE_BACKEND=postgres`。从项目控制台取得直连或 Session pooler 的连接参数，使用受限登录角色并校验 TLS。每个 Node 进程占用一条 session 连接，部署副本数应计入项目连接预算。数据库超时会阻塞该 Node 进程的同步处理直至本次请求返回，故应在候选部署实测登录与同步延迟后确定副本数。[Supabase 数据库连接方式](https://supabase.com/docs/guides/database/connecting-to-postgres)
