#!/usr/bin/env python3
"""Pre-build data/examples_*.json — offline example sentences per word library.

Each example line comes from macOS Dictionary Services (the bundled Oxford
English–Chinese dictionary). We call DCSCopyTextDefinition via ctypes — no
third-party deps, no network. Lines with "▸" are the example sentences with
their Chinese translations; we keep up to 2 of them per word.

Output schema: { "<word>": ["en sentence", "…", ...], ... } — only words that
actually have examples are included. Missing words simply fall back to
"no example" in the pet UI, so partial coverage is fine and expected.

Re-run whenever word libraries are rebuilt: python3 scripts/build_examples.py
"""
import ctypes
import ctypes.util
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

MAX_PER_WORD = 2
DIV = "▸"  # ▸


class CFRange(ctypes.Structure):
    _fields_ = [("loc", ctypes.c_long), ("len", ctypes.c_long)]


def load_cs():
    cs = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreServices"))
    cf = ctypes.cdll.LoadLibrary(ctypes.util.find_library("CoreFoundation"))
    cs.DCSCopyTextDefinition.restype = ctypes.c_void_p
    # CFRange (2 longs) is passed BY VALUE in registers on arm64.
    cs.DCSCopyTextDefinition.argtypes = [ctypes.c_void_p, ctypes.c_void_p, CFRange]
    cf.CFStringCreateWithCString.restype = ctypes.c_void_p
    cf.CFStringCreateWithCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint32]
    cf.CFStringGetLength.restype = ctypes.c_long
    cf.CFStringGetLength.argtypes = [ctypes.c_void_p]
    cf.CFStringGetCString.restype = ctypes.c_bool
    cf.CFStringGetCString.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
    return cs, cf


CS, CF = load_cs()
ENC = 0x08000100  # kCFStringEncodingUTF8


def to_cf(s: str):
    return CF.CFStringCreateWithCString(None, s.encode("utf-8"), ENC)


def from_cf(p) -> str:
    if not p:
        return ""
    buf = ctypes.create_string_buffer(CF.CFStringGetLength(p) * 4 + 1)
    CF.CFStringGetCString(p, buf, len(buf), ENC)
    return buf.value.decode("utf-8", "replace")


def examples_for(word: str):
    """Return up to MAX_PER_WORD example sentences (en+zh) for an English word.

    DCSCopyTextDefinition returns "<head> | BrE … | <POS> <defs>▸ ex1▸ ex2".
    Chunk 0 is the headword/definition header — the ▸ chunks are the examples.
    """
    rng = CFRange(0, len(word))
    text = from_cf(CS.DCSCopyTextDefinition(None, to_cf(word), rng))
    out = []
    if not text:
        return out
    chunks = text.split(DIV)
    for chunk in chunks[1:]:
        s = chunk.strip()
        if len(s) < 4 or "BrE" in s or "AmE" in s:
            continue
        out.append(s)
        if len(out) >= MAX_PER_WORD:
            break
    return out


def main() -> int:
    libs = sys.argv[1:] or sorted(
        f[len("words_"):-len(".json")]
        for f in os.listdir(DATA)
        if f.startswith("words_") and f.endswith(".json")
    )
    skip_prefix = ("words_jlpt", "words_french", "words_spanish")  # non-English libraries
    total_words = 0
    total_examples = 0
    for lib in libs:
        path = os.path.join(DATA, f"words_{lib}.json")
        if not os.path.exists(path) or any(s in f"words_{lib}.json" for s in skip_prefix):
            continue
        try:
            words = json.load(open(path))
        except Exception as e:
            print(f"skip {lib}: {e}", file=sys.stderr)
            continue
        out_path = os.path.join(DATA, f"examples_{lib}.json")
        existing = {}
        if os.path.exists(out_path):
            try:
                existing = json.load(open(out_path))
            except Exception:
                existing = {}
        out = {}
        for entry in words:
            w = str((entry or {}).get("word") or "").strip()
            if not w or not re.fullmatch(r"[A-Za-z][A-Za-z'\-\. ]{0,30}", w):
                continue
            if w in existing:                       # cache hit: word key exact
                out[w] = existing[w]
                continue
            base = w.lower()
            if base in existing:                    # cache hit: case-insensitive
                out[w] = existing[base]
                continue
            ex = examples_for(w)
            if ex:
                out[w] = ex
        # normalize: drop None entries
        out = {k: v for k, v in out.items() if v}
        with open(out_path, "w") as f:
            json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
        total_words += len(words)
        total_examples += len(out)
        print(f"{lib}: {len(out)}/{len(words)} words have examples -> {out_path}")
    print(f"done: {total_examples} example entries across {len(libs)} libs")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
