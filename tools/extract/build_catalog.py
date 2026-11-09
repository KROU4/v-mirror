"""
Собирает каталог редактора персонажа Cyberpunk 2077 из файлов игры.

Вход (готовится скриптом extract_game_data.ps1 через WolvenKit CLI):
  <work>/cc_json/{male,female}_cco_ep1.inkcharcustomization.json
  <work>/cc_json/character_creation_thumbnails_atlas.inkatlas.json
  <work>/atlas_png/character_creation_thumbnails_atlas.png
  <work>/loc_json/*/onscreens.json.json        (ru-ru и en-us, base + ep1)
  <work>/all_list.txt                          (листинг архивов, для имён мешей причёсок)

Выход: src/data/catalog.male.json, src/data/catalog.female.json

В каталог попадают только факты (структура опций, имена, номера, усреднённые
цвета образцов). Текстуры, меши и иконки игры в приложение не копируются.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image


def v(x):
    if isinstance(x, dict) and "$value" in x:
        return x["$value"]
    return x


# ---------------------------------------------------------------- localization
def load_loc(loc_dir: Path, lang: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for f in sorted(loc_dir.glob(f"*{lang}*/*.json")):
        data = json.loads(f.read_text(encoding="utf-8"))
        for e in data["Data"]["RootChunk"]["root"]["Data"]["entries"]:
            text = e.get("femaleVariant") or e.get("maleVariant") or ""
            if not text:
                continue
            sk = e.get("secondaryKey") or ""
            pk = str(e.get("primaryKey") or "")
            if sk:
                out.setdefault(sk, text)
            if pk and pk != "0":
                out.setdefault(f"LocKey#{pk}", text)
    return out


def resolve(key: str, ru: dict, en: dict) -> dict:
    key = (key or "").strip()
    if not key:
        return {"ru": "", "en": ""}
    r = ru.get(key)
    e = en.get(key)
    if r is None and e is None:
        if key.startswith("UI-CharacterCreation-"):
            return humanize(key.replace("UI-CharacterCreation-", ""))
        return {"ru": key, "en": key}
    return {"ru": r or e or key, "en": e or r or key}


# Названия цветов в локализации игры отсутствуют (в UI показываются только образцы),
# поэтому делаем читаемые подписи из внутренних имён.
RU_WORDS = {
    "black": "чёрный", "brown": "коричневый", "blonde": "блонд", "platinum": "платиновый", "golden": "золотистый",
    "gold": "золото", "dishwater": "пепельный", "dishwasher": "пепельный", "red": "красный", "merlot": "мерло",
    "ginger": "рыжий", "copper": "медный", "strawberry": "клубничный", "teal": "бирюзовый", "ombre": "омбре",
    "liquorice": "лакричный", "carbon": "угольный", "blue": "синий", "sapphire": "сапфировый", "saphire": "сапфировый",
    "apple": "яблочный", "gray": "серый", "grey": "серый", "gunmetal": "оружейный", "ash": "пепельный", "pink": "розовый",
    "magenta": "маджента", "rose": "чайная роза", "cyan": "циан", "baby": "нежно", "sign": "", "multilayer": "узор",
    "warning": "предупреждение", "splash": "брызги", "rebecca": "ребекка", "steel": "стальной", "cold": "холодный", "white": "белый",
    "cyberpunk": "киберпанк", "yellow": "жёлтый", "goblin": "гоблинский", "green": "зелёный", "liliac": "сиреневый",
    "lilac": "сиреневый", "mermaid": "русалочий", "aquamarine": "аквамарин", "purple": "фиолетовый", "salt": "соль",
    "n": "и", "pepper": "перец", "toxic": "токсичный", "medium": "средний", "sky": "небесный", "citrus": "цитрусовый",
    "dark": "тёмный", "orange": "оранжевый", "phoenix": "феникс", "fire": "огонь", "silver": "серебряный",
    "light": "светлый", "violet": "фиолетовый", "gradient": "градиент", "blood": "кровавый", "default": "стандарт",
    "metal": "металл", "rusty": "ржавый", "pearl": "жемчуг", "plastic": "пластик", "wood": "дерево", "rainbow": "радуга",
    "mixed": "микс", "neon": "неоновый", "metalic": "металлик", "peach": "персиковый", "burgundy": "бордовый",
    "scarlet": "алый", "pastel": "пастельный", "very": "очень", "raspberry": "малиновый", "beige": "бежевый",
    "crimson": "багровый", "turquoise": "бирюзовый", "chrome": "хром", "and": "и", "strap": "полоса",
    "heart": "сердце", "ragged": "рваный", "zygzag": "зигзаг", "checker": "клетка", "dots": "точки",
    "holo": "голо", "nails": "ногти", "five": "пять", "colors": "цветов", "color": "цвет", "end": "кончики",
    "none": "нет", "ca": "", "bl": "", "pale": "бледный", "limestone": "известняк", "senna": "сенна",
    "almond": "миндаль", "espresso": "эспрессо", "warm": "тёплый", "ivory": "слоновая кость", "amber": "янтарный",
    "honey": "медовый", "band": "бронзовый", "umber": "умбра", "nude": "нюд", "relic": "реликт",
}


def humanize(raw: str) -> dict:
    s = re.sub(r"^.*__", "", raw)          # he_000_pma__basehead__12_gradient_brown -> 12_gradient_brown
    s = re.sub(r"^(Bla(?=[A-Z])|Thumb_nail_(0\d_)?(all_)?|Makeup_(lip_color|cheek|freckle)_|Makeupcolor_|Piercing_|Teeth_|Pubes_)", "", s)
    s = re.sub(r"^\d+_", "", s)
    s = re.sub(r"_?multilayer$", "", s)
    toks = [t for t in re.split(r"[_\s]+|(?<=[a-z])(?=[A-Z])", s) if t]
    en = " ".join(t.capitalize() for t in toks)
    ru = " ".join(RU_WORDS.get(t.lower(), t.lower()) for t in toks)
    return {"ru": ru[:1].upper() + ru[1:], "en": en}


# ---------------------------------------------------------------- atlas colors
def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.lower())


ICON_FIXES = {
    "blablondeplatinum": "blondeplatinum",
    "blablondegolden": "blondegolden",
    "mermiadaquamarine": "mermaidaquamarine",
    "blondedishwasher": "blondedishwasher",
    "bluesaphire": "bluesaphire",
    "multilayerarasakablac": "multilayerarasakablack",
    "makeupfreckleverylightblack": "freckles02verylighbrown",
    "gradientgray": "gradientgrey",
}


def atlas_key(part: str) -> str:
    p = part.lower()
    p = re.sub(r"-duplicate$", "", p)
    p = re.sub(r"^(ccthumb_|cc_thumb_|00_thumb_|00_)", "", p)
    p = re.sub(r"^\d+_(ca_|bl_)?", "", p)
    p = p.replace("__multilayer", "multilayer").replace("_multilayer", "multilayer")
    return norm(p)


def icon_key(icon: str) -> str:
    k = norm(icon.replace("OptionsIcons.", ""))
    return ICON_FIXES.get(k, k)


def build_atlas_colors(atlas_json: Path, atlas_png: Path) -> dict[str, dict]:
    atlas = json.loads(atlas_json.read_text(encoding="utf-8"))["Data"]["RootChunk"]
    parts = atlas["slots"]["Elements"][0]["parts"]
    im = Image.open(atlas_png).convert("RGB")
    W, H = im.size
    px = im.load()
    out = {}
    for p in parts:
        name = v(p["partName"])
        r = p["clippingRectInUVCoords"]
        x0, x1 = int(r["Left"] * W), int(r["Right"] * W)
        y0, y1 = int(r["Top"] * H), int(r["Bottom"] * H)
        w, h = x1 - x0, y1 - y0
        cx, cy = x0 + w / 2, y0 + h / 2
        center, ring = [], []
        for yy in range(y0 + 2, y1 - 2, 2):
            for xx in range(x0 + 2, x1 - 2, 2):
                dx, dy = (xx - cx) / w, (yy - cy) / h
                d = (dx * dx + dy * dy) ** 0.5
                c = px[xx, yy]
                if abs(dx) < 0.3 and abs(dy) < 0.3:
                    center.append(c)
                if 0.12 < d < 0.3:
                    ring.append(c)

        def avg(cs):
            if not cs:
                return [0, 0, 0]
            return [round(sum(c[i] for c in cs) / len(cs)) for i in range(3)]

        def iris(cs):
            # Радужка: берём самые насыщенные пиксели кольца (без зрачка и белка).
            if not cs:
                return [0, 0, 0]

            def sat(c):
                mx, mn = max(c), min(c)
                return 0 if mx == 0 else (mx - mn) / mx * (0.3 + mx / 255)

            s = sorted(cs, key=sat, reverse=True)[: max(8, len(cs) // 4)]
            return avg(s)

        out[name] = {"avg": avg(center), "ring": iris(ring)}
    return out


def to_hex(rgb) -> str:
    return "#" + "".join(f"{int(c):02x}" for c in rgb)


def match_icon(icon: str, atlas_colors: dict[str, dict], index: dict[str, str]) -> str | None:
    k = icon_key(icon)
    if not k:
        return None
    if k in index:
        return index[k]
    # Makeup_lip_color_red -> makeuplipcolorred ; atlas 00_makeup_lip_color_red -> makeuplipcolorred
    cands = [(a, n) for a, n in index.items() if k in a or a in k]
    if cands:
        cands.sort(key=lambda t: -len(t[0]))
        return cands[0][1]
    # cheeks / lips / makeup color fallbacks by last token
    tail = re.sub(r"^(makeupcheek|makeuplipcolor|makeupcolor|makeupfreckle|thumbnail|piercing|teeth|pubes|blemishes)", "", k)
    cands = [(a, n) for a, n in index.items() if tail and a.endswith(tail)]
    if cands:
        cands.sort(key=lambda t: len(t[0]))
        return cands[0][1]
    return None


# ---------------------------------------------------------------- hair meshes
def hair_folders(all_list: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    rx = re.compile(r"characters\\common\\hair\\(hh_(\d{3})_[a-z]+__([a-z0-9_]+?))\\")
    for line in all_list.read_text(encoding="utf-8", errors="ignore").splitlines():
        m = rx.search(line)
        if m and m.group(2) not in out:
            out[m.group(2)] = m.group(3)
    return out


_A2M = Path(__file__).resolve().parents[2] / "tools" / "local" / "hair" / "app_to_mesh.json"
APP_TO_MESH: dict[str, list[str]] = (
    {k: (v if isinstance(v, list) else [v]) for k, v in json.loads(_A2M.read_text(encoding="utf-8-sig")).items()}
    if _A2M.exists() else {}
)
# meshHint -> имена мешей (для рендера причёсок в tools/calibrate; только локально)
HINT_MESHES: dict[str, dict[str, list[str]]] = {}


# ---------------------------------------------------------------- catalog
GROUP_ORDER = {"headCustomizationOptions": "head", "bodyCustomizationOptions": "body", "armsCustomizationOptions": "arms"}


def build(gender: str, cc: Path, ru, en, atlas_colors, atlas_index, hairs) -> dict:
    root = json.loads(cc.read_text(encoding="utf-8"))["Data"]["RootChunk"]
    variants = []

    # Цвета волос: в определениях hair_color* поле color совпадает с именем цвета,
    # в бровях/ресницах — сдвинуто. Строим словарь «имя цвета -> RGB» по волосам
    # и применяем его ко всем «волосяным» слотам.
    hair_rgb: dict[str, str] = {}
    for item in root["headCustomizationOptions"]:
        d = item.get("Data") or {}
        if not str(v(d.get("name", ""))).startswith("hair_color"):
            continue
        for o in d.get("definitions", []):
            c = o.get("color") or {}
            if c.get("Red") or c.get("Green") or c.get("Blue"):
                key = re.sub(r"^\d+_", "", str(v(o["name"])).split("__")[-1])
                hair_rgb.setdefault(key, to_hex([c["Red"], c["Green"], c["Blue"]]))
    # В определениях игры у части цветов (pink_rose, black_salt_n_pepper) RGB скопирован
    # с другого цвета. Такие дубли заменяем образцом из атласа иконок волос.
    seen: dict[str, list[str]] = defaultdict(list)
    for k, hx in hair_rgb.items():
        seen[hx].append(k)
    hair_dups = {k for ks in seen.values() if len(ks) > 1 for k in ks}
    for item in root["headCustomizationOptions"]:
        d = item.get("Data") or {}
        if v(d.get("uiSlot")) != "hair_color":
            continue
        for o in d.get("definitions", []):
            key = re.sub(r"^\d+_", "", str(v(o["name"])).split("__")[-1])
            icon = v(o.get("icon"))
            if key in hair_dups and icon and icon not in ("None", "0"):
                part = match_icon(icon, atlas_colors, atlas_index)
                if part:
                    hair_rgb[key] = to_hex(atlas_colors[part]["avg"])
                    hair_dups.discard(key)
    HAIRY ={"hair_color", "eyebrows_color", "eyelash_color", "beard_color", "pubic_hair_color"}
    unmatched_icons = set()
    for list_name, group in GROUP_ORDER.items():
        for item in root[list_name]:
            d = item.get("Data")
            if not d:
                continue
            tags = [v(t) for t in d.get("editTags", [])]
            name = v(d["name"])
            res = v(d.get("resource", {}).get("DepotPath")) if d.get("resource") else None
            rec = {
                "name": name,
                "slot": v(d.get("uiSlot")),
                "group": group,
                "type": d["$type"].replace("gameui", "").replace("Info", "").lower(),
                "order": int(d["index"]),
                "label": resolve(d.get("localizedName", ""), ru, en),
                "hidden": int(d.get("hidden", 0)) == 1,
                "newGame": "NewGame" in tags,
                "editTags": tags,
                "enabled": int(d.get("enabled", 1)) == 1,
                "defaultIndex": int(d.get("defaultIndex", 0)),
                "link": v(d.get("link")) if v(d.get("link")) not in (None, "None") else None,
                "randomizeCategory": d.get("randomizeCategory"),
                "resource": res if res and res != "0" else None,
                "options": [],
            }
            if rec["type"] == "switcher":
                for o in d["options"]:
                    rec["options"].append({
                        "i": int(o["index"]),
                        "label": resolve(o.get("localizedName", ""), ru, en),
                        "activates": [v(n) for n in o["names"]],
                        "tags": [v(t) for t in o["tags"]["tags"]],
                        "rating": [o["randomizationInfo"]["minRating"], o["randomizationInfo"]["maxRating"]],
                    })
            elif rec["type"] == "morph":
                for o in d["morphNames"]:
                    rec["options"].append({
                        "i": int(o["index"]),
                        "label": resolve(o.get("localizedName", ""), ru, en),
                        "morph": v(o["morphName"]),
                        "tags": [v(t) for t in o["tags"]["tags"]],
                        "rating": [o["randomizationInfo"]["minRating"], o["randomizationInfo"]["maxRating"]],
                    })
            else:
                for o in d.get("definitions", []):
                    icon = v(o.get("icon"))
                    hexc = None
                    iris = None
                    part = None
                    # Цвет берём из образца атласа, который игра показывает в UI:
                    # поле color в определениях бровей/ресниц сдвинуто относительно имён.
                    if icon and icon not in ("None", "0") and not str(icon).isdigit():
                        part = match_icon(icon, atlas_colors, atlas_index)
                        if part:
                            ac = atlas_colors[part]
                            hexc = to_hex(ac["avg"])
                            iris = to_hex(ac["ring"])
                        else:
                            unmatched_icons.add(icon)
                    if rec["slot"] in HAIRY:
                        key = re.sub(r"^\d+_", "", str(v(o["name"])).split("__")[-1])
                        hexc = hair_rgb.get(key, hexc)
                    label = resolve(o.get("localizedName", ""), ru, en)
                    app_tail = re.sub(r"^\d+_", "", str(v(o["name"])).split("__")[-1])
                    app_words = set(re.findall(r"[a-z]{3,}", app_tail))
                    label_words = set(re.findall(r"[a-z]{3,}", label["en"].lower()))
                    # В локализации игры встречаются чужие подписи (brown_ombre -> «Blue Sapphire»)
                    mismatch = bool(app_words) and bool(label_words) and not (app_words & label_words)
                    if (not label["ru"].strip() or mismatch) and rec["slot"] in HAIRY | {"eyes_color"} and app_words:
                        # Имя ресурса надёжнее имени иконки (у иконок встречаются опечатки и дубли)
                        label = humanize(v(o["name"]))
                    if not label["ru"].strip():
                        if icon and icon not in ("None", "0") and not str(icon).isdigit():
                            label = humanize(icon.replace("OptionsIcons.", ""))
                        elif rec["link"] == "skin color" or not rec["label"]["ru"].strip():
                            label = humanize(v(o["name"]))
                    opt = {
                        "i": int(o["index"]),
                        "label": label,
                        "app": v(o["name"]),
                        "tags": [v(t) for t in o["tags"]["tags"]],
                        "rating": [o["randomizationInfo"]["minRating"], o["randomizationInfo"]["maxRating"]],
                    }
                    if icon and icon not in ("None", "0"):
                        opt["icon"] = icon.replace("OptionsIcons.", "")
                    if hexc:
                        opt["hex"] = hexc
                    if iris and rec["slot"] == "eyes_color":
                        opt["iris"] = iris
                    rec["options"].append(opt)
            # В данных игры встречаются повторы индекса (женский нос: h112 и h172 оба index=17).
            # Внутри приложения индекс должен быть уникальным: берём позицию в списке,
            # а исходный индекс сохраняем. Игрок всё равно выставляет номер по позиции.
            idx = [o["i"] for o in rec["options"]]
            if len(set(idx)) != len(idx):
                for pos, o in enumerate(rec["options"]):
                    o["gameIndex"] = o["i"]
                    o["i"] = pos
            variants.append(rec)

    by_name = {r["name"]: r for r in variants}

    # Описание причёсок/бород по имени ресурса, на который указывает включаемый вариант
    def res_hint(name: str) -> str | None:
        r = by_name.get(name)
        if not r or not r["resource"]:
            return None
        base = re.split(r"[\\/]", r["resource"])[-1].rsplit(".", 1)[0]
        # Точное соответствие .app -> меш (из export_hair.ps1): номер hairs_NNN в имени
        # ресурса не всегда совпадает с номером папки причёски (hairs_143 -> hh_060_wa__voodoo_03)
        if base in APP_TO_MESH and APP_TO_MESH[base]:
            fm = re.search(r"\\hh_(\d{3})_[a-z]+__([a-z0-9_]+?)\\", APP_TO_MESH[base][0])
            if fm:
                hint = f"{fm.group(1)}_{fm.group(2)}"
                HINT_MESHES.setdefault(gender, {}).setdefault(hint, [re.split(r"[\\/]", p)[-1].rsplit(".", 1)[0] for p in APP_TO_MESH[base]])
                return hint
        m = re.search(r"hairs_(\d+)", base)
        if m and m.group(1).zfill(3) in hairs:
            return f"{m.group(1).zfill(3)}_{hairs[m.group(1).zfill(3)]}"
        return base

    for r in variants:
        if r["type"] != "switcher":
            continue
        for o in r["options"]:
            # Варианты *_fpp — вид от первого лица, их ресурсы нумеруются иначе; описываем по виду от третьего лица
            hints = [h for h in (res_hint(n) for n in o["activates"] if "fpp" not in n) if h and "_fpp" not in h]
            if not hints and any(n.endswith("_none") for n in o["activates"]):
                o["meshHint"] = "none"
            if hints:
                o["meshHint"] = sorted(set(hints))[0] if len(set(hints)) == 1 else sorted(set(hints))

    # Отбираем то, что видно в редакторе новой игры
    visible = [r for r in variants if not r["hidden"] and r["newGame"]]
    visible_names = {r["name"] for r in visible}

    # Кто кем управляет: имя варианта -> список (switcher, option index)
    controlled = defaultdict(list)
    for r in variants:
        if r["type"] == "switcher":
            for o in r["options"]:
                for n in o["activates"]:
                    controlled[n].append([r["name"], o["i"]])

    slots: dict[str, dict] = {}
    for r in sorted(visible, key=lambda r: (list(GROUP_ORDER.values()).index(r["group"]), r["order"])):
        s = slots.setdefault(r["slot"], {
            "id": r["slot"],
            "group": r["group"],
            "order": r["order"],
            "label": r["label"],
            "variants": [],
        })
        s["order"] = min(s["order"], r["order"])
        if not s["label"]["ru"].strip() and r["label"]["ru"].strip():
            s["label"] = r["label"]
        # Слот без подписи (шея под цвет кожи, FPP-дубли, служебные данные рук) в UI
        # редактора не показывается — игра выставляет его сама.
        s["auto"] = not s["label"]["ru"].strip()
        var = {k: r[k] for k in ("name", "type", "enabled", "defaultIndex", "link", "randomizeCategory", "options")}
        if r["name"] in controlled:
            var["controlledBy"] = controlled[r["name"]]
        s["variants"].append(var)

    # Управляющие свитчеры, скрытые из UI, но влияющие на видимые (например FPP) — не нужны.
    # Но свитчеры, которые управляют видимыми, должны быть видимы сами — проверим.
    missing = set()
    for s in slots.values():
        for var in s["variants"]:
            for sw, _ in var.get("controlledBy", []):
                if sw not in visible_names:
                    missing.add(sw)

    ordered = sorted(slots.values(), key=lambda s: (list(GROUP_ORDER.values()).index(s["group"]), s["order"]))
    return {
        "gender": gender,
        "gameVersion": "2.5",
        "source": cc.name,
        "slots": ordered,
        "stats": {
            "variantsTotal": len(variants),
            "variantsVisible": len(visible),
            "slots": len(ordered),
            "unmatchedIcons": sorted(unmatched_icons),
            "controllersNotVisible": sorted(missing),
        },
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True, help="папка с результатами extract_game_data.ps1")
    ap.add_argument("--out", required=True, help="куда положить catalog.*.json")
    a = ap.parse_args()
    work, out = Path(a.work), Path(a.out)
    out.mkdir(parents=True, exist_ok=True)

    ru = load_loc(work / "loc_json", "ru-ru")
    en = load_loc(work / "loc_json", "en-us")
    atlas_colors = build_atlas_colors(
        work / "cc_json" / "character_creation_thumbnails_atlas.inkatlas.json",
        work / "atlas_png" / "character_creation_thumbnails_atlas.png",
    )
    atlas_index = {}
    for part in atlas_colors:
        atlas_index.setdefault(atlas_key(part), part)
    hairs = hair_folders(work / "all_list.txt")

    for gender in ("male", "female"):
        cat = build(gender, work / "cc_json" / f"{gender}_cco_ep1.inkcharcustomization.json", ru, en, atlas_colors, atlas_index, hairs)
        (out / f"catalog.{gender}.json").write_text(json.dumps(cat, ensure_ascii=False, indent=1), encoding="utf-8")
        st = cat["stats"]
        print(f"{gender}: slots={st['slots']} visibleVariants={st['variantsVisible']}/{st['variantsTotal']} "
              f"unmatchedIcons={len(st['unmatchedIcons'])} controllersNotVisible={st['controllersNotVisible']}")
        if st["unmatchedIcons"]:
            print("   unmatched:", " ".join(st["unmatchedIcons"]))
    if HINT_MESHES:
        (_A2M.parent / "hint_meshes.json").write_text(json.dumps(HINT_MESHES, indent=1), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
