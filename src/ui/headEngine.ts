// 3D-голова V из мешей игры (tools/local, отдаются по /game/...). Модуль грузится
// лениво: three.js и GLTFLoader попадают в отдельный чанк и только когда меши есть.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { Gender } from '../model/catalog';

/** В выгрузке WolvenKit лицо смотрит в -Z, вверх +Y. */
const FACING = -1;
const CODE: Record<Gender, string> = { male: 'pma', female: 'pwa' };

export interface HeadLook {
  gender: Gender;
  /** имена blendshape, которые надо включить (морфы глаз, носа, рта, челюсти, ушей) */
  morphs: string[];
  skin?: string;
  hair?: string;
  brows?: string;
  iris?: string;
  lashes?: string;
  /** имена glb из /game/hair без расширения */
  hairMeshes: string[];
}

type MorphMesh = THREE.Mesh & { morphTargetDictionary: Record<string, number>; morphTargetInfluences: number[] };

interface HeadRig {
  root: THREE.Group;
  morphMeshes: MorphMesh[];
  skin: THREE.MeshStandardMaterial;
  brows: THREE.MeshStandardMaterial;
  lashes: THREE.MeshStandardMaterial;
  /** меши глаз и веса радужки/зрачка по вершинам — чтобы перекрашивать без пересборки */
  eyes: { mesh: THREE.Mesh; iris: Float32Array; pupil: Float32Array }[];
  target: THREE.Vector3;
  dist: number;
}

const loader = new GLTFLoader();
const sceneCache = new Map<string, Promise<THREE.Group>>();
function loadScene(url: string): Promise<THREE.Group> {
  let p = sceneCache.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => g.scene);
    p.catch(() => sceneCache.delete(url));
    sceneCache.set(url, p);
  }
  return p;
}

