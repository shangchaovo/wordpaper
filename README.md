# WordPaper · 把单词做成你的电脑壁纸

背单词老忘，就把当天要看的词做成壁纸。在电脑桌面抬眼就能扫到，不必专门打开背词 App。

**线上：[wordpaper.pages.dev](https://wordpaper.pages.dev/)**  
另有一份 GitHub Pages 镜像：[shangchaovo.github.io/wordpaper](https://shangchaovo.github.io/wordpaper/)

网页打开就能预览电脑壁纸。默认 1920×1080，支持 2K、4K 和自定义尺寸。词库有雅思、四六级、考研、JLPT，也可以自己导入一份。复习按艾宾浩斯排，到点会提醒；导出是 PNG，也可以开 Live 模式当动态壁纸一直转。配色、排版、词数都能改。

Mac 上还有个可选的桌面伴侣：装在自己电脑上，能把壁纸直接设到系统桌面，还有个小词灵窗口。网页主体在 Windows / Linux 浏览器里也能用，自动换系统壁纸和 OCR 是 macOS 专属。

账号存在服务器的 SQLite 里（密码加盐哈希，不存明文）。换电脑登录同一个号，复习进度、自定义词库和布局会跟过来。也可以下载一份 JSON 备份。Google / 微信 / 邮箱都能登，没配的登录按钮会明白写「管理员尚未配置」，不会假装能用。

现在是单入口、多用户，结构大概是这样：

```text
浏览器 ── 同源 HTTPS ──> Node Web + API（一个端口） ──> SQLite 持久卷
                                               └── 每条数据绑定 session user_id

Mac 桌面伴侣（可选）── 127.0.0.1:8771，仅在用户自己的 Mac 上
```

## 本机启动

需要 Node.js 22.23.2+ 或 Node 24；项目没有第三方 npm 运行依赖。

```bash
npm start
# 打开 http://localhost:8770，创建账号
```

默认数据库在 `~/.wordpaper/wordpaper.sqlite`，不在源码目录里。重启 Node、浏览器或电脑不会清空账号数据。端口被占用时服务会直接报错退出，不会自动换端口，以免 origin 改变后让浏览器缓存看起来像“丢失”。

可以显式指定稳定的数据目录和端口：

```bash
WORDPAPER_DATA_DIR=/absolute/persistent/path PORT=8770 npm start
```

首次创建账号时，当前浏览器旧版的 `wp:*` localStorage 会一次性归入该账号；迁移完成后，本地缓存改用 `wp:user:<user-id>:*`，后续登录的其他账号不会继承这份数据。如果先登录了已有账号，页面只会提示“迁移旧数据”，由用户确认后再导入，避免共享浏览器上的数据被错误认领。

浏览器不允许新域名读取旧域名或 `localhost` 的 localStorage。因此从旧网址迁到新公网域名前，应先在旧入口注册账号并等待同步完成，再按下文迁移数据库/数据卷；可以另外下载账号“备份”留作核对。新域名不能绕过同源策略自动读取旧站数据。

macOS 上若要登录后自动启动，不要复制仓库里的 plist 模板；运行安装脚本，它会自动发现当前电脑的用户名、Node 路径、项目路径和数据目录：

```bash
chmod +x scripts/install_macos_service.sh
./scripts/install_macos_service.sh
```

## 多台 Mac：主账号镜像（卫星模式）

另一台 Mac 上的独立版可以共用主账号，而不是新建一个互不相干的本地账号。模型是**卫星主动拉取**（pull），不是网页直推 localhost：

```text
主力机(本地或公网实例,权威数据)
        ↑ 卫星用账号密码配对一次,持有长期会话
卫星机(另一台 Mac 的独立版)
  读:先补推再拉取,以上游为准覆盖本机缓存
  写:在线直推上游;断网写本机缓存 + 排队,恢复后自动补推
  冲突:上游赢;上游会话过期(约 30 天)转「重新验证」,本机缓存仍可离线用
```

在卫星机的登录页展开「这台是我的另一台电脑？连接到主账号 →」，填主账号所在电脑的地址和账号密码即可。配对后：本地注册/登录入口让位给「继续」；壁纸、小词灵、记忆本全部照常在本机运行。「断开连接」会删除本机同步副本，不影响主账号。

**主账号地址优先用私有网络，不必走公网**（真实使用留在本地，公网实例只做展示）：

- **同一 Wi-Fi / 局域网**：`http://主机名.local:8770`（如 `http://mininn.local:8770`）或局域网 IP `http://192.168.x.x:8770`。
- **异地 / 不同网络**：用主力机的 Tailscale 地址 `http://100.x.x.x:8770`（两台都装 Tailscale 后，走加密私有网络，不暴露公网）。
- 公网地址仍可用，但必须 `https://`。

主力机需让 8770 监听所有网卡（默认只听回环，别的电脑连不上）：在 launchd plist 里加 `HOST=0.0.0.0` 并保留 `WORDPAPER_MODE=local`（设了非回环 HOST 后必须显式钉住 local，否则会自动降级成 public、配对被禁用）。

仅 `local` 模式可配对（回环 + Origin 校验 + 限流）；`public` 实例永远是权威数据源，不能做卫星。卫星的后台节拍每 45 秒补推 + 拉取一轮。

## 数据持久化与用户隔离

- 密码使用 Node `crypto.scrypt` 加盐哈希，数据库不保存明文密码。
- 登录使用随机不透明 session token；数据库只保存 token 的 SHA-256。
- Cookie 为 `HttpOnly`，邮箱登录默认 `SameSite=Strict`；OAuth 回跳 session 使用 `SameSite=Lax`，HTTPS 下都会自动使用 `Secure`。
- `user_state` 的主键是 `(user_id, namespace)`；`user_id` 只从服务端 session 获取，API 不接受客户端指定用户。
- 设置、背景图、自定义词库、初筛、提醒、轮换状态、复习记录和模块布局都保存进 SQLite。
- 每个 namespace 有 revision；两台设备同时覆盖同一份数据时返回冲突，而不是静默丢掉其中一份。
- localStorage 只是按账号分区的本地缓存；服务器数据库才是跨电脑恢复的权威数据源。
- 登录后可点顶栏“备份”，或访问 `/api/export` 下载当前账号的 JSON 备份。

## 登录方式：Google、微信与邮箱

登录页始终提供三个入口：

- **邮箱 + 密码**：注册时先输入 6 位邮件验证码；旧版用户名账号仍可在登录框中继续使用。
- **Google**：服务端 Authorization Code + PKCE，范围仅为 `openid email profile`。
- **微信**：微信开放平台“网站应用”扫码登录，范围为 `snsapi_login`。

Google 和微信首次授权会创建独立 WordPaper 账号，之后以 Google `sub` 或“微信 AppID + openid”定位同一账号。服务器不会保存第三方 access token / refresh token，也不会根据昵称或相同邮箱静默合并账号。即使 Google 邮箱与邮箱账号相同，两种身份仍保持为两个独立数据空间；未来如需合并，必须增加“同时证明两种身份”的显式绑定流程。

在 `.env` 中填写对应平台参数后，登录页会自动启用按钮；未配置时按钮会保留但明确显示“管理员尚未配置”。完整变量见 [`.env.example`](.env.example)。

Google Cloud 需要创建 Web application 类型 OAuth 客户端，并登记完全一致的回调：

```text
https://你的域名/api/auth/google/callback
```

参见 [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect) 与 [Web Server OAuth 指南](https://developers.google.com/identity/protocols/oauth2/web-server)。

微信需要先在微信开放平台创建并审核“网站应用”，再申请“微信登录”能力；授权域名必须与公网回调域名一致：

```text
https://你的域名/api/auth/wechat/callback
```

参见 [微信网站应用登录指南](https://developers.weixin.qq.com/doc/oplatform/Website_App/WeChat_Login/Wechat_Login.html)。AppSecret 只放服务器环境变量，禁止提交 Git 或发送给浏览器。

邮箱验证码使用 [Resend Send Email API](https://resend.com/docs/api-reference/emails/send-email)。先在 Resend 验证发信域名，再在 `.env` 填写：

```dotenv
WORDPAPER_RESEND_API_KEY=re_xxxxxxxxx
WORDPAPER_EMAIL_FROM=WordPaper <login@你的域名>
```

验证码 10 分钟内有效、最多尝试 5 次，同一邮箱 60 秒内不能重复发送。正式公网环境未配置邮件服务时，登录仍可用，但邮箱自助注册会明确禁用；本机 loopback 开发模式会把测试验证码直接填入页面，不会假装已经发出邮件。

## 公网部署（单端口）

复制环境模板并启动：

```bash
cp .env.example .env
# 编辑 .env，填写正式 HTTPS 域名
docker compose up -d --build
```

Compose 只映射一个 Web 端口，且只挂载一个持久卷：

- 公网 / 反向代理入口：`${WORDPAPER_PORT:-8770}`
- 容器应用端口：`8770`
- 持久数据卷：`wordpaper-data` → `/data`
- 不映射、也不启动 `8771`

镜像构建阶段会预生成完整的 Mac 伴侣 zip（包含 Web/API、登录页、公共词库和启动器）；运行中的公网容器只读取并下载它，不会为每次下载启动 Python。

正式环境应由 Nginx、Caddy 或云平台终止 HTTPS，并配置：

```dotenv
WORDPAPER_PUBLIC_ORIGIN=https://wordpaper.example.com
TRUST_PROXY=1
```

`TRUST_PROXY=1` 表示只信任一跳受控反向代理：代理必须覆盖或追加 `X-Forwarded-For / Proto / Host`，应用端口必须像 Compose 默认值一样只绑定 `127.0.0.1`，防火墙也不能允许公网绕过代理直连 8770。服务取右侧最后一跳客户端地址，客户端伪造在左侧的 X-Forwarded-For 不会绕过登录与验证码限流。

不要把 SQLite 放在临时 / serverless 文件系统，也不要让多个应用副本同时共享这一个 SQLite 文件。需要水平扩容时，应先把 `lib/storage.js` 的存储适配迁移到 PostgreSQL。

### 迁移到另一台服务器

先停止写入，再备份整个数据卷：

```bash
docker compose stop
docker run --rm \
  -v wordpaper-data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar czf /backup/wordpaper-data.tar.gz -C /data .'
docker compose start
```

把源码、`.env` 和 `wordpaper-data.tar.gz` 复制到新电脑后：

```bash
docker volume create wordpaper-data
docker run --rm \
  -v wordpaper-data:/data \
  -v "$PWD":/backup \
  alpine sh -c 'tar xzf /backup/wordpaper-data.tar.gz -C /data'
docker compose up -d --build
```

数据库、账号、session 和所有用户状态会一起迁移。恢复前不要在目标卷里放另一套数据。

## 两个端口与桌面伴侣

- `8770` 是网页和 API 的唯一应用入口。
- `8771` 仅属于可选的 Mac 桌面伴侣，而且固定绑定 `127.0.0.1`。
- `public` 模式不会在云主机上 probe、spawn 或代理服务器自己的桌面伴侣；相关控制端点返回 404。
- `local` 模式可使用伴侣，但首次使用它的账号会成为这台本地伴侣的 owner，其他 Web 账号不能读取或操控它。
- 公网用户若要自动设置 Mac 壁纸，需要把伴侣安装在自己的 Mac 上。网页主体仍可在 macOS、Windows 和 Linux 的浏览器使用；Apple Vision OCR、`osascript` 壁纸和小词灵窗口是 macOS 专属。

伴侣配置、学习状态、自定义词和窗口位置默认放在 `~/Library/Application Support/WordPaper/companion/`，不再写进源码/解压目录。第一次启动新版伴侣时会把旧目录里的同名文件复制过去，旧文件保留用于回退。可用 `WORDPAPER_COMPANION_DATA_DIR` 改到其他持久目录。

## 静态资源安全边界

服务只公开：

- `/index.html`、`/login.html`
- `/css/**`
- `/js/**`
- `/data/*.json`（公共内置词库）

数据库、源码、`.git`、伴侣配置和用户文件都不在静态白名单中；解码后的路径还会再次做目录 containment 校验。

## 测试

```bash
npm test

# 对一个已经启动的临时测试服务跑真实浏览器账号流程：
WORDPAPER_TEST_BASE_URL=http://127.0.0.1:18991 npm run test:browser
```

服务端测试覆盖：账号 A/B 隔离、session/密码哈希、revision 冲突、停止后重启恢复、敏感文件拒绝、目录穿越拒绝，以及 public 模式禁用桌面伴侣。浏览器测试覆盖：旧 localStorage 安全自动迁移与显式迁移、刷新恢复、退出/切换账号和同一浏览器内 A/B 不串数据。

## Liquid Glass 主题

Liquid 主题把中央展示板、顶栏操作组、预览工具、桌面伴侣入口和弹窗都作为不同厚度的动态玻璃；左右设置区使用更稳定的磨砂材质，避免层层玻璃抢夺内容。进入主题时会联动到壁纸配色里的「玻璃」并使用纯净背景；该配色不自动叠加星点装饰，仍可手动选择其他背景纹理。未选中的配色色块会适度降饱和，避免跳出主题。默认材质是中性珍珠白与冰蓝灰；强调色只用于主操作与焦点状态。

实现依据 Apple 的 [HIG Materials](https://developer.apple.com/design/human-interface-guidelines/materials)、[Meet Liquid Glass](https://developer.apple.com/videos/play/wwdc2025/219/) 和 [Get to know the new design system](https://developer.apple.com/videos/play/wwdc2025/356/)。Web 端的圆角矩形边缘位移、折射缓存、RGB 微色散和降级策略参考了 MIT 许可的 [shuding/liquid-glass](https://github.com/shuding/liquid-glass)、[rdev/liquid-glass-react](https://github.com/rdev/liquid-glass-react) 与 [LiquidGlass-UI](https://github.com/hwyuanzi/LiquidGlass-UI) 的公开思路，项目中采用无运行依赖的原生实现。

玻璃不是单一透明色：运行时会为每块主要表面生成边缘位移贴图，并组合背景模糊、细微 RGB 色散、内外高光和随指针移动的焦散；展示板与弹窗使用更深的位移，按钮按压时会产生短促的液态收缩。壁纸自身也使用多层环境光、宽幅焦散和一块半透明内容玻璃，保证导出结果与界面材质属于同一套语言。

`prefers-reduced-motion` 会关闭环境漂移、弹性与跟随光；`prefers-reduced-transparency` 会让展示板等表面改用高不透明材质；高对比度和强制色模式也有独立回退。

## 词库与渲染脚本

```bash
python3 scripts/build_wordlibs.py
python3 scripts/render_v3.py
```

内置词库来自免费的 [ECDICT](https://github.com/skywind3000/ECDICT) 与开放 JLPT 词表，生成后的公共 JSON 位于 `data/`。
