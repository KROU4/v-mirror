// Usage: node glbinfo.mjs file.glb [--joints] [--json out.json]
// Parses GLB (JSON + BIN), prints meshes/primitives/morphs/skins, and with --joints dumps
// joints, parents, bind world positions (from inverse bind matrices), per-joint weighted vertex
// counts (weight > 0.05) and weighted centroids + bbox.
import fs from 'node:fs';

export function readGlb(path) {
  const buf = fs.readFileSync(path);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + jsonLen).toString('utf8'));
  let off = 20 + jsonLen;
  let bin = null;
  if (off < buf.length) {
    const binLen = buf.readUInt32LE(off);
    bin = buf.slice(off + 8, off + 8 + binLen);
  }
  return { json, bin };
}

const COMP = { 5120: [Int8Array, 1], 5121: [Uint8Array, 1], 5122: [Int16Array, 2], 5123: [Uint16Array, 2], 5125: [Uint32Array, 4], 5126: [Float32Array, 4] };
const NUM = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

export function accessor(g, i) {
  const a = g.json.accessors[i];
  const bv = g.json.bufferViews[a.bufferView];
  const [T, size] = COMP[a.componentType];
  const n = NUM[a.type];
  const stride = bv.byteStride || size * n;
  const base = (bv.byteOffset || 0) + (a.byteOffset || 0);
  const out = new Float64Array(a.count * n);
  const dv = new DataView(g.bin.buffer, g.bin.byteOffset, g.bin.byteLength);
  for (let k = 0; k < a.count; k++) {
    for (let c = 0; c < n; c++) {
      const o = base + k * stride + c * size;
      let v;
      switch (a.componentType) {
        case 5126: v = dv.getFloat32(o, true); break;
        case 5125: v = dv.getUint32(o, true); break;
        case 5123: v = dv.getUint16(o, true); break;
        case 5121: v = dv.getUint8(o); break;
        case 5122: v = dv.getInt16(o, true); break;
        default: v = dv.getInt8(o);
      }
      if (a.normalized) {
        if (a.componentType === 5121) v /= 255; else if (a.componentType === 5123) v /= 65535;
      }
      out[k * n + c] = v;
    }
  }
  return { data: out, n, count: a.count };
}

function inv4(m) { // column-major 4x4 inverse (general)
  const a = m, inv = new Array(16);
  inv[0] = a[5]*a[10]*a[15]-a[5]*a[11]*a[14]-a[9]*a[6]*a[15]+a[9]*a[7]*a[14]+a[13]*a[6]*a[11]-a[13]*a[7]*a[10];
  inv[4] = -a[4]*a[10]*a[15]+a[4]*a[11]*a[14]+a[8]*a[6]*a[15]-a[8]*a[7]*a[14]-a[12]*a[6]*a[11]+a[12]*a[7]*a[10];
  inv[8] = a[4]*a[9]*a[15]-a[4]*a[11]*a[13]-a[8]*a[5]*a[15]+a[8]*a[7]*a[13]+a[12]*a[5]*a[11]-a[12]*a[7]*a[9];
  inv[12] = -a[4]*a[9]*a[14]+a[4]*a[10]*a[13]+a[8]*a[5]*a[14]-a[8]*a[6]*a[13]-a[12]*a[5]*a[10]+a[12]*a[6]*a[9];
  inv[1] = -a[1]*a[10]*a[15]+a[1]*a[11]*a[14]+a[9]*a[2]*a[15]-a[9]*a[3]*a[14]-a[13]*a[2]*a[11]+a[13]*a[3]*a[10];
  inv[5] = a[0]*a[10]*a[15]-a[0]*a[11]*a[14]-a[8]*a[2]*a[15]+a[8]*a[3]*a[14]+a[12]*a[2]*a[11]-a[12]*a[3]*a[10];
  inv[9] = -a[0]*a[9]*a[15]+a[0]*a[11]*a[13]+a[8]*a[1]*a[15]-a[8]*a[3]*a[13]-a[12]*a[1]*a[11]+a[12]*a[3]*a[9];
  inv[13] = a[0]*a[9]*a[14]-a[0]*a[10]*a[13]-a[8]*a[1]*a[14]+a[8]*a[2]*a[13]+a[12]*a[1]*a[10]-a[12]*a[2]*a[9];
  inv[2] = a[1]*a[6]*a[15]-a[1]*a[7]*a[14]-a[5]*a[2]*a[15]+a[5]*a[3]*a[14]+a[13]*a[2]*a[7]-a[13]*a[3]*a[6];
  inv[6] = -a[0]*a[6]*a[15]+a[0]*a[7]*a[14]+a[4]*a[2]*a[15]-a[4]*a[3]*a[14]-a[12]*a[2]*a[7]+a[12]*a[3]*a[6];
  inv[10] = a[0]*a[5]*a[15]-a[0]*a[7]*a[13]-a[4]*a[1]*a[15]+a[4]*a[3]*a[13]+a[12]*a[1]*a[7]-a[12]*a[3]*a[5];
  inv[14] = -a[0]*a[5]*a[14]+a[0]*a[6]*a[13]+a[4]*a[1]*a[14]-a[4]*a[2]*a[13]-a[12]*a[1]*a[6]+a[12]*a[2]*a[5];
  inv[3] = -a[1]*a[6]*a[11]+a[1]*a[7]*a[10]+a[5]*a[2]*a[11]-a[5]*a[3]*a[10]-a[9]*a[2]*a[7]+a[9]*a[3]*a[6];
  inv[7] = a[0]*a[6]*a[11]-a[0]*a[7]*a[10]-a[4]*a[2]*a[11]+a[4]*a[3]*a[10]+a[8]*a[2]*a[7]-a[8]*a[3]*a[6];
  inv[11] = -a[0]*a[5]*a[11]+a[0]*a[7]*a[9]+a[4]*a[1]*a[11]-a[4]*a[3]*a[9]-a[8]*a[1]*a[7]+a[8]*a[3]*a[5];
  inv[15] = a[0]*a[5]*a[10]-a[0]*a[6]*a[9]-a[4]*a[1]*a[10]+a[4]*a[2]*a[9]+a[8]*a[1]*a[6]-a[8]*a[2]*a[5];
  let det = a[0]*inv[0]+a[1]*inv[4]+a[2]*inv[8]+a[3]*inv[12];
  return inv.map(x => x / det);
}

