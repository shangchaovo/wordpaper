# 让休眠的账号服务发送已经到期的微信提醒

此操作用于 WordPaper 的 Supabase 项目与 `https://wordpaper-api.onrender.com`。数据库每分钟核对已经预约的批次。预约已到期、账号仍绑定、微信授权有效并且发送器尚未领取时，数据库向该地址提交一次对应预约的请求。HTTP 头只携带账号数字 ID 与该预约独有的随机凭证。原有应用发送器仍会运行。两种入口使用同一条数据库记录认领，发送前都核对账号、模板、词条与复习轮次。

## 安装

1. 通常先部署 `POST /api/mini/reminder/wake`，并在 Render 设置原 AppID 对应的 AppSecret、已获批模板 ID 和字段映射。若下面的只读查询返回 0 个授权、0 个已预约批次，也可以先安装并观察空队列下的 Cron 运行。用真实账号验收发送时，需要确认公开的 `GET /api/mini/config` 已返回 `loginAvailable: true` 和已批准的 `templateId`，并由用户在微信内实际同意且有对应词条到期。

```sql
SELECT
  (SELECT count(*) FROM wordpaper.mini_reminder_prefs WHERE enabled = 1 AND has_grant = 1) AS granted_accounts,
  (SELECT count(*) FROM wordpaper.mini_reminders WHERE state = 'scheduled') AS scheduled_batches;
```

2. 在既有 WordPaper Supabase 项目中，用数据库运维角色执行同目录的 [install_mini_reminder_wakeup.sql](install_mini_reminder_wakeup.sql)。整份文件在一个事务中安装所需扩展、私有退避记录及具名 Cron 作业。同一角色重跑会保留已有退避记录。
3. 查看作业配置和实际运行结果。查询不包含预约凭证或用户数据。

```sql
SELECT jobname, schedule, active
FROM cron.job WHERE jobname = 'wordpaper-mini-reminder-wake';

SELECT d.start_time, d.end_time, d.status
FROM cron.job_run_details d JOIN cron.job j USING (jobid)
WHERE j.jobname = 'wordpaper-mini-reminder-wake'
ORDER BY d.start_time DESC LIMIT 8;

SELECT count(*) AS reservations_woken FROM wordpaper_ops.mini_reminder_wakes;
```

没有到期预约时，检查产生零次外部请求。出现真实预约后，同一批次的 HTTP 唤醒间隔从 3 分钟递增，最长一小时，最多 12 次。新的预约独立计算；每轮最多选择 20 个到期批次。发送器收到明确的微信拒收或不确定的发送回执，会记录微信投递状态；网络丢失发送回执时保留 `unknown`，防止重复通知。Cron 启动时间、Render 冷启动和微信网络都可能使通知晚于词条到期时间。

## 暂停和恢复

以下语句只暂停当前角色安装的这一个 Cron 作业。已有的应用内定时发送器继续工作，已排队的 HTTPS 请求仍可能完成。

```sql
SELECT cron.unschedule(jobid) FROM cron.job
WHERE jobname = 'wordpaper-mini-reminder-wake' AND username = current_user;
```

用原角色重新执行安装文件可以恢复。遇到接收端配置错误时，先修正应用配置。若某个预约已达到 12 次唤醒上限，可在确认账号和故障恢复后删除该账号在 `wordpaper_ops.mini_reminder_wakes` 中的退避记录；下一轮仍会按原预约的真实状态判断是否请求。

在测试环境执行 `node scripts/test_mini_wake.js` 可复验应用认领、并发和重试。SQL 回归使用 `WORDPAPER_TEST_DATABASE_URL` 指向本机可创建临时测试库的 PostgreSQL，并执行 `node scripts/test_mini_wake_sql.js`。隔离测试使用网络队列替身，不会发送微信通知。[Supabase Cron](https://supabase.com/docs/guides/cron) · [pg_net](https://supabase.com/docs/guides/database/extensions/pg_net)
