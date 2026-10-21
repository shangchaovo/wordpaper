#!/usr/bin/env python3
"""Build WordPaper.app (zero-install Mac companion) and package it as DMGs.

Variants (uploaded to GitHub Releases, linked from the site's download modal):
  WordPaper-macOS-AppleSilicon.dmg  — bundled node-arm64, ~44MB, offline-ready
  WordPaper-macOS-Intel.dmg         — bundled node-x64,   ~45MB, offline-ready
  WordPaper-macOS-Slim.dmg          — no runtime, ~1.6MB; launcher downloads Node
                                      on first launch (npmmirror CDN first,
                                      nodejs.org fallback, SHA256-verified)

CFBundleExecutable is a tiny UNIVERSAL (arm64+x86_64) C stub that execs
MacOS/launcher.sh — a pure-script executable makes LaunchServices classify the
bundle as Intel-only and Apple-Silicon Macs without Rosetta get the
"你需要安装 Rosetta" prompt. The stub kills that prompt for good.

DMG window is dressed like a real installer: assets/dmg-background.png baked
background (arrow + Gatekeeper hint), icons pinned to fixed positions, custom
volume icon. Done via the classic UDRW → attach rw → Finder AppleScript layout
→ detach → convert UDZO pipeline (a Finder window briefly opens on the build
machine during packaging — that's the layout step, not an error).

Prereqs:
  - assets/icon.icns            (python3 scripts/make_icon.py)
  - assets/dmg-background.png   (python3 scripts/make_dmg_bg.py)
  - scripts/node-dist/node-arm64|node-x64  (official v24.19.0 bin/node; only
    needed for the full variants — slim builds without them)
  - clang (Xcode CLT) for the universal stub

Output: scripts/dist/*.dmg

Launcher runtime resolution order (Contents/MacOS/launcher.sh):
  1. Resources/bin/node-<arch>          (bundled — full variants)
  2. ~/.wordpaper/runtime/node-<arch>   (cached from a previous slim download)
  3. system Node 22–24 with node:sqlite (dev machines)
  4. download tarball, verify SHA256, cache under ~/.wordpaper/runtime
Self-test hooks (used by CI-ish checks, harmless for users):
  WORDPAPER_SELFTEST=1       resolve runtime, print it, exit before serving
  WORDPAPER_FORCE_DOWNLOAD=1 skip steps 1–3 to exercise the download path
  WORDPAPER_SKIP_COMPANION=1 start server only (no pet/wallpaper)
  WORDPAPER_RUNTIME_DIR      override the runtime cache location

The app is UNSIGNED: first launch needs 系统设置→隐私与安全性→仍要打开 once
(documented in 使用说明.txt on the DMG and in the site's download modal).
Developer-ID signing + notarization can be layered on later without changing
the bundle layout.
"""
import os
import plistlib
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BUILD = os.path.join(HERE, "build")
DIST = os.path.join(HERE, "dist")
NODE_DIST = os.path.join(HERE, "node-dist")
ICON = os.path.join(ROOT, "assets", "icon.icns")
DMG_BG = os.path.join(ROOT, "assets", "dmg-background.png")

APP_NAME = "WordPaper.app"
EXEC_NAME = "WordPaper"
BUNDLE_ID = "cc.cd.wordpaper.companion"
# 版本号唯一来源是仓库根的 VERSION 文件;独立版启动后拿它跟 GitHub main 比对出新版本提示。
VERSION = open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip()
VOLNAME = "WordPaper 每日壁纸"

PAYLOAD_FILES = ["server.js", "companion.js", "package.json", "index.html", "login.html", "VERSION"]
PAYLOAD_DIRS = ["lib", "css", "js", "data"]

