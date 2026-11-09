"""Контактные листы рендеров морфов (локально, для ручного описания вариантов).
python -I tools/calibrate/contact_sheet.py male nose
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
CROPS = {  # доля кадра 640x640: (x0, y0, x1, y1)
    "eyes": (0.32, 0.40, 0.68, 0.52),
    "nose": (0.40, 0.42, 0.60, 0.64),
    "mouth": (0.38, 0.58, 0.62, 0.74),
    "jaw": (0.25, 0.40, 0.75, 0.84),
    "side_nose": (0.55, 0.38, 0.85, 0.68),
    "side_jaw": (0.35, 0.45, 0.85, 0.85),
    "side_mouth": (0.58, 0.55, 0.84, 0.76),
    "side_ear": (0.22, 0.32, 0.60, 0.72),
}


def main(gender: str, slot: str, diff: bool = False):
    rd = ROOT / "tools" / "local" / "renders" / gender
    files = sorted(f for f in rd.glob(f"{slot}_*.png") if f.stem.split("_")[-1].isdigit())
    x0, y0, x1, y1 = CROPS[slot]
    tiles = []
    for f in files:
        im = Image.open(f).convert("RGB")
        W, H = im.size
        tile = im.crop((int(x0 * W), int(y0 * H), int(x1 * W), int(y1 * H)))
        scale = 300 / tile.width
        tile = tile.resize((300, int(tile.height * scale)))
        d = ImageDraw.Draw(tile)
        d.rectangle((0, 0, 44, 26), fill=(0, 0, 0))
        d.text((6, 4), f.stem.split("_")[-1], fill=(255, 230, 0), font=ImageFont.load_default(18))
        tiles.append(tile)
    cols = 6 if slot != "jaw" else 6
    tw, th = tiles[0].size
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * tw, rows * th), (20, 20, 20))
    for k, t in enumerate(tiles):
        sheet.paste(t, ((k % cols) * tw, (k // cols) * th))
    out = rd / f"sheet_{slot}.png"
    sheet.save(out)
    print(out)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
