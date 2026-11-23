# 云端数据迁移与恢复

## 来源与备份

为每个原账号服务器指定长期稳定的来源名，例如 `primary-mac` 和 `legacy-public`。分别确认该端用户身份、用户名及 Google 绑定。保留原 Mac 伴侣数据、各设备 SQLite 与未同步队列、旧公网实例和现有云库的备份。先同步待传操作或在退出 App 与伴侣并冻结旧权威端后保留这些文件。同一台设备可能有普通账号及卫星影子账号，使用权威端的真实账号库进行导入。制作 SQLite 快照时使用 SQLite backup API，以便包含 WAL 中的已提交事务。模型主密钥、Google 凭据和生产连接串单独保管。

在可信、非公开目录中执行，目录权限为 0700，报告与备份为 0600。安装本项目锁定版本的 pg 驱动，按文件名顺序以迁移角色应用 `supabase/migrations/*.sql`。运行角色只授 `wordpaper_runtime`。导入需要 schema owner 权限及调整 users 序列的权限。

```sh
umask 077
npm ci --ignore-scripts
export WORDPAPER_SOURCE_INSTANCE=primary-mac
node scripts/migrate_wordpaper_postgres.js inventory /secure/source.sqlite > /secure/source-inventory.json
node scripts/migrate_wordpaper_postgres.js dry-run /secure/source.sqlite > /secure/cloud-plan.json
```

inventory 统计原始绑定、每表行数与校验和，并列出每个账号各 namespace 的字节数、SHA-256、revision 和 Unix 毫秒时间。词库、提醒、复习与学习活动附条目数或事件数。dry-run 在本机检查完整性、外键、未覆盖的表和身份、影子账号、数字范围和 namespace，并按云端格式生成对账清单。两条命令均只读 SQLite。演练目标的唯一约束、凭据密文及 SQL 权限通过下一步隔离导入验证。

## Google 归属

本项目的 `google-desktop` 与 `google` 都经 Google 授权并从同一 Google UserInfo 接口取得 sub。导入将二者转为云端 `google`。同一账号同一 subject 的两份记录可以合一。同名、同邮箱、不同账号共用同一 subject，均不能作为跨账号自动合并的依据。

同一 subject 在多个账号时 dry-run 会指出数字账号 ID 及 issuer/subject 指纹。若所有者明确要让这些业务账号继续分开，确认落选账号已有可用的独立密码登录后，使用与来源及指纹绑定的私有 JSON 决定文件，再设置 `WORDPAPER_MIGRATION_DECISIONS` 指向该文件。以下值仅示意。

```json
{
  "sourceInstance": "primary-mac",
  "googleOwners": [
    {
      "issuerSubjectHash": "<dry-run 指纹>",
      "sourceIds": [1, 2],
      "ownerId": 1
    }
  ]
}
```

此选项只选择登录归属，各账号学习数据仍按原账号保留。落选账号缺少独立密码、持有仅供联邦登录的内部账号键或同一账号持有两个不同 Google subject 时，导入会中止。需要合并两套学习历史时，先对词条、复习排期、撤销和冲突逐项预览，由所有者确认，保留两个原始快照和获批的合并结果，再导入确认后的快照。

## 隔离演练与最终切换

先将 `WORDPAPER_DATABASE_URL` 注入到一次性演练库，连接串只放在秘密管理服务或操作者的私有环境中。存在模型或语音绑定时，目标密钥通过 `WORDPAPER_MODEL_KEY_BASE64` 注入。原快照来自不同主密钥时传入 `WORDPAPER_SOURCE_MODEL_KEY_BASE64`。这两项均为原始 32 字节密钥的 Base64，迁移工具验证旧密文后按目标 ID 与目标主密钥加密。

```sh
node scripts/migrate_wordpaper_postgres.js import /secure/source.sqlite > /secure/import.json
node scripts/migrate_wordpaper_postgres.js verify /secure/source.sqlite > /secure/verified.json
```

首次导入在一个事务内写入来源实例、旧 ID、规范 ID 和快照收据。未占用的旧 ID 尽量保留，碰到其他来源的 ID 时分配新的数值 ID 并同步调整外键及密钥加密上下文。相同用户名键或已有的不同 Google 绑定将中止整笔事务。已有账号绝不按同名接管。技术上有多套来源的场景，先解决真正需要合并的账号再导入。

相同快照再次导入时逐项核验已导入行。同来源快照变化、云端某行已经修改或删除，均要求复核。新快照的正式部署应在独立演练库通过后，冻结旧写入口，用最终一致快照执行唯一一次正式导入。verify 核对导入行与原快照；来源表的校验和与每个实际目标值的比较同时有效。其他来源的独立账号及后续独立新行可协同存在。

用户在切换后重新登录。会话、未完成的 OAuth/设备授权和邮箱验证码不会迁入。app_meta 仅保留四个已登记的 feature 开关。卫星配对令牌、队列和冲突副本随设备保留。先用旧密码和已绑定 Google 验证原账号、词库、复习历史，再开放云端写入。

## PostgreSQL 备份与恢复

