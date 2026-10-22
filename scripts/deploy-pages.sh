#!/usr/bin/env bash
# Deploy WordPaper static site to Cloudflare Pages (https://wordpaper.pages.dev/)
# 只上传纯静态文件,不含 server/companion/登录等本地服务端文件。
set -euo pipefail

cd "$(dirname "$0")/.."
STAGE="$(mktemp -d /tmp/wordpaper-pages.XXXXXX)"
trap 'rm -rf "$STAGE"' EXIT

cp index.html "$STAGE/"
cp -R assets css js lib data "$STAGE/"
rm -f "$STAGE/assets/icon.icns" "$STAGE/assets/icon-1024.png"   # 桌面包专用资源不上静态站(省体积)
rm -f "$STAGE/js/auth.js"   # auth 只属于本地伴侣端

# 桌面伴侣 DMG(App 形态,44MB/45MB/1.6MB)超过 CF Pages ~25MiB 单文件上限,
# 托管 GitHub Releases;app.js 下载弹窗指 releases/latest/download/<name>。
# 更新流程:python3 scripts/package_app.py && gh release upload companion-v2.0.0 scripts/dist/*.dmg --clobber

npx wrangler pages deploy "$STAGE" --project-name wordpaper --commit-dirty=true
echo "✅ https://wordpaper.pages.dev/"
