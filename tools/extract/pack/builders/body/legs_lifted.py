"""C3: lifted_feet legs. In the game the female 'lifted_feet' option resolves to l0_000_base__full.app, whose component is the
full body morphtarget (t0_000_pwa_base__full) with chunkMask 0xFFFFFFFFFFFFFFE0 = render chunks 5,6,7 only.
So the lifted legs are body submeshes 5-7; write them as a standalone glb (same skeleton/skin, same layout as the cs_flat legs glb)
and register glb.pwa_legs_lifted + top-level legsLifted in body/manifest.json. Male has no feet options (no lifted variant)."""
import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, struct
from pathlib import Path
import numpy as np

LOCAL = vmpaths.OUT
SRC = LOCAL / "body/glb/t0_000_pwa_base__full.morphtarget.glb"
DST = LOCAL / "body/glb/l0_000_pwa_base__full_lifted.glb"
KEEP = [5, 6, 7]


def read(p):
    b = Path(p).read_bytes()
    n = struct.unpack_from("<I", b, 12)[0]
    j = json.loads(b[20:20 + n])
    bl = struct.unpack_from("<I", b, 20 + n)[0]
    return j, b[28 + n:28 + n + bl]


def write(p, j, chunks):
    bin_ = b"".join(chunks)
    bin_ += b"\0" * ((4 - len(bin_) % 4) % 4)
    j["buffers"] = [{"byteLength": len(bin_)}]
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(bin_)
    out = struct.pack("<III", 0x46546C67, 2, total) + struct.pack("<II", len(js), 0x4E4F534A) + js + struct.pack("<II", len(bin_), 0x004E4942) + bin_
    Path(p).write_bytes(out)
    return total


j, b = read(SRC)
mesh_nodes = {n["mesh"]: i for i, n in enumerate(j["nodes"]) if "mesh" in n}
drop_nodes = sorted(mesh_nodes[m] for m in range(len(j["meshes"])) if m not in KEEP)
assert drop_nodes == list(range(drop_nodes[0], drop_nodes[0] + len(drop_nodes))), "mesh nodes not contiguous"
# joint nodes must all precede the dropped mesh nodes so their indices stay valid
assert all(jt < drop_nodes[0] for s in j["skins"] for jt in s["joints"])
remap_node = {}
nodes = []
for i, n in enumerate(j["nodes"]):
    if i in drop_nodes:
        continue
    remap_node[i] = len(nodes)
    nodes.append(n)
new_meshes = []
for k, mi in enumerate(KEEP):
    m = j["meshes"][mi]
    m = dict(m, name=f"submesh_{k:02d}_LOD_1", extras=dict(m.get("extras", {}), sourceSubmesh=f"submesh_{mi:02d}_LOD_1"))
    new_meshes.append(m)
for n in nodes:
    if "mesh" in n:
        k = KEEP.index(n["mesh"])
        n["mesh"] = k
        n["name"] = f"submesh_{k:02d}_LOD_1"
    if "children" in n:
        n["children"] = [remap_node[c] for c in n["children"] if c in remap_node]
for s in j["scenes"]:
    s["nodes"] = [remap_node[x] for x in s["nodes"] if x in remap_node]
for s in j["skins"]:
    s["joints"] = [remap_node[x] for x in s["joints"]]
    if "skeleton" in s:
        s["skeleton"] = remap_node[s["skeleton"]]
j["nodes"] = nodes
j["meshes"] = new_meshes

used = set()
for s in j["skins"]:
    if "inverseBindMatrices" in s:
        used.add(s["inverseBindMatrices"])
for m in j["meshes"]:
    for p in m["primitives"]:
        used |= set(p["attributes"].values())
        if "indices" in p:
            used.add(p["indices"])
        for t in p.get("targets", []):
            used |= set(t.values())
amap, accs, bvs, chunks, off = {}, [], [], [], 0
for i in sorted(used):
    a = j["accessors"][i]
    bv = j["bufferViews"][a["bufferView"]]
    data = b[bv.get("byteOffset", 0):bv.get("byteOffset", 0) + bv["byteLength"]]
    pad = (4 - off % 4) % 4
    if pad:
        chunks.append(b"\0" * pad)
        off += pad
    nbv = {"buffer": 0, "byteOffset": off, "byteLength": bv["byteLength"]}
    for k in ("byteStride", "target"):
        if k in bv:
            nbv[k] = bv[k]
    chunks.append(data)
    off += len(data)
    bvs.append(nbv)
    accs.append(dict(a, bufferView=len(bvs) - 1))
    amap[i] = len(accs) - 1
for s in j["skins"]:
    if "inverseBindMatrices" in s:
        s["inverseBindMatrices"] = amap[s["inverseBindMatrices"]]
for m in j["meshes"]:
    for p in m["primitives"]:
        p["attributes"] = {k: amap[v] for k, v in p["attributes"].items()}
        if "indices" in p:
            p["indices"] = amap[p["indices"]]
        p["targets"] = [{k: amap[v] for k, v in t.items()} for t in p.get("targets", [])]
