#!/usr/bin/env python3
"""Package the desktop companion as a simple, double-clickable zip.

The user experience we're after: download ONE zip → double-click to unzip →
double-click 启动伴侣.command → the wallpaper website + auto desktop wallpaper
+ floating pet window all start. No `node`, no terminal typing.

2026-08-16: 免安装版 —— zip 内自带 Node 运行时(bin/node-arm64 + bin/node-x64),
用户不再需要安装 Node.js。启动器按芯片架构自动选择;自带运行时失效时才回退
系统 node,最后才提示去 nodejs.org(基本不会走到)。

Bundle layout (inside 每日壁纸伴侣.zip):
    每日壁纸伴侣/
        启动伴侣.command      ← double-click this (chmod +x, opens Terminal & runs)
        bin/node-arm64        ← bundled runtime, Apple Silicon
        bin/node-x64          ← bundled runtime, Intel Mac
        server.js + lib/      ← authenticated one-port web/API service
        companion.js          ← local-only Mac integration on 127.0.0.1
        index/login/css/js/   ← complete website
        data/                 ← public word libraries
        使用说明.txt           ← 3-step plain-language guide

Zero third-party deps — uses only the stdlib zipfile.
"""
import os
import stat
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "每日壁纸伴侣.zip")
BUNDLE = "每日壁纸伴侣"
NODE_DIST = os.path.join(HERE, "node-dist")  # 缓存目录,gitignored;fetch_node_dist.py 生成

LAUNCHER = """#!/bin/bash
# WordPaper · 桌面伴侣启动器(免安装版,自带运行时)。
cd "$(dirname "$0")"

echo ""
echo "  🌱 每日壁纸 · 桌面伴侣"
echo "  ────────────────────────────"

# 解除 macOS 对下载文件的隔离标记(不解除的话自带运行库可能被 Gatekeeper 拦)
xattr -dr com.apple.quarantine . 2>/dev/null || true
chmod +x ./bin/node-* 2>/dev/null || true

# 优先用包内自带的 Node 运行时(免安装),按芯片架构选择
ARCH="$(uname -m)"
NODE=""
if [ "$ARCH" = "arm64" ] && [ -x ./bin/node-arm64 ]; then NODE="./bin/node-arm64"; fi
if [ "$ARCH" = "x86_64" ] && [ -x ./bin/node-x64 ]; then NODE="./bin/node-x64"; fi
if [ -n "$NODE" ] && ! "$NODE" -e "require('node:sqlite')" >/dev/null 2>&1; then NODE=""; fi

# 兜底:系统里已装的 Node(版本合适才用)
if [ -z "$NODE" ]; then
  for c in node /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    if [ -x "$(command -v "$c" 2>/dev/null)" ] || [ -x "$c" ]; then NODE="$c"; break; fi
  done
fi
if [ -n "$NODE" ]; then
  NODE_MAJOR="$("$NODE" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  if [ "$NODE_MAJOR" -lt 22 ] || [ "$NODE_MAJOR" -gt 24 ] || ! "$NODE" -e "require('node:sqlite')" >/dev/null 2>&1; then
    NODE=""
  fi
fi

if [ -z "$NODE" ]; then
  echo "  自带的运行库在这台电脑上没能跑起来(很少见)。"
  echo "  可以打开 https://nodejs.org 安装 LTS 版 Node 后再双击本文件。"
  read -n 1 -s -r -p "  按任意键打开下载页…"
  open "https://nodejs.org"
  exit 1
fi

echo "  启动中…  保持这个窗口开着,关掉就停止。"
echo ""

export HOST=127.0.0.1
export PORT=8770
export WORDPAPER_MODE=local
export WORDPAPER_DATA_DIR="${WORDPAPER_DATA_DIR:-$HOME/.wordpaper}"
export WORDPAPER_COMPANION_ENABLED=1
export WORDPAPER_WEB_ORIGIN=http://localhost:8770

SERVER_PID=""
cleanup() {
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

if ! curl -fsS http://127.0.0.1:8770/healthz >/dev/null 2>&1; then
  mkdir -p "$HOME/Library/Logs/wordpaper"
  "$NODE" server.js >>"$HOME/Library/Logs/wordpaper/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    curl -fsS http://127.0.0.1:8770/healthz >/dev/null 2>&1 && break
    sleep 0.25
  done
fi

if ! curl -fsS http://127.0.0.1:8770/healthz >/dev/null 2>&1; then
  echo "  WordPaper 主服务启动失败,请查看 ~/Library/Logs/wordpaper/server.log"
  exit 1
fi

"$NODE" companion.js
"""

