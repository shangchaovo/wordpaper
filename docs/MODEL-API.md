# 账号模型接入

在主窗口右上角打开「设置 → 模型接口」，填写接口格式、Base URL、模型名称和 API Key。造句窗口也有「模型接口」入口，会打开当前 WordPaper App 的设置。点击「验证并绑定」后，服务端用一条短请求测试；成功后配置绑定到当前登录账号。可以测试连接、更换或解除绑定，学习记录保持原位。

- OpenAI 兼容格式使用 `POST <Base URL>/chat/completions`。DeepSeek 官方示例是 `https://api.deepseek.com`，模型名按服务商控制台填写。参考 [DeepSeek 官方接入文档](https://api-docs.deepseek.com/)。
- Anthropic 格式使用 `POST <Base URL>/messages`，官方 Base URL 是 `https://api.anthropic.com/v1`。自建代理需要填写其提供的完整前缀。参考 [Messages API](https://platform.claude.com/docs/en/api/messages/create)。
- 完整的 `/chat/completions` 或 `/messages` 地址会自动去除末尾方法路径。模型名不会自动替换成其他供应商或账号。
- 修改模型名时，API Key 留空可保留原密钥；更换地址或接口格式时必须重新填写 Key。测试连接不会保存新的配置。
- 模型费用由接口账户承担。造句、当前词条和相应对话内容会发给配置的服务商；测试连接也会产生一次短调用。

## 账号与密钥

服务端从登录会话确定用户，不接收请求体指定的用户 ID。密钥使用 AES-256-GCM 加密，密文绑定账号 ID，保存在 SQLite 的 `user_models` 表。加密主密钥是服务数据目录下权限为 `0600` 的 `model-key.bin`。客户端不回显 Key，不写入 localStorage，也不放进 `/api/state`、用户备份或静态文件。

本机账号的配置保存在这台 Mac。连接主账号后，配置操作与模型调用转发到主账号服务器；明文 Key 不下发到卫星客户端。主账号服务器必须同样升级到支持此接口的版本，否则会明确提示升级。主账号离线或登录过期时返回错误，不把密钥操作加入离线同步队列。

服务器运维备份需要一起保存 `wordpaper.sqlite` 与 `model-key.bin`，并按敏感凭据保护；只有数据库而没有主密钥无法恢复模型 Key。普通用户数据导出刻意排除密钥，换到独立账号或新安装后需重新绑定。

旧版机器级 `companion/magpie.json` 不会自动分配给其他账号。已有用户可在「模型接口」中重新验证并绑定自己有权使用的接口。

## 缺失例句自动补充

在桌面小词灵朗读英语词条时，如果词条和内置词典都没有例句，会使用当前账号绑定的模型即时生成一条英文例句及中文译文。配置为 Magpie 的 OpenAI 兼容地址与 DeepSeek 模型即可沿用此服务；不会另存一份密钥，也不会调用其他账号的接口。自定义英语词条同样支持，日语、法语和西班牙语词库暂不自动生成英语例句。

生成期间先播放单词，气泡显示生成状态；例句通过内容校验、保存并在原生窗口显示后才播放英文，中文只显示。连续点击同一词条共用生成请求；换词或切换账号后，旧结果只保存到原账号，不会打断当前朗读。已有词条或词典例句保持优先。

例句保存在本机 `wordpaper.sqlite` 的 `user_word_examples` 表，按账号、词库、单词、词义、词性和音标区分。成功结果持续复用，更新 App 不会清除，断网也可读取；删除账号会同时删除其例句。它是本机学习辅助缓存，暂不参与跨设备同步或普通学习数据导出，运维备份整个数据库可保留。绑定模型失败、限流、超时或回复格式无效时不保存空结果，短暂冷却后重新点击可以重试。

运行 `npm run test:examples` 验证真实 HTTP 模拟模型、重复请求合并、重启和离线复用、账号隔离、无效输出与朗读时序；原生气泡更新通过 `python3 scripts/test_patrick_speech_layout.py` 验证。

## HTTP 接口

所有端点要求 WordPaper 登录会话；除 GET 外还要求同源 Origin 与 `X-CSRF-Token`。

| 端点 | 用途 |
| --- | --- |
| `GET /api/account/model` | 当前账号的地址、格式、模型名、绑定状态；不返回 Key |
| `PUT /api/account/model` | `{baseUrl, protocol: "openai" 或 "anthropic", model, apiKey}`，验证成功才替换配置 |
| `POST /api/account/model/test` | 相同字段测试待保存配置，或 `{}` 测试已绑定配置 |
| `DELETE /api/account/model` | 解除当前账号的模型绑定 |
| `POST /api/ai/chat` | `{messages: [{role, content}], maxTokens?}`，使用当前账号 Key 调用，返回 `{ok, text, model}` |

本机模式允许局域网、回环或 Tailscale 的 HTTP 接口。公网模式只允许 HTTPS 公网接口，连接前解析并固定 DNS 地址，拒绝私网、回环、链路本地及 IPv4 映射地址，且不跟随重定向。

错误码分别表示未配置、Key 无效、余额不足、访问被拒、模型不存在、限流、网络失败或超时。不会把供应商的原始响应体直接展示给用户。单账号同一调用入口一次处理一个请求。造句回复必须包含有效分数、是否使用目标词、修正句和点评；不合格的回复不计入学习记录。

验证：`node scripts/test_model_accounts.js` 检查账号隔离、加密、失败保留、重启、删除、同步代理、桌面批改和网络边界；`npm run test:models` 额外运行真实浏览器表单与造句提交。测试使用隔离数据库及模拟模型，不证明某个第三方账号的实际额度或权限。
