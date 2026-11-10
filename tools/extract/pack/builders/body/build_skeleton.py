"""Build a unified hierarchical skeleton per body gender (pwa/pma) in glTF space (Y-up, metres, character faces -Z).
Hierarchy: body deformation rig (player_*_base_deformations / fpp) + head face rig (h0_000_p?a_c__basehead_skeleton).
Bind world matrices: from glb inverse bind matrices (exact for skinning) when the joint is skinned in any exported glb;
otherwise derived from the parent's bind matrix and the rig local transform (with WolvenKit's per-bone axis correction)."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, os, sys, glob, math
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import rigtool
W = str(vmpaths.area('body'))
OUT = str(vmpaths.OUT / 'body')


def qmat(q):
    x, y, z, w = q
    return np.array([[1 - 2*(y*y + z*z), 2*(x*y - z*w), 2*(x*z + y*w)],
                     [2*(x*y + z*w), 1 - 2*(x*x + z*z), 2*(y*z - x*w)],
                     [2*(x*z - y*w), 2*(y*z + x*w), 1 - 2*(x*x + y*y)]])


def mat_q(m):
    t = m[0, 0] + m[1, 1] + m[2, 2]
    if t > 0:
        s = math.sqrt(t + 1) * 2
        return np.array([(m[2, 1] - m[1, 2]) / s, (m[0, 2] - m[2, 0]) / s, (m[1, 0] - m[0, 1]) / s, 0.25 * s])
    i = int(np.argmax([m[0, 0], m[1, 1], m[2, 2]]))
    if i == 0:
        s = math.sqrt(1 + m[0, 0] - m[1, 1] - m[2, 2]) * 2
        return np.array([0.25 * s, (m[0, 1] + m[1, 0]) / s, (m[0, 2] + m[2, 0]) / s, (m[2, 1] - m[1, 2]) / s])
    if i == 1:
        s = math.sqrt(1 + m[1, 1] - m[0, 0] - m[2, 2]) * 2
        return np.array([(m[0, 1] + m[1, 0]) / s, 0.25 * s, (m[1, 2] + m[2, 1]) / s, (m[0, 2] - m[2, 0]) / s])
    s = math.sqrt(1 + m[2, 2] - m[0, 0] - m[1, 1]) * 2
    return np.array([(m[0, 2] + m[2, 0]) / s, (m[1, 2] + m[2, 1]) / s, 0.25 * s, (m[1, 0] - m[0, 1]) / s])


def m4(R, t):
    M = np.eye(4); M[:3, :3] = R; M[:3, 3] = t; return M


RCORR = qmat((math.sqrt(0.5), 0, 0, math.sqrt(0.5)))  # local post-rotation +90deg about bone X (WolvenKit export)
ZUP2YUP = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float)

GLB_LOCAL = str(vmpaths.OUT / 'body' / 'glb')


def build(g):
    G = 'woman' if g == 'pwa' else 'man'
    body_rig = 'player_woman_base_deformations' if g == 'pwa' else 'player_man_fpp_deformations'
    head_rig = 'h0_000_%s_c__basehead_skeleton' % g
    bn, bp, bl, bms = rigtool.load(body_rig)
    hn, hp, hl, hms = rigtool.load(head_rig)
    # analysis jsons (IBM-derived) - produced by glbinfo.mjs
    srcs = sorted(glob.glob(os.path.join(W, 'an', '*%s*.json' % g)))
    ibm = {}
    for s in srcs:
        d = json.load(open(s))
        for j in d['skins'][0]['jointList']:
            R = np.array([j['bindAxes']['x'], j['bindAxes']['y'], j['bindAxes']['z']]).T
            M = m4(R, j['bindPos'])
            if j['name'] in ibm:
                diff = np.abs(ibm[j['name']][0] - M).max()
                if diff > 1e-3:
                    print('  WARN bind mismatch', j['name'], os.path.basename(s), round(float(diff), 4))
                ibm[j['name']][1].append(os.path.basename(s))
            else:
                ibm[j['name']] = [M, [os.path.basename(s)]]
    # hierarchy
    parent = {}
    local_rig = {}
    for names, par, loc in ((hn, hp, hl), (bn, bp, bl)):  # body rig overrides head rig for shared names
        for i, n in enumerate(names):
            parent[n] = names[par[i]] if par[i] >= 0 else None
            local_rig[n] = loc[i]
    order = []
    seen = set()
    def visit(n):
        if n in seen:
            return
        p = parent.get(n)
        if p:
            visit(p)
        seen.add(n); order.append(n)
    for n in parent:
        visit(n)
    world = {}
    for n in order:
        if n in ibm:
            world[n] = ibm[n][0]
            continue
        T, Q, S = local_rig[n]
        L = m4(qmat(Q), T)
        p = parent[n]
        if p is None:
            # root: rig model space -> gl, with axis correction
            world[n] = m4(ZUP2YUP @ qmat(Q) @ RCORR, ZUP2YUP @ np.array(T))
        else:
            C = m4(RCORR, [0, 0, 0])
            world[n] = world[p] @ np.linalg.inv(C) @ L @ C
    # verify derived (non-IBM) path against IBM for skinned joints (should agree for head, may differ for body pose)
    errs = []
    for n in order:
        p = parent[n]
        if n in ibm and p is not None:
            T, Q, S = local_rig[n]
            C = m4(RCORR, [0, 0, 0])
            est = world[p] @ np.linalg.inv(C) @ m4(qmat(Q), T) @ C
            errs.append((float(np.abs(est[:3, 3] - world[n][:3, 3]).max()), n))
    errs.sort(reverse=True)
    bones = []
    for n in order:
        Wm = world[n]
        p = parent[n]
        Lm = np.linalg.inv(world[p]) @ Wm if p else Wm
        bones.append({
            'name': n, 'parent': p, 'skinned': n in ibm, 'skinnedIn': ibm[n][1] if n in ibm else [],
            'bindPosition': [round(float(x), 6) for x in Wm[:3, 3]],
            'bindQuaternion': [round(float(x), 6) for x in mat_q(Wm[:3, :3])],
            'localPosition': [round(float(x), 6) for x in Lm[:3, 3]],
            'localQuaternion': [round(float(x), 6) for x in mat_q(Lm[:3, :3])],
        })
    return bones, world, parent, errs, ibm


def axis_local(world, n, axis_world):
    R = world[n][:3, :3]
    v = R.T @ np.array(axis_world, dtype=float)
    return [round(float(x), 5) for x in v / np.linalg.norm(v)]


def rot_about(p, pivot, axis, ang):
    k = np.array(axis, float); k /= np.linalg.norm(k)
    v = np.array(p) - pivot
    v2 = v * math.cos(ang) + np.cross(k, v) * math.sin(ang) + k * np.dot(k, v) * (1 - math.cos(ang))
    return pivot + v2


if __name__ == '__main__':
    report = {}
    for g in ('pwa', 'pma'):
        bones, world, parent, errs, ibm = build(g)
        print(g, 'bones', len(bones), 'skinned', sum(b['skinned'] for b in bones), 'top derived-vs-ibm pos errors', [(round(e, 4), n) for e, n in errs[:5]])
        # jaw / blink verification on head vertices
        head = json.load(open(os.path.join(W, 'an', 'head_%s.json' % g)))['skins'][0]['jointList']
        hj = {j['name']: j for j in head}
        jaw = 'mid_J_jaw_JNT'
        piv = world[jaw][:3, 3]
        lip_dn = np.array(hj['l_J_mug_lip_dn_0_JNT']['c'])
        out = {}
        for deg in (12, 15, 18):
            q = rot_about(lip_dn, piv, (1, 0, 0), -math.radians(deg))
            out['jaw_%d' % deg] = {'lowerLipCentroidMove_m': [round(float(x), 4) for x in (q - lip_dn)]}
        eye = world['l_J_eye_lid_up_root_1_JNT'][:3, 3]
        up = np.array(hj['l_J_eye_lid_up_rowA_1_JNT']['bindPos']); dn = np.array(hj['l_J_eye_lid_dn_rowA_1_JNT']['bindPos'])
        el = lambda p: math.degrees(math.atan2(p[1] - eye[1], -(p[2] - eye[2])))
        out['eyeCenter'] = [round(float(x), 4) for x in eye]
        out['upperLidElevationDeg'] = round(el(up), 2)
        out['lowerLidElevationDeg'] = round(el(dn), 2)
        up2 = np.array(hj['l_J_eye_lid_up_rowA_2_JNT']['bindPos']); dn2 = np.array(hj['l_J_eye_lid_dn_rowA_2_JNT']['bindPos'])
        out['upperLid2ElevationDeg'] = round(el(up2), 2); out['lowerLid2ElevationDeg'] = round(el(dn2), 2)
        rig_axes = {}
        for n in ('mid_J_jaw_JNT', 'jaw_root_JNT', 'l_J_eye_lid_up_root_1_JNT', 'l_J_eye_lid_up_root_2_JNT', 'r_J_eye_lid_up_root_1_JNT', 'r_J_eye_lid_up_root_2_JNT',
                  'l_J_eye_lid_dn_root_1_JNT', 'l_J_eye_lid_dn_root_2_JNT', 'r_J_eye_lid_dn_root_1_JNT', 'r_J_eye_lid_dn_root_2_JNT',
                  'l_J_eye_lid_up_rowA_0_JNT', 'l_J_eye_lid_up_rowA_3_JNT', 'r_J_eye_lid_up_rowA_0_JNT', 'r_J_eye_lid_up_rowA_3_JNT',
                  'l_J_eye_lid_up_rowA_1_JNT', 'l_J_eye_lid_up_rowA_2_JNT', 'r_J_eye_lid_up_rowA_1_JNT', 'r_J_eye_lid_up_rowA_2_JNT',
                  'l_J_eye_JNT', 'r_J_eye_JNT', 'Head', 'Neck', 'Neck1', 'Spine3'):
            rig_axes[n] = {'pivot': [round(float(x), 5) for x in world[n][:3, 3]], 'worldPlusX_inBoneLocalFrame': axis_local(world, n, (1, 0, 0)),
                           'worldPlusY_inBoneLocalFrame': axis_local(world, n, (0, 1, 0)), 'parent': parent[n], 'skinned': n in ibm}
        out['axes'] = rig_axes
        report[g] = out
        json.dump({'gender': g, 'space': 'glTF: Y-up, metres, +X = character left, character faces -Z (same space as WolvenKit glb exports of head/body)',
                   'hierarchySources': ['player_%s rig' % ('woman_base_deformations' if g == 'pwa' else 'man_fpp_deformations'), 'h0_000_%s_c__basehead_skeleton.rig' % g],
                   'bones': bones}, open(os.path.join(OUT, 'skeleton.%s.json' % g), 'w'), indent=0)
    json.dump(report, open(os.path.join(W, 'an', 'face_report.json'), 'w'), indent=1)
    print(json.dumps(report, indent=1)[:6000])
