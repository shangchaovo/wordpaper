#!/usr/bin/env python3
"""Build the compact Patrick sprite sheets for the desktop pet.

Source: the Codex pet spritesheet (~/.codex/pets/patrick/spritesheet.webp,
8x11 grid of 192x208 cells, transparent background). We keep only the frames
the roaming pet actually animates, laid out in a dense 6x4 grid, and emit two
files: sheet.png (frames face right / forward) and sheet_flip.png (whole sheet
mirrored, so frame (r,c) flipped == frame (r, 5-c) facing the other way).

Re-run after replacing the source sheet: python3 scripts/build_patrick_sheet.py
"""
import os
import sys

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "assets", "patrick")
SRC_CANDIDATES = [
    os.path.expanduser("~/.codex/pets/patrick/spritesheet.webp"),
    os.path.join(ROOT, "assets", "patrick", "source_sheet.png"),
]

CELL_W, CELL_H = 192, 208
COLS, ROWS = 6, 4

# slot -> (row, col) in the source sheet. Keep in sync with companion.js
# PATRICK_FRAMES (slot order matters: walk cycle is slots 6..13).
FRAME_MAP = [
    (0, 0),   # 0  idle0  站立(微侧目)
    (0, 1),   # 1  idle1  站立(另一眼神)
    (0, 3),   # 2  blink  闭眼
    (9, 0),   # 3  lookL  张望左
    (9, 1),   # 4  lookR  张望右
    (3, 1),   # 5  wave0  挥手起
    (1, 0),   # 6  walk0  行走(朝右) 8 帧循环 6..13
    (1, 1),   # 7  walk1
    (1, 2),   # 8  walk2
    (1, 3),   # 9  walk3
    (2, 0),   # 10 walk4
    (2, 1),   # 11 walk5
    (2, 2),   # 12 walk6
    (2, 3),   # 13 walk7
    (3, 2),   # 14 wave1  挥手落
    (5, 0),   # 15 happy0 开心
    (5, 1),   # 16 happy1 开心(另一张)
    (4, 0),   # 17 sad0   难过
    (4, 1),   # 18 sad1   难过(另一张)
    (7, 3),   # 19 think0 托腮思考
    (6, 0),   # 20 angry0 生气
    (10, 7),  # 21 front0 正面站定
]


def main() -> int:
    src = next((p for p in SRC_CANDIDATES if os.path.exists(p)), None)
    if not src:
        print("找不到源精灵图（~/.codex/pets/patrick/spritesheet.webp）", file=sys.stderr)
        return 1
    sheet = Image.open(src).convert("RGBA")
    os.makedirs(OUT_DIR, exist_ok=True)

    canvas = Image.new("RGBA", (COLS * CELL_W, ROWS * CELL_H), (0, 0, 0, 0))
    for slot, (r, c) in enumerate(FRAME_MAP):
        cell = sheet.crop((c * CELL_W, r * CELL_H, (c + 1) * CELL_W, (r + 1) * CELL_H))
        if not cell.getbbox():
            print(f"警告: 源帧 r{r}c{c} 为空", file=sys.stderr)
        gx, gy = slot % COLS, slot // COLS
        canvas.paste(cell, (gx * CELL_W, gy * CELL_H))

    # 像素风精灵量化到 160 色,体积 725KB → 123KB,视觉无损
    sheet_path = os.path.join(OUT_DIR, "sheet.png")
    canvas.quantize(colors=160, method=Image.FASTOCTREE).save(sheet_path, optimize=True)
    flip_path = os.path.join(OUT_DIR, "sheet_flip.png")
    canvas.transpose(Image.FLIP_LEFT_RIGHT).quantize(colors=160, method=Image.FASTOCTREE).save(flip_path, optimize=True)
    for p in (sheet_path, flip_path):
        print(f"{p}: {os.path.getsize(p) // 1024} KiB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