const SCLERA = new THREE.Color('#e9e4df');
const PUPIL = new THREE.Color('#050505');
const safe = (hex: string | undefined, fallback: string) => (/^#[0-9a-f]{6}$/i.test(hex ?? '') ? hex! : fallback);

export class HeadEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(16, 1, 0.01, 100);
  private rigs: Partial<Record<Gender, Promise<HeadRig>>> = {};
  private rig: HeadRig | null = null;
  private hair = new THREE.Group();
  private hairMat = new THREE.MeshStandardMaterial({ color: '#3b2a20', roughness: 0.62, metalness: 0, side: THREE.DoubleSide });
  private hairKey = '';
  private yaw = 0;
  private token = 0;
  private lights: { key: THREE.DirectionalLight; rimL: THREE.DirectionalLight; rimR: THREE.DirectionalLight; fill: THREE.DirectionalLight };
  disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setClearColor(0x000000, 0);
    // Свет как в редакторе игры: тёплый ключевой спереди, красный и бирюзовый контровые сзади
    this.scene.add(new THREE.HemisphereLight('#ffe9e0', '#1a1416', 0.9));
    const key = new THREE.DirectionalLight('#fff1e6', 2.4);
    const fill = new THREE.DirectionalLight('#ffd2c8', 0.5);
    const rimL = new THREE.DirectionalLight('#ff3347', 0.9);
    const rimR = new THREE.DirectionalLight('#46d9ff', 1.8);
    this.scene.add(key, fill, rimL, rimR, this.hair);
    this.lights = { key, fill, rimL, rimR };
  }

  private async buildRig(gender: Gender): Promise<HeadRig> {
    const c = CODE[gender];
    const [head, eyes, brows] = await Promise.all([
      loadScene(`/game/glb/h0_000_${c}__morphs.morphtarget.glb`),
      loadScene(`/game/glb/he_000_${c}__morphs.morphtarget.glb`),
      loadScene(`/game/glb/heb_000_${c}__morphs.morphtarget.glb`),
    ]);
    const skin = new THREE.MeshStandardMaterial({ color: '#c99a7c', roughness: 0.58, metalness: 0 });
    // Брови — карточки без текстуры-маски: полупрозрачность смягчает «плашку»
    const browsMat = new THREE.MeshStandardMaterial({ color: '#2a1d16', roughness: 0.95, transparent: true, opacity: 0.78, depthWrite: false });
    const lashes = new THREE.MeshStandardMaterial({ color: '#141010', roughness: 0.8, side: THREE.DoubleSide });
    const rig: HeadRig = { root: new THREE.Group(), morphMeshes: [], skin, brows: browsMat, lashes, eyes: [], target: new THREE.Vector3(), dist: 1 };
    // В меше глаз: двусторонние карточки ресниц («doubled»), глазные яблоки (самый крупный
    // из остальных подмешей — передние полусферы) и мелкие тени/слёзная линия
    let eyeball: THREE.Object3D | null = null;
    let best = 0;
    eyes.traverse((o) => {
      const m = o as THREE.Mesh;
      const n = m.isMesh ? m.geometry.getAttribute('position')?.count ?? 0 : 0;
      if (n > best && !/doubled/i.test(m.name)) (best = n), (eyeball = m);
    });
    const take = (root: THREE.Object3D, kind: 'head' | 'eyes' | 'brows') => {
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.frustumCulled = false;
        if (kind === 'head') m.material = skin;
        else if (kind === 'brows') m.material = browsMat;
        else {
          const pos = m.geometry.getAttribute('position');
          if (m !== eyeball) {
            if (/doubled/i.test(m.name)) {
              m.material = lashes;
              // ресницы двигаются вместе с веками — им нужны те же морфы глаз
              if (m.morphTargetDictionary && m.morphTargetInfluences) rig.morphMeshes.push(m as MorphMesh);
            } else m.visible = false;
            return;
          }
          // Радужка и зрачок — по нормали «вперёд» (текстур глаз в выгрузке нет)
          const nrm = m.geometry.getAttribute('normal');
          const iris = new Float32Array(pos.count);
          const pupil = new Float32Array(pos.count);
          for (let i = 0; i < pos.count; i++) {
            const forward = nrm ? FACING * nrm.getZ(i) : 0;
            iris[i] = THREE.MathUtils.smoothstep(forward, 0.86, 0.95);
            pupil[i] = THREE.MathUtils.smoothstep(forward, 0.975, 0.99);
          }
          m.geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(pos.count * 3), 3));
          m.material = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.25, vertexColors: true });
          rig.eyes.push({ mesh: m, iris, pupil });
        }
        if (m.morphTargetDictionary && m.morphTargetInfluences) rig.morphMeshes.push(m as MorphMesh);
      });
    };
    take(head, 'head');
    take(eyes, 'eyes');
    take(brows, 'brows');
    rig.root.add(head, eyes, brows);
    // Кадр как в игре и одинаковый для обоих тел: от уровня глаз, а не от габаритов меша
    // (у мужской головы в выгрузке длиннее шея). Центр вращения — середина головы за глазами.
    const eyeBox = new THREE.Box3().setFromObject(eyes);
    const eye = eyeBox.getCenter(new THREE.Vector3());
    rig.target.set(eye.x, eye.y + 0.012, eye.z - FACING * 0.085);
    rig.dist = 0.205 / Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    return rig;
  }

  private rigFor(gender: Gender): Promise<HeadRig> {
    let p = this.rigs[gender];
    if (!p) {
      p = this.buildRig(gender);
      p.catch(() => delete this.rigs[gender]);
      this.rigs[gender] = p;
    }
    return p;
  }

  /**
   * Применяет внешний вид. Последний вызов побеждает: устаревшие загрузки отбрасываются.
   * Возвращает true, если голова этого вызова надета (false — вызов вытеснен следующим).
   */
  async setLook(look: HeadLook): Promise<boolean> {
    const my = ++this.token;
    const rig = await this.rigFor(look.gender);
    if (this.disposed || my !== this.token) return false;
    if (this.rig !== rig) {
      if (this.rig) this.scene.remove(this.rig.root);
      this.scene.add(rig.root);
      this.rig = rig;
      // Причёска прежнего тела на новой голове не остаётся
      this.hair.clear();
      this.hairKey = '';
    }
    rig.skin.color.set(safe(look.skin, '#c99a7c'));
    rig.brows.color.set(safe(look.brows ?? look.hair, '#2a1d16'));
    rig.lashes.color.set(safe(look.lashes, '#141010'));
    this.hairMat.color.set(safe(look.hair, '#3b2a20'));
    const irisC = new THREE.Color(safe(look.iris, '#4b3424'));
    const tmp = new THREE.Color();
    for (const e of rig.eyes) {
      const col = e.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
      for (let i = 0; i < e.iris.length; i++) {
        tmp.copy(SCLERA).lerp(irisC, e.iris[i]).lerp(PUPIL, e.pupil[i]);
        col.setXYZ(i, tmp.r, tmp.g, tmp.b);
      }
      col.needsUpdate = true;
    }
    for (const m of rig.morphMeshes) {
      m.morphTargetInfluences.fill(0);
      for (const name of look.morphs) {
        const k = Object.keys(m.morphTargetDictionary).find((x) => x === name || x.startsWith(name + '_'));
        if (k !== undefined) m.morphTargetInfluences[m.morphTargetDictionary[k]] = 1;
      }
    }
    this.place();
    this.render();

    const hairKey = look.gender + ':' + look.hairMeshes.join('|');
    // Ключ запоминаем только после того, как меши надеты: иначе вызов, вытесненный
    // следующим (например, сменой цвета), оставил бы на голове прежнюю причёску
    if (hairKey !== this.hairKey) {
      const scenes = await Promise.all(look.hairMeshes.map((n) => loadScene(`/game/hair/${n}.glb`).catch(() => null)));
      if (this.disposed || my !== this.token) return true;
      this.hairKey = hairKey;
      this.hair.clear();
      for (const s of scenes) {
        if (!s) continue;
        s.traverse((x) => {
          const mesh = x as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.material = this.hairMat;
            mesh.frustumCulled = false;
          }
        });
        this.hair.add(s);
      }
      this.render();
    }
    return true;
  }

  setYaw(deg: number) {
    this.yaw = deg;
    this.place();
    this.render();
  }

  private place() {
    const rig = this.rig;
    if (!rig) return;
    const a = THREE.MathUtils.degToRad(this.yaw);
    const t = rig.target;
    this.camera.position.set(t.x + Math.sin(a) * rig.dist, t.y + rig.dist * 0.02, t.z + FACING * Math.cos(a) * rig.dist);
    this.camera.lookAt(t);
    // Свет привязан к камере, чтобы лицо не уходило в тень при повороте
    const at = (l: THREE.DirectionalLight, side: number, up: number, front: number) => {
      const s = Math.sin(a), c = Math.cos(a);
      const x = side * c + front * s;
      const z = FACING * (front * c - side * s);
      l.position.set(t.x + x, t.y + up, t.z + z);
      l.target.position.copy(t);
      l.target.updateMatrixWorld();
    };
    at(this.lights.key, -0.7, 0.8, 1.4);
    at(this.lights.fill, 1.2, 0.1, 1);
    at(this.lights.rimL, -1.0, 0.6, -1.8);
    at(this.lights.rimR, 1.5, 0.3, -0.6);
  }

  /**
   * gapLeft..gapRight — видимый промежуток холста между колонками интерфейса (в пикселях
   * холста). Голова встаёт в его середину и уменьшается, если промежуток узкий.
   */
  resize(w: number, h: number, gapLeft = 0, gapRight = w) {
    if (w < 1 || h < 1) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    const gap = Math.max(1, gapRight - gapLeft);
    this.camera.zoom = Math.min(1, (gap / h) * 1.3);
    const center = (gapLeft + gapRight) / 2 / w;
    this.camera.setViewOffset(w, h, (0.5 - center) * w, 0, w, h);
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render() {
    if (!this.disposed) this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.disposed = true;
    this.token++;
    this.renderer.dispose();
  }
}