j["accessors"], j["bufferViews"] = accs, bvs
j.pop("animations", None)
size = write(DST, j, chunks)

# ---- verify round trip: positions of the new glb == source submeshes 5..7 ----
def pos(jj, bb, mi):
    a = jj["accessors"][jj["meshes"][mi]["primitives"][0]["attributes"]["POSITION"]]
    bv = jj["bufferViews"][a["bufferView"]]
    return np.frombuffer(bb, np.float32, count=a["count"] * 3, offset=bv.get("byteOffset", 0) + a.get("byteOffset", 0)).reshape(-1, 3)


j2, b2 = read(DST)
j0, b0 = read(SRC)
for k, mi in enumerate(KEEP):
    assert np.array_equal(pos(j2, b2, k), pos(j0, b0, mi)), k
print("wrote", DST.name, size, "bytes; meshes", [m["name"] for m in j2["meshes"]], "nodes", len(j2["nodes"]), "joints", len(j2["skins"][0]["joints"]))

# ---- male check: heel/toe heights of the male body feet ----
jm, bm = read(LOCAL / "body/glb/t0_000_pma_base__full.glb")
low = []
for mi in range(len(jm["meshes"])):
    P = pos(jm, bm, mi)
    if P[:, 1].min() < 0.05:
        back = P[P[:, 2] > np.percentile(P[:, 2], 95)]
        front = P[P[:, 2] < np.percentile(P[:, 2], 5)]
        low.append((jm["meshes"][mi]["name"], round(float(back[:, 1].min()), 4), round(float(front[:, 1].min()), 4)))
print("male feet submeshes (name, heel minY, toes minY):", low)

# ---- manifest ----
MF = LOCAL / "body/manifest.json"
man = json.loads(MF.read_text(encoding="utf-8"))
flat = man["glb"]["pwa_legs_cs_flat"]
entry = {
    "file": "body/glb/l0_000_pwa_base__full_lifted.glb",
    "bytes": size,
    "gender": "pwa",
    "role": "female char-creator legs with LIFTED feet (heel ~5.8 cm off the ground, toes down; calves, ankles, feet) replacing body submeshes 5-7",
    "submeshes": [
        {"index": 0, "role": "calves", "material": "skin:pwa_body"},
        {"index": 1, "role": "ankles/lower shins", "material": "skin:pwa_body"},
        {"index": 2, "role": "feet (lifted heel)", "material": "skin:pwa_body"},
    ],
    "morphTargets": ["t0_000_wa_base__full_breast_small_breast", "t0_000_wa_base__full_breast_big_breast"],
}
assert set(entry) == set(flat), (set(entry) ^ set(flat))
man["glb"]["pwa_legs_lifted"] = entry
man["legsLifted"] = {
    "pwa": entry,
    "pma": None,
    "notes": [
        "Game: female inkcharcustomization body options 'lifted_feet' (index 1200) -> l0_000_base__full.app and 'flat_feet' (1210) -> l0_000_base__cs_flat.app; "
        "both are hidden, linked to 'skin color' (one appearance per skin tone: l0_000_pwa_base__<tone>, meshAppearance = <tone>).",
        "l0_000_base__full.app is NOT a separate legs mesh: its component is t0_000_pwa_base__full.morphtarget with chunkMask 0xFFFFFFFFFFFFFFE0 "
        "(render chunks 5,6,7). body/glb/l0_000_pwa_base__full_lifted.glb is exactly those 3 submeshes cut out of body/glb/t0_000_pwa_base__full.morphtarget.glb "
        "(positions verified bit-identical), with the same flat 167-joint skin as every other body glb (rebind with skeleton.pwa.json).",
        "Use it exactly like glb.pwa_legs_cs_flat: show pwa_body with submeshes 5,6,7 hidden + this glb. Equivalent alternative: simply keep pwa_body submeshes 5-7 visible.",
        "Textures per skin tone: the lifted legs use the body skin material (skin:pwa_body), same UV layout as the cs_flat legs -> textures.pwa_body.albedoByTone[tone] "
        "(and the pwa_body normal/orm/detail maps). No separate leg textures exist in the game.",
        "Morph targets are the body's breast morphs (zero displacement on legs); set them to the same influences as pwa_body or ignore them.",
        "Geometry vs cs_flat: same vertex counts (260/396/848) and UV0; calves identical (<2 mm), ankles/feet differ: lifted heel minY 0.058 m / toes 0.010 m vs flat heel 0.015 m / toes 0.027 m.",
        "pma: the male inkcharcustomization has no lifted_feet / flat_feet options and no legs component: the male body t0_000_pma_base__full always shows its own feet (no lifted variant exists).",
        "research/cc_behaviour.md: the creator uses lifted_feet by default (character_creation group); flat_feet is the alternative.",
    ],
}
MF.write_text(json.dumps(man, indent=1, ensure_ascii=False), encoding="utf-8")
print("manifest updated")
