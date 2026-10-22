#!/usr/bin/env python3
"""Rasterize the site favicon (W mark) into a macOS icon.icns.

Renders the inline SVG favicon at 1024x1024 with a transparent background via
headless Chromium, downsamples the standard iconset sizes with sips, and packs
them with iconutil. Output: assets/icon.icns (committed to the repo so
package_app.py doesn't need Playwright).

Re-run only when the brand mark changes:
    python3 scripts/make_icon.py
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT_DIR = os.path.join(ROOT, "assets")
MASTER = os.path.join(OUT_DIR, "icon-1024.png")
ICONSET = os.path.join(OUT_DIR, "icon.iconset")
ICNS = os.path.join(OUT_DIR, "icon.icns")

# Same artwork as the favicon in index.html, scaled up.
SVG = """<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64' width='1024' height='1024'>
<rect width='64' height='64' rx='18' fill='#f6efff'/>
<path d='M12 17h9l5 25 6-19h7l6 19 5-25h9L50 48h-9l-6-18-6 18h-9z' fill='#a176e5'/>
</svg>"""

SIZES = [  # (filename, px)
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]


def rasterize():
    from playwright.sync_api import sync_playwright
    os.makedirs(OUT_DIR, exist_ok=True)
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 1024, "height": 1024})
        # 不能用 data: URL —— SVG 里的 # 会被当成 fragment 截断
        page.set_content(f"<body style='margin:0'>{SVG}</body>")
        page.locator("svg").screenshot(omit_background=True, path=MASTER)
        browser.close()
    print(f"master -> {MASTER}")


def pack():
    os.makedirs(ICONSET, exist_ok=True)
    for name, px in SIZES:
        subprocess.run(["sips", "-z", str(px), str(px), MASTER,
                        "--out", os.path.join(ICONSET, name)],
                       check=True, capture_output=True)
    subprocess.run(["iconutil", "-c", "icns", ICONSET, "-o", ICNS], check=True)
    print(f"icns  -> {ICNS} ({os.path.getsize(ICNS)//1024} KB)")


if __name__ == "__main__":
    # master 已入库(玻璃卡片+日出设计)。--favicon 可用旧 W 标重新生成 master。
    if "--favicon" in sys.argv:
        try:
            rasterize()
        except Exception as e:  # noqa: BLE001
            sys.exit(f"Playwright 渲染失败(先 pip install playwright && playwright install chromium): {e}")
    elif not os.path.exists(MASTER):
            sys.exit(f"缺 {MASTER}")
    pack()
