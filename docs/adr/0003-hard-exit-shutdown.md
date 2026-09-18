# ADR 0003: SIGTERM 关停采用 hardExit(线程池排空 / SIGKILL 兜底)

- 状态:已接受
- 日期:2026-09-18

## 背景

`checkForUpdate()`(仅 local 模式)在启动时 `https.get` 直连
`raw.githubusercontent.com` 检查新版本。在 DNS 被污染或无代理的网络里,
这个域名的 `getaddrinfo` 可能**永不返回**;而:

1. DNS 查询跑在 libuv 线程池上,`req.destroy()` **无法撤销**已在执行的 `getaddrinfo`;
2. `process.exit()` 会等待 libuv 线程池排空才真正退出;
3. 于是 SIGTERM → `server.close` 回调 → `process.exit(0)` 被永久阻塞,
   launchd `kickstart` 也杀不动进程(实测 `npm test` 的 teardown 全部 PASS 后
   报 `server did not stop` 而失败)。

## 决策

`shutdown` 不再调用裸 `process.exit`,改走 `hardExit(code)`:

- 关停时先 `updateRequest.destroy()` 取消版本检查请求(尽力而为);
- `hardExit` 轮询 `process._getActiveRequests()`:线程池排空 → `process.exit`;
  超过 3s 未排空 → `process.kill(process.pid, 'SIGKILL')`;
- `_getActiveRequests` 若在未来 Node 版本移除,退化为立即退出(等同旧行为)。

## 理由

- SIGTERM 语义必须可靠:launchd 看门狗、CI、测试 teardown 都依赖它在有界时间内生效。
- 3s 优雅窗口覆盖正常情况(DNS 毫秒级),SIGKILL 只落在病态网络上,代价可接受。

## 约束

- 任何新的「启动即发起的网络请求」都必须像 `updateRequest` 一样可被关停时取消。
- 不要用「等待更久」替代 SIGKILL 兜底——病态 DNS 没有上界。
