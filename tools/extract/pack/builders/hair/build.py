"""Build tools/local/tex/hair: textures (PNG) + manifest.json for the three.js engine."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, hashlib, shutil, collections
from pathlib import Path
import numpy as np
from PIL import Image

R = vmpaths.REPO
W = vmpaths.area('hair')
LOCAL = vmpaths.OUT
OUT = LOCAL / "tex" / "hair"
PNG = W / "png"
OUT.mkdir(parents=True, exist_ok=True)

an = json.loads((W / "analysis.json").read_text(encoding="utf-8"))
hm = json.loads((W / "hint_colour_map.json").read_text(encoding="utf-8"))
hint = json.loads((LOCAL / "hair" / "hint_meshes.json").read_text(encoding="utf-8-sig"))
xhdr = json.loads((W / "xbm_hdr.json").read_text(encoding="utf-8"))
glbm = json.loads((W / "glb_meshes.json").read_text(encoding="utf-8"))

HAIR_MT = "base\\materials\\hair.mt"
CAP_MT = "base\\materials\\mesh_decal_gradientmap_recolor.mt"
HAIR_DEF = {"AlphaCutoff": 0.33, "RoughnessScale": 1.0, "RoughnessBias": 0.0, "FlowStrength": 1.0, "VertexColorStrength": 0.0,
            "Scattering": 0.16, "ShadowStrength": 0.0, "ShadowMin": -0.5, "ShadowMax": 1.0, "ShadowRoughness": 1.0,
            "Animation_AmplitudeScale": 0.0, "Animation_PeriodScale": 0.0, "DebugHairColor": 0.0}
CAP_DEF = {"DiffuseAlpha": 0.0, "SecondaryMaskUVScale": 0.0, "SecondaryMaskInfluence": 0.0, "NormalAlpha": 0.0, "NormalsBlendingMode": 0.0,
           "RoughnessScale": 1.0, "RoughnessBias": 0.0, "MetalnessScale": 1.0, "MetalnessBias": 0.0, "AlphaMaskContrast": 0.0,
           "RoughnessMetalnessAlpha": 0.0, "DepthThreshold": 0.5, "VertexOffsetFactor": 0.0}
CAP_TEX_DEF = {"DiffuseTexture": "engine\\textures\\editor\\grey.xbm", "MaskTexture": "engine\\textures\\editor\\white.xbm",
               "GradientMap": "engine\\textures\\editor\\white.xbm", "SecondaryMask": "engine\\textures\\editor\\white.xbm",
               "NormalTexture": "engine\\textures\\editor\\normal.xbm", "RoughnessTexture": "engine\\textures\\editor\\white.xbm",
               "MetalnessTexture": "engine\\textures\\editor\\black.xbm"}


def stem(p):
    return p.replace("/", "\\").split("\\")[-1].rsplit(".", 1)[0]


def png_of(depot):
    return PNG / Path(depot.replace("\\", "/")).with_suffix(".png")


textures = {}  # id -> entry


def add_tex(depot, sub, role, color_space=None, convert=None):
    """copy exported png of a game texture into OUT/sub; returns texture id"""
    tid = stem(depot)
    if tid in textures:
        return tid
    src = png_of(depot)
    if not src.exists():
        raise FileNotFoundError(src)
    im = Image.open(src)
    if convert:
        im = convert(im)
    elif im.mode == "RGBA" and np.asarray(im)[..., 3].min() >= 250 and role not in ("flow",):
        im = im.convert("RGB")
    if max(im.size) > 2048:
        s = 2048 / max(im.size)
        im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.LANCZOS)
    dst = OUT / sub / (tid + ".png")
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, optimize=True)
    h = xhdr.get(tid, {})
    if color_space is None:
        color_space = "srgb" if h.get("isGamma") else "linear"
    textures[tid] = {"file": dst.relative_to(LOCAL).as_posix(), "size": list(im.size), "mode": im.mode, "colorSpace": color_space,
                     "role": role, "gamePath": depot, "gameCompression": h.get("compression"), "gameIsGamma": h.get("isGamma")}
    return tid


def hexc(c):
    return "#%02x%02x%02x" % (c["Red"], c["Green"], c["Blue"])


# ---------- hair profiles (.hp) ----------
profiles = {}
RAMP_W = 256


def bake(stops):
    xs = np.array([s["pos"] for s in stops])
    cs = np.array([[int(s["hex"][i:i + 2], 16) for i in (1, 3, 5)] for s in stops], dtype=np.float64)
    t = (np.arange(RAMP_W) + 0.5) / RAMP_W
    return np.stack([np.interp(t, xs, cs[:, i]) for i in range(3)], -1)


for f in sorted((W / "mat_json").glob("*.hp.json")):
    name = f.name[:-len(".hp.json")]
    d = json.loads(f.read_text(encoding="utf-8"))["Data"]["RootChunk"]
    def conv(es):
        s = sorted(({"pos": round(e["value"], 6), "hex": hexc(e["color"]), "alpha": e["color"]["Alpha"]} for e in es), key=lambda x: x["pos"])
        return s
    rt = conv(d.get("gradientEntriesRootToTip") or [])
    idg = conv(d.get("gradientEntriesID") or [])
    gp = "engine\\materials\\defaults\\default.hp" if name == "default" else f"base\\characters\\common\\hair\\textures\\hair_profiles\\{name}.hp"
    entry = {"gamePath": gp, "sampleCount": d.get("sampleCount"),
             "rootToTip": rt, "id": idg}
    if rt and idg:
        img = np.stack([bake(rt), bake(idg)], 0).round().clip(0, 255).astype(np.uint8)
        dst = OUT / "profiles" / (name + ".png")
        dst.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(img, "RGB").save(dst, optimize=True)
        entry["ramp"] = dst.relative_to(LOCAL).as_posix()
    profiles[name] = entry

# ---------- card sets ----------
cardsets = {}


def cardset_id(alpha, grad, idt):
    base = stem(grad).replace("hh_", "").split("_grad")[0]
    return base


def build_packed(sid, alpha, grad, idt):
    ims = [Image.open(png_of(p)).convert("L") if p else None for p in (grad, idt, alpha)]
    size = max((im.size for im in ims if im is not None), key=lambda s: s[0] * s[1])
    chans = []
    for im in ims:
        if im is None or im.size == (32, 32) and np.asarray(im).min() == 255:
            chans.append(Image.new("L", size, 255))
        else:
            chans.append(im.resize(size, Image.BILINEAR) if im.size != size else im)
    out = Image.merge("RGB", chans)
    dst = OUT / "cards" / f"hh_{sid}_packed.png"
    out.save(dst, optimize=True)
    return dst.relative_to(LOCAL).as_posix(), list(size)


def get_cardset(p):
    a = p.get("Strand_Alpha", {}).get("value")
    g = p.get("Strand_Gradient", {}).get("value")
    i = p.get("Strand_ID", {}).get("value")
    fl = p.get("Flow", {}).get("value")
    sid = cardset_id(a, g, i)
    if sid in cardsets:
        c = cardsets[sid]
        if c["_src"] != (a, g, i, fl):
            sid = sid + "_" + hashlib.md5(repr((a, g, i, fl)).encode()).hexdigest()[:6]
            if sid in cardsets:
                return sid
        else:
            return sid
    white_alpha = a is None or "placeholder\\white" in a
    e = {"_src": (a, g, i, fl)}
    e["alpha"] = None if white_alpha else add_tex(a, "cards", "strand_alpha")
    e["gradient"] = add_tex(g, "cards", "strand_gradient")
    e["id"] = add_tex(i, "cards", "strand_id")
    e["flow"] = add_tex(fl, "cards", "flow", color_space="linear", convert=lambda im: im.convert("RGB")) if fl else None
    e["packed"], e["packedSize"] = build_packed(sid, None if white_alpha else a, g, i)
    if white_alpha:
        e["note"] = "Strand_Alpha is the white placeholder in game: geometry is fully opaque (braid mesh); packed.B = 1"
    cardsets[sid] = e
    return sid


# ---------- materials ----------
materials = {}


def num(p, k, d):
    v = p.get(k, {}).get("value", d)
    return round(float(v), 6) if isinstance(v, (int, float)) else v


def reg(prefix, desc):
    js = json.dumps(desc, sort_keys=True)
    h = hashlib.md5(js.encode()).hexdigest()[:6]
    key = f"{prefix}"
    if key in materials and json.dumps(materials[key], sort_keys=True) != js:
        key = f"{prefix}#{h}"
    materials[key] = desc
    return key


accessory_notes = {}


def material_key(st, mn):
    m = an[st]["materials"].get(mn)
    if m is None or "error" in m:
        # local buffer missing in the cooked mesh (seen only on band meshes): same multilayer band material
        return reg("accessory.hair_band", {"type": "accessory", "kind": "hair_band", "fallbackColor": "#1d1c1e", "roughness": 0.55, "metalness": 0.0,
                                           "note": "multilayered band/clip material (steel + canvas + gold layers) - not reproduced; use flat colour"})
    p = m.get("params", {})
    mt = m.get("mt")
    if mt == HAIR_MT:
        cs = get_cardset(p)
        prof = stem(p["HairProfile"]["value"]) if "HairProfile" in p else "default"
        desc = {"type": "hairCards", "cardSet": cs, "profile": prof}
        for k, d in HAIR_DEF.items():
            desc[k[0].lower() + k[1:]] = num(p, k, d)
        desc["chain"] = m["chain"]
        return reg(f"cards.{cs}.{prof}", desc)
    if mt == CAP_MT:
        tex = {k: p.get(k, {}).get("value", dv) for k, dv in CAP_TEX_DEF.items()}
        prof_lut = stem(tex["GradientMap"])
        desc = {"type": "cap",
                "diffuse": add_tex(tex["DiffuseTexture"], "caps" if "hair" in tex["DiffuseTexture"] else "misc", "cap_diffuse_gray",
                                   color_space="linear") if "editor\\grey" not in tex["DiffuseTexture"] else None,
                "diffuseConstant": 132 / 255 if "editor\\grey" in tex["DiffuseTexture"] else None,
                "mask": add_tex(tex["MaskTexture"], "caps", "cap_mask", color_space="linear") if "editor\\white" not in tex["MaskTexture"] else None,
                "gradientLUT": add_tex(tex["GradientMap"], "cap_gradients", "cap_gradient_lut", color_space="srgb",
                                       convert=lambda im: im.convert("RGB").crop((0, 0, im.size[0], 1))),
                "secondaryMask": add_tex(tex["SecondaryMask"], "misc", "cyberware_cap_mask", color_space="linear") if "editor\\white" not in tex["SecondaryMask"] else None,
                "diffuseColor": hexc(p["DiffuseColor"]["value"]) if "DiffuseColor" in p else "#ffffff"}
        for k, d in CAP_DEF.items():
            desc[k[0].lower() + k[1:]] = num(p, k, d)
        nt = tex["NormalTexture"]
        desc["normalTextureIgnored"] = None if "editor\\normal" in nt else nt
        desc["chain"] = m["chain"]
        dn = stem(tex["DiffuseTexture"]) if desc["diffuse"] else "flat"
        return reg(f"cap.{dn}.{prof_lut.replace('hh_cap_grad__', '')}", desc)
    if mt == "engine\\materials\\multilayered.mt" or mn.startswith(("pasted__ml_hair_bands", "ml_hair_bands")):
        return reg("accessory.hair_band", {"type": "accessory", "kind": "hair_band", "fallbackColor": "#1d1c1e", "roughness": 0.55, "metalness": 0.0,
                                           "note": "multilayered band/clip material (steel + canvas + gold layers) - not reproduced; use flat colour"})
    if m.get("chain") and m["chain"][0].endswith("metal_base.remt"):
        bc = p.get("BaseColor", {}).get("value")
        desc = {"type": "accessory", "kind": "metal", "baseColor": add_tex(bc, "misc", "basecolor", color_space="srgb") if bc else None,
                "roughnessTexture": add_tex(p["Roughness"]["value"], "misc", "roughness", color_space="linear") if "Roughness" in p else None,
                "metalness": 1.0, "roughnessScale": num(p, "RoughnessScale", 1), "roughnessBias": num(p, "RoughnessBias", 0),
                "baseColorScale": p.get("BaseColorScale", {}).get("value"), "fallbackColor": "#b8b8b8",
                "note": "engine metal_base: roughness = tex.r * roughnessScale + roughnessBias; baseColor * baseColorScale (RGBA scale)"}
        return reg(f"accessory.metal.{mn}", desc)
    return reg(f"unknown.{mn}", {"type": "unknown", "mt": mt, "chain": m.get("chain"), "fallbackColor": "#202020"})


# ---------- meshes ----------
meshes = {}
used_appearances = collections.defaultdict(set)
fallbacks = []
for g in hm:
    for h, v in hm[g].items():
        for colour, lst in v["colours"].items():
            for st, ma in lst:
                if ma not in an[st]["appearances"]:
                    fallbacks.append({"gender": g, "hint": h, "colour": colour, "mesh": st, "requested": ma,
                                      "used": colour.split("_", 1)[1]})
                    ma = colour.split("_", 1)[1]
                used_appearances[st].add(ma)

for st in sorted(used_appearances):
    r = an[st]
    gm = {int(x["name"].split("_")[1]): x for x in glbm[st]}
    subs = []
    for pos, ci in enumerate(r["lod1_chunks"]):
        x = gm.get(ci)
        subs.append({"chunk": ci, "glbMesh": x["name"] if x else None, "verts": r["chunk_verts"][pos],
                     "doubleSided": bool(x and "doubled" in x["name"]), "kind": None})
    apps = {}
    for ma in sorted(used_appearances[st]):
        keys = [material_key(st, mn) if mn else None for mn in r["appearances"][ma]]
        apps[ma] = keys
        for s, k in zip(subs, keys):
            kind = {"hairCards": "cards", "cap": "cap", "accessory": "accessory"}.get(materials[k]["type"], "unknown") if k else None
            if s["kind"] is None:
                s["kind"] = kind
            elif s["kind"] != kind:
                s["kind"] = s["kind"] + "|" + kind
    meshes[st] = {"glb": f"hair/{st}.glb", "gamePath": r["depot"], "submeshes": subs, "appearances": apps}

# ---------- hints ----------
hints = {}
for g in hm:
    hints[g] = {}
    for h, v in hm[g].items():
        cols = {}
        for colour, lst in v["colours"].items():
            d = {}
            for st, ma in lst:
                if ma not in an[st]["appearances"]:
                    ma = colour.split("_", 1)[1]
                d[st] = ma
            cols[colour] = d
        hints[g][h] = {"gameApp": v["app"], "meshes": hint[g][h], "colours": cols}

# leftover misc textures
for t in ("base\\characters\\common\\character_customisation_items\\cyberware\\face\\textures\\hh_cyberware_cap_mask_01.xbm",):
    add_tex(t, "misc", "cyberware_cap_mask", color_space="linear")

for c in cardsets.values():
    c.pop("_src", None)

# catalog colour -> profile name (generic)
catalog_colours = {}
for g in ("male", "female"):
    cat = json.loads((R / f"src/data/catalog.{g}.json").read_text(encoding="utf-8"))
    for s in cat["slots"]:
        if s["id"] == "hair_color":
            for vv in s["variants"]:
                for o in vv["options"]:
                    a = o.get("app")
                    if a and a != "None":
                        p = a.split("_", 1)[1]
                        catalog_colours[a] = {"profile": p if p in profiles else None, "capGradientLUT": ("hh_cap_grad__" + p) if ("hh_cap_grad__" + p) in textures else None,
                                              "uiSwatch": o.get("hex")}

notes = json.loads((W / "notes.json").read_text(encoding="utf-8"))
manifest = {
    "version": 1,
    "game": "Cyberpunk 2077 2.x (patch 2.5 data, GOG)",
    "pathsRelativeTo": "tools/local",
    "notes": notes,
    "textures": dict(sorted(textures.items())),
    "cardSets": cardsets,
    "profiles": profiles,
    "catalogColours": dict(sorted(catalog_colours.items())),
    "materials": dict(sorted(materials.items())),
    "meshes": meshes,
    "hints": hints,
    "appearanceFallbacks": fallbacks,
}
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False), encoding="utf-8")
tot = sum(f.stat().st_size for f in OUT.rglob("*") if f.is_file())
print("textures", len(textures), "cardsets", list(cardsets), "profiles", len(profiles), "materials", len(materials), "meshes", len(meshes))
print("kinds", collections.Counter(s["kind"] for m in meshes.values() for s in m["submeshes"]))
print("files", sum(1 for f in OUT.rglob("*") if f.is_file()), "MB", round(tot / 1e6, 1))
print("fallbacks", fallbacks)
