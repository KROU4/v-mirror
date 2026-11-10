import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import sys, os, json
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bake_ml
P = 'base\\characters\\cyberware\\player\\a0_001__personal_link\\textures\\'
col, rough, metal, info = bake_ml.bake(P + 'a0_001__personal_link_1.mlsetup', P + 'a0_001__personal_link_1_masksset.mlmask')
os.makedirs(os.path.join(bake_ml.OUT, 'cyberware'), exist_ok=True)
r = {'albedo': bake_ml.save(col, os.path.join(bake_ml.OUT, 'cyberware', 'a0_001__personal_link_albedo.png')),
     'orm': bake_ml.save(np.stack([np.ones_like(rough), rough, metal], -1), os.path.join(bake_ml.OUT, 'cyberware', 'a0_001__personal_link_orm.png')),
     'normal': bake_ml.normal_gl(P + 'a0_001__personal_link_n01.xbm', 'cyberware/a0_001__personal_link_n01_gl'),
     'layers': info, 'meanAlbedoSRGB': '#%02x%02x%02x' % tuple(int(x * 255) for x in col.reshape(-1, 3).mean(0)),
     'meanRoughness': round(float(rough.mean()), 3), 'meanMetalness': round(float(metal.mean()), 3)}
json.dump(r, open(os.path.join(bake_ml.W, 'bake_pl_result.json'), 'w'), indent=1)
print(r['meanAlbedoSRGB'], r['meanRoughness'], r['meanMetalness'])
