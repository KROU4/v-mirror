import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json
from pathlib import Path

W = vmpaths.area('face')
STATE = json.loads((W / "state.json").read_text(encoding="utf-8"))
_cache = {}


def v(x):
    if isinstance(x, dict):
        if "$value" in x:
            return x["$value"]
        if "DepotPath" in x:
            return v(x["DepotPath"])
    return x


def load(depot):
    k = depot.lower()
    if k in _cache:
        return _cache[k]
    st = STATE.get(k)
    if not st or "json" not in st:
        _cache[k] = None
        return None
    d = json.loads((W / st["json"]).read_text(encoding="utf-8"))["Data"]["RootChunk"]
    _cache[k] = d
    return d


def conv(val):
    if isinstance(val, dict):
        t = val.get("$type")
        if "DepotPath" in val:
            return v(val["DepotPath"])
        if t == "Color":
            return "#%02x%02x%02x" % (val["Red"], val["Green"], val["Blue"]) + ("" if val.get("Alpha", 255) == 255 else "@a=%d" % val["Alpha"])
        if t == "Vector4":
            return [val.get("X"), val.get("Y"), val.get("Z"), val.get("W")]
        if t == "HDRColor":
            return {"rgba": [val.get("Red"), val.get("Green"), val.get("Blue"), val.get("Alpha")]}
        if "$value" in val:
            return val["$value"]
        return {k: conv(x) for k, x in val.items() if k != "$type"}
    return val


def params_of(mat):
    out = {}
    for p in mat.get("values") or []:
        for k, val in p.items():
            if k == "$type":
                continue
            out[k] = conv(val)
    return out


def mt_defaults(mt):
    """parameters of .mt: list of handles in 'parameters' arrays"""
    d = load(mt)
    out = {}
    if not d:
        return out
    ps = d.get("parameters", []) or []
    if isinstance(ps, dict):
        ps = ps.get("Elements", [])
    for grp in ps:
        for h in grp or []:
            hd = h.get("Data") if isinstance(h, dict) else None
            if not hd:
                continue
            name = v(hd.get("parameterName"))
            for key in ("texture", "scalar", "color", "vector", "gradient", "mlsetup", "mlmask", "hairProfile", "skinProfile", "cube", "enumValue", "multilayerMask", "multilayerSetup"):
                if key in hd:
                    out[name] = conv(hd[key])
                    break
            else:
                rest = {k: conv(x) for k, x in hd.items() if k not in ("$type", "parameterName", "register")}
                out[name] = rest
    return out


def resolve(mat_or_path, with_defaults=True):
    """returns (chain, final_template, params) - params merged child-over-parent"""
    chain = []
    layers = []
    if isinstance(mat_or_path, str):
        cur = load(mat_or_path)
        chain.append(mat_or_path)
    else:
        cur = mat_or_path
        chain.append("<local>")
    tmpl = None
    while cur is not None:
        layers.append(params_of(cur))
        base = v(cur.get("baseMaterial"))
        if not base:
            break
        chain.append(base)
        if base.lower().endswith((".mt", ".remt")):
            tmpl = base
            break
        cur = load(base)
        if cur is None:
            chain.append("<unresolved>")
            break
    params = {}
    if tmpl and with_defaults:
        for k, x in mt_defaults(tmpl).items():
            params[k] = x
    for lay in reversed(layers):
        params.update(lay)
    return chain, tmpl, params


def mesh_info(depot):
    d = load(depot)
    apps = {}
    for a in d.get("appearances", []):
        ad = a.get("Data") or a
        apps[v(ad["name"])] = [v(c) for c in ad.get("chunkMaterials", [])]
    ents = {}
    locs = (d.get("localMaterialBuffer") or {}).get("materials") or []
    pre = d.get("preloadLocalMaterialInstances") or []
    ext = [v(x) for x in d.get("externalMaterials") or []]
    for e in d.get("materialEntries", []):
        name = v(e["name"])
        idx = e["index"]
        if e.get("isLocalInstance"):
            if locs:
                m = locs[idx]
            else:
                m = pre[idx].get("Data") or pre[idx]
            ents[name] = m
        else:
            ents[name] = ext[idx]
    return apps, ents, d
