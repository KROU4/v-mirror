"""Face layers of the creator drawn on top of the head: eye, lip and cheek makeup, freckles,
blemishes, face tattoos, face scars, face cyberware (all mesh decals in game) and the piercing
meshes. Writes tex/face/decals.json for the engine.

In game every layer is a morph-target mesh hugging the head (0.2-0.5 mm above the skin, same
topology and morph targets as the head) drawn with mesh_decal.mt / mesh_decal_double_diffuse.mt:
the decal replaces the albedo, normal and roughness of the skin under it before lighting.
Piercings are real meshes with multilayered materials (colour from the creator swatch).

Inputs (work folder, area "decal"):
  plan.json                      creator apps -> components (mesh, mesh appearance, chunk mask),
                                 mesh appearances -> chunk material keys, resolved material params
  glb/<stem>.morphtarget.glb     exported layer meshes (hx_000_p?a__morphs_*, i1_000_p?a__morphs_earring_*)
  png/<depot path>.png           decal textures

Outputs:
  glb/face/decals/<stem>.glb     slim meshes (position/normal morph deltas, uv0, 4 bone influences)
  tex/face/decals/*.png          textures: colour (RGBA), masks (L), normals (RGB, OpenGL green)
  tex/face/decals.json           apps, meshes, materials, textures
"""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
from glbslim import slim  # noqa: E402
import json, re
from pathlib import Path
import numpy as np
from PIL import Image

W = vmpaths.area('decal')
LOCAL = vmpaths.OUT
GLB_OUT = LOCAL / 'glb' / 'face' / 'decals'
TEX_OUT = LOCAL / 'tex' / 'face' / 'decals'
MF = LOCAL / 'tex' / 'face' / 'decals.json'

plan = json.loads((W / 'plan.json').read_text(encoding='utf-8'))

# ------------------------------------------------------------------ textures
textures = {}


def stem(p: str) -> str:
    return p.replace('/', '\\').split('\\')[-1].rsplit('.', 1)[0]


def limit(im: Image.Image, cap=1024) -> Image.Image:
    if max(im.size) > cap:
        s = cap / max(im.size)
        im = im.resize((max(1, round(im.size[0] * s)), max(1, round(im.size[1] * s))), Image.LANCZOS)
    return im


def src(depot: str) -> Image.Image:
    p = W / 'png' / Path(depot.replace('\\', '/')).with_suffix('.png')
    im = Image.open(p)
    im.load()
    return im


def mask_channel(im: Image.Image) -> Image.Image:
    """One-channel mask: the alpha channel when the colour is constant (e.g. *_a*.xbm: white RGB, shape in A), else red."""
    if im.mode == 'RGBA':
        a = np.asarray(im)
        rgb_flat = float(a[..., :3].std()) < 1.0
        if rgb_flat and float(a[..., 3].std()) >= 1.0:
            return im.getchannel('A')
    return im.convert('RGB').getchannel('R') if im.mode != 'L' else im


def add_tex(depot: str | None, kind: str) -> str | None:
    if not depot:
        return None
    key = f'{stem(depot)}.{kind}'
    if key in textures:
        return textures[key]['file']
    im = src(depot)
    if kind == 'color':
        im = im.convert('RGBA')
    elif kind == 'mask':
        im = mask_channel(im)
    elif kind == 'normal':
        a = np.asarray(im.convert('RGB')).astype(np.uint8).copy()
        a[..., 1] = 255 - a[..., 1]  # DirectX -> OpenGL green (as the skin normal maps)
        a[..., 2] = 255  # z is rebuilt in the shader from x, y
        im = Image.fromarray(a, 'RGB')
    im = limit(im, 1024 if kind != 'color' else 2048)
    dst = TEX_OUT / f'{stem(depot)}{"" if kind == "color" else "_" + kind}.png'
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, optimize=True)
    rel = dst.relative_to(LOCAL).as_posix()
    textures[key] = {'file': rel, 'size': list(im.size), 'mode': im.mode, 'colorSpace': 'srgb' if kind == 'color' else 'linear', 'gamePath': depot}
    return rel


# ------------------------------------------------------------------ materials
def num(p, k, d):
    v = p.get(k)
    return round(float(v), 6) if isinstance(v, (int, float)) else d


# Piercing colours: the creator swatch hex of each colour app (catalog), metal unless plastic, pearl or wood.
# Multilayer setups are named after the swatch icon (earring_05_plastic_red <- Piercing_plastic_red), the
# colour apps are not (i0_000_pma__earring__05_red): both names point at the same option.
cat_hex = {}
cat_icon = {}
# Colours whose game material is a pattern (marble, rainbow film, rippled steel, wood grain): one
# hex paints them as plain plastic, so the engine maps the creator thumbnail of the colour on them.
PATTERNED = {'blue', 'mixed', 'mixed2', 'pink_metalic', 'rainbow', 'steel', 'wood'}
for g in ('male', 'female'):
    cat = json.loads((vmpaths.REPO / 'src' / 'data' / f'catalog.{g}.json').read_text(encoding='utf-8'))
    for s in cat['slots']:
        if s['id'] != 'piercings_color':
            continue
        for var in s['variants']:
            for o in var['options']:
                if not o.get('hex'):
                    continue
                m = re.search(r'__\d+_(.+)$', o.get('app') or '')
                icon = o.get('icon') or ''
                if m:
                    cat_hex.setdefault(m.group(1), o['hex'])
                    if icon:
                        cat_icon.setdefault(m.group(1), icon)
                if icon.startswith('Piercing_'):
                    cat_hex.setdefault(icon[len('Piercing_'):], o['hex'])
                    cat_icon.setdefault(icon[len('Piercing_'):], icon)


