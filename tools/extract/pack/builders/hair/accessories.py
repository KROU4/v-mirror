"""G4: bake hair accessories (multilayered bands/clips/chopsticks, Panam beads, hh_106 chrome bands) into albedo + ORM 512 px
with the body lane's multilayer baker, and point the hair manifest materials at the baked textures."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, os, sys
from pathlib import Path
import numpy as np
from PIL import Image

S = vmpaths.WORK
H = vmpaths.area('hair')
F = vmpaths.area('fix')
B = vmpaths.area('body')
sys.path.insert(0, str(vmpaths.BUILDERS / 'body'))
import milib  # noqa: E402
import bake_ml  # noqa: E402

LOCAL = Path(bake_ml.LOCAL)
OUT = LOCAL / "tex" / "hair" / "accessories"
OUT.mkdir(parents=True, exist_ok=True)
MF = LOCAL / "tex" / "hair" / "manifest.json"
SIZE = 512

# make hair-lane files visible to the body baker
milib.INDEX["base\\characters\\common\\hair\\hair_bands_clips\\textures\\ml_hair_bands_clips.mlsetup"] = str(H / "xbm_json" / "ml_hair_bands_clips.mlsetup.json")
milib.INDEX["base\\surfaces\\materials\\metal\\gold\\gold_bare_01_300.mltemplate"] = str(F / "ml_json" / "gold_bare_01_300.mltemplate.json")
bake_ml.PNG += [str(F / "ml_png"), str(H / "png")]

ML_SETUP = "base\\characters\\common\\hair\\hair_bands_clips\\textures\\ml_hair_bands_clips.mlsetup"
ML_MASK = "base\\characters\\common\\hair\\hair_bands_clips\\textures\\ml_hair_bands_clips_masksset.mlmask"

man = json.loads(MF.read_text(encoding="utf-8"))
textures, materials, meshes = man["textures"], man["materials"], man["meshes"]


def rel(p):
    return Path(p).relative_to(LOCAL).as_posix()


def save_rgb(arr, name):
    p = OUT / (name + ".png")
    Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8), "RGB").save(p, optimize=True)
    return p


def reg_tex(tid, path, cs, role, src):
    textures[tid] = {"file": rel(path), "size": [SIZE, SIZE], "mode": "RGB", "colorSpace": cs, "role": role, "gamePath": None,
                     "gameCompression": None, "gameIsGamma": None, "bakedFrom": src}
    return tid


def hexs(a):
    m = a.reshape(-1, 3).mean(0)
    return "#%02x%02x%02x" % tuple(int(round(float(x) * 255)) for x in m)


# ---- 1. multilayered bands / clips / chopsticks ----
col, rough, metal, info = bake_ml.bake(ML_SETUP, ML_MASK, size=SIZE)
pa = save_rgb(col, "ml_hair_bands_clips_albedo")
po = save_rgb(np.stack([np.ones_like(rough), rough, metal], -1), "ml_hair_bands_clips_orm")
ta = reg_tex("ml_hair_bands_clips_albedo", pa, "srgb", "baked_albedo", ML_SETUP)
to = reg_tex("ml_hair_bands_clips_orm", po, "linear", "baked_orm", ML_SETUP)
materials["accessory.hair_band"] = {
    "type": "accessory", "kind": "hair_band", "shading": "baked",
    "albedo": ta, "orm": to, "normal": None,
    "fallbackColor": hexs(col), "roughness": round(float(rough.mean()), 3), "metalness": round(float(metal.mean()), 3),
    "mlsetup": ML_SETUP, "mlmask": ML_MASK, "layers": info,
    "note": ("engine multilayered.mt (ml_hair_bands_clips.mlsetup: steel / canvas / gold layers blended by the 3 mask layers) baked to "
             "albedo (sRGB) + ORM (R=1, G=roughness, B=metalness, linear) at 512 px, UV0, same baker as body nails/underwear. "
             "Microblends/per-layer normals ignored (GlobalNormal is the flat engine normal). Used by every band/clip/chopstick submesh."),
}
print("bands", materials["accessory.hair_band"]["fallbackColor"], materials["accessory.hair_band"]["roughness"], materials["accessory.hair_band"]["metalness"])

# ---- 2. metal_base accessories (Panam beads) ----
def png(depot):
    return bake_ml.png_of(depot)


for key in [k for k in materials if k.startswith("accessory.metal.bead")]:
    m = materials[key]
    bc_depot = textures[m["baseColor"]]["gamePath"]
    r_depot = textures[m["roughnessTexture"]]["gamePath"]
    bc = np.asarray(Image.open(png(bc_depot)).convert("RGB").resize((SIZE, SIZE), Image.LANCZOS)).astype(np.float32) / 255
    rt = np.asarray(Image.open(png(r_depot)).convert("L").resize((SIZE, SIZE), Image.LANCZOS)).astype(np.float32) / 255
    sc = m["baseColorScale"]
    lin = bake_ml.s2l(bc) * np.array([sc["X"], sc["Y"], sc["Z"]], np.float32)
    alb = bake_ml.l2s(lin)
    r = np.clip(rt * m["roughnessScale"] + m["roughnessBias"], 0, 1)
    name = "hair_" + key.split(".")[-1]
    ta = reg_tex(name + "_albedo", save_rgb(alb, name + "_albedo"), "srgb", "baked_albedo", bc_depot)
    to = reg_tex(name + "_orm", save_rgb(np.stack([np.ones_like(r), r, np.ones_like(r)], -1), name + "_orm"), "linear", "baked_orm", r_depot)
    m.update({"shading": "baked", "albedo": ta, "orm": to, "normal": None, "fallbackColor": hexs(alb), "roughness": round(float(r.mean()), 3)})
    m["note"] = ("engine metal_base.remt baked: albedo = srgb(linear(BaseColor) * BaseColorScale.xyz), ORM = (1, Roughness.r * roughnessScale + "
                 "roughnessBias, Metalness = white -> 1). Raw params kept (baseColor/roughnessTexture/baseColorScale) for reference.")
    print(key, m["fallbackColor"], m["roughness"])

# ---- 3. hh_106 ponytail bands: metal_base with white BaseColor / white Metalness / RoughnessScale 0 ----
white = np.ones((SIZE, SIZE, 3), np.float32)
ta = reg_tex("hair_chrome_white_albedo", save_rgb(white, "hair_chrome_white_albedo"), "srgb", "baked_albedo", "engine\\textures\\editor\\white.xbm")
orm = np.stack([np.ones((SIZE, SIZE)), np.zeros((SIZE, SIZE)), np.ones((SIZE, SIZE))], -1)
to = reg_tex("hair_chrome_white_orm", save_rgb(orm, "hair_chrome_white_orm"), "linear", "baked_orm", "engine\\materials\\metal_base.remt defaults")
materials["accessory.metal.chrome_white"] = {
    "type": "accessory", "kind": "metal", "shading": "baked", "albedo": ta, "orm": to, "normal": None,
    "fallbackColor": "#ffffff", "roughness": 0.0, "metalness": 1.0,
    "note": ("hh_106 ponytail bands: engine metal_base.remt with BaseColor = editor white, Metalness = white, RoughnessScale = 0 (RoughnessBias default 0) "
             "-> mirror-polished white metal. In three.js clamp roughness to >= 0.08 to avoid fireflies; it reflects the env map."),
}
n106 = 0
for st, me in meshes.items():
    if not st.startswith("hh_106_"):
        continue
    for ma, keys in me["appearances"].items():
        for i, k in enumerate(keys):
            if k == "accessory.hair_band":
                keys[i] = "accessory.metal.chrome_white"
                n106 += 1
print("hh_106 rerouted", n106)

man["notes"]["accessories"] = (
    "All accessory materials are baked (shading = 'baked'): materials[key].albedo (sRGB) + .orm (linear; R = AO 1, G = roughness, B = metalness) "
    "are texture ids (textures[id].file, 512x512, under tex/hair/accessories). three.js: MeshStandardMaterial({map: albedo (SRGBColorSpace), "
    "roughnessMap: orm, metalnessMap: orm, roughness: 1, metalness: 1}), flipY = false, RepeatWrapping, UV0. "
    "accessory.hair_band = multilayered ml_hair_bands_clips (steel + canvas + gold) for every band/clip/chopstick; accessory.metal.bead1..3 = Panam beads "
    "(metal_base: tinted metal_generic); accessory.metal.chrome_white = hh_106 ponytail bands (polished white metal). fallbackColor = mean baked albedo.")
man["textures"] = dict(sorted(textures.items()))
man["materials"] = dict(sorted(materials.items()))
MF.write_text(json.dumps(man, indent=1, ensure_ascii=False), encoding="utf-8")
print("ok")