# Universal launcher stub: LaunchServices 只认 Mach-O 的架构;纯脚本可执行文件
# 会被当成 Intel-only,Apple 芯片机器上弹「需要安装 Rosetta」。stub 找到同目录
# 的 launcher.sh 并 exec /bin/bash(系统 bash 是 universal,不会触发 Rosetta)。
STUB_C = r'''#include <libgen.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

int main(int argc, char **argv) {
    (void)argc;
    char self[PATH_MAX];
    if (!realpath(argv[0], self)) return 1;
    char script[PATH_MAX];
    snprintf(script, sizeof(script), "%s/launcher.sh", dirname(self));
    execl("/bin/bash", "bash", script, (char *)NULL);
    return 1;
}
'''

LAUNCHER = r'''#!/bin/bash
# WordPaper 每日壁纸 · Mac 桌面伴侣启动器(由 Contents/MacOS/WordPaper stub 拉起)。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
RES="$(cd "$HERE/../Resources" && pwd)"
cd "$RES"

ARCH="$(uname -m)"   # arm64 | x86_64
NODE_VER="v24.19.0"
NODE_DIST="darwin-arm64"; [ "$ARCH" = "x86_64" ] && NODE_DIST="darwin-x64"
SHA_EXPECT="8294b7aa9b03997481c06babf1e8b270c859358f27da57a11509afe537ac381d"
[ "$ARCH" = "x86_64" ] && SHA_EXPECT="d1b5e999db158c62fe8f7267a4476b035d8bd93b1a605bac24a3f0dd166e3316"
RUNTIME_DIR="${WORDPAPER_RUNTIME_DIR:-$HOME/.wordpaper/runtime}"
LOG_DIR="$HOME/Library/Logs/wordpaper"
mkdir -p "$LOG_DIR"
SELFTEST="${WORDPAPER_SELFTEST:-0}"

ok_sqlite() { "$1" -e "require('node:sqlite')" >/dev/null 2>&1; }

wp_alert() {  # 纯提示弹窗(消息经环境变量传入,避免引号地狱)
  WP_MSG="$1" /usr/bin/osascript -e 'display dialog (system attribute "WP_MSG") buttons {"好"} default button 1 with title "WordPaper 每日壁纸" with icon note' >/dev/null 2>&1 || true
}
wp_confirm() { # 取消/继续:选「继续」返回 0
  WP_MSG="$1" /usr/bin/osascript -e 'display dialog (system attribute "WP_MSG") buttons {"取消","继续"} default button 2 with title "WordPaper 每日壁纸" with icon note' >/dev/null 2>&1
}

# ── 运行时解析:包内 → 缓存 → 系统 → 下载 ──────────────────────
NODE=""
if [ -x "$RES/bin/node-$ARCH" ] && ok_sqlite "$RES/bin/node-$ARCH"; then NODE="$RES/bin/node-$ARCH"; fi
if [ -z "$NODE" ] && [ -x "$RUNTIME_DIR/node-$ARCH" ] && ok_sqlite "$RUNTIME_DIR/node-$ARCH"; then NODE="$RUNTIME_DIR/node-$ARCH"; fi
if [ -z "$NODE" ]; then
  for c in node /usr/local/bin/node /opt/homebrew/bin/node "$HOME/.nvm/versions/node"/*/bin/node; do
    { [ -x "$(command -v "$c" 2>/dev/null)" ] || [ -x "$c" ]; } || continue
    maj="$("$c" -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
    if [ "$maj" -ge 22 ] 2>/dev/null && [ "$maj" -le 24 ] 2>/dev/null && ok_sqlite "$c"; then NODE="$c"; break; fi
  done
fi
[ "${WORDPAPER_FORCE_DOWNLOAD:-0}" = "1" ] && NODE=""   # 测试钩子:强制走下载

if [ -z "$NODE" ]; then
  if [ "$SELFTEST" != "1" ]; then
    wp_confirm "$(printf '首次使用需要下载运行环境(约 40MB,只此一次,之后离线可用)。\n\n来自淘宝 NPM 镜像或 nodejs.org 的官方文件,已做完整性校验。需要联网。')" || exit 1
  fi
  mkdir -p "$RUNTIME_DIR"
  TGZ="$RUNTIME_DIR/node-$NODE_DIST.tar.gz"
  DLG=""
  if [ "$SELFTEST" != "1" ]; then
    WP_MSG="正在下载运行环境…(完成后此提示自动关闭)" /usr/bin/osascript -e 'display dialog (system attribute "WP_MSG") buttons {"请稍候"} default button 1 with title "WordPaper 每日壁纸" giving up after 1800' >/dev/null 2>&1 &
    DLG=$!
  fi
  OK=0
  for BASE in "https://registry.npmmirror.com/-/binary/node" "https://nodejs.org/dist"; do
    echo "下载运行时: $BASE/$NODE_VER/node-$NODE_VER-$NODE_DIST.tar.gz" >>"$LOG_DIR/server.log"
    if curl -fL --connect-timeout 15 --retry 2 -o "$TGZ" "$BASE/$NODE_VER/node-$NODE_VER-$NODE_DIST.tar.gz" 2>>"$LOG_DIR/server.log"; then
      GOT="$(shasum -a 256 "$TGZ" | awk '{print $1}')"
      if [ "$GOT" = "$SHA_EXPECT" ]; then OK=1; break; fi
      echo "SHA256 不匹配: $GOT" >>"$LOG_DIR/server.log"
    fi
  done
  [ -n "$DLG" ] && kill "$DLG" 2>/dev/null
  if [ "$OK" = "1" ]; then
    tar -xzf "$TGZ" -C "$RUNTIME_DIR" "node-$NODE_VER-$NODE_DIST/bin/node"
    mv "$RUNTIME_DIR/node-$NODE_VER-$NODE_DIST/bin/node" "$RUNTIME_DIR/node-$ARCH"
    rm -rf "$RUNTIME_DIR/node-$NODE_VER-$NODE_DIST" "$TGZ"
    chmod +x "$RUNTIME_DIR/node-$ARCH"
    ok_sqlite "$RUNTIME_DIR/node-$ARCH" && NODE="$RUNTIME_DIR/node-$ARCH"
  fi
fi

if [ -z "$NODE" ]; then
  wp_alert "$(printf '运行环境准备失败:请检查网络后重试。\n也可以先到 nodejs.org 免费安装 Node.js(LTS 版),再打开本 App。')"
  open "https://nodejs.org" >/dev/null 2>&1 &
  exit 1
fi

if [ "$SELFTEST" = "1" ]; then echo "SELFTEST OK: NODE=$NODE"; "$NODE" -v; exit 0; fi

# ── 应用内更新旗标:server.js 的 /api/update/apply 替换完 Resources 后写下此文件
#    并自行退出;走到进程尾部的 launcher 看到它,清理后自动重启整个服务链,
#    用户全程只需点一次「一键更新」。─────────────────────────────────
UPDATE_FLAG="$HOME/.wordpaper/update-pending.json"
restart_requested() { [ -f "$UPDATE_FLAG" ]; }
clear_restart_flag() { rm -f "$UPDATE_FLAG" 2>/dev/null; }
clear_restart_flag

# ── 主服务 + 伴侣 ─────────────────────────────────────────────
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8770}"
export WORDPAPER_MODE="${WORDPAPER_MODE:-local}"
export WORDPAPER_DATA_DIR="${WORDPAPER_DATA_DIR:-$HOME/.wordpaper}"
export WORDPAPER_COMPANION_ENABLED=1
export WORDPAPER_WEB_ORIGIN="${WORDPAPER_WEB_ORIGIN:-http://localhost:$PORT}"
COMP_PORT="${WORDPAPER_COMPANION_PORT:-8771}"
# 钉死伴侣端口:server.js 的代理/状态探测和 companion.js 的 bind 都以它为准,
# 不受 companion-config.json 里旧配置影响——否则 launcher 探的口和伴侣绑的口可能不一致。
export WORDPAPER_COMPANION_PORT="$COMP_PORT"
export WORDPAPER_PORT="$COMP_PORT"

SERVER_PID=""
COMP_PID=""
cleanup() {
  [ -n "$COMP_PID" ] && kill "$COMP_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
}
trap cleanup EXIT INT TERM

server_up() { curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; }
companion_up() { curl -fsS "http://127.0.0.1:$COMP_PORT/status.json" >/dev/null 2>&1; }

# ── 版本闸门:在跑的实例版本和本包不一致时(比如没退旧版就装了新版),
#    只替换从某个 WordPaper.app 启动的进程——别人/开发版实例绝不乱动。
#    旧版 healthz 不带 version 字段,读到空串也算不一致。────────────────
bundle_process() {  # $1=pid;该进程的工作目录在某个 WordPaper.app 里才算我们的实例
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | grep -q "WordPaper.app/Contents/Resources"
}
if server_up; then
  RUNNING_VER="$(curl -fsS "http://127.0.0.1:$PORT/healthz" 2>/dev/null | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')"
  MY_VER="$(cat "$RES/VERSION" 2>/dev/null)"
  if [ -n "$MY_VER" ] && [ "$RUNNING_VER" != "$MY_VER" ]; then
    for port in "$PORT" "$COMP_PORT"; do
      for p in $(lsof -nP -tiTCP:$port -sTCP:LISTEN 2>/dev/null); do
        bundle_process "$p" && kill "$p" 2>/dev/null
      done
    done
    sleep 1
  fi
fi

# ── 已在运行:再次双击 = 回到应用(真·Mac 应用行为)。
#    没有这一步时,重复双击会让第二个伴侣撞 EADDRINUSE 秒退,
#    从用户看就是「双击图标毫无反应」。─────────────────────────
if server_up && companion_up; then
  open "http://localhost:$PORT"
  exit 0
fi

# ── 主服务 ──────────────────────────────────────────────────
if ! server_up; then
  "$NODE" server.js >>"$LOG_DIR/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    server_up && break
    sleep 0.25
  done
fi
if ! server_up; then
  wp_alert "$(printf 'WordPaper 主服务启动失败。\n请把日志文件发给开发者:\n%s/server.log' "$LOG_DIR")"
  exit 1
fi

if [ "${WORDPAPER_SKIP_COMPANION:-0}" = "1" ]; then
  echo "server up at :$PORT (companion skipped)"
  wait "$SERVER_PID"
  exit 0
fi

# ── 伴侣端口残留清理。走到这里说明伴侣没在跑或只剩半吊子状态:
#    上次异常退出(断电/强制退出)留下的旧伴侣占着 8771 不放,
#    新伴侣会 bind 失败秒退。只清理由 companion.js 占用的进程。───
STALE="$(lsof -nP -tiTCP:$COMP_PORT -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "$STALE" ]; then
  for p in $STALE; do
    if ps -p "$p" -o command= 2>/dev/null | grep -q "companion.js"; then
      kill "$p" 2>/dev/null || true
    else
      wp_alert "$(printf '端口 %s 被其它程序占用,小词灵无法启动。\n请退出占用该端口的程序后重新打开。' "$COMP_PORT")"
      exit 1
    fi
  done
  for _ in $(seq 1 20); do
    [ -z "$(lsof -nP -tiTCP:$COMP_PORT -sTCP:LISTEN 2>/dev/null || true)" ] && break
    sleep 0.25
  done
fi

# ── 桌面伴侣(小词灵 / 自动壁纸 / 热键,并打开网页) ────────────
"$NODE" companion.js >>"$LOG_DIR/companion.log" 2>&1 &
COMP_PID=$!
sleep 1.5
if ! kill -0 "$COMP_PID" 2>/dev/null; then
  wp_alert "$(printf '小词灵启动失败。\n请把日志文件发给开发者:\n%s/companion.log' "$LOG_DIR")"
  exit 1
fi
wait "$COMP_PID"
# 服务链退出后:若是应用内更新的预期退出(UPDATE_FLAG 在),exec 重入本脚本,
# 重新走一遍完整启动流程(含版本闸门 + 端口清理 + 小词灵复活)。
if restart_requested; then
  clear_restart_flag
  echo "update applied: restarting service chain" >>"$LOG_DIR/server.log"
  for _ in $(seq 1 20); do server_up || break; sleep 0.25; done
  exec "$0"
fi
'''

