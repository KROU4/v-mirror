"""Approximate CP2077 multilayered.mt baker -> albedo (sRGB) + ORM (R=1,G=rough,B=metal) PNGs."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, sys
from pathlib import Path
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from matlib import load, v, conv

PNG = vmpaths.area('face') / 'texpng'
_img = {}


def s2l(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def tex(depot, size, tile=1.0, channels="rgba"):
    """load exported png for depot xbm, resample to size x size with tiling (nearest-wrap via numpy)."""
    key = (depot.lower(), size, tile)
    if key in _img:
        return _img[key]
    p = PNG / (depot[:-4] + ".png")
    im = Image.open(p).convert("RGBA")
    a = np.asarray(im).astype(np.float32) / 255.0
    h, w = a.shape[:2]
    ys = (np.arange(size) + 0.5) / size * tile
    xs = (np.arange(size) + 0.5) / size * tile
    yi = (np.floor((ys % 1.0) * h)).astype(int) % h
    xi = (np.floor((xs % 1.0) * w)).astype(int) % w
    out = a[yi][:, xi]
    _img[key] = out
    return out


def mask_layer(mlmask, i, size):
    name = Path(mlmask).stem
    p = PNG / Path(mlmask).parent / f"{name}_layers" / f"{name}_{i}.png"
    if not p.exists():
        return None
    im = Image.open(p).convert("L").resize((size, size), Image.BILINEAR)
    return np.asarray(im).astype(np.float32) / 255.0


def ov_lookup(tmpl, kind, name):
    ovs = (tmpl.get("overrides") or {}).get(kind) or []
    for e in ovs:
        if v(e["n"]) == name:
            val = e["v"]
            return val["Elements"] if isinstance(val, dict) else val
    # fall back to default override name then to 'null'
    dname = v((tmpl.get("defaultOverrides") or {}).get(kind))
    for e in ovs:
        if v(e["n"]) == dname:
            val = e["v"]
            return val["Elements"] if isinstance(val, dict) else val
    for e in ovs:
        if v(e["n"]) in ("null", "null_null"):
            val = e["v"]
            return val["Elements"] if isinstance(val, dict) else val
    return None


def levels(x, pair):
    if pair is None:
        return x
    hi, lo = pair[0], pair[1]
    return lo + x * (hi - lo)


def bake(mlsetup, mlmask, size=512, diffuse_mul=1.0, verbose=False):
    d = load(mlsetup)
    albedo = np.zeros((size, size, 3), np.float32)
    rough = np.ones((size, size), np.float32)
    metal = np.zeros((size, size), np.float32)
    used = []
    for i, L in enumerate(d["layers"]):
        op = float(L.get("opacity", 1))
        if op <= 0 and i != 0:
            continue
        m = np.ones((size, size), np.float32) if i == 0 else mask_layer(mlmask, i, size)
        if m is None or m.max() <= 0:
            continue
        m = m * (op if i != 0 else 1.0)
        tp = v(L["material"])
        t = load(tp)
        if t is None:
            continue
        tile = float(L.get("matTile", 1)) * float(t.get("tilingMultiplier", 1) or 1)
        cs_name = v(L.get("colorScale"))
        cs = ov_lookup(t, "colorScale", cs_name) or [0.5, 0.5, 0.5]
        ctex = s2l(tex(v(t["colorTexture"]), size, tile)[..., :3])
        # colour texture used as detail normalised to mean 1 -> layer average albedo == colorScale (approximation)
        ctex = ctex / max(float(ctex.mean()), 1e-4)
        col = np.clip(ctex * np.array(cs, np.float32) * diffuse_mul, 0, 1)
        rtex = tex(v(t["roughnessTexture"]), size, tile)[..., 0]
        rli = ov_lookup(t, "roughLevelsIn", v(L.get("roughLevelsIn")))
        rlo = ov_lookup(t, "roughLevelsOut", v(L.get("roughLevelsOut")))
        r = np.clip(levels(np.clip(levels(rtex, rli), 0, 1), rlo), 0, 1)
        mtex = tex(v(t["metalnessTexture"]), size, tile)[..., 0]
        mli = ov_lookup(t, "metalLevelsIn", v(L.get("metalLevelsIn")))
        mlo = ov_lookup(t, "metalLevelsOut", v(L.get("metalLevelsOut")))
        mt = np.clip(levels(np.clip(levels(mtex, mli), 0, 1), mlo), 0, 1)
        a = m[..., None]
        albedo = albedo * (1 - a) + col * a
        rough = rough * (1 - m) + r * m
        metal = metal * (1 - m) + mt * m
        used.append({"layer": i, "opacity": op, "template": tp, "colorScale": cs_name, "colorLinear": [round(float(x), 4) for x in cs],
                     "roughLevelsOut": v(L.get("roughLevelsOut")), "metalLevelsOut": v(L.get("metalLevelsOut")), "tile": tile,
                     "maskCoverage": round(float(m.mean()), 4)})
    return albedo, rough, metal, used


def save(albedo, rough, metal, out_albedo, out_orm):
    Image.fromarray((l2s(albedo) * 255 + 0.5).astype(np.uint8), "RGB").save(out_albedo, optimize=True)
    orm = np.stack([np.ones_like(rough), rough, metal], -1)
    Image.fromarray((orm * 255 + 0.5).astype(np.uint8), "RGB").save(out_orm, optimize=True)


if __name__ == "__main__":
    a, r, m, used = bake(sys.argv[1], sys.argv[2], verbose=True)
    for u in used:
        print(u)
    save(a, r, m, sys.argv[3], sys.argv[4])
