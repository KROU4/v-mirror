"""Load CP2077 .rig JSON (WolvenKit serialize), compute model-space bind transforms and convert to glTF space
(Y-up, character facing -Z, as WolvenKit glb export): gl = (x, z, -y)."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, os, glob, math
R = str(vmpaths.area('body') / 'rigjson')


def qmul(a, b):  # (x,y,z,w)
    ax, ay, az, aw = a; bx, by, bz, bw = b
    return (aw*bx + ax*bw + ay*bz - az*by, aw*by - ax*bz + ay*bw + az*bx, aw*bz + ax*by - ay*bx + az*bw, aw*bw - ax*bx - ay*by - az*bz)


def qrot(q, v):
    x, y, z, w = q
    vx, vy, vz = v
    # v' = q v q*
    ix = w*vx + y*vz - z*vy; iy = w*vy + z*vx - x*vz; iz = w*vz + x*vy - y*vx; iw = -x*vx - y*vy - z*vz
    return (ix*w + iw*-x + iy*-z - iz*-y, iy*w + iw*-y + iz*-x - ix*-z, iz*w + iw*-z + ix*-y - iy*-x)


def load(name):
    f = glob.glob(R + r'\**\%s.rig.json' % name, recursive=True)[0]
    d = json.load(open(f, encoding='utf-8'))['Data']['RootChunk']
    names = [b['$value'] for b in d['boneNames']]
    par = d['boneParentIndexes']
    loc = []
    for t in d['boneTransforms']:
        T = (t['Translation']['X'], t['Translation']['Y'], t['Translation']['Z'])
        Q = (t['Rotation']['i'], t['Rotation']['j'], t['Rotation']['k'], t['Rotation']['r'])
        S = (t['Scale']['X'], t['Scale']['Y'], t['Scale']['Z'])
        loc.append((T, Q, S))
    ms = [None] * len(names)
    for i in range(len(names)):
        T, Q, S = loc[i]
        p = par[i]
        if p < 0:
            ms[i] = (T, Q)
        else:
            pT, pQ = ms[p]
            r = qrot(pQ, T)
            ms[i] = ((pT[0] + r[0], pT[1] + r[1], pT[2] + r[2]), qmul(pQ, Q))
    return names, par, loc, ms


def to_gl(p):
    return (p[0], p[2], -p[1])


QZUP_TO_YUP = (-math.sqrt(0.5), 0, 0, math.sqrt(0.5))  # rotation -90deg about X: (x,y,z)->(x,z,-y)


def q_to_gl(q):
    return qmul(QZUP_TO_YUP, q)