README_COMMON = """每日壁纸 WordPaper · Mac 桌面伴侣
================================

安装(10 秒):
  1. 把「WordPaper」拖到右边的「应用程序」文件夹。
  2. 到「应用程序」里双击 WordPaper 的图标。

★ 第一次打开会被 macOS 拦一下(所有没交苹果年费的免费软件都会,
  不是病毒,放心):
  1. 弹窗里点「完成」——千万别点「移到废纸篓」!
  2. 打开「系统设置」→「隐私与安全性」,拉到最下面,
     会看到「已阻止 WordPaper…」,点右边的「仍要打开」。
  3. 再点「打开」(可能要按指纹或输开机密码)。
  这一步只需要做一次,以后双击直接用,永远不再拦。

★ 如果提示「需要安装 Rosetta」:点「以后」就好。
  那是下错了芯片版本(Intel 版装到了 Apple 芯片电脑上),
  伴侣会自动换成适合的运行环境,不影响使用;
  更省事的做法是回下载页改选「Apple 芯片版」。

{extra}
跑起来之后:
  • 自动把桌面壁纸换成今天的单词,每 30 分钟换一组。
  • 屏幕角落有常驻的「小词灵」窗,点词卡就是学习。
  • 浏览器会打开 http://localhost:8770 ,首次使用请创建账号。
  • 数据保存在 ~/.wordpaper ,删掉 App 也不会丢。
  • 已经在运行时再次双击图标,会重新打开浏览器里的页面,
    不会重复启动——看到「没反应」时先看浏览器是不是已经开着了。

退出:程序坞(Dock)里右键 WordPaper 图标 →「退出」。

不想自动换桌面壁纸?
  编辑 ~/Library/Application Support/WordPaper/companion/companion-config.json,
  把 "autoSetWallpaper": true 改成 false,重新打开 App 即可。
"""

