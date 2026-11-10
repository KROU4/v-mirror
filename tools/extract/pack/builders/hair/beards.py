"""Beards of male V: hair-card morph meshes plus the stubble shadow decal, added to
tex/hair/manifest.json (section "beards"), so the engine draws them with the hair materials.

Inputs (work folder, area "beard"):
  plan.json                      creator beard apps -> components (mesh, mesh appearance, chunk mask),
                                 mesh appearances -> chunk materials -> beard material (profile / decal)
  glb/<stem>.morphtarget.glb     exported beard morph meshes (hb_000_pma__morphs_<style>)
  png/<depot path>.png           stubble shadow textures

Outputs:
  hair/beards/<stem>.glb         the same meshes without morph-target tangents (three.js reads only
                                 position and normal deltas) and without all-zero targets
  tex/hair/beards/*.png          shadow decal textures
  tex/hair/manifest.json         + textures, materials ("beard.<profile>", "beardShadow.<n>"), meshes, beards
"""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, re, struct
from pathlib import Path
import numpy as np
from PIL import Image

W = vmpaths.area('beard')
LOCAL = vmpaths.OUT
MF = LOCAL / 'tex' / 'hair' / 'manifest.json'
GLB_OUT = LOCAL / 'hair' / 'beards'
TEX_OUT = LOCAL / 'tex' / 'hair' / 'beards'

plan = json.loads((W / 'plan.json').read_text(encoding='utf-8'))
man = json.loads(MF.read_text(encoding='utf-8-sig'))

# ------------------------------------------------------------------ glb slimming
COMP = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}


def read_glb(p: Path):
    b = p.read_bytes()
    assert b[:4] == b'glTF', p
    jl = struct.unpack_from('<I', b, 12)[0]
    j = json.loads(b[20:20 + jl])
    off = 20 + jl
    bl = struct.unpack_from('<I', b, off)[0]
    return j, b[off + 8: off + 8 + bl]


def accessor_bytes(j, bin_, i):
    a = j['accessors'][i]
    v = j['bufferViews'][a['bufferView']]
    n = NCOMP[a['type']]
    dt = np.dtype(COMP[a['componentType']])
    stride = v.get('byteStride') or n * dt.itemsize
    start = v.get('byteOffset', 0) + a.get('byteOffset', 0)
    if stride == n * dt.itemsize:
        return bytes(bin_[start: start + a['count'] * stride])
    rows = [bin_[start + k * stride: start + k * stride + n * dt.itemsize] for k in range(a['count'])]
    return b''.join(rows)


def slim(src: Path, dst: Path) -> dict:
    j, bin_ = read_glb(src)
    dropped = 0
    for m in j['meshes']:
        names = (m.get('extras') or {}).get('targetNames')
        keep_idx = None
        for prim in m['primitives']:
            tg = prim.get('targets')
            if not tg:
                continue
            if keep_idx is None:
                keep_idx = []
                for k, t in enumerate(tg):
                    live = False
                    for att in ('POSITION', 'NORMAL'):
                        if att in t:
                            a = np.frombuffer(accessor_bytes(j, bin_, t[att]), dtype=np.float32)
                            if a.size and float(np.abs(a).max()) > 1e-7:
                                live = True
                    if live:
                        keep_idx.append(k)
            prim['targets'] = [{att: t[att] for att in ('POSITION', 'NORMAL') if att in t} for k, t in enumerate(tg) if k in keep_idx]
            if not prim['targets']:
                del prim['targets']
            for att in ('JOINTS_1', 'WEIGHTS_1'):
                prim['attributes'].pop(att, None)
        if keep_idx is not None:
            if names:
                m['extras']['targetNames'] = [names[k] for k in keep_idx]
            if 'weights' in m:
                m['weights'] = [m['weights'][k] for k in keep_idx]
            dropped += (len(names) if names else 0) - len(keep_idx)
    # rebuild the binary chunk with only the accessors still referenced
    used = set()
    for m in j['meshes']:
        for prim in m['primitives']:
            used.update(prim['attributes'].values())
            if 'indices' in prim:
                used.add(prim['indices'])
            for t in prim.get('targets', []):
                used.update(t.values())
    for s in j.get('skins', []):
        if 'inverseBindMatrices' in s:
            used.add(s['inverseBindMatrices'])
    for an in j.get('animations', []):
        for sm in an['samplers']:
            used.update((sm['input'], sm['output']))
    remap, accessors, views, out = {}, [], [], bytearray()
    for i in sorted(used):
        a = dict(j['accessors'][i])
        data = accessor_bytes(j, bin_, i)
        while len(out) % 4:
            out.append(0)
        views.append({'buffer': 0, 'byteOffset': len(out), 'byteLength': len(data)})
        out += data
        a['bufferView'] = len(views) - 1
        a.pop('byteOffset', None)
        remap[i] = len(accessors)
        accessors.append(a)
    for m in j['meshes']:
        for prim in m['primitives']:
            prim['attributes'] = {k: remap[v] for k, v in prim['attributes'].items()}
            if 'indices' in prim:
                prim['indices'] = remap[prim['indices']]
            if 'targets' in prim:
                prim['targets'] = [{k: remap[v] for k, v in t.items()} for t in prim['targets']]
    for s in j.get('skins', []):
        if 'inverseBindMatrices' in s:
            s['inverseBindMatrices'] = remap[s['inverseBindMatrices']]
    for an in j.get('animations', []):
        for sm in an['samplers']:
            sm['input'], sm['output'] = remap[sm['input']], remap[sm['output']]
    j['accessors'], j['bufferViews'] = accessors, views
    j['buffers'] = [{'byteLength': len(out)}]
    for k in ('images', 'textures', 'samplers'):
        j.pop(k, None)
    js = json.dumps(j, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    while len(out) % 4:
        out.append(0)
    dst.parent.mkdir(parents=True, exist_ok=True)
    with open(dst, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(out)))
        f.write(struct.pack('<II', len(js), 0x4E4F534A))
        f.write(js)
        f.write(struct.pack('<II', len(out), 0x004E4942))
        f.write(out)
    return {'meshes': [m['name'] for m in j['meshes']], 'droppedTargets': dropped, 'mb': round(dst.stat().st_size / 1e6, 2), 'srcMb': round(src.stat().st_size / 1e6, 2)}