README = """每日壁纸 · 桌面伴侣 —— 使用说明
======================================

就 3 步,不用安装任何东西:

  1. 解压这个 zip(双击即可)。
  2. 双击文件夹里的「启动伴侣.command」。
  3. 第一次 macOS 可能会拦一下:
     右键点它 →「打开」→ 再点「打开」。以后双击就能直接跑。

跑起来之后(保持那个黑色窗口开着就行):

  • 自动把你的 Mac 桌面壁纸换成今日单词,每 30 分钟换一组。
  • 屏幕角落有个常驻小窗,显示今天的单词和提醒。
  • 浏览器会打开 http://localhost:8770;首次使用请创建自己的账号。
  • 词库、提醒和复习数据保存在 ~/.wordpaper,更新或移动本文件夹也不会丢。

不想自动换桌面壁纸了?
  打开 ~/Library/Application Support/WordPaper/companion/companion-config.json,把
  "autoSetWallpaper": true 改成 false,再重新双击启动即可。

包内已自带运行环境(Apple 芯片和 Intel 芯片的 Mac 都支持),
不需要安装 Node.js 或任何其他软件。
"""


def add_file(zf, src, arc, mode=None):
    """Write a file into the zip, optionally forcing a unix mode (for +x)."""
    with open(src, "rb") as f:
        data = f.read()
    zi = zipfile.ZipInfo(arc)
    zi.date_time = (2026, 8, 7, 0, 0, 0)
    if mode is not None:
        zi.external_attr = (stat.S_IFREG | mode) << 16
    else:
        zi.external_attr = (stat.S_IFREG | 0o644) << 16
    zi.compress_type = zipfile.ZIP_DEFLATED
    zf.writestr(zi, data)


def main():
    data_dir = os.path.join(ROOT, "data")
    words = sorted(f for f in os.listdir(data_dir)
                   if f.startswith("words_") and f.endswith(".json"))
    if not words:
        raise SystemExit("data/words_*.json 不存在,先跑 scripts/build_wordlibs.py")

    node_bins = []
    for arch in ("arm64", "x64"):
        p = os.path.join(NODE_DIST, f"node-{arch}")
        if os.path.exists(p):
            node_bins.append((p, arch))
    if not node_bins:
        print("⚠️  scripts/node-dist/ 里没有自带运行时,打成需要系统 Node 的旧版 zip。"
              "先跑 scripts/fetch_node_dist.py 可获得免安装包。")

    if os.path.exists(OUT):
        os.remove(OUT)

    with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as zf:
        # launcher (executable)
        zi = zipfile.ZipInfo(f"{BUNDLE}/启动伴侣.command")
        zi.date_time = (2026, 8, 7, 0, 0, 0)
        zi.external_attr = (stat.S_IFREG | 0o755) << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(zi, LAUNCHER)
        # bundled Node runtimes (executable) — 免安装的关键
        for path, arch in node_bins:
            add_file(zf, path, f"{BUNDLE}/bin/node-{arch}", mode=0o755)
        # Complete portable local service + website.
        for name in ("server.js", "companion.js", "index.html", "login.html", "connect.html", "pet-chat.html", "pet-sentence.html", "package.json", ".node-version"):
            add_file(zf, os.path.join(ROOT, name), f"{BUNDLE}/{name}")
        for directory in ("lib", "css", "js", "data", "assets"):
            source_dir = os.path.join(ROOT, directory)
            for current, dirs, files in os.walk(source_dir):
                dirs[:] = sorted(d for d in dirs if not d.startswith("."))
                for name in sorted(files):
                    if name.startswith("."):
                        continue
                    source = os.path.join(current, name)
                    relative = os.path.relpath(source, ROOT)
                    add_file(zf, source, f"{BUNDLE}/{relative}")
        add_file(zf, os.path.join(ROOT, "scripts", "package_companion.py"), f"{BUNDLE}/scripts/package_companion.py")
        # readme
        zi = zipfile.ZipInfo(f"{BUNDLE}/使用说明.txt")
        zi.date_time = (2026, 8, 7, 0, 0, 0)
        zi.external_attr = (stat.S_IFREG | 0o644) << 16
        zi.compress_type = zipfile.ZIP_DEFLATED
        zf.writestr(zi, README)

    size = os.path.getsize(OUT)
    print(f"打包完成 -> {OUT}  ({size/1024/1024:.1f} MB, 含 {len(words)} 个词库, 运行时 {len(node_bins)} 个)")


if __name__ == "__main__":
    main()