README_SLIM_EXTRA = """★ 这个「国内加速版」第一次打开时会自动下载运行环境(约 40MB,
  走国内高速镜像,一般 10~30 秒),只下载这一次,之后离线可用。

"""

VARIANTS = [
    # (key, dmg name, bundled arch or None)
    ("arm64", "WordPaper-macOS-AppleSilicon.dmg", "arm64"),
    ("x64", "WordPaper-macOS-Intel.dmg", "x64"),
    ("slim", "WordPaper-macOS-Slim.dmg", None),
]

# DMG 窗口排版(逻辑坐标,窗口 660x420):app 左、Applications 右、说明书左下。
# 背景图里已画好箭头与提示文字,与这些坐标对齐(make_dmg_bg.py)。
DMG_WINDOW_RECT = ((400, 100), (660, 420))
DMG_ICON_LOCATIONS = {
    "WordPaper.app": (170, 160),
    "Applications": (490, 160),
    "使用说明.txt": (80, 385),
}


def log(msg):
    print(msg, flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, check=True, capture_output=True, text=True, **kw)


def build_app(dest, bundled_arch):
    """Create WordPaper.app at dest; bundled_arch='arm64'|'x64'|None."""
    if os.path.exists(dest):
        shutil.rmtree(dest)
    macos = os.path.join(dest, "Contents", "MacOS")
    res = os.path.join(dest, "Contents", "Resources")
    os.makedirs(macos)
    os.makedirs(res)

    # Info.plist
    plist = {
        "CFBundleDevelopmentRegion": "zh_CN",
        "CFBundleDisplayName": "每日壁纸 WordPaper",
        "CFBundleExecutable": EXEC_NAME,
        "CFBundleIconFile": "icon",
        "CFBundleIdentifier": BUNDLE_ID,
        "CFBundleInfoDictionaryVersion": "6.0",
        "CFBundleName": "WordPaper",
        "CFBundlePackageType": "APPL",
        "CFBundleShortVersionString": VERSION,
        "CFBundleVersion": VERSION,
        "LSMinimumSystemVersion": "13.0",
        "NSHighResolutionCapable": True,
    }
    with open(os.path.join(dest, "Contents", "Info.plist"), "wb") as f:
        plistlib.dump(plist, f)

    # universal stub (CFBundleExecutable) + the real logic in launcher.sh
    stub_c = os.path.join(BUILD, "wordpaper_stub.c")
    with open(stub_c, "w") as f:
        f.write(STUB_C)
    run(["clang", "-arch", "arm64", "-arch", "x86_64", "-O2",
         "-mmacosx-version-min=12.0", "-o", os.path.join(macos, EXEC_NAME), stub_c])
    launcher = os.path.join(macos, "launcher.sh")
    with open(launcher, "w") as f:
        f.write(LAUNCHER)
    os.chmod(launcher, 0o755)

    # payload
    for name in PAYLOAD_FILES:
        shutil.copy2(os.path.join(ROOT, name), os.path.join(res, name))
    for d in PAYLOAD_DIRS:
        shutil.copytree(
            os.path.join(ROOT, d), os.path.join(res, d),
            ignore=shutil.ignore_patterns(".*", "__pycache__"),
        )
    shutil.copy2(ICON, os.path.join(res, "icon.icns"))

    # RELEASE_SHA256.json — 应用内自更新(/api/update/apply)用它在 rsync 后
    # 校验各文件完整落地。逐文件记录「刚拷进本 bundle 的那一份」的摘要。
    import hashlib, json as _json
    manifest = {"version": VERSION, "files": {}}
    for name in PAYLOAD_FILES:
        digest = hashlib.sha256(open(os.path.join(res, name), "rb").read()).hexdigest()
        manifest["files"][name] = digest
    for d in PAYLOAD_DIRS:
        base = os.path.join(res, d)
        for root_dir, _dirs, names in os.walk(base):
            for fn in sorted(names):
                if fn.startswith("."):
                    continue
                fp = os.path.join(root_dir, fn)
                rel = os.path.relpath(fp, res)
                manifest["files"][rel] = hashlib.sha256(open(fp, "rb").read()).hexdigest()
    with open(os.path.join(res, "RELEASE_SHA256.json"), "w", encoding="utf-8") as f:
        _json.dump(manifest, f, ensure_ascii=False, indent=1, sort_keys=True)

    # bundled runtime
    if bundled_arch:
        src = os.path.join(NODE_DIST, f"node-{bundled_arch}")
        if not os.path.exists(src):
            raise SystemExit(f"缺自带运行时: {src}(见 scripts/node-dist/README)")
        bin_dir = os.path.join(res, "bin")
        os.makedirs(bin_dir)
        node_name = "node-x86_64" if bundled_arch == "x64" else f"node-{bundled_arch}"
        shutil.copy2(src, os.path.join(bin_dir, node_name))
        os.chmod(os.path.join(bin_dir, node_name), 0o755)


