// node glb_subset.mjs in.glb out.glb "<regex of animation names to keep>" [--rename-armature]
// Keeps nodes/skins/scenes, keeps only matching animations, repacks the binary buffer with only referenced accessors.
import fs from 'node:fs';
import { readGlb } from './glbinfo.mjs';
const [, , inp, out, rxs] = process.argv;
const rx = new RegExp(rxs);
const g = readGlb(inp);
const J = g.json;
J.animations = (J.animations || []).filter(a => rx.test(a.name));
const used = new Set();
for (const s of J.skins || []) if (s.inverseBindMatrices !== undefined) used.add(s.inverseBindMatrices);
for (const m of J.meshes || []) for (const p of m.primitives) { Object.values(p.attributes).forEach(a => used.add(a)); if (p.indices !== undefined) used.add(p.indices); (p.targets || []).forEach(t => Object.values(t).forEach(a => used.add(a))); }
for (const a of J.animations) for (const s of a.samplers) { used.add(s.input); used.add(s.output); }
const accMap = new Map();
const newAcc = [], newBV = [];
const chunks = [];
let off = 0;
for (const i of [...used].sort((a, b) => a - b)) {
  const a = J.accessors[i];
  const bv = J.bufferViews[a.bufferView];
  const start = (bv.byteOffset || 0);
  const bytes = g.bin.slice(start, start + bv.byteLength);
  const pad = (4 - (off % 4)) % 4;
  if (pad) { chunks.push(Buffer.alloc(pad)); off += pad; }
  const nbv = { buffer: 0, byteOffset: off, byteLength: bv.byteLength };
  if (bv.byteStride) nbv.byteStride = bv.byteStride;
  if (bv.target) nbv.target = bv.target;
  chunks.push(bytes); off += bytes.length;
  newBV.push(nbv);
  const na = { ...a, bufferView: newBV.length - 1 };
  newAcc.push(na);
  accMap.set(i, newAcc.length - 1);
}
for (const s of J.skins || []) if (s.inverseBindMatrices !== undefined) s.inverseBindMatrices = accMap.get(s.inverseBindMatrices);
for (const m of J.meshes || []) for (const p of m.primitives) {
  for (const k of Object.keys(p.attributes)) p.attributes[k] = accMap.get(p.attributes[k]);
  if (p.indices !== undefined) p.indices = accMap.get(p.indices);
  (p.targets || []).forEach(t => Object.keys(t).forEach(k => (t[k] = accMap.get(t[k]))));
}
for (const a of J.animations) for (const s of a.samplers) { s.input = accMap.get(s.input); s.output = accMap.get(s.output); }
J.accessors = newAcc; J.bufferViews = newBV;
let bin = Buffer.concat(chunks);
const bpad = (4 - (bin.length % 4)) % 4; if (bpad) bin = Buffer.concat([bin, Buffer.alloc(bpad)]);
J.buffers = [{ byteLength: bin.length }];
let js = Buffer.from(JSON.stringify(J), 'utf8');
const jpad = (4 - (js.length % 4)) % 4; if (jpad) js = Buffer.concat([js, Buffer.alloc(jpad, 0x20)]);
const total = 12 + 8 + js.length + 8 + bin.length;
const hdr = Buffer.alloc(12); hdr.writeUInt32LE(0x46546C67, 0); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(total, 8);
const jh = Buffer.alloc(8); jh.writeUInt32LE(js.length, 0); jh.writeUInt32LE(0x4E4F534A, 4);
const bh = Buffer.alloc(8); bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004E4942, 4);
fs.writeFileSync(out, Buffer.concat([hdr, jh, js, bh, bin]));
console.log(out, 'animations', J.animations.map(a => a.name).join(','), 'bytes', total);
