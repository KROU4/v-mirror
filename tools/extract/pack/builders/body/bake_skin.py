"""Bake per-tone skin albedos (body + arms, both genders) using the game's skin.mt tint logic
(as reimplemented by the WolvenKit Blender add-on): linear space,
  f = |TintScale| * TintColorMask.R
  tinted = (TintScale >= 0) ? albedo * tint : overlay(albedo, tint)
  out = lerp(albedo, tinted, f)
Also converts normal maps (2-channel DirectX) to 3-channel OpenGL and packs roughness into three.js ORM."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import os, sys, json
import numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import milib
W = milib.W
SRC = os.path.join(W, 'texpng')
OUT = str(vmpaths.OUT / 'body' / 'tex')
os.makedirs(OUT, exist_ok=True)

def find(name):
    for dp, dn, fn in os.walk(SRC):
        if name + '.png' in fn:
            return os.path.join(dp, name + '.png')
    raise FileNotFoundError(name)

def s2l(x):
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)

def l2s(x):
    x = np.clip(x, 0, 1)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * np.power(x, 1 / 2.4) - 0.055)

def load(name, mode='RGB'):
    return np.asarray(Image.open(find(name)).convert(mode)).astype(np.float32) / 255.0

def hexrgb(h):
    h = h.lstrip('#')[:6]
    return np.array([int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], np.float32)

def save_rgb(arr01, name, jpg=False):
    im = Image.fromarray((np.clip(arr01, 0, 1) * 255 + 0.5).astype(np.uint8))
    p = os.path.join(OUT, name + ('.jpg' if jpg else '.png'))
    if jpg:
        im.save(p, quality=92, subsampling=0)
    else:
        im.save(p, optimize=True)
    return os.path.relpath(p, os.path.dirname(os.path.dirname(OUT))).replace('\\', '/')

def convert_normal(name, out):
    a = load(name, 'RGBA')
    x = a[..., 0] * 2 - 1
    y = -(a[..., 1] * 2 - 1)          # DirectX -> OpenGL (flip green)
    z = np.sqrt(np.clip(1 - x * x - y * y, 0, 1))
    n = np.stack([x, y, z], -1) * 0.5 + 0.5
    return save_rgb(n, out)

def convert_orm(name, out):
    a = load(name, 'RGBA')
    r = a[..., 0]; m = a[..., 1]; mask = a[..., 2]
    orm = np.stack([np.ones_like(r), r, m], -1)  # three.js: G=roughness, B=metalness
    p1 = save_rgb(orm, out)
    p2 = os.path.join(OUT, out.replace('_orm', '_detailmask') + '.png')
    Image.fromarray((mask * 255 + 0.5).astype(np.uint8), 'L').save(p2, optimize=True)
    return p1, os.path.relpath(p2, os.path.dirname(os.path.dirname(OUT))).replace('\\', '/')

def mask_r(name, out):
    a = load(name, 'RGBA')
    p = os.path.join(OUT, out + '.png')
    Image.fromarray((a[..., 0] * 255 + 0.5).astype(np.uint8), 'L').save(p, optimize=True)
    return os.path.relpath(p, os.path.dirname(os.path.dirname(OUT))).replace('\\', '/'), float(a[..., 0].mean())

def tint(alb_lin, mask, color_hex, scale):
    t = s2l(hexrgb(color_hex))
    f = (abs(scale) * mask)[..., None]
    if scale >= 0:
        tinted = alb_lin * t
    else:
        tinted = np.where(alb_lin < 0.5, 2 * alb_lin * t, 1 - 2 * (1 - t) * (1 - alb_lin))
    tinted = np.clip(tinted, 0, 1)
    return alb_lin * (1 - f) + tinted * f

TONES = ['01_ca_pale', '01_ca_pale_00_warm_ivory', '02_ca_limestone', '02_ca_limestone_00_beige', '03_ca_senna', '03_ca_senna_00_amber', '03_ca_senna_01_honey', '03_ca_senna_02_band', '04_ca_almond', '04_ca_almond_00_umber', '05_bl_espresso', '06_bl_dark']
MI = 'base\\characters\\common\\skin\\character_mat_instance\\'
PARTS = {
    ('pwa', 'body'): ('female\\body\\female_%s.mi', 't0_000_wa__c_base_d02_naked', 't0_000_wa__c_base_n02_naked', 't0_000_wa__c_base_rm02'),
    ('pma', 'body'): ('male\\body\\male_%s.mi', 't0_000_ma__c_base_d03_naked', 't0_000_ma__c_base_n03_naked', 't0_000_ma__c_base_rm03'),
    ('pwa', 'arms'): ('female\\arms\\female_arm_%s.mi', 'a0_000_wa__c_base_hq_d01', 'a0_000_wa_base__hq_nd01', 'a0_000_wa__base_hq_rm01'),
    ('pma', 'arms'): ('male\\arms\\male_arms_%s.mi', 'a0_000_ma__c_base_hq_d01', 'a0_000_ma_base__hq_nd01', 'a0_000_ma__base_hq_rm01'),
}
res = {'parts': {}, 'masks': {}}
mask_cache = {}
for (g, part), (mipat, alb, nrm, rm) in PARTS.items():
    entry = {'albedoUntinted': save_rgb(load(alb), '%s_%s_albedo_base' % (g, part), jpg=True),
             'normal': convert_normal(nrm, '%s_%s_normal' % (g, part)),
             'tones': {}}
    entry['orm'], entry['detailMask'] = convert_orm(rm, '%s_%s_orm' % (g, part))
    alb_lin = s2l(load(alb))
    for t in TONES:
        prm, chain, tmpl = milib.resolve(MI + mipat % t)
        mpath = prm['TintColorMask']
        mname = os.path.basename(mpath)[:-4]
        if mname not in mask_cache:
            mask_cache[mname] = mask_r(mname, 'tintmask_' + mname)
            res['masks'][mname] = {'file': mask_cache[mname][0], 'meanR': round(mask_cache[mname][1], 3)}
        m = load(mname, 'RGBA')[..., 0]
        if m.shape != alb_lin.shape[:2]:
            m = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize(alb_lin.shape[1::-1], Image.BILINEAR)).astype(np.float32) / 255
        out = l2s(tint(alb_lin, m, prm['TintColor'], prm['TintScale']))
        f = save_rgb(out, '%s_%s_albedo_%s' % (g, part, t), jpg=True)
        entry['tones'][t] = {'albedo': f, 'TintColor': prm['TintColor'], 'TintScale': round(prm['TintScale'], 4), 'TintColorMask': 'tintmask_' + mname,
                             'mi': (MI + mipat % t), 'miChain': chain}
        print(g, part, t, 'mean sRGB', [round(float(x), 3) for x in out.reshape(-1, 3).mean(0)])
    res['parts']['%s_%s' % (g, part)] = entry
json.dump(res, open(os.path.join(W, 'bake_skin_result.json'), 'w'), indent=1)
