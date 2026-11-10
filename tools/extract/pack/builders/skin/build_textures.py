"""Build final web assets + manifest for the 'skin' lane."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, os, re
import numpy as np
from PIL import Image

W = str(vmpaths.area('skin'))
ROOT = str(vmpaths.REPO)
LOCAL = str(vmpaths.OUT)
OUT = os.path.join(LOCAL, 'tex', 'skin')
PNG = os.path.join(W, 'png')
MAXS = 2048
for d in ('female', 'male', 'common'):
    os.makedirs(os.path.join(OUT, d), exist_ok=True)

def rel(p):
    return os.path.relpath(p, LOCAL).replace('\\', '/')

def load(name):
    im = Image.open(os.path.join(PNG, name + '.png')).convert('RGBA')
    if max(im.size) > MAXS:
        s = MAXS / max(im.size)
        im = im.resize((round(im.size[0] * s), round(im.size[1] * s)), Image.LANCZOS)
    return im

done = {}

def color_jpg(src, dst):
    if src in done: return done[src]
    im = load(src).convert('RGB')
    p = os.path.join(OUT, dst)
    im.save(p, 'JPEG', quality=95, subsampling=0, optimize=True)
    done[src] = rel(p); return done[src]

def plain_png(src, dst, mode='RGB'):
    if src in done: return done[src]
    im = load(src).convert(mode)
    p = os.path.join(OUT, dst)
    im.save(p, optimize=True)
    done[src] = rel(p); return done[src]

def normal_gl(src, dst):
    """BC5 DirectX tangent normal (R=X, G=-Y, B empty) -> OpenGL/glTF RGB normal (G inverted, Z rebuilt)."""
    if src in done: return done[src]
    a = np.asarray(load(src)).astype(np.float64) / 255.0
    x = a[..., 0] * 2 - 1
    y = -(a[..., 1] * 2 - 1)
    z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
    o = np.stack([x, y, z], -1) * 0.5 + 0.5
    p = os.path.join(OUT, dst)
    Image.fromarray(np.clip(np.round(o * 255), 0, 255).astype(np.uint8), 'RGB').save(p, optimize=True)
    done[src] = rel(p); return done[src]

def rough_orm(src, dst):
    """rm01: R=roughness, G=metalness(0), B=detail mask -> glTF-style: R=detail mask, G=roughness, B=metalness."""
    if src in done: return done[src]
    a = np.asarray(load(src))
    o = np.stack([a[..., 2], a[..., 0], a[..., 1]], -1)
    p = os.path.join(OUT, dst)
    Image.fromarray(o.astype(np.uint8), 'RGB').save(p, optimize=True)
    done[src] = rel(p); return done[src]

def hexrgb(c):
    return '#' + c[1:7] if isinstance(c, str) and c.startswith('#') else c

res = json.load(open(os.path.join(W, 'resolved.json'), encoding='utf-8'))
tone_map = json.load(open(os.path.join(W, 'tone_map.json'), encoding='utf-8'))
cats = {g: json.load(open(os.path.join(ROOT, 'src', 'data', 'catalog.%s.json' % g), encoding='utf-8')) for g in ('female', 'male')}
sp = json.load(open(os.path.join(W, 'spjson', 'default.sp.json'), encoding='utf-8'))['Data']['RootChunk']

def tex_name(v):
    return v[4:].split('\\')[-1][:-4] if isinstance(v, str) and v.startswith('RES:') else None

# common textures
common = {
    'tintMaskFace': plain_png('h0_000_base__tintcolormask', 'common/tintmask_face.png'),
    'tintMaskTorso': plain_png('i0_000_base__tintcolormask', 'common/tintmask_torso.png'),
    'microDetailNormal': normal_gl('microdetail_n', 'common/microdetail_n_gl.png'),
}
manifest = {
    'version': 1,
    'source': 'Cyberpunk 2077 2.x, basegame_4_appearance.archive; WolvenKit 9.1.1 export; material chain mesh-local -> .mi -> .mi -> base\\materials\\skin.mt',
    'common': common,
    'skinProfile': {
        'file': 'engine\\materials\\defaults\\default.sp',
        'diffuse': '#ffffff', 'falloff': '#%02x%02x%02x' % (sp['falloff']['Red'], sp['falloff']['Green'], sp['falloff']['Blue']),
        'blurSize': sp['blurSize'], 'roughness0': sp['roughness0'], 'roughness1': sp['roughness1'], 'lobeMix': sp['lobeMix'],
    },
}
GEN = {'female': 'pwa', 'male': 'pma'}
for g, code in GEN.items():
    mats = res[code]['materials']
    mesh_apps = res[code]['appearances']
    folder = g
    # textures shared by all tones of this gender
    any_mat = next(m for k, m in mats.items() if not k.startswith('npc_'))
    p0 = any_mat['params']
    shared = {
        'normal': normal_gl(tex_name(p0['Normal']), folder + '/normal_gl.png'),
        'roughness': rough_orm(tex_name(p0['Roughness']), folder + '/rough_detailmask_gl.png'),
        'detailNormal': normal_gl(tex_name(p0['DetailNormal']), folder + '/detail_normal_gl.png'),
        'wrinkleStretchNormal': normal_gl(tex_name(p0['Detailmap_Stretch']), folder + '/wrinkle_stretch_n_gl.png'),
        'wrinkleSquashNormal': normal_gl(tex_name(p0['Detailmap_Squash']), folder + '/wrinkle_squash_n_gl.png'),
        'bloodflowMask': plain_png(tex_name(p0['Bloodflow']), folder + '/bloodflow_mask.png'),
        'tintMask': common['tintMaskFace'],
        'microDetailNormal': common['microDetailNormal'],
    }
    scalars = {k: p0[k] for k in ('DetailNormalInfluence', 'MicroDetailInfluence', 'MicroDetailUVScale01', 'MicroDetailUVScale02',
                                  'DetailRoughnessBiasMin', 'DetailRoughnessBiasMax', 'CavityIntensity', 'EmissiveEV',
                                  'SecondaryAlbedoInfluence', 'SecondaryAlbedoTintColorInfluence')}
    scalars['BloodColor'] = hexrgb(p0['BloodColor'])
    skin_types = {}
    for i in range(1, 6):
        alb = 'h0_000_%s_c__basehead_d0%d' % (code, i)
        hint = 'h0_000__basehead' if i == 1 else 'h0_000__basehead_d0%d' % i
        skin_types[hint] = {'albedo': color_jpg(alb, '%s/albedo_d0%d.jpg' % (folder, i)), 'gameTexture': alb + '.xbm'}
    tones = {}
    problems = []
    for slot in cats[g]['slots']:
        if slot['id'] != 'skin_color': continue
        for v in slot['variants']:
            for o in v['options']:
                app = o['app']
                entry = {'catalogHex': o.get('hex'), 'byskinType': {}}
                for hint in skin_types:
                    tm = tone_map.get(hint, {}).get(app)
                    if not tm or not tm['head']:
                        problems.append('%s: no head meshAppearance for %s in %s.app' % (g, app, hint)); continue
                    ma = tm['head'][0]
                    chunk = mesh_apps.get(ma)
                    if not chunk:
                        problems.append('%s: mesh appearance %s missing' % (g, ma)); continue
                    mname = chunk[0]
                    m = mats[mname]
                    p = m['params']
                    albn = tex_name(p['Albedo'])
                    st = 'h0_000__basehead' if albn.endswith('_d01') else 'h0_000__basehead_' + albn[-3:]
                    rec = {
                        'meshAppearance': ma, 'material': mname, 'albedo': skin_types[st]['albedo'],
                        'tintColor': hexrgb(p['TintColor']), 'tintScale': p['TintScale'],
                        'tintMask': 'face' if 'h0_000_base__tintcolormask' in p['TintColorMask'] else 'torso',
                        'mi': m['chain'][0],
                    }
                    if tex_name(p['Normal']) != tex_name(p0['Normal']):
                        rec['normalOverride'] = normal_gl(tex_name(p['Normal']), folder + '/normal_npc_quirk_gl.png')
                        rec['note'] = 'game data quirk: this material has no mesh-local Normal and falls back to the NPC head normal %s; recommend using the shared player normal anyway' % tex_name(p['Normal'])
                    if st != hint:
                        rec['note'] = (rec.get('note', '') + ' albedo is %s although skin type is %s' % (st, hint)).strip()
                    entry['byskinType'][hint] = rec
                d01 = entry['byskinType'].get('h0_000__basehead')
                if d01:
                    entry['tintColor'], entry['tintScale'], entry['tintMask'] = d01['tintColor'], d01['tintScale'], d01['tintMask']
                tones[app] = entry
    manifest[g] = {
        'gameMesh': 'base\\characters\\head\\player_base_heads\\%s\\h0_000_%s_c__basehead\\h0_000_%s_c__basehead.mesh' % ('player_female_average' if g == 'female' else 'player_man_average', code, code),
        'glbCompat': 'tools/local/glb/h0_000_%s__morphs.morphtarget.glb has identical topology and TEXCOORD_0 to the basehead .mesh export (same vertex count, same index buffer, max |dUV| = 0, max |dPos| = 0) - all textures here apply to its UV0 directly' % code,
        'maps': shared,
        'params': scalars,
        'skinTypes': skin_types,
        'skinTones': tones,
        'problems': problems,
    }
json.dump(manifest, open(os.path.join(W, 'manifest_body.json'), 'w', encoding='utf-8'), indent=1)
print(json.dumps({g: manifest[g]['problems'] for g in GEN}, indent=1))
tot = 0
for r, ds, fs in os.walk(OUT):
    for f in fs:
        s = os.path.getsize(os.path.join(r, f)); tot += s
        print(rel(os.path.join(r, f)), s)
print('total MB', tot / 1e6)