def eject_stale(extra_paths):
    """弹出所有挂着同名卷或来自我们镜像的残留挂载。

    曾经挂过同卷名镜像(比如验证时忘了 detach)时,Finder 的
    `tell disk "<volname>"` 会解析到旧卷,排版打在那上面直接 AppleEvent 超时。
    """
    info = subprocess.run(["hdiutil", "info"], capture_output=True, text=True).stdout
    for block in re.split(r"={10,}", info):
        if any(p in block for p in extra_paths) or f"/Volumes/{VOLNAME}" in block:
            for dev in sorted(set(re.findall(r"/dev/disk\d+(?!s)", block)), reverse=True):
                subprocess.run(["hdiutil", "detach", dev, "-force"], capture_output=True)


def make_dmg(stage, out_path):
    """stage → 排版好的只读 UDZO DMG(背景图 + 图标定位 + 卷标图标)。

    用 dmgbuild 程序化写 .DS_Store,不走 Finder AppleScript——本机实测
    所有碰 Finder 窗口的 AppleEvent 都会超时(macOS 26 的窗口事件异常)。
    """
    import dmgbuild
    eject_stale([out_path])
    if os.path.exists(out_path):
        os.remove(out_path)
    dmgbuild.build_dmg(
        out_path,
        VOLNAME,
        settings={
            "files": [
                (os.path.join(stage, APP_NAME), APP_NAME),
                (os.path.join(stage, "使用说明.txt"), "使用说明.txt"),
            ],
            "symlinks": {"Applications": "/Applications"},
            "icon": ICON,
            "background": DMG_BG,
            "window_rect": DMG_WINDOW_RECT,
            "default_view": "icon-view",
            "icon_size": 96,
            "icon_locations": DMG_ICON_LOCATIONS,
            "show_status_bar": False,
            "show_toolbar": False,
            "format": "UDZO",
        },
        lookForHiDPI=False,
    )


