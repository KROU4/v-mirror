"""Shrinks an asset pack for the browser: PNG textures become lossless WebP (pixel-exact,
RGB kept under transparent pixels) when that saves space, every JSON manifest that names a
converted file is updated, and all manifests are written without whitespace. Files the
manifests do not mention are left alone.

  python tools/extract/pack/optimize.py <pack folder> [--min-kb 24] [--dry-run]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

SKIP_DIRS = {"swatches"}  # already WebP, written by build_swatches.py


def to_webp(src: Path) -> Path | None:
    im = Image.open(src)
    im.load()
    if im.mode in ("I", "I;16", "I;16B", "F") or im.info.get("bits", 8) > 8:
        return None  # 16-bit data would lose precision
    if im.mode == "P":
        im = im.convert("RGBA" if "transparency" in im.info else "RGB")
    elif im.mode == "L":
        im = im.convert("RGB")
    elif im.mode == "LA":
        im = im.convert("RGBA")
    elif im.mode not in ("RGB", "RGBA"):
        return None
    dst = src.with_suffix(".webp")
    im.save(dst, "WEBP", lossless=True, exact=True, quality=100, method=4)
    back = Image.open(dst)
    back.load()
    if back.mode != im.mode:
        back = back.convert(im.mode)
    if back.size != im.size or not np.array_equal(np.asarray(back), np.asarray(im)):
        dst.unlink()
        return None
    if dst.stat().st_size > src.stat().st_size * 0.95:
        dst.unlink()
        return None
    return dst


def walk_strings(o, fn):
    """applies fn to every string value and every dict key (texture registries are keyed by path)"""
    if isinstance(o, dict):
        return {fn(k): walk_strings(v, fn) for k, v in o.items()}
    if isinstance(o, list):
        return [walk_strings(v, fn) for v in o]
    if isinstance(o, str):
        return fn(o)
    return o


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("pack")
    ap.add_argument("--min-kb", type=float, default=24)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    root = Path(a.pack).resolve()

    pngs, jsons = [], []
    for dp, dns, fns in os.walk(root):
        rel = Path(dp).relative_to(root)
        if rel.parts and rel.parts[0] in SKIP_DIRS:
            dns[:] = []
            continue
        for f in fns:
            p = Path(dp) / f
            if f.lower().endswith(".png"):
                pngs.append(p)
            elif f.lower().endswith(".json") and f != "pack.json":
                jsons.append(p)

    # which PNGs the manifests reference (only those are converted)
    texts = {j: j.read_text(encoding="utf-8-sig") for j in jsons}
    referenced = set()
    allrefs = set()
    for j, t in texts.items():
        walk_strings(json.loads(t), lambda s: (allrefs.add(s), s)[1])
    for p in pngs:
        rel = p.relative_to(root).as_posix()
        if rel in allrefs:
            referenced.add(p)

    before = sum(p.stat().st_size for p in pngs)
    converted: dict[str, str] = {}
    saved = 0
    for p in sorted(referenced):
        if p.stat().st_size < a.min_kb * 1024:
            continue
        if a.dry_run:
            continue
        size = p.stat().st_size
        w = to_webp(p)
        if w is None:
            continue
        saved += size - w.stat().st_size
        converted[p.relative_to(root).as_posix()] = w.relative_to(root).as_posix()

    # Manifests are written compact: the browser downloads and parses them on every body build
    # (tex/hair/manifest.json shrank from 4.6 MB pretty-printed)
    changed = 0
    for j, t in texts.items():
        d = json.loads(t)
        nd = walk_strings(d, lambda s: converted.get(s, s))
        out = json.dumps(nd, ensure_ascii=False, separators=(",", ":"))
        if out != t:
            if not a.dry_run:
                j.write_text(out, encoding="utf-8")
            changed += 1
    for old in converted:
        (root / old).unlink()

    # every .png/.webp/.jpg/.glb a manifest names must exist
    missing = sorted(s for s in {converted.get(s, s) for s in allrefs}
                     if isinstance(s, str) and s.lower().endswith((".png", ".webp", ".jpg", ".glb")) and "/" in s
                     and not s.startswith(("base\\", "engine\\", "ep1\\")) and not (root / s).exists())
    print(f"  PNG textures: {len(pngs)} ({before / 1e6:.1f} MB), referenced {len(referenced)}, converted {len(converted)}, "
          f"saved {saved / 1e6:.1f} MB; manifests updated: {changed}")
    if missing:
        print(f"  note: {len(missing)} manifest paths do not exist in the pack, e.g. {missing[:5]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
