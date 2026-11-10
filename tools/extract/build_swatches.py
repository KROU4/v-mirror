"""
Builds the colour swatches of the character creator from a local game install.

The game draws every colour option (hair, eyes, skin, makeup, nails, piercings,
teeth, pubic hair...) with a thumbnail from the inkatlas
base\\gameplay\\gui\\fullscreen\\main_menu\\character_creation_thumbnails_atlas.
Each option of the .inkcharcustomization files references a TweakDB record
`OptionsIcons.<Name>` whose flat `atlasPartName` names the atlas part. This
script resolves that chain exactly as the game does (reading r6/cache/tweakdb*.bin
read-only), crops the parts and writes two outputs:

  1. Asset pack images (game pixels, local only, never committed):
       <pack>/swatches/icons/<Icon>.webp              one per icon, 96x96
       <pack>/swatches/<gender>/<slotId>/<index>.webp per option index for slots
                                                      whose index -> icon is stable
       <pack>/swatches/index.json
  2. Data-only fallback descriptors (colour facts, no pixels) committed to the repo:
       src/data/swatches.male.json, src/data/swatches.female.json
     Each descriptor is {kind:'gradient'|'radial'|'solid', stops:[hex...],
     pos?:[0..100...], angle?, pattern?:'streaks'|'iris'|'metal'|'none', ring?:[inner,outer]}
     which src/ui/swatch.ts turns into CSS.

Inputs:
  --game     game install folder (reads r6/cache/tweakdb_ep1.bin or tweakdb.bin)
  --work     output folder of tools/extract/extract_game_data.ps1
             (cc_json/character_creation_thumbnails_atlas.inkatlas.json and
              atlas_png/character_creation_thumbnails_atlas.png)
  --catalog  folder with catalog.{male,female}.json (default src/data)
  --pack     asset pack root (default tools/local); images go to <pack>/swatches
  --data     where swatches.{male,female}.json go (default src/data)

Example:
  python -I tools/extract/build_swatches.py --game "G:/Cyberpunk 2077" --work C:/tmp/cp-work
"""
from __future__ import annotations

import argparse
import json
import struct
import sys
import warnings
import zlib
from pathlib import Path

import numpy as np
from PIL import Image

SIZE = 96
ATLAS_PATH = "base\\gameplay\\gui\\fullscreen\\main_menu\\character_creation_thumbnails_atlas.inkatlas"
HAIRY = {"hair_color", "eyebrows_color", "eyelash_color", "beard_color", "pubic_hair_color"}
# Natural teeth (option without an icon in the game data): ivory enamel.
NATURAL_TEETH = {"kind": "gradient", "angle": 180, "stops": ["#ece4d3", "#d9cfbd", "#b9ab93"], "pattern": "none"}


def v(x):
    if isinstance(x, dict) and "$value" in x:
        return x["$value"]
    return x


# ------------------------------------------------------------------ TweakDB
def fnv1a64(s: str) -> int:
    h = 0xCBF29CE484222325
    for c in s.encode():
        h ^= c
        h = (h * 0x100000001B3) & 0xFFFFFFFFFFFFFFFF
    return h


def tdbid(s: str) -> int:
    raw = s.encode()
    return zlib.crc32(raw) | (len(raw) << 32)


class TweakDB:
    """Minimal read-only reader of the flats section of tweakdb.bin (CName and raRef only)."""

    def __init__(self, path: Path):
        self.b = path.read_bytes()
        magic = struct.unpack_from("<I", self.b, 0)[0]
        if magic != 0x0BB1DB47:
            raise ValueError(f"{path}: not a TweakDB file")
        count = struct.unpack_from("<I", self.b, 0x20)[0]
        self.types = {}
        for i in range(count):
            th, nvals, nkeys, off = struct.unpack_from("<QIII", self.b, 0x24 + i * 20)
            self.types[th] = (nvals, nkeys, off)
        self.cnames, self.cname_keys = self._flats("CName", self._strings)
        self.refs, self.ref_keys = self._flats("raRef:CResource", self._u64s)

    def _vlq(self, o: int):
        b = self.b
        c = b[o]
        o += 1
        neg, val, shift, cont = c & 0x80, c & 0x3F, 6, c & 0x40
        while cont:
            c = b[o]
            o += 1
            val |= (c & 0x7F) << shift
            shift += 7
            cont = c & 0x80
        return (-val if neg else val), o

    def _strings(self, o: int):
        n = struct.unpack_from("<I", self.b, o)[0]
        o += 4
        out = []
        for _ in range(n):
            ln, o = self._vlq(o)
            if ln < 0:
                out.append(self.b[o:o - ln].decode("latin1"))
                o -= ln
            else:
                out.append(self.b[o:o + 2 * ln].decode("utf-16le", "replace"))
                o += 2 * ln
        return out, o

    def _u64s(self, o: int):
        n = struct.unpack_from("<I", self.b, o)[0]
        o += 4
        return list(struct.unpack_from(f"<{n}Q", self.b, o)), o + 8 * n

    def _flats(self, type_name: str, reader):
        _nvals, _nkeys, off = self.types[fnv1a64(type_name)]
        vals, o = reader(off)
        n = struct.unpack_from("<I", self.b, o)[0]
        o += 4
        keys = {}
        for i in range(n):
            k, ix = struct.unpack_from("<QI", self.b, o + i * 12)
            keys[k] = ix
        return vals, keys

    def cname(self, flat: str) -> str | None:
        ix = self.cname_keys.get(tdbid(flat))
        return None if ix is None else self.cnames[ix]

    def ref(self, flat: str) -> int | None:
        ix = self.ref_keys.get(tdbid(flat))
        return None if ix is None else self.refs[ix]


