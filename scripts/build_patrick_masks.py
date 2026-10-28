#!/usr/bin/env python3
"""Describe the existing sprite's pink pixels as runs for native mood tinting."""
import json
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
sheet = Image.open(ROOT / 'assets/patrick/sheet.png').convert('RGBA')
frames = {}
for idx in range(22):
    runs = []
    ox, oy = idx % 6 * 192, idx // 6 * 208
    for y in range(208):
        start = None
        for x in range(193):
            skin = False
            if x < 192:
                r, g, b, a = sheet.getpixel((ox + x, oy + y))
                skin = a > 127 and r > 173 and 64 < g < 199 and b < 184 and r > g * 1.22
            if skin and start is None:
                start = x
            if not skin and start is not None:
                runs.append([start, 207 - y, x - start, 1])
                start = None
    frames[str(idx)] = runs
(ROOT / 'assets/patrick/skin-masks.json').write_text(json.dumps(frames, separators=(',', ':')))
print('Built skin masks for', len(frames), 'existing sprite frames')
