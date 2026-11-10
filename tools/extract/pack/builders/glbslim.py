"""Slimming of exported morph-target glb files (shared by the beard and face-decal builders).

three.js reads only position and normal deltas of morph targets, four bone influences and the
attributes a material samples, so the slim copy drops TANGENT deltas, all-zero targets, the
second joint set and (optionally) unused vertex attributes, and rebuilds the binary chunk.
"""
import json
import struct
from pathlib import Path

import numpy as np

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


def slim(src: Path, dst: Path, drop_attrs=(), sparse=False) -> dict:
    """sparse: morph deltas that move few vertices are stored as glTF sparse accessors."""
    j, bin_ = read_glb(src)
    dropped = 0
    for m in j['meshes']:
        names = (m.get('extras') or {}).get('targetNames')
        keep_idx = None
        for prim in m['primitives']:
            for att in ('JOINTS_1', 'WEIGHTS_1', *drop_attrs):
                prim['attributes'].pop(att, None)
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
    target_acc = {i for m in j['meshes'] for prim in m['primitives'] for t in prim.get('targets', []) for i in t.values()}
    remap, accessors, views, out = {}, [], [], bytearray()

    def view(data: bytes) -> int:
        while len(out) % 4:
            out.append(0)
        views.append({'buffer': 0, 'byteOffset': len(out), 'byteLength': len(data)})
        out.extend(data)
        return len(views) - 1

    for i in sorted(used):
        a = dict(j['accessors'][i])
        data = accessor_bytes(j, bin_, i)
        a.pop('byteOffset', None)
        rows = None
        if sparse and i in target_acc and a['componentType'] == 5126:
            arr = np.frombuffer(data, dtype=np.float32).reshape(a['count'], NCOMP[a['type']])
            rows = np.nonzero(np.abs(arr).max(1) > 1e-7)[0]
            if len(rows) > a['count'] * 0.6:
                rows = None
        if rows is not None:
            # glTF sparse accessor: zeros except the listed rows (three.js GLTFLoader reads it)
            idx_t = np.uint16 if a['count'] < 65536 else np.uint32
            a.pop('bufferView', None)
            a['sparse'] = {
                'count': len(rows),
                'indices': {'bufferView': view(rows.astype(idx_t).tobytes()), 'componentType': 5123 if idx_t is np.uint16 else 5125},
                'values': {'bufferView': view(np.ascontiguousarray(arr[rows]).tobytes())},
            }
            if not len(rows):
                a['sparse']['count'] = 1
                a['sparse']['indices']['bufferView'] = view(np.zeros(1, idx_t).tobytes())
                a['sparse']['values']['bufferView'] = view(np.zeros((1, arr.shape[1]), np.float32).tobytes())
        else:
            a['bufferView'] = view(data)
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