使用 Python 3.11+ 及 PostgreSQL 客户端自带的 pg_dump、pg_restore 和 psql。客户端主版本应至少与数据库匹配。用 libpq 的 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER` 与 0600 权限的 `PGPASSFILE` 指定连接。远程连接使用 verify-full；Supabase CA 通过 `PGSSLROOTCERT` 指定。使用能读取完整 wordpaper schema 的备份身份。以下两个命令在两个不同的数据库连接环境执行。

```sh
python3 scripts/postgres_backup.py backup /secure/backups/2026-11-23
# 切换 libpq 连接至无 wordpaper schema 的新数据库，预置同名 NOLOGIN 权限组。
python3 scripts/postgres_backup.py restore /secure/backups/2026-11-23
```

以同一个只读 REPEATABLE READ 事务建立导出的 PostgreSQL 快照。pg_dump 与每个账号的背景图片引用清单共享该快照。只要快照引用私有图片，备份和恢复均需通过各自环境的 `WORDPAPER_STORAGE_ORIGIN`、`WORDPAPER_STORAGE_SECRET` 和可选 `WORDPAPER_STORAGE_BUCKET` 指向相应私有桶。归档包含 schema、表、绑定、序列、来源映射与 ACL。manifest 记录 UTC 时间、数据库归档的字节数与 SHA-256，以及当前各账号所引用对象的 ID、内容哈希、MIME 类型（编码在 ref 内）和字节数。对象内容保存在 `objects/<账号ID>/<sha256>.<格式>`。应将整个备份目录完整复制到异地。仍在 settings 中的旧内联图片随数据库保存。此版本清单的对象范围为当次快照实际引用的背景图。

恢复先核验本地归档和全部对象，再用目标桶密钥逐项上传并回读验证 SHA-256。存量对象仅在内容相符时复用。数据库结构、数据、ACL 和引用清单比对在一个事务完成，遗漏引用会触发回滚。中断后可以重跑，已验证的内容寻址对象天然可复用。目标集群预先创建无登录权限的 `wordpaper_runtime` 组并独立配置 API 账号，模型主密钥从独立秘密备份恢复。完成后重新运行 verify、实际密码登录、Google 及基本状态读写。

把每日备份输出至受控卷，异地加密复制，监控命令退出码与最近一次成功时间，按保留期轮换。异地存储、通知接收者及密钥需要部署环境配置。定期在干净环境演练，否则无法仅从归档文件判断可恢复性。

云端尚未接收用户写入时，可以恢复先前路由与服务配置。云端已接收写入后，回滚应用版本时继续使用兼容的权威云库。需要回退数据端时，先冻结写入、备份云库、对上次收据后的新增/修改/删除进行逐项回放并验收，再切换旧端。

## 自动化回归

`WORDPAPER_TEST_DATABASE_URL` 指向允许 CREATEDB 的一次性回环 PostgreSQL 集群。测试自动创建和清理测试数据库。开启 `WORDPAPER_TEST_PG_BACKUP=1` 并安装三个 PG 客户端工具及 OpenSSL 后，将额外执行真实 PG 归档、空库恢复、逐来源复验和私有图片恢复。Storage 服务在该项回归中使用隔离的 HTTPS 测试实例，同时检查损坏对象、缺失清单和事务回滚。

```sh
WORDPAPER_TEST_PG_BACKUP=1 node scripts/test_postgres_migration.js
```

## 按已核对的双账号预览制作独立候选库

此工具针对以下已确认的数据形状：一个业务主账号和一个仅能用 Google 登录的普通副账号共享同一已验证 subject；副账号的全部 namespace 在主账号中均已存在；两者使用单词级 review。副账号存在独立密码、额外绑定、独有 namespace、旧式复习分组、模型、语音或例句配置时，需要更新处理方案。工具会明确指出阻断项。

在最终冻结且已包含所有已提交事务的 SQLite **快照**上核对。先生成未批准的决定模板，结合该快照的逐项预览审阅。按实际主、副账号顺序填写两个数字 ID。以下示例的 1 为主账号，2 为副账号。

```sh
umask 077
python3 scripts/prepare_review_merge.py inspect /secure/source.sqlite 1 2 > /secure/decision.json
```

模板包含源文件 SHA-256、两个账号所有持久业务表的独立 SHA-256，以及主账号词数、副账号词数、共有词、分叉历史和待新增词数。其 `approval` 初始值为 `null`。账号所有者明确接受这一份逐项预览后，才在私有决定文件中将此值设为 `"merge-as-previewed"`。最终快照发生变化时重新预览。

```sh
python3 scripts/prepare_review_merge.py prepare /secure/source.sqlite /secure/decision.json /secure/review-merge
node scripts/migrate_wordpaper_postgres.js dry-run /secure/review-merge/candidate.sqlite
```

输出目录必须全新。主账号保留原 ID、角色、原密码和全部已有词条的完整排期、事件与撤销信息。副账号独有的每条复习记录原样追加。其他 namespace 沿用主账号。工具将副账号所有持久业务行和解码后的每个 namespace 写入私有的 `secondary-account.json`，包括共有词的分叉历史，方便机主离线查阅或导出给账号所有者。已整合的副账号从候选库移出，原始双账号快照继续保留。后续正常 Google 登录将进入候选库中的主账号。

`receipt.json` 包含原始/候选库校验和、副账号私有档案校验和、来源 ID 到规范 ID 的映射、复习 revision 与各未涉及行的核验摘要。将该目录、原始快照与来源数据库到云端 ID 的导入收据一起备份到受控位置。先在独立 PG 实例完成 import/verify、原密码和匹配的 Google 登录验收，再确定切换。运维回归入口为 `python3 scripts/test_review_merge.py`。