def ensure_dmgbuild():
    """dmgbuild 只在打包机需要,装在 scripts/.venv-build;缺了自动切过去重跑。

    注意 venv 的 bin/python 是指向基础解释器的软链,realpath 会穿透它导致
    误判「已经在 venv 里」——必须比较未解析的路径,并加环境变量防死循环。
    """
    try:
        import dmgbuild  # noqa: F401
        return
    except ImportError:
        pass
    venv_py = os.path.join(HERE, ".venv-build", "bin", "python")
    already = os.path.abspath(sys.executable) == os.path.abspath(venv_py)
    if (os.path.exists(venv_py) and not already
            and os.environ.get("WP_BUILD_VENV") != "1"):
        os.execve(venv_py, [venv_py, os.path.abspath(__file__)] + sys.argv[1:],
                  {**os.environ, "WP_BUILD_VENV": "1"})
    raise SystemExit("缺 dmgbuild:python3 -m venv scripts/.venv-build && "
                     "scripts/.venv-build/bin/pip install dmgbuild")


def main():
    ensure_dmgbuild()
    if not os.path.exists(ICON):
        raise SystemExit("缺 assets/icon.icns,先跑 python3 scripts/make_icon.py")
    if not os.path.exists(DMG_BG):
        raise SystemExit("缺 assets/dmg-background.png,先跑 python3 scripts/make_dmg_bg.py")
    shutil.rmtree(BUILD, ignore_errors=True)
    os.makedirs(BUILD, exist_ok=True)
    os.makedirs(DIST, exist_ok=True)

    results = []
    for key, dmg_name, arch in VARIANTS:
        stage = os.path.join(BUILD, f"stage-{key}")
        os.makedirs(stage)
        app_dest = os.path.join(stage, APP_NAME)
        log(f"· 构建 {APP_NAME} ({key})…")
        build_app(app_dest, arch)
        os.symlink("/Applications", os.path.join(stage, "Applications"))
        extra = README_SLIM_EXTRA if arch is None else ""
        with open(os.path.join(stage, "使用说明.txt"), "w") as f:
            f.write(README_COMMON.format(extra=extra))
        out = os.path.join(DIST, dmg_name)
        log(f"· 打包排版 {dmg_name}…")
        make_dmg(stage, out)
        mb = os.path.getsize(out) / 1024 / 1024
        results.append((dmg_name, mb))
        log(f"  ✓ {dmg_name}  {mb:.1f} MB")

    log(f"\n完成。gh release upload companion-v{VERSION} scripts/dist/*.dmg 即上传到对应 Release:")
    for name, mb in results:
        log(f"  {name}  {mb:.1f} MB")


if __name__ == "__main__":
    sys.exit(main())
