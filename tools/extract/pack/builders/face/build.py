"""Builds face-lane textures + manifest (eyes, eyelashes, eyebrows, teeth) for the three.js engine."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, shutil, sys, hashlib
from collections import defaultdict, OrderedDict
from pathlib import Path
import numpy as np
from PIL import Image

W = vmpaths.area('face')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.stdout.reconfigure(encoding="utf-8")
from matlib import load, resolve, mesh_info, v, conv, STATE
import mlbake

PROJ = vmpaths.REPO
LOCAL = vmpaths.OUT
OUT = LOCAL / "tex" / "face"
GLBOUT = LOCAL / "glb" / "face"
PNG = W / "texpng"
OUT.mkdir(parents=True, exist_ok=True)
GLBOUT.mkdir(parents=True, exist_ok=True)

G = {
    "female": {"tag": "pwa", "dir": "player_female_average"},
    "male": {"tag": "pma", "dir": "player_man_average"},
}
HB = "base\\characters\\head\\player_base_heads\\"
APPS = HB + "appearances\\head\\"


def mesh_path(g, kind):
    t = G[g]["tag"]
    return f"{HB}{G[g]['dir']}\\h0_000_{t}_c__basehead\\{kind}_000_{t}_c__basehead.mesh"


def load_app(depot):
    d = load(depot)
    if d is None:  # fall back to flattened json from step 1
        name = depot.split("\\")[-1]
        p = W / "json" / (name + ".json")
        d = json.loads(p.read_text(encoding="utf-8"))["Data"]["RootChunk"]
    out = {}
    for a in d["appearances"]:
        ad = a["Data"]
        comps = []
        for c in ad["components"]:
            if "meshAppearance" in c:
                comps.append({"component": v(c["name"]), "meshAppearance": v(c["meshAppearance"]),
                              "chunkMask": int(v(c.get("chunkMask", "18446744073709551615"))),
                              "morphResource": v(c.get("morphResource")) if c.get("morphResource") else None})
        out[v(ad["name"])] = comps
    return out


# ---------------------------------------------------------------- textures
TEXREG = OrderedDict()


def rel(p):
    return str(p.relative_to(LOCAL)).replace("\\", "/")


def src_png(depot):
    return PNG / (depot[:-4] + ".png")


def limit(im):
    if max(im.size) > 2048:
        s = 2048 / max(im.size)
        im = im.resize((max(1, int(im.size[0] * s)), max(1, int(im.size[1] * s))), Image.LANCZOS)
    return im


def put(sub, name, im, meta):
    p = OUT / sub / name
    p.parent.mkdir(parents=True, exist_ok=True)
    if not p.exists():
        limit(im).save(p, optimize=True)
    r = rel(p)
    TEXREG[r] = meta | {"size": list(Image.open(p).size), "mode": Image.open(p).mode, "bytes": p.stat().st_size}
    return r


def stem(depot):
    return depot.split("\\")[-1][:-4]


def t_color(sub, depot, keep_alpha=True):
    im = Image.open(src_png(depot))
    im = im.convert("RGBA" if keep_alpha else "RGB")
    return put(sub, stem(depot) + ".png", im, {"source": depot, "kind": "color", "colorSpace": "sRGB"})


def t_channel(sub, depot, ch, suffix, kind="mask"):
    im = Image.open(src_png(depot)).convert("RGBA")
    c = im.split()[ch]
    return put(sub, f"{stem(depot)}_{suffix}.png", c, {"source": depot, "kind": kind, "colorSpace": "linear",
                                                     "note": f"single channel ({'RGBA'[ch]} of source) stored as grayscale L png, usable as three.js alphaMap (reads G)"})


def t_normal(sub, depot):
    a = np.asarray(Image.open(src_png(depot)).convert("RGBA")).astype(np.float32) / 255.0
    x = a[..., 0] * 2 - 1
    y = a[..., 1] * 2 - 1
    z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
    y = -y  # DirectX (green = +V down) -> OpenGL/glTF (green up)
    n = np.stack([x, y, z], -1) * 0.5 + 0.5
    im = Image.fromarray((n * 255 + 0.5).astype(np.uint8), "RGB")
    return put(sub, stem(depot) + "_nrm_gl.png", im, {"source": depot, "kind": "normal", "colorSpace": "linear",
                                                   "note": "source BC5 two-channel DX normal; Z reconstructed, green flipped -> OpenGL/glTF tangent space"})


def t_orm(sub, depot, ch=0, scale=1.0, bias=0.0, name=None, metal=0.0):
    a = np.asarray(Image.open(src_png(depot)).convert("RGBA")).astype(np.float32) / 255.0
    r = np.clip(a[..., ch] * scale + bias, 0, 1)
    orm = np.stack([np.ones_like(r), r, np.full_like(r, metal)], -1)
    im = Image.fromarray((orm * 255 + 0.5).astype(np.uint8), "RGB")
    nm = name or f"{stem(depot)}_orm.png"
    return put(sub, nm, im, {"source": depot, "kind": "orm", "colorSpace": "linear",
                             "note": f"R=1 (no AO), G=roughness = src.{'RGBA'[ch]}*{scale:.4g}+{bias:.4g}, B=metalness={metal}"})


def grad_stops(depot):
    d = load(depot)
    if d is None:
        return None
    es = d.get("gradientEntries") or []
    st = sorted(((float(e["value"]), conv(e["color"])) for e in es), key=lambda t: t[0])
    return [{"t": round(t, 5), "color": c} for t, c in st]


def hexrgb(h):
    h = h.split("@")[0].lstrip("#")
    return np.array([int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)], np.float32)


def ramp(stops, x):
    ts = np.array([s["t"] for s in stops], np.float32)
    cs = np.stack([hexrgb(s["color"]) for s in stops])
    out = np.stack([np.interp(x, ts, cs[:, k]) for k in range(3)], -1)
    return out


def tohex(c):
    c = np.clip(np.round(c), 0, 255).astype(int)
    return "#%02x%02x%02x" % tuple(c)


def bake_eye_gradient(albedo, gradient, irismask):
    stops = grad_stops(gradient)
    a = np.asarray(Image.open(src_png(albedo)).convert("RGBA")).astype(np.float32)
    m = np.asarray(Image.open(src_png(irismask)).convert("RGBA").resize((a.shape[1], a.shape[0]), Image.BILINEAR)).astype(np.float32)
    iris = ramp(stops, m[..., 0] / 255.0)
    k = (m[..., 3] / 255.0)[..., None]
    rgb = a[..., :3] * (1 - k) + iris * k
    im = Image.fromarray(np.clip(rgb + 0.5, 0, 255).astype(np.uint8), "RGB")
    name = f"eye_{stem(albedo)}__{gradient.split(chr(92))[-1][:-9]}_albedo.png"
    irisavg = tohex((iris * k).sum((0, 1)) / max(k.sum(), 1))
    return put("eyes", name, im, {"source": [albedo, gradient, irismask], "kind": "color", "colorSpace": "sRGB",
                                  "note": "baked: lerp(Albedo.rgb, IrisColorGradient(IrisMask.r), IrisMask.a)"}), irisavg


def bake_ml(sub, mlsetup, mlmask, name):
    al, ro, me, used = mlbake.bake(mlsetup, mlmask, size=512)
    pa = OUT / sub / f"{name}_albedo.png"
    po = OUT / sub / f"{name}_orm.png"
    pa.parent.mkdir(parents=True, exist_ok=True)
    if not pa.exists() or not po.exists():
        mlbake.save(al, ro, me, pa, po)
    ra, rr = rel(pa), rel(po)
    TEXREG[ra] = {"source": [mlsetup, mlmask], "kind": "color", "colorSpace": "sRGB", "size": [512, 512], "mode": "RGB", "bytes": pa.stat().st_size,
                  "note": "baked multilayer albedo (approximation of engine\\materials\\multilayered.mt)"}
    TEXREG[rr] = {"source": [mlsetup, mlmask], "kind": "orm", "colorSpace": "linear", "size": [512, 512], "mode": "RGB", "bytes": po.stat().st_size,
                  "note": "baked multilayer R=1, G=roughness, B=metalness"}
    return ra, rr, used


def hp_info(depot):
    d = load(depot)
    if d is None:
        return None
    def st(key):
        es = d.get(key) or []
        s = sorted(((float(e["value"]), conv(e["color"])) for e in es), key=lambda t: t[0])
        return [{"t": round(t, 5), "color": c} for t, c in s]
    return {"rootToTip": st("gradientEntriesRootToTip"), "id": st("gradientEntriesID")}


PLACEHOLDER_VALUE = {
    "base\\materials\\placeholder\\white.xbm": 1.0,
    "base\\materials\\placeholder\\grey.xbm": 106 / 255.0,
    "engine\\textures\\editor\\white.xbm": 1.0,
    "engine\\textures\\editor\\grey.xbm": 131 / 255.0,
}

# ---------------------------------------------------------------- material conversion
EYE_SCALARS = ["RefractionIndex", "RefractionAmount", "IrisSize", "EyeRadius", "EyeParallaxPlane", "EyeHorizAngleLeft", "EyeHorizAngleRight",
               "IrisCoordFactor", "IrisCoordMargin", "BubbleNormalTile", "EggFullRadius", "EggMarginExponent", "EggMarginFactor", "EggSubFactor",
               "BlickScale", "Specularity", "RoughnessScale", "SubsurfaceFactor", "AntiLightbleedValue", "AntiLightbleedUpOff"]
FLAT_NORMALS = {"engine\\textures\\editor\\normal.xbm", "engine\\textures\\small_flat_normal.xbm", "base\\surfaces\\materials\\default\\default_n.xbm"}
_matcache = {}


def convert_material(mat, sub, label):
    """mat: local material dict from a mesh. Returns manifest material record."""
    chain, tmpl, p = resolve(mat)
    key = json.dumps([chain, p], sort_keys=True, default=str)
    hk = hashlib.md5(key.encode()).hexdigest()
    if hk in _matcache:
        return _matcache[hk]
    tname = (tmpl or "").split("\\")[-1]
    rec = {"template": tmpl, "chain": [c for c in chain if c != "<local>"]}
    if tname == "eye_gradient.mt":
        alb, irisavg = bake_eye_gradient(p["Albedo"], p["IrisColorGradient"], p["IrisMask"])
        rec.update({
            "shader": "eye_gradient",
            "maps": {"albedo": alb, "normal": t_normal("eyes", p["Normal"]),
                     "orm": t_orm("eyes", p["Roughness"], 0, float(p.get("RoughnessScale", 1)), 0, name=f"{stem(p['Roughness'])}_x{float(p.get('RoughnessScale', 1)):.3f}_orm.png"),
                     "rawAlbedo": t_color("eyes", p["Albedo"]), "irisMask": t_color("eyes", p["IrisMask"]),
                     "normalBubble": t_normal("eyes", p["NormalBubble"])},
            "irisGradient": grad_stops(p["IrisColorGradient"]), "irisGradientSource": p["IrisColorGradient"],
            "irisAvgColor": irisavg,
            "params": {k: p[k] for k in EYE_SCALARS if k in p},
            "notBaked": {"Blick": p.get("Blick"), "note": "Blick is a cubemap used for a fake specular highlight; not exported - use env map / clearcoat instead"},
        })
    elif tname == "eye.mt":
        nrm = p.get("Normal")
        rec.update({
            "shader": "eye_textured",
            "maps": {"albedo": t_color("eyes", p["Albedo"], keep_alpha=False),
                     "normal": None if nrm in FLAT_NORMALS else t_normal("eyes", nrm),
                     "orm": t_orm("eyes", p["Roughness"], 0, float(p.get("RoughnessScale", 1)), 0, name=f"{stem(p['Roughness'])}_x{float(p.get('RoughnessScale', 1)):.3f}_orm.png"),
                     "normalBubble": t_normal("eyes", p["NormalBubble"])},
            "params": {k: p[k] for k in EYE_SCALARS if k in p},
        })
    elif tname == "multilayered.mt":
        mls, msk = p["MultilayerSetup"], p["MultilayerMask"]
        nm = mls.split("\\")[-1][:-8]
        ra, ro, used = bake_ml(sub, mls, msk, f"ml_{nm}")
        gn = p.get("GlobalNormal")
        rec.update({
            "shader": "multilayered_baked",
            "maps": {"albedo": ra, "orm": ro, "normal": None if gn in FLAT_NORMALS else t_normal(sub, gn)},
            "multilayer": {"setup": mls, "mask": msk, "layersUsed": used},
            "params": {"GlobalNormalIntensity": p.get("GlobalNormalIntensity", 1)},
        })
    elif tname == "hair.mt":
        hp = hp_info(p["HairProfile"])
        gv = PLACEHOLDER_VALUE.get(p.get("Strand_Gradient"), None)
        iv = PLACEHOLDER_VALUE.get(p.get("Strand_ID"), None)
        sugg = None
        if hp and gv is not None and iv is not None:
            c1 = ramp(hp["rootToTip"], np.array([gv]))[0]
            c2 = ramp(hp["id"], np.array([iv]))[0]
            sugg = {"rootToTipAtStrandGradient": tohex(c1), "idAtStrandId": tohex(c2), "product": tohex(c1 * c2 / 255.0)}
        rec.update({
            "shader": "hair_card",
            "maps": {"alpha": t_channel("lashes", p["Strand_Alpha"], 0, "alpha", "alpha")},
            "hairProfile": p["HairProfile"], "hairProfileGradients": hp,
            "strandGradientTexture": p.get("Strand_Gradient"), "strandGradientConst": gv,
            "strandIdTexture": p.get("Strand_ID"), "strandIdConst": iv,
            "suggestedColor": sugg,
            "params": {k: p.get(k) for k in ("AlphaCutoff", "RoughnessScale", "RoughnessBias", "Scattering", "VertexColorStrength", "ShadowStrength", "ShadowMin", "ShadowMax", "ShadowRoughness", "FlowStrength")},
        })
    elif tname == "eye_shadow.mt":
        rec.update({
            "shader": "eye_shadow_wetness",
            "maps": {"maskRGBA": t_color("eyes", p["Mask"]), "maskA": t_channel("eyes", p["Mask"], 3, "a"),
                     "maskR": t_channel("eyes", p["Mask"], 0, "r"), "maskG": t_channel("eyes", p["Mask"], 1, "g")},
            "params": {k: p.get(k) for k in ("ShadowColor", "Intensity", "Exponent", "AdditiveAlphaBlend", "WetnessRoughness", "WetnessStrength", "SubsurfaceBlur")},
        })
    elif tname == "skin.mt":
        rec.update({
            "shader": "skin",
            "maps": {"albedo": t_color("teeth", p["Albedo"], keep_alpha=False), "normal": t_normal("teeth", p["Normal"]),
                     "orm": t_orm("teeth", p["Roughness"], 0, 1.0, 0.0), "tintColorMask": t_channel("teeth", p["TintColorMask"], 0, "l")},
            "params": {k: p.get(k) for k in ("TintColor", "TintScale", "CavityIntensity", "DetailRoughnessBiasMin", "DetailRoughnessBiasMax", "MicroDetailInfluence", "SubsurfaceFactor")},
            "skinProfile": p.get("SkinProfile"),
        })
    elif tname == "mesh_decal_double_diffuse.mt":
        rec.update({"shader": "decal_double_diffuse", "rawParams": p})
    else:
        rec.update({"shader": "unknown:" + tname, "rawParams": {k: x for k, x in p.items() if not isinstance(x, dict)}})
    _matcache[hk] = rec
    return rec


def chunk_roles(g, ents, apps):
    """role per chunk index from a representative appearance"""
    roles = {}
    for an, mats in apps.items():
        if an == "default":
            continue
        for i, mn in enumerate(mats):
            ch, tmpl, p = resolve(ents[mn])
            t = (tmpl or "").split("\\")[-1]
            r = "eyelashes" if t == "hair.mt" else "eye_wetness" if t == "eye_shadow.mt" else "eyeball"
            roles.setdefault(i, r)
        if len(roles) == len(mats):
            break
    return roles


def visible_chunks(mask, n):
    return [i for i in range(n) if (mask >> i) & 1]


# ---------------------------------------------------------------- catalog
CAT = {}
for g in G:
    CAT[g] = json.loads((PROJ / "src" / "data" / f"catalog.{g}.json").read_text(encoding="utf-8"))


def cat_opts(g, slot):
    for s in CAT[g]["slots"]:
        if s["id"] == slot:
            for vv in s["variants"]:
                for o in vv["options"]:
                    yield vv, o


manifest = OrderedDict()
manifest["generatedBy"] = "face lane extractor (WolvenKit 9.1.1 serialize/export + python bakes)"
manifest["root"] = "tools/local"
manifest["pathsRelativeTo"] = "tools/local (all texture/glb paths below)"
problems = []

# ---------------------------------------------------------------- meshes
he_app = load_app(APPS + "he_000__basehead.app")
hel_app = load_app(APPS + "hel_000__basehead.app")
ht_app = load_app(APPS + "ht_000__basehead.app")

meshes = OrderedDict()
EYEINFO = {}
for g in G:
    t = G[g]["tag"]
    apps, ents, d = mesh_info(mesh_path(g, "he"))
    n = len(apps["default"])
    roles = chunk_roles(g, ents, apps)
    glbnames = {0: "submesh_00_LOD_1_doubled", 1: "submesh_01_LOD_1", 2: "submesh_02_LOD_1"}
    EYEINFO[g] = (apps, ents, roles)
    # copy teeth glbs
    for src, dst in ((W / "glb_out" / f"ht_000_{t}__morphs.morphtarget.glb", GLBOUT / f"ht_000_{t}__morphs.morphtarget.glb"),
                     (W / "glb_out" / f"ht_000_{t}_c__basehead.glb", GLBOUT / f"ht_000_{t}_c__basehead.glb")):
        shutil.copyfile(src, dst)
    tbones = [v(b) for b in load(mesh_path(g, "ht"))["boneNames"]]
    meshes[g] = OrderedDict({
        "eyes": {"glb": f"glb/he_000_{t}__morphs.morphtarget.glb", "sourceMesh": mesh_path(g, "he"),
                 "parts": {glbnames[i]: {"chunk": i, "role": roles[i],
                                         "drivenBySlot": "eyelash_color" if roles[i] == "eyelashes" else "eyes_color"} for i in range(n)},
                 "note": "In game two components share this mesh: the eyes_color app renders chunks " +
                         str(visible_chunks(18446744073709551614, n)) + " (chunkMask ...FFFE) and the eyelash_color app renders chunk [0] (chunkMask ...FFF9). Chunk order differs between genders - use 'parts'."},
        "eyebrows": {"glb": f"glb/heb_000_{t}__morphs.morphtarget.glb", "sourceMesh": mesh_path(g, "heb"),
                     "parts": {"submesh_00_LOD_1": {"chunk": 0, "role": "eyebrows", "drivenBySlot": "eyebrows (style) + eyebrows_color"}},
                     "note": "Single 390-vertex decal strip hugging the brow skin; the style is purely the texture set (no geometry change)."},
        "teeth": {"glb": f"glb/face/ht_000_{t}__morphs.morphtarget.glb", "glbNoMorphs": f"glb/face/ht_000_{t}_c__basehead.glb",
                  "sourceMesh": mesh_path(g, "ht"), "morphtarget": f"{HB}{G[g]['dir']}\\ht_000_{t}__morphs.morphtarget",
                  "parts": {"submesh_00_LOD_1": {"chunk": 0, "role": "teeth_gums_tongue", "drivenBySlot": "teeth"}},
                  "skinnedToBones": tbones,
                  "note": ("ONE submesh/material contains upper+lower teeth, gums and tongue (the albedo atlas holds all of them). "
                           "Skinned to Head (upper teeth/gums), mid_J_jaw_JNT (lower teeth/gums - rotate this bone to open the mouth, the head glb is skinned to the same bone name) "
                           "and the tongue chain l/mid/r_J_tongue_row[A-D]_0_JNT. Exported with the same WolvenKit exporter/space as the head/eyes glbs "
                           "(Y-up, metres, face looking -Z, identical 'Head' bind position), so it lines up without any offset. "
                           "Morph targets h0X3_mouth (21 female / 20 male) mirror the head's mouth morphs - drive them with the same weights as the head's hXX3_mouth targets.")},
    })
JAWPIVOT = {"female": [-6.9e-07, 1.6769125, 0.0058320826], "male": [-4.99e-05, 1.6799879, 0.0042544077]}
for g in G:
    meshes[g]["teeth"]["jawOpen"] = {
        "pivotWorld": JAWPIVOT[g],
        "axisWorld": [1, 0, 0],
        "signToOpen": "negative angle about world +X (verified: lower-teeth centroid moves down and back). With GLTFLoader bones (flat skeleton, every joint is a direct child of 'Armature', joint rest rotation = 180deg about (1,1,0)/sqrt2) this is jawBone.rotateY(-angle) in the bone's local frame.",
        "typicalAngleDeg": [8, 20],
        "teethGlb": "Rotating mid_J_jaw_JNT alone opens the teeth glb correctly (1553/3210 verts are weighted to it: lower teeth, lower gums, part of tongue).",
        "headGlbCaveat": ("The head glb skeleton is exported FLAT (no hierarchy), and the head skin has only ~80 verts dominated by mid_J_jaw_JNT; the chin/lower lip are skinned to "
                          "separate face joints. To open the mouth on the head as well, rotate these joints too about the same pivot/axis (full angle): names matching "
                          "/(mid_J_jaw_JNT|_J_mug_chin_|_J_mug_lip_dn|_J_mug_lip_corner_inside_dn|_J_mug_mouth_row[AB]_[4-6]|_J_jaw_throat|_J_jaw_nosabial_row[AB]_[34]|_J_tongue_)/ "
                          "and ~50% of the angle for _J_mug_mouth_rowA_3 / _J_jaw_nosabial_rowC_3 / _J_jaw_rowB_2. Approximation of the facial rig - tune visually."),
    }
manifest["meshes"] = meshes
manifest["shaderNotes"] = OrderedDict({
    "general": [
        "All colour PNGs (albedo/diffuse/gradient strips) are sRGB -> texture.colorSpace = SRGBColorSpace. Normal/ORM/mask PNGs are linear (NoColorSpace).",
        "glb meshes come from WolvenKit with glTF UV convention -> set texture.flipY = false for every texture used on them.",
        "Normal maps: game source is BC5 (only X/Y stored, DirectX convention: green = +V pointing DOWN in the image; verified on brow strand normals). "
        "Every *_nrm_gl.png here is already converted: Z reconstructed and green inverted to OpenGL/glTF convention -> use as normalMap with normalScale (1,1). "
        "If bumps ever look inverted, set normalScale.y = -1.",
        "ORM PNGs: R = 1 (no AO), G = roughness, B = metalness (three.js roughnessMap reads G, metalnessMap reads B -> pass the same texture to both).",
        "alpha/mask PNGs are single-channel grayscale (L) so three.js alphaMap (which reads G) works directly.",
        "Eye textures: eyeball UV0 goes outside 0..1 (back of eyeball) -> use ClampToEdgeWrapping for eye albedo/normal/orm.",
    ],
    "eye_gradient": ("Game shader base\\materials\\eye_gradient.mt (eyeball: sclera+iris+pupil in one 512px atlas, iris centred). Albedo is baked here: "
                     "albedo = lerp(Albedo.rgb, IrisColorGradient(IrisMask.r), IrisMask.a) (IrisMask.r = grey iris fibre detail, .a = iris ring with pupil hole). "
                     "Game adds refraction/parallax of the iris under a cornea (RefractionIndex/IrisSize/EyeRadius/EyeParallaxPlane), a cubemap glint (Blick) and SSS. "
                     "three.js: MeshPhysicalMaterial{map: albedo, normalMap: normal (iris relief), roughnessMap/metalnessMap: orm (roughness already *RoughnessScale), "
                     "metalness 0, clearcoat 1, clearcoatRoughness 0.02-0.05, clearcoatNormalMap: normalBubble (optional, tile BubbleNormalTile), envMapIntensity ~1}. "
                     "Optional parallax: offset iris UVs toward the view by EyeParallaxPlane inside IrisMask.a."),
    "eye_textured": "base\\materials\\eye.mt - same as eye_gradient but Albedo already contains the final iris (cyber/double/ring/stand_clear/circle/rebecca eyes). Use maps.albedo directly.",
    "multilayered_baked": ("engine\\materials\\multilayered.mt (Multilayer eyes, metal/pink teeth). Baked here into albedo + ORM at 512px: per layer colour = template colorTexture (normalised to mean 1) * colorScale override "
                           "(linear), roughness/metalness = template textures remapped by roughLevelsOut/metalLevelsOut ([max,min] pairs), blended bottom-to-top with mlmask layer i * opacity "
                           "(layer 0 = full). Microblends ignored. Approximation, checked against the in-game UI thumbnails. Use as MeshPhysicalMaterial{map, roughnessMap+metalnessMap: orm, normalMap: normal (teeth only)}; "
                           "for multilayer eyes also clearcoat 1 like the gradient eyes."),
    "hair_card": ("base\\materials\\hair.mt (eyelashes). maps.alpha = strand coverage (female: one 32x128 single-lash texture mapped on each of ~1.5k strand cards, 12393 verts, "
                  "male: 512px lash-row atlas on 255-vert cards). Colour comes from the HairProfile (.hp) gradients: rootToTip sampled by Strand_Gradient texture (placeholder white => t=1 i.e. tip colour) "
                  "and id gradient sampled by Strand_ID (placeholder grey => t~0.42). Exact game combine is not documented; suggestedColor.product = rootToTip(t) * id(t) is the closest to the UI swatch. "
                  "three.js: MeshStandardMaterial{color: suggestedColor.product, alphaMap: alpha, transparent:false, alphaTest 0.3-0.5 (or alphaToCoverage with MSAA), side: DoubleSide, roughness 0.5, depthWrite true}."),
    "eye_shadow_wetness": ("base\\materials\\eye_shadow.mt on the 152-vert lid-margin strip (tear line / lid contact shadow), drawn translucent over the eyeball. "
                           "Mask channels: A = soft rim shadow along the lids (main alpha), R = ~1 outside the eye opening and low inside (lens shape), G constant (~0.42), B ~0. "
                           "three.js approximation: MeshPhysicalMaterial{color: ShadowColor, transparent: true, depthWrite: false, opacity: Intensity, alphaMap: maskA "
                           "(game applies pow(mask, Exponent)), roughness 0.05 (wet, WetnessRoughness/WetnessStrength), polygonOffset to avoid z-fighting}, renderOrder after the eyeball."),
    "skin_teeth": ("base\\materials\\skin.mt for natural teeth (teeth_001): albedo atlas contains teeth, gums and tongue. ORM G = Roughness.r. Game also applies TintColor (#3d2500, TintScale 0.9) through "
                   "TintColorMask (exported as tintColorMask, grayscale) - exact skin-shader tint formula unknown; leave it out or use a very subtle mix(albedo, albedo*tint*2, mask*0.15). "
                   "SkinProfile customisation_teeth.sp drives SSS: use MeshPhysicalMaterial with a little sheen/transmission or just roughness from ORM."),
    "decal_double_diffuse_brows": ("base\\materials\\mesh_decal_double_diffuse.mt on the 390-vert brow strip, alpha-blended over the head skin (render after head, depthWrite false, polygonOffset -1). "
                                   "Two layers: (1) secondary 'shadow' layer: colour = SecondaryDiffuseColor, alpha = secondaryAlpha * SecondaryDiffuseAlphaIntensity; "
                                   "(2) strands: alpha = strandAlpha (DiffuseTexture.a) * DiffuseAlpha, colour = GradientMap(u = strandLuma (DiffuseTexture.r), v = 0.5) * GradientMapIntensity "
                                   "(UseGradientMap=1 for all colours; if you do not want a custom shader use colors[app].suggestedStrandColor as flat colour). "
                                   "Normal: NormalTexture blended with NormalAlpha 0.4. RoughnessTexture is engine roughmetal (rough 0.5, metal 0). "
                                   "Simplest three.js: two meshes (or two draw passes) sharing the brow geometry: pass 1 MeshStandardMaterial{color: SecondaryDiffuseColor, alphaMap: secondaryAlpha, opacity: SecondaryDiffuseAlphaIntensity, transparent}, "
                                   "pass 2 {color: suggestedStrandColor, alphaMap: strandAlpha, normalMap: normal, transparent, roughness 0.6}."),
    "morphs": "eyes/brows/teeth glbs carry morph targets with the same names as the head glb (hXXY_<region>); apply the same weights as the head to keep them aligned.",
})

# ---------------------------------------------------------------- eyes_color
eyes = OrderedDict()
for g in G:
    apps, ents, roles = EYEINFO[g]
    for vv, o in cat_opts(g, "eyes_color"):
        app = o.get("app")
        if not app or app == "None":
            continue
        comps = he_app.get(app)
        if not comps:
            problems.append(f"eyes_color {g} {app}: app not in he_000__basehead.app")
            continue
        c = comps[0]
        ma = c["meshAppearance"]
        mats = apps.get(ma)
        if not mats:
            problems.append(f"eyes_color {g} {app}: mesh appearance {ma} missing")
            continue
        rec = OrderedDict({"gender": g, "meshAppearance": ma, "chunkMask": str(c["chunkMask"]), "visibleChunks": visible_chunks(c["chunkMask"], len(mats))})
        for i in rec["visibleChunks"]:
            role = roles[i]
            rec[role] = convert_material(ents[mats[i]], "eyes", f"{app}:{role}") | {"materialName": mats[i]}
        rec["catalogHex"] = o.get("hex"); rec["catalogIris"] = o.get("iris")
        eyes[app] = rec
manifest["eyes_color"] = eyes

# ---------------------------------------------------------------- eyelash_color
lashes = OrderedDict()
for g in G:
    apps, ents, roles = EYEINFO[g]
    lash_chunk = [i for i, r in roles.items() if r == "eyelashes"][0]
    for vv, o in cat_opts(g, "eyelash_color"):
        app = o.get("app")
        if not app or app == "None":
            continue
        comps = hel_app.get(app)
        if not comps:
            problems.append(f"eyelash_color {g} {app}: not in hel_000__basehead.app")
            continue
        c = [x for x in comps if G[g]["tag"] in (x["component"] or "")] or comps
        c = c[0]
        ma = c["meshAppearance"]
        mats = apps.get(ma)
        if not mats:
            problems.append(f"eyelash_color {g} {app}: mesh appearance {ma} missing")
            continue
        rec = OrderedDict({"gender": g, "meshAppearance": ma, "chunkMask": str(c["chunkMask"]), "visibleChunks": visible_chunks(c["chunkMask"], len(mats))})
        rec["eyelashes"] = convert_material(ents[mats[lash_chunk]], "lashes", app) | {"materialName": mats[lash_chunk]}
        rec["catalogHex"] = o.get("hex")
        lashes[app] = rec
manifest["eyelash_color"] = lashes

# ---------------------------------------------------------------- teeth
teeth = OrderedDict()
for g in G:
    apps, ents, d = mesh_info(mesh_path(g, "ht"))
    for vv, o in cat_opts(g, "teeth"):
        app = o.get("app")
        comps = ht_app.get(app)
        if not comps:
            problems.append(f"teeth {g} {app}: not in ht_000__basehead.app")
            continue
        c = comps[0]
        ma = c["meshAppearance"]
        mats = apps[ma]
        teeth[app] = OrderedDict({"gender": g, "meshAppearance": ma, "glb": meshes[g]["teeth"]["glb"],
                                  "teeth_gums_tongue": convert_material(ents[mats[0]], "teeth", app) | {"materialName": mats[0]}})
manifest["teeth"] = teeth

# ---------------------------------------------------------------- eyebrows
styles = OrderedDict()
colors = OrderedDict()
exceptions = []
style_hints = defaultdict(set)
for g in G:
    for vv, o in cat_opts(g, "eyebrows"):
        style_hints[g].add(o.get("meshHint"))
COLKEYS = ("DiffuseColor", "DiffuseAlpha", "GradientMap", "GradientMapIntensity", "GradientMapUV", "UseGradientMap", "SecondaryDiffuseColor",
           "SecondaryDiffuseAlphaIntensity", "NormalAlpha", "NormalsBlendingMode", "UseNormalAlphaTex", "RoughnessTexture", "RoughnessScale", "RoughnessBias",
           "MetalnessTexture", "RoughnessMetalnessAlpha", "UVScaleX", "UVScaleY", "UVOffsetX", "UVOffsetY", "UVRotation", "AlphaMaskContrast")
for g in G:
    apps, ents, d = mesh_info(mesh_path(g, "heb"))
    styles[g] = OrderedDict()
    for hint in sorted(h for h in style_hints[g] if h):
        app = load_app(APPS + "eyebrows\\" + hint + ".app")
        st_tex = None
        for cname, comps in app.items():
            if not cname.startswith(g + "__"):
                continue
            ma = comps[0]["meshAppearance"]
            if ma not in apps:
                problems.append(f"eyebrows {g} {hint} {cname}: mesh appearance {ma} missing")
                continue
            ch, tmpl, p = resolve(ents[apps[ma][0]])
            tex3 = (p.get("DiffuseTexture"), p.get("SecondaryDiffuseAlpha"), p.get("NormalTexture"))
            if st_tex is None:
                st_tex = tex3
            elif tex3 != st_tex:
                exceptions.append({"gender": g, "style": hint, "app": cname, "textures": tex3, "expected": st_tex})
            colrec = {k: p.get(k) for k in COLKEYS}
            colrec["chain"] = ch[1:-1]
            key = cname
            if key in colors:
                prev = {k: colors[key][k] for k in COLKEYS}
                if prev != {k: colrec[k] for k in COLKEYS}:
                    exceptions.append({"gender": g, "style": hint, "app": cname, "params": {k: colrec[k] for k in COLKEYS if colrec[k] != prev[k]},
                                       "expected": {k: prev[k] for k in COLKEYS if colrec[k] != prev[k]}})
            else:
                colors[key] = colrec
        if st_tex is None:
            problems.append(f"eyebrows {g} {hint}: no appearances")
            continue
        dtex, stex, ntex = st_tex
        styles[g][hint] = OrderedDict({
            "app": APPS + "eyebrows\\" + hint + ".app",
            "diffuseRGBA": t_color("brows", dtex), "strandAlpha": t_channel("brows", dtex, 3, "a", "alpha"),
            "strandLuma": t_channel("brows", dtex, 0, "r", "mask"),
            "secondaryAlpha": t_channel("brows", stex, 3, "a", "alpha"), "secondaryRGBA": t_color("brows", stex),
            "normal": t_normal("brows", ntex), "sources": {"DiffuseTexture": dtex, "SecondaryDiffuseAlpha": stex, "NormalTexture": ntex},
        })
# colour records: gradient map png + suggested colour
for key, c in colors.items():
    gm = c.get("GradientMap")
    if gm:
        c["gradientMapPng"] = t_color("brows/gradients", gm, keep_alpha=False)
        a = np.asarray(Image.open(src_png(gm)).convert("RGB")).astype(np.float32)
        row = a[a.shape[0] // 2]
        c["gradientSamples8"] = [tohex(row[int(i * (len(row) - 1) / 7)]) for i in range(8)]
        inten = float(c.get("GradientMapIntensity") or 1)
        # strand pixels of DiffuseTexture.r are ~0.75-0.97 -> sample there
        smp = row[int(0.85 * (len(row) - 1))]
        lin = mlbake.s2l(smp / 255.0) * inten
        c["suggestedStrandColor"] = tohex(mlbake.l2s(lin) * 255)
        c["suggestedStrandColor_note"] = "GradientMap sampled at u=0.85 (typical DiffuseTexture.r of strands) x GradientMapIntensity in linear space"
gm_png = {c.get("GradientMap"): c.get("gradientMapPng") for c in colors.values()}
for e in exceptions:
    if "params" in e and "GradientMap" in e["params"]:
        gmx = e["params"]["GradientMap"]
        e["gradientMapPng"] = gm_png.get(gmx) or t_color("brows/gradients", gmx, keep_alpha=False)
for g in G:
    for vv, o in cat_opts(g, "eyebrows_color"):
        if o.get("app") in colors:
            colors[o["app"]]["catalogHex"] = o.get("hex")
manifest["eyebrows"] = OrderedDict({
    "styles": styles,
    "colors": colors,
    "colorOptionNote": ("eyebrows_color app names (e.g. female__05_brown_liquorice) are identical in every heb_000__basehead_NN.app; each selects mesh appearance "
                        "'<colour>__NN' whose material = style textures of NN + colour params of <colour>. Verified style-independent; deviations listed in 'exceptions'."),
    "exceptions": exceptions,
    "noneOption": "eyebrows option with meshHint null (activates eyebrows_color0) = no eyebrows: hide the brow mesh.",
})
manifest["textures"] = TEXREG
manifest["problems"] = problems
(OUT / "manifest.json").write_text(json.dumps(manifest, indent=1, ensure_ascii=False, default=str), encoding="utf-8")
print("eyes", len(eyes), "lashes", len(lashes), "teeth", len(teeth), "brow styles", {g: len(s) for g, s in styles.items()}, "brow colors", len(colors))
print("textures", len(TEXREG), "bytes", sum(t["bytes"] for t in TEXREG.values()))
print("exceptions", len(exceptions), "problems", len(problems))
for pr in problems[:30]:
    print("  P", pr)
for e in exceptions[:10]:
    print("  E", e)
