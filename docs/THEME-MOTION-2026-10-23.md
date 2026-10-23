# 主题切换动效调整

基于当前四套界面主题与既有预览性能优化，增加约 460ms 的整页材质交接。方向参考 [Apple Motion 指南](https://developer.apple.com/design/human-interface-guidelines/motion)：动效辅助状态理解，克制使用，并尊重减少动态效果偏好。

## 第二轮打磨（同日，Claude Code 接续）

在整页主题交接之上，把其余"啪一下消失/出现"的表面也补齐成同一种材质语言：

- **弹窗退场**：四个弹窗（导入 / 词书 / 记忆本 / 下载）统一走 `closeModal()`——先播 190ms 落回（遮罩淡出 + 卡片下沉缩近），动画结束才置 `hidden`；`animationend` 与兜底定时器双保险，`prefers-reduced-motion` 或老浏览器直接瞬时关闭。
- **实时模式**：进入时全屏画布 420ms 淡入合拢（scale .988→1），退出 260ms 淡出后再 `hidden`。
- **登录页分段控件**：登录/注册的白色指示块像工作台主题滑块一样滑动（340ms 减速曲线），面板文字切换带 260ms 轻淡入；出错提示改为短距浮起，不再硬切。
- 两个既有测试对"关闭后立即 hidden"的断言改为 ≤800ms 轮询（动画期间 hidden 尚未置位是预期行为）：`scripts/e2e.py` 的「导入弹窗可关闭」与 `scripts/test_memory_scroll.py` 的「可正常关闭记忆本」。
- 修正 `AGENTS.md` 中过期的断言数（e2e 55→73、render 7→9，与 `CLAUDE.md` 及实际一致）。

## 实现

- 支持 View Transitions 的浏览器把旧画面整体淡出，新画面保持完整不透明，避免渐变、卡片与壁纸分别跳变；只动画快照透明度，不新增全屏动态模糊或缩放。
- 等 `refresh(false)` 完成画布绘制后再捕获新画面。更新回调内不能等待 rAF：浏览器暂停绘制时会把捕获拖到超时。主题滑块在该阶段同步测量一次。
- 选择滑块使用 460ms 减速曲线；主题按钮独立于整页淡出层，保持文字清晰。重复选择不重绘，快速连点仅保留最后一次选择。
- 原生快照期间浏览器不对已捕获的元素执行鼠标命中测试，见 [W3C View Transitions](https://www.w3.org/TR/css-view-transitions-1/)。因此只对被重定向到 html 的主题区域点击按当前按钮边界处理，键盘和普通点击仍使用真实按钮；不转发页面其他操作。
- 光学控件测量等主题过渡结束再执行。页面卡片保持原有一次性入场，不因切换主题重播。
- 减少动态效果时跳过快照并关闭滑块过渡；不支持该 API 时使用有限范围的颜色过渡；捕获失败会清理状态并允许继续切换。
- 更新资源查询版本，刷新开发网页会载入新 CSS/JS。没有修改 VERSION、重新打包或安装独立版。

## 验证

`npm run test:motion` 使用临时账号、数据库与端口，并以 public 模式禁用本机伴侣控制，避免影响真实桌面。截图和诊断时序默认输出 `/tmp/wordpaper-theme-motion/`。

在本机系统 Chrome 与已安装的 Playwright WebKit 引擎上均通过以下 7 组检查：

1. 整页淡出实际启动，壁纸在捕获前完成，入场动画不重播。
2. 四主题切换、选择态一致、重复选择无操作。
3. 快照期间真实鼠标连续点击，最终选择生效，中间请求不逐个播放。
4. 人为重复快照名称使捕获失败后恢复，无未处理 Promise 拒绝。
5. 减少动态效果时不创建快照、滑块过渡关闭。
6. 无 API 降级，以及刷新后主题持久化。
7. 390px 手机布局无横向溢出、无页面 JavaScript 错误。

`python3 scripts/e2e.py` 通过 **73/73**，包括 Liquid 跟随光/按压反馈。可选 SheetJS CDN 连接失败仍按原测试规则排除。`node --check js/app.js` 与 `git diff --check` 通过。

WebKit 测试命令（此路径仅适用于当前机器）：

```sh
python3 scripts/test_theme_motion.py --browser webkit \
  --executable-path /Users/xieshangchao/Library/Caches/ms-playwright/webkit-2272/pw_run.sh \
  --output /tmp/wordpaper-theme-motion-webkit
```

这是引擎与功能回归，不等于实机 Safari 的帧率认证。无头浏览器的快照准备耗时受软件渲染、截图与测试负载影响，未据此宣称稳定 60/120fps。生产独立版需要重新构建安装后才会包含这轮改动。