export function analyze(path, wantJoints) {
  const g = readGlb(path);
  const J = g.json;
  const res = { file: path, nodes: J.nodes.length, meshes: [], skins: [], materials: (J.materials || []).map(m => m.name) };
  // overall bbox from POSITION accessor min/max
  for (const [mi, m] of (J.meshes || []).entries()) {
    const mesh = { name: m.name, primitives: [], targetNames: (m.extras && m.extras.targetNames) || null };
    for (const p of m.primitives) {
      const pa = J.accessors[p.attributes.POSITION];
      mesh.primitives.push({ verts: pa.count, tris: p.indices !== undefined ? J.accessors[p.indices].count / 3 : null, attrs: Object.keys(p.attributes), material: p.material !== undefined ? (J.materials[p.material] || {}).name : null, morphs: p.targets ? p.targets.length : 0, min: pa.min, max: pa.max });
    }
    res.meshes.push(mesh);
  }
  const meshNodes = J.nodes.map((n, i) => [i, n]).filter(([i, n]) => n.mesh !== undefined);
  res.meshNodes = meshNodes.map(([i, n]) => ({ node: i, name: n.name, mesh: n.mesh, skin: n.skin, t: n.translation, r: n.rotation, s: n.scale }));
  const parent = new Array(J.nodes.length).fill(-1);
  J.nodes.forEach((n, i) => (n.children || []).forEach(c => (parent[c] = i)));
  for (const [si, s] of (J.skins || []).entries()) {
    const sk = { name: s.name, joints: s.joints.length, skeleton: s.skeleton };
    if (wantJoints) {
      const ibm = accessor(g, s.inverseBindMatrices).data;
      const jl = [];
      const jointIndexOfNode = new Map(s.joints.map((nd, k) => [nd, k]));
      for (let k = 0; k < s.joints.length; k++) {
        const nd = s.joints[k];
        const m = Array.from(ibm.slice(k * 16, k * 16 + 16));
        const w = inv4(m); // joint world bind matrix
        const node = J.nodes[nd];
        jl.push({
          i: k, node: nd, name: node.name,
          parent: parent[nd] >= 0 ? J.nodes[parent[nd]].name : null,
          parentJoint: jointIndexOfNode.has(parent[nd]) ? jointIndexOfNode.get(parent[nd]) : -1,
          localT: node.translation || [0, 0, 0], localR: node.rotation || [0, 0, 0, 1],
          bindPos: [w[12], w[13], w[14]],
          bindAxes: { x: [w[0], w[1], w[2]], y: [w[4], w[5], w[6]], z: [w[8], w[9], w[10]] },
          count: 0, wsum: 0, c: [0, 0, 0], min: [1e9, 1e9, 1e9], max: [-1e9, -1e9, -1e9],
        });
      }
      // weights from all primitives of meshes using this skin
      for (const [ni, n] of meshNodes) {
        if (n.skin !== si) continue;
        for (const p of J.meshes[n.mesh].primitives) {
          const pos = accessor(g, p.attributes.POSITION).data;
          for (const set of [0, 1, 2]) {
            const ja = p.attributes['JOINTS_' + set], wa = p.attributes['WEIGHTS_' + set];
            if (ja === undefined) continue;
            const jd = accessor(g, ja).data, wd = accessor(g, wa).data;
            const cnt = pos.length / 3;
            for (let v = 0; v < cnt; v++) {
              for (let c = 0; c < 4; c++) {
                const wt = wd[v * 4 + c];
                if (wt <= 0.05) continue;
                const j = jl[jd[v * 4 + c]];
                if (!j) continue;
                const x = pos[v * 3], y = pos[v * 3 + 1], z = pos[v * 3 + 2];
                j.count++; j.wsum += wt; j.c[0] += wt * x; j.c[1] += wt * y; j.c[2] += wt * z;
                j.min = [Math.min(j.min[0], x), Math.min(j.min[1], y), Math.min(j.min[2], z)];
                j.max = [Math.max(j.max[0], x), Math.max(j.max[1], y), Math.max(j.max[2], z)];
              }
            }
          }
        }
      }
      for (const j of jl) {
        if (j.wsum > 0) j.c = j.c.map(x => x / j.wsum); else { j.c = null; j.min = null; j.max = null; }
      }
      sk.jointList = jl;
    }
    res.skins.push(sk);
  }
  return res;
}

if (process.argv[1] && process.argv[1].endsWith('glbinfo.mjs')) {
  const f = process.argv[2];
  const wantJ = process.argv.includes('--joints');
  const ji = process.argv.indexOf('--json');
  const r = analyze(f, wantJ);
  if (ji > 0) fs.writeFileSync(process.argv[ji + 1], JSON.stringify(r, null, 1));
  const r2 = JSON.parse(JSON.stringify(r));
  for (const s of r2.skins) if (s.jointList) s.jointList = s.jointList.length + ' joints (see json)';
  console.log(JSON.stringify(r2, (k, v) => (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v)));
}
