# 安全政策

## 支持版本

| 版本 | 支持状态 |
| --- | --- |
| 最新 release(`VERSION` 文件为准) | ✅ 支持 |
| 旧版本 | ❌ 仅最新版接受安全修复 |

## 报告漏洞

**不要开公开 Issue。** 请通过 GitHub 的
[Private Vulnerability Reporting](../../security/advisories/new) 提交,
预期在 7 天内得到首次响应。

## 安全模型速览(审计入口)

- 密码使用 scrypt 加盐哈希;会话为 httpOnly Cookie + CSRF Token 双重校验
- `public` 模式禁用一切本机伴侣控制端点,只开放同一 Web/API 端口;伴侣端口(8771)仅允许 loopback
- 静态文件服务有目录白名单与路径逃逸防护
- 密钥(OAuth client secret、Resend API key 等)只存在于本机 `.env`(已 gitignore),`public` 模式不加载伴侣相关配置
- 卫星配对的凭证(cookie/CSRF)存于本机 SQLite `app_meta`,不会上行到上游以外的任何方
