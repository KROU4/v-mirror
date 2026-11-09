// Калибровка (только локально, нужны glb из tools/local/glb — выгружаются из игры
// скриптом tools/extract/export_heads.ps1, в репозиторий не попадают).
// Для каждого морфа (глаза/нос/рот/челюсть/уши) рендерим голову V с этим морфом,
// прогоняем через MediaPipe и сохраняем геометрические признаки в src/data/morphs.<g>.json.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { getIndex, type Gender } from '../../src/model/catalog';
import { computeFeatures, type Features } from '../../src/scan/faceFeatures';
import { detect } from '../../src/scan/landmarker';

const params = new URLSearchParams(location.search);
const gender = (params.get('g') === 'female' ? 'female' : 'male') as Gender;
const code = gender === 'male' ? 'pma' : 'pwa';
const FACING = -1;
const logEl = document.getElementById('log')!;
const log = (s: string) => {
  logEl.textContent += s + '\n';
  logEl.scrollTop = 1e9;
};

const canvas = document.getElementById('c') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color('#8a8f96');
const camera = new THREE.PerspectiveCamera(18, 1, 0.01, 100);
scene.add(new THREE.HemisphereLight('#ffffff', '#4a3c34', 1.4));
const key = new THREE.DirectionalLight('#ffffff', 2.2);
scene.add(key);
const fill = new THREE.DirectionalLight('#dde6ff', 0.6);
scene.add(fill);

const loader = new GLTFLoader();
const load = (f: string) => loader.loadAsync(`/tools/local/glb/${f}`);

type MorphMesh = THREE.Mesh & { morphTargetDictionary: Record<string, number>; morphTargetInfluences: number[] };
const morphMeshes: MorphMesh[] = [];

function prepare(root: THREE.Object3D, kind: 'head' | 'eyes' | 'brows') {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    let mat: THREE.Material;
    if (kind === 'head') mat = new THREE.MeshStandardMaterial({ color: '#c99a7c', roughness: 0.65 });
    else if (kind === 'brows') mat = new THREE.MeshStandardMaterial({ color: '#2a1d16', roughness: 0.9 });
    else {
      const vc = (m.geometry.getAttribute('position')?.count ?? 0) as number;
      if (vc < 400) {
        m.visible = false;
        return;
      }
      mat = new THREE.MeshStandardMaterial({ color: '#e9e4df', roughness: 0.3 });
      // радужка: темнее в центре — задаём по нормали «вперёд» через вершинные цвета
      const pos = m.geometry.getAttribute('position');
      const nrm = m.geometry.getAttribute('normal');
      const colors = new Float32Array(pos.count * 3);
      for (let i = 0; i < pos.count; i++) {
        const forward = nrm ? FACING * nrm.getZ(i) : 0;
        const t = THREE.MathUtils.smoothstep(forward, 0.86, 0.95);
        const p = THREE.MathUtils.smoothstep(forward, 0.975, 0.99);
        const c = new THREE.Color('#e9e4df').lerp(new THREE.Color('#4b3424'), t).lerp(new THREE.Color('#050505'), p);
        colors.set([c.r, c.g, c.b], i * 3);
      }
      m.geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      (mat as THREE.MeshStandardMaterial).vertexColors = true;
      (mat as THREE.MeshStandardMaterial).color.set('#ffffff');
    }
    m.material = mat;
    m.frustumCulled = false;
    if (m.morphTargetDictionary && m.morphTargetInfluences) morphMeshes.push(m as MorphMesh);
  });
}

const view = { dist: 1, h: 0.3, target: new THREE.Vector3() };
function setYaw(deg: number) {
  const a = THREE.MathUtils.degToRad(deg);
  const t = view.target;
  camera.position.set(t.x + Math.sin(a) * view.dist, t.y + view.h * 0.02, t.z + FACING * Math.cos(a) * view.dist);
  camera.lookAt(t);
}

