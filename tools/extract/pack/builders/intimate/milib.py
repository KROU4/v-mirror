import sys, os; sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))  # noqa: E401,E702
import vmpaths  # noqa: E402
import json, os

W = str(vmpaths.area('intimate'))
ROOTS = [os.path.join(W, d) for d in ('mijson', 'mjson', 'extjson')]

INDEX = {}
for r in ROOTS:
    if not os.path.isdir(r):
        continue
    for dp, dn, fn in os.walk(r):
        for f in fn:
            if f.endswith('.json'):
                full = os.path.join(dp, f)
                rel = os.path.relpath(full, r)[:-5].lower()
                INDEX[rel] = full


def val(v):
    if isinstance(v, dict):
        if 'DepotPath' in v:
            return v['DepotPath'].get('$value')
        if '$value' in v:
            return v['$value']
        if 'Red' in v:
            return '#%02x%02x%02x' % (v['Red'], v['Green'], v['Blue']) + ('' if v.get('Alpha', 255) == 255 else '/a%d' % v['Alpha'])
        if 'X' in v:
            return [v.get(k) for k in ('X', 'Y', 'Z', 'W') if k in v]
        return {k: val(x) for k, x in v.items() if k != '$type'}
    if isinstance(v, list):
        return [val(x) for x in v]
    return v


def params_of(mi):
    out = {}
    for p in mi.get('values', []):
        for k, v in p.items():
            if k == '$type':
                continue
            out[k] = val(v)
    return out


def load_mi(depot):
    p = INDEX.get(depot.lower())
    if not p:
        return None
    d = json.load(open(p, encoding='utf-8'))
    return d['Data']['RootChunk']


def resolve(depot_or_obj, chain=None):
    """Return (merged params, chain list, final template)."""
    chain = chain or []
    if isinstance(depot_or_obj, str):
        if depot_or_obj.endswith(('.mt', '.remt')):
            return {}, chain + [depot_or_obj], depot_or_obj
        obj = load_mi(depot_or_obj)
        chain = chain + [depot_or_obj]
        if obj is None:
            return {}, chain + ['<MISSING>'], None
    else:
        obj = depot_or_obj
        chain = chain + ['<local>']
    own = params_of(obj)
    base = val(obj.get('baseMaterial'))
    if base:
        parent, chain2, tmpl = resolve(base, chain)
    else:
        parent, chain2, tmpl = {}, chain, None
    merged = dict(parent)
    merged.update(own)
    return merged, chain2, tmpl