# ------------------------------------------------------------------ atlas
def load_atlas(work: Path) -> tuple[dict[str, Image.Image], tuple[int, int]]:
    atlas = json.loads((work / "cc_json" / "character_creation_thumbnails_atlas.inkatlas.json").read_text(encoding="utf-8"))
    parts = atlas["Data"]["RootChunk"]["slots"]["Elements"][0]["parts"]
    im = Image.open(work / "atlas_png" / "character_creation_thumbnails_atlas.png").convert("RGBA")
    w, h = im.size
    out = {}
    for p in parts:
        r = p["clippingRectInUVCoords"]
        box = (round(r["Left"] * w), round(r["Top"] * h), round(r["Right"] * w), round(r["Bottom"] * h))
        out[v(p["partName"])] = im.crop(box)
    return out, (w, h)


# ------------------------------------------------------------------ descriptors
def to_hex(c) -> str:
    return "#" + "".join(f"{round(min(255, max(0, x))):02x}" for x in c[:3])


def fit_stops(profile: np.ndarray, tol: float = 7.0, max_stops: int = 6) -> tuple[list[int], list[str]]:
    """Greedy polyline fit of a colour profile (N x 3). Returns positions (0..100) and hex stops."""
    n = len(profile)
    xs = np.linspace(0, 1, n)
    chosen = [0, n - 1]
    while len(chosen) < max_stops:
        chosen.sort()
        approx = np.empty_like(profile)
        for ch in range(3):
            approx[:, ch] = np.interp(xs, xs[chosen], profile[chosen, ch])
        err = np.abs(approx - profile).max(axis=1)
        worst = int(err.argmax())
        if err[worst] < tol:
            break
        chosen.append(worst)
    chosen.sort()
    pos = [round(xs[i] * 100) for i in chosen]
    return pos, [to_hex(profile[i]) for i in chosen]


def r2(img: np.ndarray, mask: np.ndarray, axis: int) -> float:
    """Share of colour variance explained by the mean profile along one axis."""
    total = 0.0
    explained = 0.0
    for ch in range(3):
        a = np.where(mask, img[..., ch], np.nan)
        mean = np.nanmean(a)
        prof = np.nanmean(a, axis=axis, keepdims=True)
        total += np.nansum((a - mean) ** 2)
        explained += np.nansum((np.broadcast_to(prof, a.shape) - mean) ** 2 * mask)
    return explained / total if total > 1e-6 else 1.0


def radial_profile(img: np.ndarray, mask: np.ndarray, bins: int = 40) -> np.ndarray:
    h, w = mask.shape
    yy, xx = np.mgrid[0:h, 0:w]
    r = np.hypot(xx + 0.5 - w / 2, yy + 0.5 - h / 2) / (min(w, h) / 2)
    # closest-side circle only: the corners would smear the outer stop (CSS uses closest-side too)
    idx = np.where(r < 1, (r * bins).astype(int), -1)
    prof = np.zeros((bins, 3))
    for b in range(bins):
        sel = (idx == b) & mask
        prof[b] = img[sel].mean(axis=0) if sel.any() else prof[b - 1]
    return prof


def lum(c) -> float:
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]


def pattern_for(slot: str, icon: str) -> str:
    low = icon.lower()
    if slot in HAIRY:
        return "streaks"
    if slot == "eyes_color":
        return "iris" if "gradient" in low else "none"
    if slot in ("piercings_color", "teeth"):
        return "none" if "plastic" in low else "metal"
    return "none"


