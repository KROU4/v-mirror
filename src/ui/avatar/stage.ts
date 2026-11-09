// Сцена редактора: театральный свет из 15 конусных ламп (cc_behaviour.md §4.2) и
// камера FOV 15° с плавным переездом между слотами за 1 с (§1). Свет неподвижен,
// поворачивается сам персонаж.
import * as THREE from 'three';
import type { Gender } from '../../model/catalog';
import type { CameraShot } from './slots';

interface LampSpec {
  name: string;
  pos: [number, number, number];
  color: string;
  lm: number;
  /** полный угол конуса снаружи / внутри, ° */
  out: number;
  inn: number;
  /** куда направлена лампа (в данных игры только позиция — цель по роли лампы) */
  aim: [number, number, number];
  shadow?: number;
}

/** Женский набор (метры от ступней, Y вверх, V смотрит в −Z, +X — правая рука V). */
const LAMPS: LampSpec[] = [
  { name: 'Main_Face', pos: [-0.3, 1.0, -0.79], color: '#ffffff', lm: 40, out: 45, inn: 15, aim: [0, 1.63, -0.05], shadow: 2048 },
  { name: 'Main_Eyes', pos: [-0.78, 1.75, -3.61], color: '#ffffff', lm: 40, out: 30, inn: 1, aim: [0, 1.68, -0.05] },
  { name: 'Main_Top', pos: [-1.58, 4.0, -2.25], color: '#ffffff', lm: 250, out: 50, inn: 25, aim: [0, 1.5, 0], shadow: 1024 },
  { name: 'Main_Body', pos: [-0.41, 0.95, -1.72], color: '#ffffff', lm: 65, out: 60, inn: 30, aim: [0, 1.05, 0] },
  { name: 'Main_Feet', pos: [-0.41, 0.65, -1.72], color: '#ffffff', lm: 35, out: 30, inn: 15, aim: [0, 0.25, 0] },
  { name: 'Fill_Upper', pos: [0.55, 0.0, -0.94], color: '#a5e4ff', lm: 100, out: 50, inn: 1, aim: [0, 1.5, 0] },
  { name: 'Fill_Base', pos: [2.25, 0.0, -1.58], color: '#a5e4ff', lm: 10, out: 40, inn: 1, aim: [0, 0.6, 0] },
  { name: 'Fill_Left', pos: [2.25, 3.0, -1.58], color: '#a5e4ff', lm: 10, out: 90, inn: 30, aim: [0, 1.3, 0] },
  { name: 'Fill_Lower', pos: [0.99, 0.93, -0.33], color: '#a5e4ff', lm: 2.5, out: 45, inn: 30, aim: [0, 0.9, 0] },
  { name: 'Highlight_Right', pos: [-2.05, 2.0, -1.01], color: '#ffffff', lm: 50, out: 15, inn: 10, aim: [0, 1.62, 0] },
  { name: 'Highlight_Body', pos: [-1.79, 0.0, -1.19], color: '#ffffff', lm: 75, out: 55, inn: 1, aim: [0, 0.9, 0] },
  { name: 'Rim_Right', pos: [-2.25, 1.5, 1.58], color: '#bffeff', lm: 600, out: 75, inn: 1, aim: [0, 1.4, 0], shadow: 1024 },
  { name: 'Rim_Top', pos: [-0.12, 3.0, 0.7], color: '#e5f7ff', lm: 600, out: 25, inn: 1, aim: [0, 1.7, 0] },
  { name: 'Rim_Left_Head', pos: [0.66, 0.5, 1.98], color: '#ff1980', lm: 450, out: 90, inn: 1, aim: [0, 1.6, 0], shadow: 1024 },
  { name: 'Rim_Left_Body', pos: [0.94, 0.78, 1.78], color: '#ff1980', lm: 450, out: 60, inn: 1, aim: [0, 1.0, 0] },
];

/**
 * Перевод «люменов» игры в канделы three.js. Экспозиция игры (f/1.4, ISO 450) к
 * физическим единицам three не сводится — множители подобраны на глаз по кадрам
 * редактора: тёмные провалы, яркий циан-белый и пурпурный контровой.
 */