# ------------------------------------------------------------------ textures
def stem(p: str) -> str:
    return p.replace('/', '\\').split('\\')[-1].rsplit('.', 1)[0]


def add_tex(depot: str, role: str, convert=None) -> str:
    tid = stem(depot)
    if tid in man['textures']:
        return tid
    src = W / 'png' / Path(depot.replace('\\', '/')).with_suffix('.png')
    im = Image.open(src)
    if convert:
        im = convert(im)
    dst = TEX_OUT / (tid + '.png')
    dst.parent.mkdir(parents=True, exist_ok=True)
    im.save(dst, optimize=True)
    man['textures'][tid] = {'file': dst.relative_to(LOCAL).as_posix(), 'size': list(im.size), 'mode': im.mode, 'colorSpace': 'linear', 'role': role, 'gamePath': depot}
    return tid


# ------------------------------------------------------------------ materials
def num(v, d):
    return round(float(v), 6) if isinstance(v, (int, float)) else d


mat_keys = {}
shadow_n = 0
for mk, m in sorted(plan['materials'].items()):
    if not m:
        continue
    if m['kind'] == 'cards':
        p = plan['masters'][m['master']]['params']
        prof = m['profile']
        if prof not in man['profiles']:
            raise SystemExit(f'beard profile {prof} is not in the hair profiles')
        key = f'beard.{prof}'
        man['materials'][key] = {
            'type': 'hairCards', 'cardSet': 'beard01', 'profile': prof,
            'alphaCutoff': num(p.get('AlphaCutoff'), 0.0), 'roughnessScale': num(p.get('RoughnessScale'), 1.0),
            'roughnessBias': num(p.get('RoughnessBias'), 0.0), 'shadowStrength': num(p.get('ShadowStrength'), 0.0),
            'shadowMin': num(p.get('ShadowMin'), -0.5), 'shadowRoughness': num(p.get('ShadowRoughness'), 1.0),
            'beard': True,
        }
        mat_keys[mk] = key
    elif m['kind'] == 'shadow':
        p = m['params']
        diff = add_tex(p['DiffuseTexture'], 'beard_shadow_alpha', convert=lambda im: im.getchannel('A'))
        sec = add_tex(p['SecondaryMask'], 'beard_shadow_noise', convert=lambda im: im.convert('L'))
        shadow_n += 1
        key = f'beardShadow.{mk.split("|")[1]}'
        man['materials'][key] = {
            'type': 'beardShadow', 'mask': diff, 'secondaryMask': sec, 'diffuseColor': p['DiffuseColor'],
            'diffuseAlpha': num(p.get('DiffuseAlpha'), 1.0), 'secondaryMaskUVScale': num(p.get('SecondaryMaskUVScale'), 1.0),
            'secondaryMaskInfluence': num(p.get('SecondaryMaskInfluence'), 0.0),
        }
        mat_keys[mk] = key
    elif m['kind'] == 'accessory':
        key = 'beard.accessory'
        man['materials'][key] = {'type': 'accessory', 'kind': 'metal', 'fallbackColor': m['fallbackColor'], 'roughness': m['roughness'], 'metalness': m['metalness'], 'note': m.get('note')}
        mat_keys[mk] = key

# ------------------------------------------------------------------ meshes
report = {}
for st, info in sorted(plan['meshes'].items()):
    src = W / 'glb' / f'{st}.morphtarget.glb'
    if not src.exists():
        raise SystemExit(f'beard mesh export missing: {src}')
    rel = f'hair/beards/{st}.glb'
    r = slim(src, LOCAL / rel)
    report[st] = r
    subs = []
    for name in r['meshes']:
        ci = int(re.match(r'submesh_(\d+)', name).group(1))
        subs.append({'chunk': ci, 'glbMesh': name, 'doubleSided': 'doubled' in name, 'kind': None})
    apps = {}
    for app, chunk_mats in info['apps'].items():
        keys = []
        for s in subs:
            mn = chunk_mats[s['chunk']] if s['chunk'] < len(chunk_mats) else None
            k = mat_keys.get(f'{st}|{mn}') if mn else None
            keys.append(k)
            kind = {'hairCards': 'cards', 'beardShadow': 'shadow', 'accessory': 'accessory'}.get(man['materials'][k]['type']) if k else None
            if s['kind'] is None:
                s['kind'] = kind
        apps[app] = keys
    man['meshes'][st] = {'glb': rel, 'gamePath': info['gamePath'], 'submeshes': subs, 'appearances': apps, 'morphs': True}

man['beards'] = {
    'note': 'creator beard app (beard_part meshHint) -> beard colour app (beard_color) -> components: mesh stem, its appearance, chunk indices shown',
    'apps': plan['apps'],
}
MF.write_text(json.dumps(man, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
print('beard meshes', len(report), 'materials', len(set(mat_keys.values())), 'shadow', shadow_n)
for st, r in report.items():
    print(f"  {st}: {r['srcMb']} MB -> {r['mb']} MB, dropped {r['droppedTargets']} empty targets")