def piercing(setup: str) -> dict:
    name = re.sub(r'^.*?earring_\d+_', '', stem(setup or ''))
    hexc = cat_hex.get(name) or cat_hex.get(name.replace('cooper', 'copper'))
    if not hexc:
        # a silent neutral grey here once painted every plastic piercing silver
        raise SystemExit(f'piercing colour: no creator swatch for multilayer setup {setup!r} ({name})')
    plastic = name.startswith('plastic') or name in ('pearl', 'wood', 'neon_teal', 'blue')
    rough = {'pearl': 0.25, 'wood': 0.7}.get(name, 0.4 if plastic else 0.3)
    out = {'type': 'piercing', 'colour': hexc, 'metalness': 0.0 if plastic else 1.0, 'roughness': rough, 'name': name}
    icon = cat_icon.get(name) or cat_icon.get(name.replace('cooper', 'copper'))
    if name in PATTERNED and icon:
        # swatches phase writes the creator thumbnails to swatches/icons/<icon>.webp
        out['pattern'] = f'swatches/icons/{icon}.webp'
    return out


materials = {}
for key, m in plan['materials'].items():
    p = m['params']
    if m['master'] in ('mesh_decal', 'mesh_decal_double_diffuse'):
        d = {
            'type': 'decal',
            'diffuse': add_tex(p.get('DiffuseTexture'), 'color'),
            'diffuseColor': p.get('DiffuseColor', '#ffffff'),
            'diffuseAlpha': num(p, 'DiffuseAlpha', 0.0),
        }
        if p.get('SecondaryMask') and num(p, 'SecondaryMaskInfluence', 0) > 0:
            d.update(secondaryMask=add_tex(p['SecondaryMask'], 'mask'), secondaryMaskUVScale=num(p, 'SecondaryMaskUVScale', 1.0),
                     secondaryMaskInfluence=num(p, 'SecondaryMaskInfluence', 0.0))
        if p.get('NormalTexture') and num(p, 'NormalAlpha', 0) > 0:
            d.update(normal=add_tex(p['NormalTexture'], 'normal'), normalAlpha=num(p, 'NormalAlpha', 0.0))
            if num(p, 'UseNormalAlphaTex', 0) > 0 and p.get('NormalAlphaTex'):
                d['normalAlphaTex'] = add_tex(p['NormalAlphaTex'], 'mask')
        rma = num(p, 'RoughnessMetalnessAlpha', 0.0)
        if rma > 0:
            d.update(roughnessMetalnessAlpha=rma, roughness=add_tex(p.get('RoughnessTexture'), 'mask'),
                     roughnessScale=num(p, 'RoughnessScale', 1.0), roughnessBias=num(p, 'RoughnessBias', 0.0),
                     metalness=add_tex(p.get('MetalnessTexture'), 'mask'), metalnessScale=num(p, 'MetalnessScale', 1.0),
                     metalnessBias=num(p, 'MetalnessBias', 0.0))
        if m['master'] == 'mesh_decal_double_diffuse' and p.get('SecondaryDiffuseAlpha') and num(p, 'SecondaryDiffuseAlphaIntensity', 0) > 0:
            d.update(secondaryDiffuseAlpha=add_tex(p['SecondaryDiffuseAlpha'], 'mask'), secondaryDiffuseAlphaIntensity=num(p, 'SecondaryDiffuseAlphaIntensity', 0.0),
                     secondaryDiffuseColor=p.get('SecondaryDiffuseColor', '#ffffff'))
        materials[key] = {k: v for k, v in d.items() if v is not None}
    elif m['master'] == 'multilayered':
        materials[key] = piercing(p.get('MultilayerSetup'))
    # metal_base / unknown: chunk not drawn (null key below)

# ------------------------------------------------------------------ meshes
meshes = {}
report = []
for st, info in sorted(plan['meshes'].items()):
    srcf = W / 'glb' / f'{st}.morphtarget.glb'
    if not srcf.exists():
        raise SystemExit(f'decal mesh export missing: {srcf}')
    rel = f'glb/face/decals/{st}.glb'
    r = slim(srcf, LOCAL / rel, drop_attrs=('TANGENT', 'COLOR_0', 'TEXCOORD_1'), sparse=True)
    report.append((st, r))
    subs = []
    for name in r['meshes']:
        subs.append({'chunk': int(re.match(r'submesh_(\d+)', name).group(1)), 'glbMesh': name})
    apps = {app: [k if k in materials else None for k in keys] for app, keys in info['apps'].items()}
    meshes[st] = {'glb': rel, 'gamePath': info['gamePath'], 'submeshes': subs, 'appearances': apps,
                  'kind': 'piercing' if st.startswith('i1_') else 'decal'}

out = {
    'version': 1,
    'note': 'creator face layers: apps[<app base = option meshHint, hx_000__scars, hx_000__cyberware>][<appearance>] -> components '
            '{mesh, app (mesh appearance), chunks shown}; meshes[mesh].appearances[app][chunk] -> material key',
    'apps': plan['apps'],
    'meshes': meshes,
    'materials': materials,
    'textures': textures,
}
MF.parent.mkdir(parents=True, exist_ok=True)
MF.write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
mb = sum(r['mb'] for _, r in report)
print(f'face decals: {len(meshes)} meshes ({mb:.1f} MB), {len(materials)} materials, {len(textures)} textures, {len(plan["apps"])} creator apps')