const LM_TO_CD = 0.032;
const ROLE_GAIN: Record<string, number> = {
  Rim_Right: 2.2,
  Rim_Top: 1.5,
  Rim_Left_Head: 1.6,
  Rim_Left_Body: 1.3,
  Main_Face: 1.6,
  Main_Top: 0.9,
  Main_Eyes: 1.4,
  Fill_Upper: 2.0,
};

export class LightRig {
  readonly group = new THREE.Group();
  private lamps: { spec: LampSpec; light: THREE.SpotLight }[] = [];

  constructor() {
    this.group.name = 'creator_lights';
    for (const s of LAMPS) {
      const l = new THREE.SpotLight(s.color, s.lm * LM_TO_CD * (ROLE_GAIN[s.name] ?? 1));
      l.name = s.name;
      l.angle = THREE.MathUtils.degToRad(Math.min(s.out, 170) / 2);
      l.penumbra = THREE.MathUtils.clamp(1 - s.inn / s.out, 0.2, 1);
      l.decay = 2;
      l.distance = 0;
      if (s.shadow) {
        l.castShadow = true;
        l.shadow.mapSize.set(s.shadow, s.shadow);
        l.shadow.camera.near = 0.2;
        l.shadow.camera.far = 9;
        l.shadow.bias = -0.0004;
        l.shadow.normalBias = 0.004;
        // В игре мягкие контактные тени (LSSM_ExtraSoft): размываем и не доводим до черноты
        l.shadow.radius = 5;
        l.shadow.intensity = s.name === 'Main_Face' ? 0.65 : 0.85;
      }
      this.group.add(l, l.target);
      this.lamps.push({ spec: s, light: l });
    }
    this.setGender('female');
  }

  /** Мужской набор: всё на 5 см выше, лампы чуть слабее, без Main_Feet. */
  setGender(g: Gender) {
    const dy = g === 'male' ? 0.05 : 0;
    const k = g === 'male' ? 0.9 : 1;
    for (const { spec, light } of this.lamps) {
      light.position.set(spec.pos[0], spec.pos[1] + dy, spec.pos[2]);
      light.target.position.set(spec.aim[0], spec.aim[1] + dy, spec.aim[2]);
      light.intensity = spec.lm * LM_TO_CD * (ROLE_GAIN[spec.name] ?? 1) * k;
      light.visible = !(g === 'male' && spec.name === 'Main_Feet');
    }
  }
}

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Камера редактора: прицел и дистанция слота, переезд 1 с ease-in-out. */
export class CameraRig {
  readonly camera = new THREE.PerspectiveCamera(15, 1, 0.1, 60);
  private from = { target: new THREE.Vector3(), distance: 1 };
  private to = { target: new THREE.Vector3(), distance: 1 };
  private t = 1;
  private started = false;
  readonly target = new THREE.Vector3();
  distance = 1;

  /** Новый кадр. immediate — без переезда (первый показ). */
  setShot(shot: CameraShot, immediate = false) {
    const nt = new THREE.Vector3().fromArray(shot.target);
    if (this.started && nt.equals(this.to.target) && shot.distance === this.to.distance) return;
    this.from = { target: this.target.clone(), distance: this.distance };
    this.to = { target: nt, distance: shot.distance };
    this.t = immediate || !this.started ? 1 : 0;
    this.started = true;
    this.apply();
  }

  get moving() {
    return this.t < 1;
  }

  update(dt: number) {
    if (this.t >= 1) return;
    this.t = Math.min(1, this.t + dt / 1.0);
    this.apply();
  }

  private apply() {
    const k = easeInOut(this.t);
    this.target.lerpVectors(this.from.target, this.to.target, k);
    this.distance = THREE.MathUtils.lerp(this.from.distance, this.to.distance, k);
    // Камера спереди (V смотрит в −Z) на высоте точки прицеливания
    this.camera.position.set(this.target.x, this.target.y, this.target.z - this.distance);
    this.camera.lookAt(this.target);
  }
}
