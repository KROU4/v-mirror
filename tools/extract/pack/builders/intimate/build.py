"""Build tools/local/body/intimate/** (glb + textures) and tools/local/body/intimate.json from plan.json.
Read-only on the game: all inputs come from WolvenKit CLI exports (npm run pack)."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, os, re, shutil, struct, glob, math
import numpy as np
from PIL import Image

W = str(vmpaths.area('intimate'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = str(vmpaths.REPO)
LOCAL = str(vmpaths.OUT)
OUTD = os.path.join(LOCAL, 'body', 'intimate')
GLBD = os.path.join(OUTD, 'glb')
TEXD = os.path.join(OUTD, 'tex')
for d in (GLBD, TEXD):
    os.makedirs(d, exist_ok=True)

plan = json.load(open(os.path.join(W, 'plan.json'), encoding='utf-8'))
body = json.load(open(os.path.join(LOCAL, 'body', 'manifest.json'), encoding='utf-8'))
TONES = list(body['tones'].keys())


def rel(p):
    return os.path.relpath(p, LOCAL).replace('\\', '/')


# ---------------------------------------------------------------- textures
def find_png(depot):
    name = depot.split('\\')[-1][:-4]
    f = glob.glob(os.path.join(W, 'texpng', '**', name + '.png'), recursive=True)
    if not f:
        raise FileNotFoundError(depot)
    return f[0]


def load(depot, mode='RGBA'):
    return np.asarray(Image.open(find_png(depot)).convert(mode)).astype(np.float32) / 255.0


def s2l(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def l2s(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def hexrgb(h):
    h = h.lstrip('#')[:6]
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)


def tint(alb_lin, mask, color_hex, scale):  # skin.mt tint as in body/bake_skin.py (WolvenKit Blender add-on logic)
    t = s2l(hexrgb(color_hex))
    f = (abs(scale) * mask)[..., None]
    if scale >= 0:
        tinted = alb_lin * t
    else:
        tinted = np.where(alb_lin < 0.5, 2 * alb_lin * t, 1 - 2 * (1 - t) * (1 - alb_lin))
    tinted = np.clip(tinted, 0, 1)
    return alb_lin * (1 - f) + tinted * f


def save(arr01, name, mode='RGB', jpg=False):
    a = (np.clip(arr01, 0, 1) * 255 + 0.5).astype(np.uint8)
    im = Image.fromarray(a, mode)
    p = os.path.join(TEXD, name + ('.jpg' if jpg else '.png'))
    if jpg:
        im.save(p, quality=92, subsampling=0)
    else:
        im.save(p, optimize=True)
    return rel(p)


TEXCACHE = {}
ENGINE = ('engine\\',)


def tex_name(depot):
    return depot.split('\\')[-1][:-4]


def normal_gl(depot):
    if depot.startswith(ENGINE):
        return None
    k = ('n', depot)
    if k not in TEXCACHE:
        a = load(depot)
        x = a[..., 0] * 2 - 1
        y = -(a[..., 1] * 2 - 1)  # DirectX -> OpenGL
        z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
        TEXCACHE[k] = save(np.stack([x, y, z], -1) * 0.5 + 0.5, tex_name(depot) + '_gl')
    return TEXCACHE[k]


def orm(depot):
    if depot.startswith(ENGINE):
        return None, None
    k = ('orm', depot)
    if k not in TEXCACHE:
        a = load(depot)
        r, m, mask = a[..., 0], a[..., 1], a[..., 2]
        p1 = save(np.stack([np.ones_like(r), r, m], -1), tex_name(depot) + '_orm')
        p2 = save(mask, tex_name(depot) + '_detailmask', 'L')
        TEXCACHE[k] = (p1, p2)
    return TEXCACHE[k]


def albedo_tone(depot, color, scale, tone):
    k = ('alb', depot, color, round(scale, 5))
    if k not in TEXCACHE:
        a = load(depot, 'RGB')
        mask = np.ones(a.shape[:2], np.float32)  # skin.mt default TintColorMask i0_000_base__tintcolormask.xbm: R == 1 everywhere
        TEXCACHE[k] = save(l2s(tint(s2l(a), mask, color, scale)), f'{tex_name(depot)}_albedo_{tone}', jpg=True)
    return TEXCACHE[k]


def albedo_base(depot):
    k = ('alb0', depot)
    if k not in TEXCACHE:
        TEXCACHE[k] = save(load(depot, 'RGB'), tex_name(depot) + '_albedo_base', jpg=True)
    return TEXCACHE[k]


def decal_rgba(depot, alpha_from_inverted_mask=None):
    k = ('decal', depot, alpha_from_inverted_mask)
    if k not in TEXCACHE:
        a = load(depot)
        name = tex_name(depot)
        if alpha_from_inverted_mask:
            m = load(alpha_from_inverted_mask, 'L')
            a = a.copy()
            a[..., 3] = 1 - m
            name += '_a'
        TEXCACHE[k] = save(a, name, 'RGBA')
    return TEXCACHE[k]


def gray(depot):
    if depot.startswith(ENGINE):
        return None
    k = ('gray', depot)
    if k not in TEXCACHE:
        TEXCACHE[k] = save(load(depot, 'L'), tex_name(depot), 'L')
    return TEXCACHE[k]


# ---------------------------------------------------------------- meshes
MESHES = {}
GLBSRC = {os.path.basename(f): f for f in glob.glob(os.path.join(W, 'glb', '**', '*.glb'), recursive=True)}


def read_glb(path):
    buf = open(path, 'rb').read()
    jl = struct.unpack_from('<I', buf, 12)[0]
    js = json.loads(buf[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack_from('<I', buf, off)[0]
    return js, buf[off + 8: off + 8 + bl]


def acc(js, bin_, i):
    a = js['accessors'][i]
    bv = js['bufferViews'][a['bufferView']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}[a['type']]
    dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a['componentType']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride')
    cnt = a['count']
    if stride and stride != n * np.dtype(dt).itemsize:
        raw = np.frombuffer(bin_, np.uint8, count=stride * cnt, offset=start).reshape(cnt, stride)
        return raw[:, :n * np.dtype(dt).itemsize].copy().view(dt).reshape(cnt, n)
    return np.frombuffer(bin_, dt, count=cnt * n, offset=start).reshape(cnt, n)


SUBROLE = {'scars': ['scar (scars_000 / catalog 01)', 'tribal 02 (scars_001 / catalog 02)', 'tribal 01 (scars_002, not in catalog)', 'burn (scars_003, not in catalog)']}
EXTRA_IBM = {'pma': {}, 'pwa': {}}


def mesh_id(source):
    base = source.split('\\')[-1]
    g = 'pwa' if '_pwa_' in base else 'pma'
    stem = re.sub(r'\.(mesh|morphtarget)$', '', base)
    short = (stem.replace('i0_000_%s_base__' % g, '').replace('tx_000_%s_base__full_' % g, '').replace('t0_000_%s_base__' % g, ''))
    mid = f'{g}_{short}'
    if mid in MESHES:
        return mid
    glbname = base.replace('.mesh', '') + '.glb' if base.endswith('.mesh') else base + '.glb'
    src = GLBSRC[glbname]
    dst = os.path.join(GLBD, glbname)
    shutil.copyfile(src, dst)
    js, bn = read_glb(dst)
    subs = []
    for mi, m in enumerate(js['meshes']):
        p = m['primitives'][0]
        subs.append({'index': mi, 'name': m['name'], 'verts': js['accessors'][p['attributes']['POSITION']]['count'],
                     'tris': js['accessors'][p['indices']]['count'] // 3})
        if short == 'scars':
            subs[-1]['role'] = SUBROLE['scars'][mi]
    tnames = js['meshes'][0].get('extras', {}).get('targetNames', [])
    joints = [js['nodes'][j]['name'] for j in js['skins'][0]['joints']]
    ibm = acc(js, bn, js['skins'][0]['inverseBindMatrices']).reshape(-1, 4, 4).transpose(0, 2, 1)  # column-major -> row-major
    for jn, M in zip(joints, ibm):
        if jn.startswith('dyng_'):
            EXTRA_IBM[g].setdefault(jn, []).append((glbname, M))
    kind = 'skin' if short in ('penis', 'penis_circumcised', 'vagina', 'genitals_none', 'nipple') else 'decal'
    MESHES[mid] = {'file': rel(dst), 'bytes': os.path.getsize(dst), 'gender': g, 'gameSource': source, 'kind': kind,
                   'submeshes': subs, 'morphTargets': tnames, 'joints': len(joints),
                   'extraJoints': sorted(j for j in joints if j.startswith('dyng_'))}
    return mid


# ---------------------------------------------------------------- materials
MATS = {}


def skin_material(g, mesh, m, tone):
    p = m['params']
    color, scale = p.get('TintColor', '#000000'), float(p.get('TintScale', 0))
    alb = p['Albedo']
    o, dm = orm(p.get('Roughness', 'engine\\textures\\editor\\white.xbm'))
    mat = {'type': 'skin', 'gameTemplate': 'skin.mt', 'gameMaterial': m['name'],
           'albedo': albedo_tone(alb, color, scale, tone), 'albedoUntinted': albedo_base(alb),
           'normal': normal_gl(p['Normal']), 'orm': o, 'detailMask': dm,
           'tintColor': color, 'tintScale': round(scale, 4), 'tintMask': 'full (game TintColorMask i0_000_base__tintcolormask: R=1 everywhere)',
           'microDetailUVScale': [p.get('MicroDetailUVScale01'), p.get('MicroDetailUVScale02')],
           'gameTextures': {k: v for k, v in p.items() if isinstance(v, str) and v.endswith('.xbm')}}
    return mat


def decal_material(m, kind):
    p = m['params']
    dif = p.get('DiffuseTexture', 'engine\\textures\\editor\\grey.xbm')
    sec = p.get('SecondaryMask')
    inv = sec if (sec and float(p.get('SecondaryMaskInfluence', 0)) > 0) else None
    mat = {'type': 'decal', 'gameTemplate': 'mesh_decal.mt', 'gameMaterial': m['name'],
           'diffuse': decal_rgba(dif, inv) if not dif.startswith(ENGINE) else None,
           'diffuseColor': p.get('DiffuseColor', '#ffffff'), 'diffuseAlpha': round(float(p.get('DiffuseAlpha', 0)), 4),
           'normal': normal_gl(p.get('NormalTexture', 'engine\\')), 'normalAlpha': round(float(p.get('NormalAlpha', 0)), 4),
           'roughness': gray(p['RoughnessTexture']) if p.get('RoughnessTexture') and not p['RoughnessTexture'].startswith(ENGINE) else None,
           'roughnessMetalnessAlpha': round(float(p.get('RoughnessMetalnessAlpha', 0)), 4),
           'alphaSource': 'diffuse.a (= 1 - SecondaryMask)' if inv else 'diffuse.a',
           'gameTextures': {k: v for k, v in p.items() if isinstance(v, str) and v.endswith('.xbm')}}
    return mat


def mat_id(mat):
    key = json.dumps({k: v for k, v in mat.items() if k != 'gameMaterial'}, sort_keys=True)
    for k, v in MATS.items():
        if json.dumps({kk: vv for kk, vv in v.items() if kk != 'gameMaterial'}, sort_keys=True) == key:
            return k
    base = re.sub(r'[^a-z0-9_]+', '_', (mat.get('albedo') or mat.get('diffuse') or mat['gameMaterial']).split('/')[-1].rsplit('.', 1)[0].lower())
    if mat['type'] == 'decal':
        base += '__' + mat['diffuseColor'].lstrip('#') + '_' + str(mat['diffuseAlpha']).replace('.', '')
    k, n = base, 1
    while k in MATS:
        n += 1
        k = f'{base}_{n}'
    MATS[k] = mat
    return k


def part_of(g, comp, tone=None):
    mid = mesh_id(comp['source'])
    kind = MESHES[mid]['kind']
    ids = []
    for ch in comp['chunks']:
        if ch['template'] == 'skin.mt':
            ids.append(mat_id(skin_material(g, mid, ch, tone)))
        elif ch['template'] == 'mesh_decal.mt':
            ids.append(mat_id(decal_material(ch, kind)))
        else:
            ids.append(None)
    return mid, comp['visibleChunks'], ids, comp['meshAppearance']


# ---------------------------------------------------------------- slots
SWITCH_TARGET = {'genitals_size': ('penis_none', 'penis_base', 'penis_circumcised'),
                 'pubic_hair': ('penis_none_hairstyle', 'penis_base_hairstyle', 'penis_circumcised_hairstyle', 'vagina_hairstyle')}
STYLE = {}
out_g = {}
for g, P in plan.items():
    G = out_g.setdefault(g, {})
    for slot, S in P.items():
        GS = G.setdefault(slot, {'variants': {}})
        for vn, V in S.items():
            GV = GS['variants'].setdefault(vn, {'type': V['type'], 'link': V['link'], 'options': {}})
            for i, o in V['options'].items():
                e = {'label': o['label']}
                r = o.get('resolved')
                if V['type'] == 'switcher':
                    e['activates'] = o['activates']
                    parts = []
                    enables = {}
                    for act, x in r.items():
                        for sl, names in SWITCH_TARGET.items():
                            if act in names:
                                enables[sl] = act
                        if x['kind'] == 'byTone':
                            per = {}
                            for tone, tv in x['tones'].items():
                                for comp in tv['components'] or []:
                                    mid, vis, ids, mapp = part_of(g, comp, tone)
                                    pe = per.setdefault(mid, {'mesh': mid, 'visibleSubmeshes': vis, 'materialsByTone': {}, 'gameAppearanceByTone': {}})
                                    pe['materialsByTone'][tone] = ids
                                    pe['gameAppearanceByTone'][tone] = f"{x['appFile']}:{tv['appearance']} -> {mapp}"
                            parts.extend(per.values())
                            e['game'] = {'option': act, 'appFile': x['appFile']}
                            if not per:
                                e['note'] = 'game appearance has no components: the body mesh itself provides this (nothing to add)'
                        elif x['kind'] == 'appearanceList':
                            m = re.search(r'genitals_hairstyle_(\d\d)', x['appFile'])
                            e['style'] = {'index': int(m.group(1)), 'colorVariant': act, 'appFile': x['appFile']}
                            e['game'] = {'option': act, 'appFile': x['appFile']}
                    e['parts'] = parts
                    if enables:
                        e['enables'] = enables
                    if not parts and 'style' not in e and 'note' not in e:
                        e['note'] = 'nothing rendered'
                elif V['type'] == 'appearance':
                    if r and r['components']:
                        comp = r['components'][0]
                        mid, vis, ids, mapp = part_of(g, comp)
                        e['parts'] = [{'mesh': mid, 'visibleSubmeshes': vis, 'materials': ids}]
                        e['game'] = {'appFile': r['appFile'], 'appearance': r['appearance'], 'meshAppearance': mapp}
                        e['hex'] = o.get('hex')
                        STYLE.setdefault((g, vn), mapp.rsplit('_', 1)[0] if mapp.endswith(('_black', '_blonde', '_ginger', '_green', '_pink')) else mapp)
                    else:
                        e['parts'] = []
                        e['note'] = 'nothing rendered'
                elif V['type'] == 'morph':
                    mn = o.get('morph')
                    if mn and mn != 'None':
                        e['morph'] = mn
                    else:
                        e['morph'] = None
                GV['options'][i] = e

# morph target wiring (glb target names are "<morph>_<region>")
for g, G in out_g.items():
    for slot in ('genitals_size', 'breast'):
        if slot not in G:
            continue
        for vn, V in G[slot]['variants'].items():
            if V['type'] != 'morph':
                continue
            for i, e in V['options'].items():
                applies = []
                if slot == 'breast':
                    applies.append({'mesh': 'body:pwa_body', 'target': None})
                    applies.append({'mesh': 'body:legsLifted.pwa', 'target': None})
                for mid, M in MESHES.items():
                    if M['gender'] != g:
                        continue
                    for ti, tn in enumerate(M['morphTargets']):
                        if e['morph'] and tn.startswith(e['morph'] + '_') and tn[len(e['morph']) + 1:] in (vn, 'breast'):
                            applies.append({'mesh': mid, 'target': tn, 'targetIndex': ti})
                if slot == 'breast' and e['morph']:
                    for a_, lst in ((applies[0], body['glb']['pwa_body']['morphTargets']), (applies[1], body['legsLifted']['pwa']['morphTargets'])):
                        bt = [t for t in lst if t.startswith(e['morph'] + '_')]
                        a_['target'] = bt[0] if bt else None
                        a_['targetIndex'] = lst.index(bt[0]) if bt else None
                e['appliesTo'] = applies if e['morph'] else []
                e['influence'] = 1.0 if e['morph'] else 0.0

# style names on pubic_hair switcher options
for g, G in out_g.items():
    for vn, V in G.get('pubic_hair', {}).get('variants', {}).items():
        for i, e in V['options'].items():
            if 'style' in e:
                cv = e['style']['colorVariant']
                e['style']['name'] = STYLE.get((g, cv))
                cvopts = G['pubic_hair_color']['variants'].get(cv, {}).get('options', {})
                e['style']['mesh'] = (cvopts.get('0', {}).get('parts') or [{}])[0].get('mesh')

# ---------------------------------------------------------------- extra bones (penis dangle chain, not in skeleton.<g>.json)
def qfrom(Rm):
    t = Rm[0, 0] + Rm[1, 1] + Rm[2, 2]
    if t > 0:
        s = math.sqrt(t + 1) * 2
        return [(Rm[2, 1] - Rm[1, 2]) / s, (Rm[0, 2] - Rm[2, 0]) / s, (Rm[1, 0] - Rm[0, 1]) / s, 0.25 * s]
    i = int(np.argmax([Rm[0, 0], Rm[1, 1], Rm[2, 2]]))
    if i == 0:
        s = math.sqrt(1 + Rm[0, 0] - Rm[1, 1] - Rm[2, 2]) * 2
        return [0.25 * s, (Rm[0, 1] + Rm[1, 0]) / s, (Rm[0, 2] + Rm[2, 0]) / s, (Rm[2, 1] - Rm[1, 2]) / s]
    if i == 1:
        s = math.sqrt(1 + Rm[1, 1] - Rm[0, 0] - Rm[2, 2]) * 2
        return [(Rm[0, 1] + Rm[1, 0]) / s, 0.25 * s, (Rm[1, 2] + Rm[2, 1]) / s, (Rm[0, 2] - Rm[2, 0]) / s]
    s = math.sqrt(1 + Rm[2, 2] - Rm[0, 0] - Rm[1, 1]) * 2
    return [(Rm[0, 2] + Rm[2, 0]) / s, (Rm[1, 2] + Rm[2, 1]) / s, 0.25 * s, (Rm[1, 0] - Rm[0, 1]) / s]


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


EXTRA = {}
for g in ('pma', 'pwa'):
    sk = {b['name']: b for b in json.load(open(os.path.join(LOCAL, 'body', f'skeleton.{g}.json'), encoding='utf-8'))['bones']}
    world = {}
    spread = {}
    for jn, lst in EXTRA_IBM[g].items():
        Ws = [np.linalg.inv(M) for _, M in lst]
        world[jn] = Ws[0]
        spread[jn] = max(float(np.abs(Wm[:3, 3] - Ws[0][:3, 3]).max()) for Wm in Ws)
    H = sk['Hips']
    HW = np.eye(4); HW[:3, :3] = qmat(H['bindQuaternion']); HW[:3, 3] = H['bindPosition']
    out = []
    for jn in sorted(world):
        n = int(jn[-2:])
        par = 'Hips' if n == 1 else f'dyng_penis_{n - 1:02d}'
        PW = HW if par == 'Hips' else world.get(par)
        if PW is None:
            continue
        Wm = world[jn]
        R = Wm[:3, :3]
        sc = np.linalg.norm(R, axis=0)
        Rn = R / sc
        L = np.linalg.inv(PW) @ Wm
        Ln = L[:3, :3] / np.linalg.norm(L[:3, :3], axis=0)
        out.append({'name': jn, 'parent': par, 'gameParent': 'dyng_penis_Offset_GRP (child of Hips)' if n == 1 else par,
                    'bindPosition': [round(float(x), 6) for x in Wm[:3, 3]], 'bindQuaternion': [round(float(x), 6) for x in qfrom(Rn)],
                    'localPosition': [round(float(x), 6) for x in L[:3, 3]], 'localQuaternion': [round(float(x), 6) for x in qfrom(Ln)],
                    'fromGlbs': sorted(set(f for f, _ in EXTRA_IBM[g][jn])), 'maxBindSpreadM': round(spread[jn], 7)})
    EXTRA[g] = out

# ---------------------------------------------------------------- write manifest
manifest = {
    'version': 1,
    'lane': 'body-intimate',
    'pathsRelativeTo': 'tools/local',
    'space': body['space'],
    'facing': body['facing'],
    'tones': TONES,
    'loaderNotes': [
        'Same conventions as body/manifest.json: glbs have COLOR_0 and no materials (replace materials, vertexColors=false), flat joint hierarchy (rebind with skeleton.<g>.json exactly like body glbs), UV0 only, texture.flipY=false, albedo/diffuse in sRGB, normal maps already OpenGL (+Y) with reconstructed Z, ORM: G=roughness B=metalness.',
        'Every part is a separate skinned mesh that sits on the body (no body re-texturing needed): add it to the same character root, rebind to the shared master skeleton, and show/hide it per option.',
        "extraBones.<g>: the penis 'dyng_penis_0x' dangle joints (game rig t0_000_p?a_base__full_dangle_skeleton) are not in skeleton.<g>.json. Their bind matrices differ between glbs by up to maxBindSpreadM (~5 mm on pwa), so for meshes listing meshes.<id>.extraJoints keep the glb's OWN dyng_* bones (mesh.skeleton.bones entries whose name starts with 'dyng_'): reparent them under the master 'Hips' with Object3D.attach() (keeps world transform) and map every other joint to the master skeleton as usual. extraBones gives a shared reference chain (from the first glb) if one master bone is preferred.",
        "Materials: materials.<id>.type 'skin' = opaque MeshPhysicalMaterial like body skin (albedo already tinted per tone; same TintColor/TintScale as the body for that tone). type 'decal' = transparent overlay: color = sRGBToLinear(diffuseColor) * diffuse.rgb, opacity = diffuse.a * diffuseAlpha (clamp 0..1), normalMap blended by normalAlpha, depthWrite=false, polygonOffset (factor -1, units -4) or renderOrder above the body to avoid z-fighting.",
        "Per option: <gender>.<slot>.variants.<variant>.options.<catalogIndex>. Switcher options list parts[] {mesh, visibleSubmeshes, materialsByTone[tone][submeshIndex]}; appearance options (pubic_hair_color) list parts[] {mesh, visibleSubmeshes, materials[submeshIndex]}; morph options list appliesTo[] {mesh, target} -> set mesh.morphTargetInfluences[targetIndex] = influence (others in the same region 0).",
        "Variant names mirror src/data/catalog.<g>.json; 'enables' on genitals_switcher options names which genitals_size / pubic_hair variant becomes active (the catalog 'activates' list).",
        'Decal meshes that carry breast morph targets (pwa nipple/scars/tattoos) must get the same breast influences as the body; penis hairstyle meshes carry the same small/big targets as the penis mesh and must follow genitals_size.',
    ],
    'extraBones': EXTRA,
    'meshes': MESHES,
    'materials': MATS,
    'genders': out_g,
    'bodyState': {
        'nudeByDefault': 'Uncensored body appearance (inkcharcustomization body_color -> t0_000_base__full.app, meshAppearance <tone>) uses the *_naked albedo/normal textures already baked in body/manifest.json (pwa t0_000_wa__c_base_d02_naked, pma t0_000_ma__c_base_d03_naked). The censored state is a different meshAppearance (<tone>_censored -> t0_000_pwa_base__full_d01_censored / t0_000_ma__c_base_d03_censored) on the SAME mesh and chunk mask; there is no baked underwear/censor submesh in the torso mesh.',
        'pwa': {'bodyChunkMask': '0xffffffffffffff1f (submeshes 5,6,7 hidden, legs come from l0_000_base__cs_flat / l0_000_base__full) - same in censored and uncensored apps', 'hideForNude': ['underwear glbs pwa_underwear_panties, pwa_underwear_bra from body/manifest.json defaultCharCreatorOutfit'], 'groin': 'female body mesh already contains the vulva (option "Вагина" adds no mesh); option "НЕТ" adds i0_000_pwa_base__genitals_none (skin cover mesh)', 'nipples': 'body texture has nipples (option 01 adds no mesh); options 02/03 add a nipple mesh with other nipple textures; option НЕТ adds the same mesh with the nipple-less skin texture (d01) as a cover'},
        'pma': {'bodyChunkMask': '0x7fffffffffffffff (all 8 submeshes)', 'hideForNude': ['pma_underwear_boxers from body/manifest.json defaultCharCreatorOutfit'], 'groin': 'male body mesh has no genitals: option "НЕТ" adds nothing, options Пенис 1/2/Вагина add meshes', 'nipples': 'body texture has nipples (option ДА adds nothing); option НЕТ adds i0_000_pma_base__nipple (nipple-less skin cover)'},
        'censorMeshes': 'i0_000_p?a_base_full_censored.mesh/.ent exist (mesh_decal underwear decals) but are not referenced by the uncensored creator apps; not exported.',
    },
    'limitations': [
        'Skin albedo per tone baked with the skin.mt tint reimplementation from body/manifest.json (linear space, TintColorMask = 1). Microdetail/bloodflow/SSS layers ignored.',
        'mesh_decal.mt approximated (no deferred decal blending); DiffuseColor default #ffffff when the material does not set it (template default).',
        'Scars: diffuse alpha baked from 1 - SecondaryMask (t0_000_pma_base__scars_m01: black = scar); the game also uses that mask as roughness (RoughnessMetalnessAlpha 0.15).',
        'Penis dangle physics (t0_000_p?a_base__full_dangle.animgraph) not reproduced: static bind pose.',
        'Penis pubic-hair diffuse textures (i0_000_pma_b__basepenis_hairstyle_01_d0x) carry a soft dark halo (rgb~0, alpha~0.12-0.2 over 20-38% of the texture): a stubble shadow by game design. With non-black colours it reads as a grey patch; to soften it multiply opacity by smoothstep(0.0, 0.05, luma(diffuse.rgb)).',
        'Game data quirk kept as is: vagina_hairstyle_04 colour "Зелёный" maps to landing_strip_ginger in i0_000_base__genitals_hairstyle_04.app.',
        'Female "Вагина" option has game appearances only for the 6 base tones (all empty); the 6 sub-tones have no appearance in the game file - both cases render nothing extra.',
    ],
    'tools': {'build': 'tools/extract/pack/builders/intimate/build.py (npm run pack, WolvenKit CLI exports)'},
}
json.dump(manifest, open(os.path.join(LOCAL, 'body', 'intimate.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
print('meshes', len(MESHES), 'materials', len(MATS), 'textures', len(os.listdir(TEXD)), 'extraBones', {g: len(v) for g, v in EXTRA.items()})
for g, v in EXTRA.items():
    for b in v:
        print('  ', g, b['name'], b['parent'], b['bindPosition'], 'spread', b['maxBindSpreadM'], b['fromGlbs'])
