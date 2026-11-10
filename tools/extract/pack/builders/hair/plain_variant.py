"""G1: extend tools/local/tex/hair/manifest.json with the plain (cyberware OFF) hairstyles.
Adds: meshes for the 64 plain/alternate glbs, their materials/textures, top-level hintsPlain (same shape as hints),
hintsByActivate (per catalog option, both variants), appearanceFallbacksPlain. Existing hints entries are not touched.
Material/texture logic is the hair lane's s18_build.py, seeded with the existing manifest state so keys stay stable."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, hashlib, collections, sys, struct
from pathlib import Path
import numpy as np
from PIL import Image

R = vmpaths.REPO
S = vmpaths.WORK
H = vmpaths.area('hair')
F = vmpaths.area('fix')
LOCAL = vmpaths.OUT
OUT = LOCAL / "tex" / "hair"
PNG = H / "png"
MF = OUT / "manifest.json"

man = json.loads(MF.read_text(encoding="utf-8"))
an = json.loads((F / "analysis_all.json").read_text(encoding="utf-8"))
hmp = json.loads((F / "hint_colour_map_plain.json").read_text(encoding="utf-8"))
hint_plain = json.loads((F / "hint_meshes_plain.json").read_text(encoding="utf-8"))
by_act = json.loads((F / "by_activate.json").read_text(encoding="utf-8"))
xhdr = json.loads((H / "xbm_hdr.json").read_text(encoding="utf-8"))
before = json.dumps({k: man[k] for k in ("hints", "appearanceFallbacks")}, sort_keys=True)

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

textures = man["textures"]
cardsets = man["cardSets"]
materials = man["materials"]
profiles = man["profiles"]
new_tex, new_mats, new_cardsets = [], [], []


def stem(p):
    return p.replace("/", "\\").split("\\")[-1].rsplit(".", 1)[0]


def png_of(depot):
    return PNG / Path(depot.replace("\\", "/")).with_suffix(".png")


def add_tex(depot, sub, role, color_space=None, convert=None):
    tid = stem(depot)
    if tid in textures:
        if textures[tid]["gamePath"].lower() != depot.lower():
            raise RuntimeError(f"texture id clash {tid}: {textures[tid]['gamePath']} vs {depot}")
        return tid
    src = png_of(depot)
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
    new_tex.append(tid)
    return tid


def hexc(c):
    return "#%02x%02x%02x" % (c["Red"], c["Green"], c["Blue"])


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


def same_cardset(c, a, g, i, fl):
    white = a is None or "placeholder\\white" in a
    return (c.get("alpha") == (None if white else stem(a)) and c.get("gradient") == stem(g) and c.get("id") == stem(i)
            and c.get("flow") == (stem(fl) if fl else None))


def get_cardset(p):
    a = p.get("Strand_Alpha", {}).get("value")
    g = p.get("Strand_Gradient", {}).get("value")
    i = p.get("Strand_ID", {}).get("value")
    fl = p.get("Flow", {}).get("value")
    base = stem(g).replace("hh_", "").split("_grad")[0]
    for sid in [base] + [k for k in cardsets if k.startswith(base + "_")]:
        if sid in cardsets and same_cardset(cardsets[sid], a, g, i, fl):
            return sid
    sid = base if base not in cardsets else base + "_" + hashlib.md5(repr((a, g, i, fl)).encode()).hexdigest()[:6]
    white = a is None or "placeholder\\white" in a
    e = {"alpha": None if white else add_tex(a, "cards", "strand_alpha"), "gradient": add_tex(g, "cards", "strand_gradient"),
         "id": add_tex(i, "cards", "strand_id"),
         "flow": add_tex(fl, "cards", "flow", color_space="linear", convert=lambda im: im.convert("RGB")) if fl else None}
    e["packed"], e["packedSize"] = build_packed(sid, None if white else a, g, i)
    if white:
        e["note"] = "Strand_Alpha is the white placeholder in game: geometry is fully opaque (braid mesh); packed.B = 1"
    cardsets[sid] = e
    new_cardsets.append(sid)
    return sid


def num(p, k, d):
    v = p.get(k, {}).get("value", d)
    return round(float(v), 6) if isinstance(v, (int, float)) else v


def reg(prefix, desc):
    js = json.dumps(desc, sort_keys=True)
    key = prefix
    if key in materials and json.dumps(materials[key], sort_keys=True) != js:
        key = f"{prefix}#{hashlib.md5(js.encode()).hexdigest()[:6]}"
    if key not in materials:
        new_mats.append(key)
    materials[key] = desc
    return key


def material_key(st, mn):
    m = an[st]["materials"].get(mn)
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
    if mt == "engine\\materials\\multilayered.mt":
        return "accessory.hair_band"  # baked by g4_bake.py
    if m.get("chain") and m["chain"][0].endswith("metal_base.remt"):
        if p.get("BaseColor", {}).get("value", "").endswith("editor\\white.xbm"):
            return "accessory.metal.chrome_white"  # created by g4_bake.py
        bc = p.get("BaseColor", {}).get("value")
        desc = {"type": "accessory", "kind": "metal", "baseColor": add_tex(bc, "misc", "basecolor", color_space="srgb") if bc else None,
                "roughnessTexture": add_tex(p["Roughness"]["value"], "misc", "roughness", color_space="linear") if "Roughness" in p else None,
                "metalness": 1.0, "roughnessScale": num(p, "RoughnessScale", 1), "roughnessBias": num(p, "RoughnessBias", 0),
                "baseColorScale": p.get("BaseColorScale", {}).get("value"), "fallbackColor": "#b8b8b8",
                "note": "engine metal_base: roughness = tex.r * roughnessScale + roughnessBias; baseColor * baseColorScale (RGBA scale)"}
        return reg(f"accessory.metal.{mn}", desc)
    raise RuntimeError(f"unhandled material {st} {mn} {mt} {m.get('chain')}")


def gltf(p):
    b = Path(p).read_bytes()
    n = struct.unpack_from("<I", b, 12)[0]
    return json.loads(b[20:20 + n])


def glb_meshes(st):
    g = gltf(LOCAL / "hair" / (st + ".glb"))
    out = []
    for m in g["meshes"]:
        p = m["primitives"][0]
        out.append({"name": m["name"], "verts": g["accessors"][p["attributes"]["POSITION"]]["count"]})
    return out


def resolve_app(st, ma, colour):
    if ma in an[st]["appearances"]:
        return ma, False
    alt = colour.split("_", 1)[1]
    if alt not in an[st]["appearances"]:
        raise RuntimeError(f"no appearance {st} {ma} / {alt}")
    return alt, True


# ---- appearances needed per mesh (plain hints + every catalog option) ----
need = collections.defaultdict(set)
fallbacks_plain = []
for g, hs in hmp.items():
    for h, v in hs.items():
        for colour, lst in v["colours"].items():
            for st, ma in lst:
                ma2, fb = resolve_app(st, ma, colour)
                if fb:
                    fallbacks_plain.append({"gender": g, "hint": h, "colour": colour, "mesh": st, "requested": ma, "used": ma2})
                need[st].add(ma2)
for g, acts in by_act.items():
    for a, e in acts.items():
        for colour, lst in e["colours"].items():
            for st, ma in lst:
                need[st].add(resolve_app(st, ma, colour)[0])

meshes = man["meshes"]
added_meshes, added_apps = [], []
for st in sorted(need):
    if st in meshes:
        me = meshes[st]
        for ma in sorted(need[st] - set(me["appearances"])):
            # extra appearance on an existing mesh (only reachable through hintsByActivate): add, never modify
            keys = [material_key(st, mn) if mn else None for mn in an[st]["appearances"][ma]]
            me["appearances"][ma] = keys
            added_apps.append((st, ma))
        continue
    r = an[st]
    gm = {int(x["name"].split("_")[1]): x for x in glb_meshes(st)}
    subs = []
    for pos, ci in enumerate(r["lod1_chunks"]):
        x = gm.get(ci)
        if x is None or x["verts"] != r["chunk_verts"][pos]:
            raise RuntimeError(f"glb/chunk mismatch {st} chunk {ci}: {x} vs {r['chunk_verts'][pos]}")
        subs.append({"chunk": ci, "glbMesh": x["name"], "verts": r["chunk_verts"][pos], "doubleSided": "doubled" in x["name"], "kind": None})
    apps = {}
    for ma in sorted(need[st]):
        keys = [material_key(st, mn) if mn else None for mn in r["appearances"][ma]]
        apps[ma] = keys
        for s, k in zip(subs, keys):
            kind = {"hairCards": "cards", "cap": "cap", "accessory": "accessory"}.get(materials[k]["type"], "unknown") if k in materials else (
                "accessory" if k and k.startswith("accessory.") else None)
            if k is None:
                continue
            if s["kind"] is None:
                s["kind"] = kind
            elif kind not in s["kind"].split("|"):
                s["kind"] = s["kind"] + "|" + kind
    meshes[st] = {"glb": f"hair/{st}.glb", "gamePath": r["depot"], "submeshes": subs, "appearances": apps, "set": "plain"}
    added_meshes.append(st)

# ---- hintsPlain: exactly the shape of hints ----
hints_plain = {}
for g, hs in hmp.items():
    hints_plain[g] = {}
    for h, v in hs.items():
        cols = {}
        for colour, lst in v["colours"].items():
            cols[colour] = {st: resolve_app(st, ma, colour)[0] for st, ma in lst}
        hints_plain[g][h] = {"gameApp": v["app"], "meshes": hint_plain[g][h], "colours": cols}

# ---- hintsByActivate: per catalog option ----
hints_by_act = {}
for g, acts in by_act.items():
    hints_by_act[g] = {}
    for a, e in sorted(acts.items()):
        hints_by_act[g][a] = {"variant": e["variant"], "optionI": e["optionI"], "meshHint": e["hint"], "gameApp": e["app"], "meshes": e["meshes"],
                              "colours": {c: {st: resolve_app(st, ma, c)[0] for st, ma in lst} for c, lst in e["colours"].items()}}

man["hintsPlain"] = hints_plain
man["hintsByActivate"] = hints_by_act
man["appearanceFallbacksPlain"] = fallbacks_plain
man["textures"] = dict(sorted(textures.items()))
man["materials"] = dict(sorted(materials.items()))
assert json.dumps({k: man[k] for k in ("hints", "appearanceFallbacks")}, sort_keys=True) == before, "existing hints changed!"
MF.write_text(json.dumps(man, indent=1, ensure_ascii=False), encoding="utf-8")
(LOCAL / "hair" / "hint_meshes_plain.json").write_text(json.dumps(hint_plain, indent=1, ensure_ascii=False), encoding="utf-8")
print("added meshes", len(added_meshes), "extra appearances on existing meshes", added_apps)
print("new textures", len(new_tex), new_tex)
print("new cardsets", new_cardsets)
print("new materials", len(new_mats))
print("fallbacks plain", fallbacks_plain)
print("kinds", collections.Counter(s["kind"] for st in added_meshes for s in meshes[st]["submeshes"]))
