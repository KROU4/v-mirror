"""Сводные листы рендеров причёсок: по каждой причёске анфас, 3/4 и затылок.

  python -I tools/calibrate/hair_sheet.py male
Листы кладутся в tools/local/renders/<g>/hair_sheet_NN.png (по 15 причёсок).
"""
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

g = sys.argv[1] if len(sys.argv) > 1 else "male"
d = Path(__file__).resolve().parents[2] / "tools" / "local" / "renders" / g
nums = sorted({int(m.group(1)) for p in d.glob("hair_*_front.png") if (m := re.match(r"hair_(\d+)_front", p.name))})
CROP = (130, 60, 510, 470)  # голова в кадре 640x640
TW = 150
TH = int(TW * (CROP[3] - CROP[1]) / (CROP[2] - CROP[0]))
PER_ROW, PER_SHEET = 3, 15
try:
    font = ImageFont.truetype("arial.ttf", 22)
except OSError:
    font = ImageFont.load_default()

for s in range(0, len(nums), PER_SHEET):
    chunk = nums[s : s + PER_SHEET]
    rows = (len(chunk) + PER_ROW - 1) // PER_ROW
    W = PER_ROW * (3 * TW + 16)
    sheet = Image.new("RGB", (W, rows * (TH + 30)), "white")
    dr = ImageDraw.Draw(sheet)
    for k, n in enumerate(chunk):
        x0 = (k % PER_ROW) * (3 * TW + 16)
        y0 = (k // PER_ROW) * (TH + 30)
        dr.text((x0 + 4, y0 + 3), f"{n:02d}", fill="black", font=font)
        for j, view in enumerate(("front", "q", "back")):
            im = Image.open(d / f"hair_{n:02d}_{view}.png").convert("RGB").crop(CROP).resize((TW, TH))
            sheet.paste(im, (x0 + j * TW, y0 + 28))
    out = d / f"hair_sheet_{s // PER_SHEET + 1:02d}.png"
    sheet.save(out)
    print(out.name, sheet.size)