def describe(tile: Image.Image, slot: str, icon: str) -> dict:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # nanmean over masked-out rows
        return _describe(tile, slot, icon)


def _describe(tile: Image.Image, slot: str, icon: str) -> dict:
    a = np.asarray(tile.convert("RGBA"), dtype=np.float64)
    img, alpha = a[..., :3], a[..., 3]
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w]
    # Thumbnails carry the creator's cut corner (bottom right); it is UI chrome, not colour.
    notch = (xx + yy) > (w + h) * 0.89
    mask = (alpha > 200) & ~notch
    pattern = pattern_for(slot, icon)
    std = float(np.sqrt(sum(np.var(img[..., ch][mask]) for ch in range(3))))
    if std < 4.0:
        return {"kind": "solid", "stops": [to_hex(img[mask].mean(axis=0))], "pattern": pattern}

    if slot == "eyes_color":
        prof = radial_profile(img, mask)
        pos, stops = fit_stops(prof, tol=12.0, max_stops=7)
        d: dict = {"kind": "radial", "stops": stops, "pos": pos, "pattern": pattern}
        if pattern == "iris":
            ls = np.array([lum(c) for c in prof])
            # pupil edge: first radius whose colour leaves the pupil colour; iris edge:
            # the steepest brightening towards the sclera outside the pupil.
            far = np.linalg.norm(prof - prof[0], axis=1) > 18
            pupil = int(np.argmax(far)) if far.any() else 0
            grad = np.diff(ls)
            grad[: pupil + 3] = -1e9
            outer = int(np.argmax(grad)) + 1
            d["ring"] = [round(pupil / len(ls) * 100), round(outer / len(ls) * 100)]
        return d

    # Gradient along the axis whose mean profile explains more of the colour variance
    # (hair, skin, makeup and metals are vertical ramps; nail art keeps its dominant axis).
    axis_rows = r2(img, mask, axis=1) >= r2(img, mask, axis=0)
    keep = mask.any(axis=1 if axis_rows else 0)
    a_masked = np.where(mask[..., None], img, np.nan)
    prof = np.nanmean(a_masked[keep] if axis_rows else a_masked[:, keep], axis=1 if axis_rows else 0)
    prof = prof[:: max(1, len(prof) // 40)]
    pos, stops = fit_stops(prof, tol=8.0, max_stops=6)
    d = {"kind": "gradient", "angle": 180 if axis_rows else 90, "stops": stops, "pattern": pattern}
    if not (len(pos) == 2 or pos == [round(i * 100 / (len(pos) - 1)) for i in range(len(pos))]):
        d["pos"] = pos
    return d


# ------------------------------------------------------------------ main
def merge_motifs(data: dict) -> None:
    """Generic vector motifs (tools/extract/swatch_motifs.json, keyed by icon) for nail art
    and patterned lenses: the CSS fallback draws them over the colour stops."""
    motifs = json.loads(Path(__file__).with_name("swatch_motifs.json").read_text(encoding="utf-8"))["motifs"]
    for key, layers in motifs.items():
        if key in data["keys"]:
            data["keys"][key]["motif"] = layers


def option_key(o: dict) -> str | None:
    return o.get("icon") or None


def colour_slots(cat: dict):
    """Yields (slot_id, [options of every colour variant]) for slots that are colour pickers."""
    for s in cat["slots"]:
        # every option of a colour variant (natural teeth has no icon and no colour in the game data)
        colour_variants = [vr for vr in s["variants"] if any(o.get("hex") or o.get("iris") for o in vr.get("options") or [])]
        opts = [o for vr in colour_variants for o in vr["options"]]
        if opts:
            yield s["id"], s, opts


def main() -> int:
    root = Path(__file__).resolve().parents[2]
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", required=True)
    ap.add_argument("--work", required=True)
    ap.add_argument("--catalog", default=str(root / "src" / "data"))
    ap.add_argument("--pack", default=str(root / "tools" / "local"))
    ap.add_argument("--data", default=str(root / "src" / "data"))
    a = ap.parse_args()

    game = Path(a.game)
    tdb_path = next((p for p in (game / "r6/cache/tweakdb_ep1.bin", game / "r6/cache/tweakdb.bin") if p.exists()), None)
    if not tdb_path:
        print("tweakdb.bin not found under", game / "r6/cache", file=sys.stderr)
        return 1
    tdb = TweakDB(tdb_path)
    tiles, _ = load_atlas(Path(a.work))
    atlas_hash = fnv1a64(ATLAS_PATH)

    out_dir = Path(a.pack) / "swatches"
    (out_dir / "icons").mkdir(parents=True, exist_ok=True)
    index: dict = {"version": 1, "size": SIZE, "format": "webp", "source": ATLAS_PATH, "icons": {}, "slots": {}}
    problems: list[str] = []
    icon_part: dict[str, str] = {}
    icon_desc: dict[str, dict] = {}
    images: dict[str, Image.Image] = {}

    def resolve(icon: str) -> str | None:
        if icon in icon_part:
            return icon_part[icon]
        part = tdb.cname(f"OptionsIcons.{icon}.atlasPartName")
        res = tdb.ref(f"OptionsIcons.{icon}.atlasResourcePath")
        if part is None or part not in tiles:
            problems.append(f"icon {icon}: atlas part {part!r} not found")
            return None
        if res is not None and res != atlas_hash:
            problems.append(f"icon {icon}: points to another atlas ({res:#x})")
        icon_part[icon] = part
        return part

    for gender in ("male", "female"):
        cat = json.loads((Path(a.catalog) / f"catalog.{gender}.json").read_text(encoding="utf-8"))
        data: dict = {"version": 1, "gender": gender, "source": "game thumbnails atlas, colour facts only", "keys": {}, "slots": {}}
        index["slots"][gender] = {}
        for slot_id, _slot, opts in colour_slots(cat):
            by_index: dict[int, str | None] = {}
            stable = True
            for o in opts:
                k = option_key(o)
                if o["i"] in by_index and by_index[o["i"]] != k:
                    stable = False
                by_index.setdefault(o["i"], k)
            keys = sorted({option_key(o) or f"{slot_id}_{o['i']}" for o in opts})
            slot_entry = {"stable": stable, "keys": keys}
            if stable:
                slot_entry["byIndex"] = {str(i): (k or f"{slot_id}_{i}") for i, k in sorted(by_index.items())}
            data["slots"][slot_id] = slot_entry
            index["slots"][gender][slot_id] = slot_entry

            # Hair colour repeats the same 35 options in ~90 variants: handle each (index, icon) once.
            unique = {(o["i"], option_key(o)): o for o in opts}
            for (i, icon), _o in sorted(unique.items(), key=lambda t: (t[0][0], t[0][1] or "")):
                key = icon or f"{slot_id}_{i}"
                if key not in images:
                    if icon:
                        part = resolve(icon)
                        if part is None:
                            continue
                        tile = tiles[part]
                        icon_desc[key] = describe(tile, slot_id, icon)
                        images[key] = tile.resize((SIZE, SIZE), Image.LANCZOS)
                    else:
                        if slot_id != "teeth":
                            problems.append(f"{gender}/{slot_id}/{i}: option without icon")
                            continue
                        icon_desc[key] = dict(NATURAL_TEETH)
                        images[key] = render_descriptor(icon_desc[key])
                    rel_icon = f"swatches/icons/{key}.webp"
                    images[key].save(Path(a.pack) / rel_icon, "WEBP", quality=90, method=4)
                    index["icons"][key] = {"path": rel_icon, "part": icon_part.get(icon or "")}
                data["keys"][key] = icon_desc[key]
                if stable:
                    d = out_dir / gender / slot_id
                    d.mkdir(parents=True, exist_ok=True)
                    images[key].save(d / f"{i}.webp", "WEBP", quality=90, method=4)
        merge_motifs(data)
        (Path(a.data) / f"swatches.{gender}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        print(f"{gender}: {len(data['slots'])} colour slots, {len(data['keys'])} swatches")

    (out_dir / "index.json").write_text(json.dumps(index, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"pack: {len(index['icons'])} icon images -> {out_dir}")
    for p in problems:
        print("WARN", p)
    return 0


def render_descriptor(d: dict) -> Image.Image:
    """Rasterises a vertical gradient descriptor (used for options the game draws without an icon)."""
    stops = [tuple(int(s[i:i + 2], 16) for i in (1, 3, 5)) for s in d["stops"]]
    pos = d.get("pos") or [round(i * 100 / max(1, len(stops) - 1)) for i in range(len(stops))]
    ys = np.linspace(0, 100, SIZE)
    col = np.stack([np.interp(ys, pos, [c[ch] for c in stops]) for ch in range(3)], axis=1)
    arr = np.repeat(col[:, None, :], SIZE, axis=1)
    yy, xx = np.mgrid[0:SIZE, 0:SIZE]
    # same cut corner as the game thumbnails (transparent bottom-right triangle)
    alpha = np.where(xx + yy >= 2 * SIZE - 11, 0, 255)
    return Image.fromarray(np.dstack([arr, alpha]).astype(np.uint8), "RGBA")


if __name__ == "__main__":
    sys.exit(main())
