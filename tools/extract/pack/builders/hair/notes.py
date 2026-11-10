import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json
from pathlib import Path

MF = vmpaths.OUT / 'tex' / 'hair' / 'manifest.json'
m = json.loads(MF.read_text(encoding="utf-8"))
m["notes"]["plainVsCyberware"] = [
    "Catalog slot 'hairstyle' has two variants with the same meshHint values: 'hairstyle_cyberware' (activates hair_color_cyberware_NN -> *_cyberware_01 .app) "
    "and 'hairstyle' (plain, default, activates hair_colorNN -> plain .app). hints[gender][meshHint] resolves the CYBERWARE variant; "
    "hintsPlain[gender][meshHint] has exactly the same shape ({gameApp, meshes, colours: {catalogColourApp: {meshStem: meshAppearance}}}) and resolves the PLAIN variant.",
    "57 of 123 meshHints use different meshes without cyberware (e.g. female 033_player: hh_033_pwa__player_cyberware_01 -> hh_033_wa__player); the others share the mesh. "
    "The plain meshes have their own appearances/material keys (cap textures/LUT pairs can differ), all listed in meshes (meshes[stem].set = 'plain' for the 64 added ones).",
    "meshHint is not unique per catalog option (male 999_buzz_cap x2, 120_arasaka_bun x2; female 999_buzz_cap x2, 083_ponytail_01 x3): hints/hintsPlain keep the FIRST option. "
    "hintsByActivate[gender][activateName] is exact per option for both variants: key = the option's non-fpp hair_color* activate "
    "(e.g. 'hair_color1', 'hair_color_cyberware_01', 'hair_color27'), value = {variant, optionI, meshHint, gameApp, meshes, colours} (colours shaped like hints).",
    "appearanceFallbacksPlain: same meaning as appearanceFallbacks, for hintsPlain. Game data quirk: the plain male 089_thompson .app has an extra colour key "
    "'35_silver_rose_1' (duplicate of 35_silver_rose) that the catalog never requests.",
    "hair/hint_meshes_plain.json = hint_meshes.json for the plain variant (same shape).",
]
MF.write_text(json.dumps(m, indent=1, ensure_ascii=False), encoding="utf-8")
print("ok", list(m.keys()))
