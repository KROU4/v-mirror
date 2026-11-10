"""Approximate bake of CP2077 multilayered.mt materials (mlsetup + mlmask + mltemplates) into albedo + ORM textures.
Per layer i (0..N-1): weight = opacity_i * (i == 0 ? 1 : mask_i(uv)); value = lerp(value, layerValue_i, weight)
layer colour  = colorScale (linear RGB from template overrides) * colorTexture (tiled matTile times, linear)
layer rough   = lerp(roughOut[1], roughOut[0], roughnessTexture)   (roughLevelsOut override; [max, min])
layer metal   = lerp(metalOut[1], metalOut[0], metalnessTexture)
Microblends and per-layer normal maps are ignored; GlobalNormal is exported separately (converted to OpenGL)."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, os, sys, hashlib
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import milib
W = milib.W
PNG = [os.path.join(W, 'mlpng'), os.path.join(W, 'texpng')]
LOCAL = str(vmpaths.OUT)
OUT = os.path.join(LOCAL, 'body', 'tex')

def rel(p):
    return os.path.relpath(p, LOCAL).replace('\\', '/')

def png_of(depot):
    stem = depot[:-4] if depot.endswith('.xbm') else depot
    for r in PNG:
        p = os.path.join(r, stem + '.png')
        if os.path.exists(p):
            return p
    return None

def s2l(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)

def l2s(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)

_cache = {}
def img(depot, mode):
    k = (depot, mode)
    if k not in _cache:
        p = png_of(depot)
        if p is None:
            _cache[k] = None
        else:
            _cache[k] = np.asarray(Image.open(p).convert(mode)).astype(np.float32) / 255.0
    return _cache[k]

def tiled(a, size, tile):
    """a: HxW[xC] texture, returns size x size sampling a tiled `tile` times."""
    if a is None:
        return None
    tile = max(float(tile), 1e-3)
    rep = size / tile  # pixels per repeat
    if rep < 2 or tile < 1:
        m = a.reshape(-1, a.shape[-1]).mean(0) if a.ndim == 3 else a.mean()
        return np.broadcast_to(m, (size, size) + a.shape[2:]).copy()
    n = int(round(rep))
    im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)).resize((n, n), Image.BILINEAR)
    t = np.asarray(im).astype(np.float32) / 255
    reps = int(np.ceil(size / n)) + 1
    t = np.tile(t, (reps, reps) + ((1,) if t.ndim == 3 else ()))
    return t[:size, :size]

def lookup(lst, name, default):
    if isinstance(lst, list):
        for e in lst:
            if e['n']['$value'] == name:
                v = e['v']
                return v['Elements'] if isinstance(v, dict) else v
    return default

def mask_layers(mlmask_depot):
    stem = mlmask_depot[:-7]
    d = None
    for r in PNG:
        cand = os.path.join(r, stem + '_layers')
        if os.path.isdir(cand):
            d = cand
    if d is None:
        return {}
    base = os.path.basename(stem)
    out = {}
    for f in os.listdir(d):
        i = int(f[len(base) + 1:-4])
        out[i] = np.asarray(Image.open(os.path.join(d, f)).convert('L')).astype(np.float32) / 255.0
    return out

def bake(mlsetup, mlmask, size=None):
    st = milib.load_mi(mlsetup)
    masks = mask_layers(mlmask) if mlmask else {}
    if size is None:
        size = max([m.shape[0] for m in masks.values()] + [256])
        size = min(size, 1024)
    col = np.zeros((size, size, 3), np.float32); rough = np.full((size, size), 0.5, np.float32); metal = np.zeros((size, size), np.float32)
    info = []
    for i, L in enumerate(st['layers']):
        op = float(L.get('opacity', 1))
        if i == 0:
            m = np.ones((size, size), np.float32)
        else:
            mk = masks.get(i)
            if mk is None:
                continue
            if mk.shape[0] != size:
                mk = np.asarray(Image.fromarray((mk * 255).astype(np.uint8)).resize((size, size), Image.BILINEAR)).astype(np.float32) / 255
            m = mk
        w = (m * op)
        if w.max() <= 0:
            continue
        tpath = L['material']['DepotPath']['$value']
        tm = milib.load_mi(tpath)
        ov = tm['overrides']
        dflt = tm.get('defaultOverrides', {})
        csn = L['colorScale']['$value']
        cs = lookup(ov.get('colorScale'), csn, None)
        if cs is None:
            cs = lookup(ov.get('colorScale'), dflt.get('colorScale', {}).get('$value', 'null_null'), [1, 1, 1])
        rn = L['roughLevelsOut']['$value']
        ro = lookup(ov.get('roughLevelsOut'), rn, None) or lookup(ov.get('roughLevelsOut'), 'null', [1, 0])
        mn = L['metalLevelsOut']['$value']
        mo = lookup(ov.get('metalLevelsOut'), mn, None) or lookup(ov.get('metalLevelsOut'), 'null', [1, 0])
        tile = float(L.get('matTile', 1)) * float(tm.get('tilingMultiplier', 1) or 1)
        ct = img(tm['colorTexture']['DepotPath']['$value'], 'RGB')
        rt = img(tm['roughnessTexture']['DepotPath']['$value'], 'L')
        mt = img(tm['metalnessTexture']['DepotPath']['$value'], 'L')
        ctl = s2l(tiled(ct, size, tile)) if ct is not None else np.ones((size, size, 3), np.float32)
        lc = ctl * np.array(cs[:3], np.float32)
        rtl = tiled(rt, size, tile) if rt is not None else np.full((size, size), 0.5, np.float32)
        lr = ro[1] + (ro[0] - ro[1]) * rtl
        mtl = tiled(mt, size, tile) if mt is not None else np.zeros((size, size), np.float32)
        lm = mo[1] + (mo[0] - mo[1]) * mtl
        col = col * (1 - w[..., None]) + lc * w[..., None]
        rough = rough * (1 - w) + lr * w
        metal = metal * (1 - w) + lm * w
        info.append({'layer': i, 'template': os.path.basename(tpath), 'colorScale': csn, 'colorLinear': [round(float(x), 4) for x in cs[:3]],
                     'colorSRGBhex': '#%02x%02x%02x' % tuple(int(round(float(l2s(np.array(c)) * 255))) for c in cs[:3]),
                     'opacity': round(op, 3), 'matTile': round(tile, 3), 'roughOut': [round(float(x), 3) for x in ro], 'metalOut': [round(float(x), 3) for x in mo],
                     'maskCoverage': round(float(w.mean()), 4)})
    return l2s(col), np.clip(rough, 0, 1), np.clip(metal, 0, 1), info

def save(arr, path, jpg=False, mode='RGB'):
    im = Image.fromarray((np.clip(arr, 0, 1) * 255 + 0.5).astype(np.uint8), mode)
    if jpg:
        im.save(path, quality=92, subsampling=0)
    else:
        im.save(path, optimize=True)
    return rel(path)

def normal_gl(depot, out):
    a = img(depot, 'RGBA')
    if a is None:
        return None
    p = os.path.join(OUT, out + '.png')
    if not os.path.exists(p):
        x = a[..., 0] * 2 - 1; y = -(a[..., 1] * 2 - 1)
        z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
        save(np.stack([x, y, z], -1) * 0.5 + 0.5, p)
    return rel(p)

def hexrgb(h):
    h = h.lstrip('#')[:6]
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)

if __name__ == '__main__':
    jobs = json.load(open(os.path.join(W, 'ml_jobs.json')))
    os.makedirs(os.path.join(OUT, 'nails'), exist_ok=True)
    os.makedirs(os.path.join(OUT, 'underwear'), exist_ok=True)
    results = {}
    done = {}
    for key, j in jobs.items():
        p = j['params']
        sub = 'nails' if j['kind'] == 'nails' else 'underwear'
        r = {'kind': j['kind'], 'template': j['template'], 'material': j['material']}
        if j['template'] == 'engine\\materials\\multilayered.mt':
            ident = (p['MultilayerSetup'], p.get('MultilayerMask'))
            if ident not in done:
                name = os.path.basename(p['MultilayerSetup'])[:-8]
                col, rough, metal, info = bake(p['MultilayerSetup'], p.get('MultilayerMask'))
                fa = save(col, os.path.join(OUT, sub, name + '_albedo.png'))
                orm = np.stack([np.ones_like(rough), rough, metal], -1)
                fo = save(orm, os.path.join(OUT, sub, name + '_orm.png'))
                done[ident] = {'albedo': fa, 'orm': fo, 'layers': info, 'meanAlbedoSRGB': '#%02x%02x%02x' % tuple(int(x * 255) for x in col.reshape(-1, 3).mean(0)),
                               'meanRoughness': round(float(rough.mean()), 3), 'meanMetalness': round(float(metal.mean()), 3)}
                print(key, name, done[ident]['meanAlbedoSRGB'], done[ident]['meanRoughness'], done[ident]['meanMetalness'], len(info), 'layers')
            r.update(done[ident])
            r['mlsetup'] = p['MultilayerSetup']; r['mlmask'] = p.get('MultilayerMask')
            if p.get('GlobalNormal'):
                r['normal'] = normal_gl(p['GlobalNormal'], sub + '/' + os.path.basename(p['GlobalNormal'])[:-4] + '_gl')
        elif j['template'] == 'base\\materials\\skin.mt':
            alb = img(p['Albedo'], 'RGB')
            t = s2l(hexrgb(p.get('TintColor', '#ffffff')))
            sc = float(p.get('TintScale', 0) or 0)
            a = s2l(alb)
            tinted = a * t if sc >= 0 else np.where(a < 0.5, 2 * a * t, 1 - 2 * (1 - t) * (1 - a))
            outc = l2s(a * (1 - abs(sc)) + tinted * abs(sc))
            name = 'nails_skin_' + j['material']
            r['albedo'] = save(outc, os.path.join(OUT, 'nails', name + '_albedo.png'))
            rm = img(p['Roughness'], 'RGBA')
            r['orm'] = save(np.stack([np.ones_like(rm[..., 0]), rm[..., 0], rm[..., 1]], -1), os.path.join(OUT, 'nails', 'an_000_ma__c_base_rm01_orm.png'))
            r['normal'] = normal_gl(p['Normal'], 'nails/' + os.path.basename(p['Normal'])[:-4] + '_gl')
            r['TintColor'] = p.get('TintColor'); r['TintScale'] = sc; r['albedoSource'] = p['Albedo']
            r['meanAlbedoSRGB'] = '#%02x%02x%02x' % tuple(int(x * 255) for x in outc.reshape(-1, 3).mean(0))
            print(key, name, r['meanAlbedoSRGB'])
        else:  # metal_base.remt decals (stitches/zipper) on underwear
            bc = p.get('BaseColor')
            r['note'] = 'metal_base decal (stitches/zipper strip). BaseColor is a shared decal atlas; params below.'
            r['params'] = {k: v for k, v in p.items()}
            if bc:
                pth = png_of(bc)
                if pth:
                    a = np.asarray(Image.open(pth).convert('RGBA')).astype(np.float32) / 255
                    d = os.path.join(OUT, 'underwear', os.path.basename(bc)[:-4] + '.png')
                    if not os.path.exists(d):
                        Image.open(pth).convert('RGBA').save(d, optimize=True)
                    r['baseColor'] = rel(d)
                    r['baseColorAlphaMean'] = round(float(a[..., 3].mean()), 3)
            if p.get('Normal'):
                r['normal'] = normal_gl(p['Normal'], 'underwear/' + os.path.basename(p['Normal'])[:-4] + '_gl')
        results[key] = r
    json.dump(results, open(os.path.join(W, 'bake_ml_result.json'), 'w'), indent=1)
    print('done', len(results))