async function setup() {
  const [head, eyes, brows] = await Promise.all([
    load(`h0_000_${code}__morphs.morphtarget.glb`),
    load(`he_000_${code}__morphs.morphtarget.glb`),
    load(`heb_000_${code}__morphs.morphtarget.glb`),
  ]);
  prepare(head.scene, 'head');
  prepare(eyes.scene, 'eyes');
  prepare(brows.scene, 'brows');
  scene.add(head.scene, eyes.scene, brows.scene);

  const box = new THREE.Box3().setFromObject(head.scene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  log(`bbox size ${size.toArray().map((x) => x.toFixed(3))} center ${center.toArray().map((x) => x.toFixed(3))}`);
  // В выгрузке WolvenKit лицо смотрит в -Z, вверх +Y. Кадрируем голову, как на портрете.
  const h = size.y;
  view.dist = (h * 0.62) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  view.target = new THREE.Vector3(center.x, box.max.y - h * 0.36, center.z);
  view.h = h;
  setYaw(0);
  const target = view.target;
  key.position.set(target.x + 0.6, target.y + 0.8, target.z + FACING * 1.5);
  fill.position.set(target.x - 1, target.y, target.z + FACING * 1);
  renderer.render(scene, camera);
  log(`morph meshes: ${morphMeshes.length}; targets: ${Object.keys(morphMeshes[0].morphTargetDictionary).length}`);
}

function applyMorph(morph: string | null) {
  for (const m of morphMeshes) {
    m.morphTargetInfluences.fill(0);
    if (!morph || morph === 'None') continue;
    const key = Object.keys(m.morphTargetDictionary).find((k) => k === morph || k.startsWith(morph + '_'));
    if (key !== undefined) m.morphTargetInfluences[m.morphTargetDictionary[key]] = 1;
  }
  renderer.render(scene, camera);
}

/**
 * Геометрия морфа по смещениям вершин головы: берём область, которую морф двигает
 * (|Δ| > 15% от максимума), и считаем, как меняются её размеры и положение.
 * forward — вперёд от лица, out — от центральной оси наружу (уши, скулы).
 */
function geometryStats(morph: string | null | undefined) {
  if (!morph || morph === 'None') return null;
  // Берём подмеш головы, в котором этот морф сдвигает вершины сильнее всего
  // (у женской головы морфы разных зон лежат в разных подмешах).
  const keyOf = (m: MorphMesh) => Object.keys(m.morphTargetDictionary).find((k) => k === morph || k.startsWith(morph + '_'));
  const strength = (m: MorphMesh) => {
    const k = keyOf(m);
    const d = k === undefined ? undefined : m.geometry.morphAttributes.position?.[m.morphTargetDictionary[k]];
    if (!d) return 0;
    let s = 0;
    for (let i = 0; i < d.count; i++) s += Math.hypot(d.getX(i), d.getY(i), d.getZ(i));
    return s;
  };
  const head = morphMeshes.map((m) => ({ m, s: strength(m) })).sort((a, b) => b.s - a.s)[0];
  if (!head || head.s === 0) return null;
  const key = keyOf(head.m)!;
  const headMesh = head.m;
  const pos = headMesh.geometry.getAttribute('position');
  const delta = headMesh.geometry.morphAttributes.position?.[headMesh.morphTargetDictionary[key]];
  if (!delta) return null;
  let maxD = 0;
  for (let i = 0; i < pos.count; i++) maxD = Math.max(maxD, Math.hypot(delta.getX(i), delta.getY(i), delta.getZ(i)));
  if (maxD === 0) return null;
  const parts = {
    all: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, dminX: Infinity, dmaxX: -Infinity, dminY: Infinity, dmaxY: -Infinity, fwd: 0, dy: 0, out: 0, n: 0 },
    center: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, dminX: Infinity, dmaxX: -Infinity, dminY: Infinity, dmaxY: -Infinity, fwd: 0, dy: 0, out: 0, n: 0 },
    side: { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, dminX: Infinity, dmaxX: -Infinity, dminY: Infinity, dmaxY: -Infinity, fwd: 0, dy: 0, out: 0, n: 0 },
  };
  for (let i = 0; i < pos.count; i++) {
    const dx = delta.getX(i), dy = delta.getY(i), dz = delta.getZ(i);
    if (Math.hypot(dx, dy, dz) < maxD * 0.15) continue;
    const x = pos.getX(i), y = pos.getY(i);
    for (const p of [parts.all, Math.abs(x) < 0.02 ? parts.center : parts.side]) {
      p.minX = Math.min(p.minX, x); p.maxX = Math.max(p.maxX, x);
      p.minY = Math.min(p.minY, y); p.maxY = Math.max(p.maxY, y);
      p.dminX = Math.min(p.dminX, x + dx); p.dmaxX = Math.max(p.dmaxX, x + dx);
      p.dminY = Math.min(p.dminY, y + dy); p.dmaxY = Math.max(p.dmaxY, y + dy);
      p.fwd += FACING * dz; p.dy += dy; p.out += Math.sign(x || 1) * dx; p.n++;
    }
  }
  const mm = (v: number) => Math.round(v * 10000) / 10; // метры -> мм, 0.1 мм
  const summarize = (p: typeof parts.all) =>
    p.n === 0
      ? null
      : {
          n: p.n,
          dWidth: mm((p.dmaxX - p.dminX) - (p.maxX - p.minX)),
          dHeight: mm((p.dmaxY - p.dminY) - (p.maxY - p.minY)),
          fwd: mm(p.fwd / p.n),
          up: mm(p.dy / p.n),
          out: mm(p.out / p.n),
          cy: mm((p.minY + p.maxY) / 2),
        };
  return { maxDelta: mm(maxD), all: summarize(parts.all), center: summarize(parts.center), side: summarize(parts.side) };
}

async function save(file: string, body: string) {
  const r = await fetch(`/__save?file=${encodeURIComponent(file)}`, { method: 'POST', body });
  if (!r.ok) throw new Error(`save ${file}: ${r.status}`);
}

async function measure(): Promise<Features | null> {
  const res = await detect(canvas);
  const lm = res.faceLandmarks[0];
  if (!lm) return null;
  return computeFeatures(lm, canvas.width, canvas.height);
}

