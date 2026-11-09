// Готовит локальные ассеты MediaPipe (wasm + модель Face Landmarker), чтобы приложение
// работало без внешних CDN. Запускается автоматически перед dev/build.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDst = path.join(root, 'public', 'mediapipe', 'wasm');
const modelDst = path.join(root, 'public', 'mediapipe', 'face_landmarker.task');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

fs.mkdirSync(wasmDst, { recursive: true });
for (const f of fs.readdirSync(wasmSrc)) {
  const src = path.join(wasmSrc, f);
  const dst = path.join(wasmDst, f);
  if (!fs.existsSync(dst) || fs.statSync(dst).size !== fs.statSync(src).size) fs.copyFileSync(src, dst);
}

if (!fs.existsSync(modelDst)) {
  console.log('Скачиваю модель Face Landmarker…');
  const r = await fetch(MODEL_URL);
  if (!r.ok) throw new Error(`Не удалось скачать модель: ${r.status}`);
  fs.writeFileSync(modelDst, Buffer.from(await r.arrayBuffer()));
}
console.log('MediaPipe ассеты готовы:', path.relative(root, wasmDst), path.relative(root, modelDst));
