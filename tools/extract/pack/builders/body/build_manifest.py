"""Build tools/local/body/manifest.json from the bake results, skeleton files and face report."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, os, struct, shutil

W = str(vmpaths.area('body'))
L = str(vmpaths.OUT)
B = os.path.join(L, 'body')

SPACE = ('glTF: Y-up, metres. Character faces -Z; its LEFT side is at -X (LeftHand x<0, l_J_eye_JNT x=-0.030), '
         'its RIGHT side at +X. Same space as the WolvenKit glb exports of the head (tools/local/glb/h0_000_p?a__morphs.morphtarget.glb). '
         'Game rig (Z-up) -> glTF: gl = (x, z, -y).')

skin = json.load(open(os.path.join(W, 'bake_skin_result.json')))
ml = json.load(open(os.path.join(W, 'bake_ml_result.json')))
pl = json.load(open(os.path.join(W, 'bake_pl_result.json')))
face = json.load(open(os.path.join(W, 'an', 'face_report.json')))

# fix the space description inside the skeleton files (earlier text had the left/right side inverted)
for g in ('pwa', 'pma'):
    p = os.path.join(B, 'skeleton.%s.json' % g)
    s = json.load(open(p))
    s['space'] = SPACE
    json.dump(s, open(p, 'w'), separators=(',', ':'))

def rel(p):
    return p.replace('\\', '/')

def exists(p):
    return os.path.exists(os.path.join(L, p.replace('/', os.sep)))

def size(p):
    return os.path.getsize(os.path.join(L, p.replace('/', os.sep)))

def glb_json(path):
    b = open(path, 'rb').read()
    jl = struct.unpack('<I', b[12:16])[0]
    return json.loads(b[20:20 + jl]), b, 20 + jl

def clip_info(path):
    J, b, off = glb_json(path)
    binoff = off + 8
    out = []
    for a in J.get('animations', []):
        tmax = 0.0
        for s in a['samplers']:
            acc = J['accessors'][s['input']]
            if 'max' in acc:
                tmax = max(tmax, acc['max'][0])
        paths = sorted({c['target']['path'] for c in a['channels']})
        out.append({'name': a['name'], 'durationSec': round(tmax, 3), 'channels': len(a['channels']), 'paths': paths})
    return out

TONES = ['01_ca_pale', '01_ca_pale_00_warm_ivory', '02_ca_limestone', '02_ca_limestone_00_beige', '03_ca_senna',
         '03_ca_senna_00_amber', '03_ca_senna_01_honey', '03_ca_senna_02_band', '04_ca_almond', '04_ca_almond_00_umber',
         '05_bl_espresso', '06_bl_dark']
TONE_PARAMS = {
    '01_ca_pale': ('#ab9b96', 0.0, 'c'), '01_ca_pale_00_warm_ivory': ('#fff5b5', -0.15, 'c'),
    '02_ca_limestone': ('#839553', 0.38, 'c'), '02_ca_limestone_00_beige': ('#aca61f', 0.58, 'c'),
    '03_ca_senna': ('#cab199', 0.70, 'c'), '03_ca_senna_00_amber': ('#c77470', 0.52, 'c'),
    '03_ca_senna_01_honey': ('#b58d1d', 0.67, 'c'), '03_ca_senna_02_band': ('#113e0b', 0.57, 'c'),
    '04_ca_almond': ('#bdb4ad', 1.0, 'c'), '04_ca_almond_00_umber': ('#a07146', 0.7159, 'c'),
    '05_bl_espresso': ('#756260', 0.80, 'b'), '06_bl_dark': ('#3f3327', 0.845, 'b'),
}

def part_tex(g, part):
    p = skin['parts']['%s_%s' % (g, part)]
    tones = {}
    for t in TONES:
        tones[t] = rel(p['tones'][t]) if isinstance(p['tones'][t], str) else rel(p['tones'][t].get('file', p['tones'][t].get('albedo')))
    return {
        'albedoByTone': tones,
        'albedoUntinted': rel(p['albedoUntinted']),
        'normal': rel(p['normal']),
        'orm': rel(p['orm']),
        'detailMask': rel(p['detailMask']),
    }

BODY_SUBMESH_ROLES = ['chest/upper torso', 'neck-collar/shoulder band', 'waist/abdomen', 'pelvis/hips', 'thighs+knees',
                      'calves', 'ankles/lower shins', 'feet (detailed toes)']
ARM_SUBMESH_ROLES_L = ['upper arm', 'forearm', 'hand (4.2k verts, fingers)', 'personal_link (cyberware jack at wrist, multilayered)']
ARM_SUBMESH_ROLES_R = ['upper arm', 'forearm', 'hand (fingers)']

def skin_mat(part_key):
    return {'shader': 'skin', 'textures': 'textures.' + part_key, 'tintByTone': True}

nails = {'pwa': {}, 'pma': {}}
for k, v in ml.items():
    if v['kind'] != 'nails':
        continue
    g, app = k.split('|', 1)
    e = {'catalogApp': app, 'albedo': rel(v['albedo']), 'orm': rel(v['orm']), 'normal': rel(v.get('normal', 'body/tex/nails/an_000_ma__c_base_n01_gl.png')),
         'sourceTemplate': v['template'].split('\\')[-1], 'gameMaterial': v['material']}
    if v['template'].endswith('skin.mt'):
        e['kind'] = 'skinShader'
        e['tintColor'] = v['TintColor']
        e['tintScale'] = v['TintScale']
        e['note'] = 'albedo already tinted with tintColor/tintScale (mask = 1). Use as plain baseColor.'
    else:
        e['kind'] = 'multilayeredBake'
    for kk in ('meanAlbedoSRGB', 'meanRoughness', 'meanMetalness'):
        if kk in v:
            e[kk] = v[kk]
    nails[g][app] = e

uw = {}
for k, v in ml.items():
    if v['kind'] != 'underwear':
        continue
    g, item, sub = k.split('|')
    e = {'submesh': int(sub.replace('sub', '')), 'gameMaterial': v['material'], 'sourceTemplate': v['template'].split('\\')[-1]}
    if v['template'].endswith('multilayered.mt'):
        e.update({'shader': 'standard', 'baseColor': rel(v['albedo']), 'orm': rel(v['orm']), 'normal': rel(v['normal']),
                  'meanAlbedoSRGB': v['meanAlbedoSRGB'], 'meanRoughness': v['meanRoughness'], 'meanMetalness': v['meanMetalness']})
    else:
        prm = v['params']
        bcs = prm.get('BaseColorScale', [1, 1, 1, 1])
        e.update({'shader': 'decal', 'baseColor': rel(v['baseColor']), 'normal': rel(v['normal']),
                  'baseColorScaleLinear': [round(x, 4) for x in bcs[:3]],
                  'baseColorScaleHex': '#%02x%02x%02x' % tuple(int(round(255 * (x ** (1 / 2.2)))) for x in bcs[:3]),
                  'roughness': round(prm.get('RoughnessBias', 0.5) + 0 * prm.get('RoughnessScale', 0), 3) if 'RoughnessBias' in prm else 0.5,
                  'metalness': prm.get('MetalnessBias', 0),
                  'note': 'metal_base.remt decal strip (stitches/zipper). Use transparent=true, alphaTest~0.3 or alpha blend from baseColor.a, '
                          'color = texture.rgb * baseColorScale (linear), depthWrite=false, polygonOffset to avoid z-fight.'})
    uw.setdefault('%s|%s' % (g, item), []).append(e)
for v in uw.values():
    v.sort(key=lambda e: e['submesh'])

anim = {}
for g in ('pwa', 'pma'):
    p = 'body/anim/ui_%s.glb' % g
    anim[g] = {'file': p, 'bytes': size(p), 'clips': clip_info(os.path.join(L, p.replace('/', os.sep)))}

# copy joint dumps and the dumper script for the engine author
os.makedirs(os.path.join(B, 'joints'), exist_ok=True)
for g in ('pwa', 'pma'):
    shutil.copyfile(os.path.join(W, 'an', 'head_%s.json' % g), os.path.join(B, 'joints', 'head_%s.joints.json' % g))
    for f in ('t0_000_%s_base__full%s' % (g, '.morphtarget' if g == 'pwa' else ''),):
        shutil.copyfile(os.path.join(W, 'an', f + '.json'), os.path.join(B, 'joints', 'body_%s.joints.json' % g))
# (the old dev copy of glbinfo.mjs into the pack is not needed)
pass

glb = {}
def addglb(key, path, g, role, subroles, extra=None):
    e = {'file': path, 'bytes': size(path), 'gender': g, 'role': role, 'submeshes': subroles}
    if extra:
        e.update(extra)
    glb[key] = e

addglb('pwa_body', 'body/glb/t0_000_pwa_base__full.morphtarget.glb', 'pwa', 'full female body: neck-to-toes, 8 submeshes',
       [{'index': i, 'role': r, 'material': 'skin:pwa_body'} for i, r in enumerate(BODY_SUBMESH_ROLES)],
       {'morphTargets': ['t0_000_wa_base__full_breast_small_breast', 't0_000_wa_base__full_breast_big_breast'],
        'morphNote': 'character-creator "breast" slider: small = influence[0], big = influence[1]; neutral = both 0.',
        'charCreatorVisibility': 'hide submeshes 5,6,7 (in-game chunkMask 0xFFFFFFFFFFFFFF1F) and show pwa_legs_cs_flat instead '
                                 '(barefoot flat feet used in the creator). Showing 5-7 instead is also valid (game "full" legs, l0_000_base__full.app chunkMask 0x...E0).'})
addglb('pma_body', 'body/glb/t0_000_pma_base__full.glb', 'pma', 'full male body: neck-to-toes, 8 submeshes, all visible',
       [{'index': i, 'role': r, 'material': 'skin:pma_body'} for i, r in enumerate(BODY_SUBMESH_ROLES)],
       {'morphTargets': ['GarmentSupport'], 'morphNote': 'keep GarmentSupport at 0.'})
addglb('pwa_legs_cs_flat', 'body/glb/l0_000_pwa_base__cs_flat.glb', 'pwa', 'female char-creator legs (calves, ankles, flat feet) replacing body submeshes 5-7',
       [{'index': i, 'role': r, 'material': 'skin:pwa_body'} for i, r in enumerate(['calves', 'ankles/lower shins', 'feet (flat)'])],
       {'morphTargets': ['GarmentSupport']})
for g in ('pwa', 'pma'):
    addglb('%s_arm_l' % g, 'body/glb/a0_000_%s_base_hq__l.glb' % g, g, 'left arm + hand (hq)',
           [{'index': i, 'role': r, 'material': ('skin:%s_arms' % g) if i < 3 else 'personalLink'} for i, r in enumerate(ARM_SUBMESH_ROLES_L)],
           {'morphTargets': ['GarmentSupport']})
    addglb('%s_arm_r' % g, 'body/glb/a0_000_%s_base_hq__r.glb' % g, g, 'right arm + hand (hq)',
           [{'index': i, 'role': r, 'material': 'skin:%s_arms' % g} for i, r in enumerate(ARM_SUBMESH_ROLES_R)],
           {'morphTargets': ['GarmentSupport']})
    for s in ('l', 'r'):
        addglb('%s_nails_%s' % (g, s), 'body/glb/a0_000_%s_base__nails_%s.morphtarget.glb' % (g, s), g, 'fingernails %s hand' % ('left' if s == 'l' else 'right'),
               [{'index': 0, 'role': 'nails', 'material': 'nails:%s' % g}],
               {'morphTargets': ['a0_000_%s_base__nails_%s_nails_%s' % (g, s, s)],
                'morphNote': 'nail shape morph from the game morphtarget (semantics not verified); keep 0 for the base mesh shape.'})
addglb('pwa_underwear_panties', 'body/glb/l1_047_pwa_shorts__panties.glb', 'pwa', 'default char-creator underwear (bottom)',
       [{'index': e['submesh'], 'material': 'underwear:pwa|panties#%d' % e['submesh'], 'role': 'fabric' if e['shader'] == 'standard' else 'stitch decal strip'} for e in uw['pwa|panties']],
       {'morphTargets': ['GarmentSupport']})
addglb('pwa_underwear_bra', 'body/glb/t1_057_pwa_tank__bra.glb', 'pwa', 'default char-creator underwear (top)',
       [{'index': e['submesh'], 'material': 'underwear:pwa|bra#%d' % e['submesh'], 'role': 'fabric' if e['shader'] == 'standard' else 'decal strip'} for e in uw['pwa|bra']],
       {'morphTargets': ['GarmentSupport'], 'note': 'no breast_small/breast_big morph exists for this garment; with the breast slider != 0 the bra will clip. Hide it or keep breast morphs small (<0.3).'})
addglb('pma_underwear_boxers', 'body/glb/l1_049_pma_shorts__boxers.glb', 'pma', 'default char-creator underwear (boxers)',
       [{'index': e['submesh'], 'material': 'underwear:pma|boxers#%d' % e['submesh'], 'role': 'fabric' if e['shader'] == 'standard' else 'stitch decal strip'} for e in uw['pma|boxers']],
       {'morphTargets': ['GarmentSupport']})

for k, v in glb.items():
    assert exists(v['file']), v['file']

textures = {}
for g in ('pwa', 'pma'):
    for part in ('body', 'arms'):
        textures['%s_%s' % (g, part)] = part_tex(g, part)
for k, v in textures.items():
    for kk, p in v.items():
        if isinstance(p, dict):
            for t, pp in p.items():
                assert exists(pp), pp
        else:
            assert exists(p), p

tones = {}
for t in TONES:
    c, s, m = TONE_PARAMS[t]
    tones[t] = {
        'headSkinColorApp': {'pwa': 'h0_000_pwa__basehead__%s' % t, 'pma': 'h0_000_pma__basehead__%s' % t},
        'bodyApp': {'pwa': 't0_000_pwa_base__%s' % t, 'pma': 't0_000_pma_base__%s' % t},
        'armsApp': {'pwa': 'a0_000_pwa_base__%s' % t, 'pma': 'a0_000_pma_base__%s' % t},
        'meshAppearance': t,
        'tintColor': c, 'tintScale': s,
        'tintMask': {'body': 'body/tex/tintmask_t0_000_base_%s__tintcolormask.png' % m, 'arms': 'body/tex/tintmask_a0_000_base_%s__tintcolormask_hq.png' % m},
        'albedo': {'%s_%s' % (g, part): textures['%s_%s' % (g, part)]['albedoByTone'][t] for g in ('pwa', 'pma') for part in ('body', 'arms')},
    }
headToTone = {}
for t in TONES:
    for g in ('pwa', 'pma'):
        headToTone['h0_000_%s__basehead__%s' % (g, t)] = t

def r3(v):
    return [round(x, 5) for x in v]

face_rig = {}
for g in ('pwa', 'pma'):
    f = face[g]
    ax = f['axes']
    upper = -25 if g == 'pwa' else -22
    face_rig[g] = {
        'jaw': {
            'joint': 'mid_J_jaw_JNT', 'parentChain': ['mid_J_jaw_JNT', 'jaw_root_JNT', 'Head', 'Neck1', 'Neck', 'Spine3'],
            'pivot': r3(ax['mid_J_jaw_JNT']['pivot']),
            'openAxisWorld': [1, 0, 0], 'openAxisBoneLocal': [0, 1, 0],
            'openAngleDeg': {'min': -12, 'typical': -15, 'max': -18},
            'recipe': 'bone.quaternion.copy(rest).multiply(new Quaternion().setFromAxisAngle(new Vector3(0,1,0), THREE.MathUtils.degToRad(-15)))  // NEGATIVE angle opens',
            'lowerLipMoveMetres': {'12deg': f['jaw_12']['lowerLipCentroidMove_m'], '15deg': f['jaw_15']['lowerLipCentroidMove_m'], '18deg': f['jaw_18']['lowerLipCentroidMove_m']},
            'childrenFollow': 'lip_dn_*, chin_*, mouth_rowA_4..6, mouth_rowB_4..5, jaw_nosabial_*, jaw_row*, throat_rowA*, mid_J_tongue_* are rig children of mid_J_jaw_JNT; '
                              'they follow ONLY if the face hierarchy from skeleton.<g>.json is rebuilt (exported glb hierarchy is flat).',
        },
        'eyelids': {
            'upperRoots': ['l_J_eye_lid_up_root_1_JNT', 'l_J_eye_lid_up_root_2_JNT', 'r_J_eye_lid_up_root_1_JNT', 'r_J_eye_lid_up_root_2_JNT'],
            'lowerRoots': ['l_J_eye_lid_dn_root_1_JNT', 'l_J_eye_lid_dn_root_2_JNT', 'r_J_eye_lid_dn_root_1_JNT', 'r_J_eye_lid_dn_root_2_JNT'],
            'cornerJoints': ['l_J_eye_lid_up_rowA_0_JNT', 'l_J_eye_lid_up_rowA_3_JNT', 'r_J_eye_lid_up_rowA_0_JNT', 'r_J_eye_lid_up_rowA_3_JNT'],
            'eyeCenter': {'l': r3(ax['l_J_eye_lid_up_root_1_JNT']['pivot']), 'r': r3(ax['r_J_eye_lid_up_root_1_JNT']['pivot'])},
            'axisWorld': [1, 0, 0], 'axisBoneLocal': [0, 1, 0],
            'blinkUpperDeg': upper, 'blinkLowerDeg': 5,
            'cornerRecipe': 'corner joints (rowA_0/rowA_3) are direct children of face_root_JNT, not of the roots: rotate their position about eyeCenter around world +X by blinkUpperDeg*0.5.',
            'restLidGapMm': 7.8 if g == 'pwa' else 6.8,
            'upperLidElevationDeg': f['upperLidElevationDeg'], 'lowerLidElevationDeg': f['lowerLidElevationDeg'],
            'blinkTiming': 'close 70 ms, hold 30 ms, open 120 ms; random interval 2.5-6 s; occasional double blink (15%).',
        },
        'eyes': {'joints': ['l_J_eye_JNT', 'r_J_eye_JNT'], 'note': 'rotate for look-at (pupil child joints follow); limit +-25 deg yaw, +-15 deg pitch.'},
        'neckHead': ['Spine3', 'Neck', 'Neck1', 'Head'],
    }

manifest = {
    'version': 1,
    'lane': 'body',
    'pathsRelativeTo': 'tools/local',
    'space': SPACE,
    'facing': 'models face -Z: rotate the character root by Math.PI around Y to face a camera on +Z (or put the camera at -Z).',
    'loaderNotes': [
        'GLTFLoader: every glb has COLOR_0; the default material would multiply by it. Replace materials and set vertexColors=false.',
        'glbs have no materials (exported WithMaterials=false). Build MeshStandardMaterial/MeshPhysicalMaterial from this manifest.',
        'Textures use UV0 (TEXCOORD_0). TEXCOORD_1 is unused. Set texture.flipY=false for all textures (glTF UV convention); colorSpace=SRGBColorSpace only for albedo/baseColor.',
        'Normal maps are already converted to OpenGL (+Y) tangent space with reconstructed Z: use as-is with normalScale (1,1).',
        'ORM textures: R=1 (no AO), G=roughness, B=metalness -> material.roughnessMap = material.metalnessMap = orm, roughness=1, metalness=1.',
        'Joint hierarchy in every exported glb is FLAT (all joints are children of "Armature"). Rebuild it from skeleton.<g>.json (see skeleton.rebind).',
        'Meshes are the game LOD0 (female body ~4.7k verts, each arm ~5.8k, head ~7.2k): smooth shading, keep the exported NORMAL/TANGENT attributes.',
    ],
    'skeleton': {
        'pwa': 'body/skeleton.pwa.json', 'pma': 'body/skeleton.pma.json',
        'format': 'bones[]: {name, parent, skinned, skinnedIn[], bindPosition[3] (world, m), bindQuaternion[4] (world, glTF xyzw), localPosition[3], localQuaternion[4]}. '
                  '510 bones (body deformation rig + full face rig), parents always precede children.',
        'rebind': 'Build one THREE.Bone per entry (position/quaternion = localPosition/localQuaternion), parent them, updateMatrixWorld. '
                  'For each loaded SkinnedMesh: bones2 = mesh.skeleton.bones.map(b => master[b.name]); mesh.bind(new THREE.Skeleton(bones2, mesh.skeleton.boneInverses), mesh.matrixWorld). '
                  'Keep each mesh\'s own boneInverses (they equal the world binds: max mismatch 0.26 mm). Alternative: re-parent the glb bones with Object3D.attach() which keeps world transforms.',
        'headBodyMatch': 'head glb and body glbs share one space; common joints (Spine3, Neck, Neck1, Head, shoulders) have identical binds (max diff 0.26 mm pwa, 0.01 mm pma).',
    },
    'glb': glb,
    'materials': {
        'skin': {
            'shaderNotes': [
                'Albedo per tone is PRE-BAKED: textures.<g>_<part>.albedoByTone[tone] (sRGB JPG). Just swap the map on tone change.',
                'If you prefer runtime tinting from albedoUntinted: work in LINEAR space; tint = sRGBToLinear(tintColor); f = abs(tintScale) * tintMask.r; '
                'tinted = tintScale >= 0 ? albedo*tint : overlay(albedo, tint) where overlay(a,b) = a<0.5 ? 2ab : 1-2(1-a)(1-b); out = mix(albedo, tinted, f).',
                'Roughness: ORM.G (game skin is fairly rough, ORM.G mean 0.58-0.60). Metalness: 0 for skin (ORM.B ~0).',
                'Recommended three.js material: MeshPhysicalMaterial { map, normalMap, roughnessMap: orm, roughness: 1, metalness: 0, '
                'sheen: 0.25, sheenRoughness: 0.6, sheenColor: #ffb4a0, (optional) transmission 0 + thickness, envMapIntensity 0.6 }. '
                'Optional SSS approximation: onBeforeCompile wrap-lighting (wrap 0.35, subsurface tint #c8442a).',
                'detailMask (B channel of the game roughness texture, grayscale) marks where micro-detail normals apply; optional.',
                'Game skin params: DetailNormalInfluence 0.8, MicroDetailInfluence 0.8, MicroDetailUVScale01 45 (body) / 20 (arms), DetailRoughnessBiasMin 1, DetailRoughnessBiasMax 0.93.',
            ],
        },
        'personalLink': {
            'shader': 'standard', 'baseColor': rel(pl['albedo']), 'orm': rel(pl['orm']), 'normal': rel(pl['normal']),
            'meanAlbedoSRGB': pl['meanAlbedoSRGB'], 'meanRoughness': pl['meanRoughness'], 'meanMetalness': pl['meanMetalness'],
            'appliesTo': 'arm_l submesh 3',
        },
        'underwear': uw,
        'nails': {
            'appliesTo': '<g>_nails_l / <g>_nails_r submesh 0 (left and right use identical materials)',
            'suggestedDefault': 'a0_000_<g>_base__nails_beige',
            'shader': 'standard: map=albedo (sRGB), roughnessMap/metalnessMap=orm, normalMap=normal; multilayered bakes are glossy (roughness ~0.1-0.3) and often metallic.',
            'byGender': nails,
        },
    },
    'textures': textures,
    'tintMasks': {k: {'file': rel(v['file']), 'meanR': v['meanR'], 'channel': 'grayscale = game TintColorMask.R'} for k, v in skin['masks'].items()},
    'tones': tones,
    'headSkinColorToTone': headToTone,
    'defaultCharCreatorOutfit': {
        'pwa': ['pwa_body (hide submeshes 5,6,7)', 'pwa_legs_cs_flat', 'pwa_arm_l', 'pwa_arm_r', 'pwa_nails_l', 'pwa_nails_r', 'pwa_underwear_panties', 'pwa_underwear_bra'],
        'pma': ['pma_body', 'pma_arm_l', 'pma_arm_r', 'pma_nails_l', 'pma_nails_r', 'pma_underwear_boxers'],
        'defaultTone': '01_ca_pale',
    },
    'faceRig': face_rig,
    'animations': {
        'files': anim,
        'source': 'base/animations/ui/{female,male}/ui_{female,male}.anims (character-creator body animations, 71-bone woman_base/man_base rig).',
        'playbackNotes': [
            'Bind clips to the master skeleton by bone name (THREE.AnimationMixer on the root that holds the rebuilt bones).',
            'Apply rotation tracks for all bones; apply translation ONLY for Root and Hips (other rig bone offsets differ by a few cm from the mesh bind: T-pose rig vs A-pose mesh bind).',
            'Drop scale tracks and tracks for Trajectory, reference_joint, WeaponLeft, WeaponRight (not in skeleton.json).',
            'Animation bone frames equal the mesh IBM frames (verified on Head/Neck), so rotations can be applied directly.',
            'Face/jaw/eyelid joints are not animated by these clips: drive them procedurally (faceRig).',
            'Suggested use: ui_fullbody_shot / UI_full_shot as idle, ui_closeup_shot_<part> when the camera zooms to that part, '
            'ui_expose_teeth while the Teeth tab is open (body nearly static; open the jaw procedurally, faceRig.<g>.jaw), '
            'ui_expose_hand_start -> _loop -> _end for the Nails tab, ui_fullbody_to_closeup / ui_closeup_to_fullbody for camera transitions, '
            'ui_check_boots/pants/jacket for clothing tabs.',
        ],
        'proceduralIdle': {
            'breathing': 'Spine1/Spine2/Spine3 rotate about bone-local axis matching world +X by +-0.8/0.6/0.5 deg, period 4.2 s; LeftShoulder/RightShoulder +-0.4 deg in phase.',
            'sway': 'Hips translate x +-4 mm, period 7.5 s; Spine counter-rotate 0.5 deg.',
            'headMicro': 'Head and Neck1 small noise: yaw +-1.5 deg, pitch +-1 deg, 0.15 Hz smoothed noise.',
            'eyes': 'saccades every 0.8-2.5 s, +-4 deg, 40 ms transition; blink per faceRig.',
        },
    },
    'tools': {
        'glbinfo': 'body/tools/glbinfo.mjs  (node glbinfo.mjs file.glb --joints [--json out.json]: meshes, morphs, and per joint: bind position/axes, parent, weighted vertex count (w>0.05), centroid, bbox)',
        'jointDumps': ['body/joints/head_pwa.joints.json', 'body/joints/head_pma.joints.json', 'body/joints/body_pwa.joints.json', 'body/joints/body_pma.joints.json'],
    },
    'limitations': [
        'Game textures for these assets are natively 1024x1024 (nails 512, tint masks 256); no higher resolution exists.',
        'Multilayered materials (nails, underwear, personal link) are baked approximations: microblends and per-layer normals ignored, layer colours from mltemplate overrides.',
        'Tint formula follows the WolvenKit Blender add-on reimplementation of skin.mt, not the original shader source.',
        'Facial .anims drive facialsetup pose tracks, not joints; WolvenKit exports only Neck/Head motion from them, so jaw/blink must be procedural.',
        'Female bra has no breast-size morph (only GarmentSupport).',
    ],
}

out = os.path.join(B, 'manifest.json')
json.dump(manifest, open(out, 'w'), indent=1)
tot = 0
cnt = 0
for root, _, files in os.walk(B):
    for f in files:
        tot += os.path.getsize(os.path.join(root, f)); cnt += 1
print('manifest', out, os.path.getsize(out), 'files', cnt, 'totalMB', round(tot / 1e6, 1))
print('nails', len(nails['pwa']), len(nails['pma']), 'clips', [len(anim[g]['clips']) for g in anim])
