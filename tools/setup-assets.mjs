// Prepares the local MediaPipe assets (wasm + Face Landmarker model) so the app works without
// third-party CDNs. Runs automatically before dev and build.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = path.join(root, 'public', 'mediapipe', 'wasm');
const modelDst = path.join(root, 'public', 'mediapipe', 'face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
/** SHA-256 of face_landmarker.task (float16, version 1): the model ships to every visitor. */
export const MODEL_SHA256 = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff';
/**
 * src/scan/landmarker.core.ts loads only the ES-module pair: it works in the module Web Worker
 * and on the main thread alike (the classic vision_wasm_internal pair is unused).
 */
const WASM_FILES = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

fs.mkdirSync(wasmDst, { recursive: true });
for (const f of fs.readdirSync(wasmDst)) if (!WASM_FILES.includes(f)) fs.rmSync(path.join(wasmDst, f));
for (const f of WASM_FILES) {
  const src = path.join(wasmSrc, f);
  const dst = path.join(wasmDst, f);
  if (!fs.existsSync(src)) throw new Error(`${src} is missing: run npm install`);
  // Content, not size: in CI public/mediapipe comes back from a cache, and a same-size
  // modified loader or wasm must not ship
  if (!fs.existsSync(dst) || sha256(fs.readFileSync(dst)) !== sha256(fs.readFileSync(src))) fs.copyFileSync(src, dst);
}

if (fs.existsSync(modelDst) && sha256(fs.readFileSync(modelDst)) !== MODEL_SHA256) {
  console.warn('face_landmarker.task does not match the pinned SHA-256: downloading it again');
  fs.rmSync(modelDst);
}
if (!fs.existsSync(modelDst)) {
  console.log('Downloading the Face Landmarker model…');
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`Model download failed: HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const got = sha256(buf);
  if (got !== MODEL_SHA256) throw new Error(`face_landmarker.task SHA-256 mismatch: expected ${MODEL_SHA256}, got ${got}`);
  fs.writeFileSync(modelDst, buf);
}
console.log('MediaPipe assets ready:', path.relative(root, wasmDst), path.relative(root, modelDst));