const MORPH_SLOTS = ['eyes', 'nose', 'mouth', 'jaw', 'ear'] as const;

async function runAll() {
  const { slotById } = getIndex(gender);
  const out: Record<string, unknown> = { gender, generatedAt: new Date().toISOString(), slots: {} };
  applyMorph(null);
  const base = await measure();
  out.base = base;
  await save(`tools/local/renders/${gender}/base.png`, canvas.toDataURL('image/png'));
  log(`base: ${base ? 'ok' : 'НЕ НАЙДЕНО ЛИЦО'}`);
  for (const sid of MORPH_SLOTS) {
    const v = slotById.get(sid)!.variants[0];
    const rows = [];
    for (const o of v.options) {
      applyMorph(o.morph ?? null);
      const f = await measure();
      const nn = String(o.i + 1).padStart(2, '0');
      await save(`tools/local/renders/${gender}/${sid}_${nn}.png`, canvas.toDataURL('image/png'));
      if (sid === 'nose' || sid === 'jaw' || sid === 'ear' || sid === 'mouth') {
        setYaw(sid === 'ear' ? 80 : 65);
        renderer.render(scene, camera);
        await save(`tools/local/renders/${gender}/side_${sid}_${nn}.png`, canvas.toDataURL('image/png'));
        setYaw(0);
        renderer.render(scene, camera);
      }
      rows.push({ i: o.i, morph: o.morph, features: f, geo: geometryStats(o.morph) });
      log(`${sid} ${nn} ${o.morph}: ${f ? 'ok' : 'НЕТ ЛИЦА'}`);
    }
    (out.slots as Record<string, unknown>)[sid] = rows;
  }
  applyMorph(null);
  await save(`src/data/morphs.${gender}.json`, JSON.stringify(out, null, 1));
  log('Сохранено: src/data/morphs.' + gender + '.json');
  (window as unknown as { __done: boolean }).__done = true;
}

/**
 * Рендер причёсок: для каждого варианта слота «Причёска» надеваем меши из tools/local/hair
 * (соответствие meshHint -> меши пишет build_catalog.py в hint_meshes.json) и снимаем
 * анфас, 3/4 и затылок. По этим кадрам пишутся описания в src/data/hair.<g>.json.
 */
async function renderHairs() {
  const hint: Record<string, Record<string, string[]>> = await (await fetch('/tools/local/hair/hint_meshes.json')).json();
  const opts = getIndex(gender).slotById.get('hairstyle')!.variants[0].options;
  const hairMat = new THREE.MeshStandardMaterial({ color: '#3b2a20', roughness: 0.75, side: THREE.DoubleSide });
  const saved = { dist: view.dist, target: view.target.clone() };
  view.dist = saved.dist * 1.45;
  view.target = saved.target.clone().add(new THREE.Vector3(0, -view.h * 0.08, 0));
  const shots: [string, number][] = [['front', 0], ['q', 40], ['back', 180]];
  applyMorph(null);
  for (const o of opts) {
    const key = Array.isArray(o.meshHint) ? o.meshHint[0] : o.meshHint ?? '';
    const nn = String(o.i + 1).padStart(2, '0');
    const group = new THREE.Group();
    for (const m of hint[gender]?.[key] ?? []) {
      try {
        const g = await loader.loadAsync(`/tools/local/hair/${m}.glb`);
        g.scene.traverse((x) => {
          const mesh = x as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.material = hairMat;
            mesh.frustumCulled = false;
          }
        });
        group.add(g.scene);
      } catch {
        log(`нет ${m}.glb`);
      }
    }
    scene.add(group);
    for (const [name, yaw] of shots) {
      setYaw(yaw);
      renderer.render(scene, camera);
      await save(`tools/local/renders/${gender}/hair_${nn}_${name}.png`, canvas.toDataURL('image/png'));
    }
    scene.remove(group);
    log(`hair ${nn} ${key}: ${group.children.length} мешей`);
  }
  view.dist = saved.dist;
  view.target = saved.target;
  setYaw(0);
  renderer.render(scene, camera);
  (window as unknown as { __hairDone: boolean }).__hairDone = true;
}

document.getElementById('hair')?.addEventListener('click', () => renderHairs().catch((e) => log('ОШИБКА ' + e)));

document.getElementById('run')!.onclick = () => runAll().catch((e) => log('ОШИБКА ' + e));
document.getElementById('one')!.onclick = () => {
  const sid = (document.getElementById('slot') as HTMLInputElement).value;
  const i = +(document.getElementById('opt') as HTMLInputElement).value;
  const v = getIndex(gender).slotById.get(sid)?.variants[0];
  applyMorph(v?.options.find((o) => o.i === i)?.morph ?? null);
};

setup()
  .then(() => {
    log('готово к калибровке: ' + gender);
    (window as unknown as { __ready: boolean }).__ready = true;
    (window as unknown as { __runAll: () => Promise<void> }).__runAll = runAll;
    (window as unknown as { __renderHairs: () => Promise<void> }).__renderHairs = renderHairs;
  })
  .catch((e) => log('ОШИБКА загрузки: ' + e));
