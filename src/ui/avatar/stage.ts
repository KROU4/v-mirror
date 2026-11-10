// Сцена редактора: театральный свет из 15 конусных ламп (cc_behaviour.md §4.2) и
// камера FOV 15° с плавным переездом между слотами за 1 с (§1). Свет неподвижен,
// поворачивается сам персонаж.
import * as THREE from 'three';
import type { Gender } from '../../model/catalog';
import type { CameraShot } from './slots';

interface ShadowSpec {
  size: number;
  /** сдвиг по нормали, м */
  normalBias: number;
  /** радиус размытия PCF, тексели */
  radius: number;
  /** доля затенения (1 — до черноты) */
  intensity: number;
  /** тень отбрасывают только объекты слоя HEAD_LAYER (голова, глаза, брови, волосы) */
  headOnly?: boolean;
  /** доля конуса, которую покрывает карта тени (меньше — мельче тексель; вне её тени нет) */
  focus?: number;
}

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
  shadow?: ShadowSpec;
}

/**
 * Слой «голова»: голова, глаза, брови и волосы. Тень низкой фронтальной лампы Main_Face
 * отбрасывают только они — иначе плечо кладёт на шею и щёку в профиль жёсткий серый клин
 * (в игре там мягкие контактные тени LSSM_ExtraSoft, а не тень тела).
 */
export const HEAD_LAYER = 1;

/** Женский набор (метры от ступней, Y вверх, V смотрит в −Z, +X — правая рука V). */
const LAMPS: LampSpec[] = [
  { name: 'Main_Face', pos: [-0.3, 1.0, -0.79], color: '#ffffff', lm: 40, out: 45, inn: 15, aim: [0, 1.63, -0.05], shadow: { size: 2048, normalBias: 0.004, radius: 6, intensity: 0.6, headOnly: true } },
  { name: 'Main_Eyes', pos: [-0.78, 1.75, -3.61], color: '#ffffff', lm: 40, out: 30, inn: 1, aim: [0, 1.68, -0.05] },
  { name: 'Main_Top', pos: [-1.58, 4.0, -2.25], color: '#ffffff', lm: 250, out: 50, inn: 25, aim: [0, 1.5, 0], shadow: { size: 1024, normalBias: 0.004, radius: 5, intensity: 0.85 } },
  { name: 'Main_Body', pos: [-0.41, 0.95, -1.72], color: '#ffffff', lm: 65, out: 60, inn: 30, aim: [0, 1.05, 0] },
  { name: 'Main_Feet', pos: [-0.41, 0.65, -1.72], color: '#ffffff', lm: 35, out: 30, inn: 15, aim: [0, 0.25, 0] },
  // Fill_Upper стоит на полу прямо перед лицом. С цветом игры (#a5e4ff), силой 2,0 и прицелом
  // на грудь он светил снизу только на грани, смотрящие вниз: щёки, подбородок и кончик носа
  // уходили в голубой, а верхняя губа и нижние веки оставались тёплыми и тёмными («усы»,
  // синяки под глазами, красный нос на циановом лице у мужчины). Прицел — на лицо, цвет
  // бледнее, сила меньше; недостающий фронтальный свет даёт Main_Eyes на уровне глаз.
  { name: 'Fill_Upper', pos: [0.55, 0.0, -0.94], color: '#d8f0ff', lm: 100, out: 50, inn: 1, aim: [0, 1.62, 0] },
  { name: 'Fill_Base', pos: [2.25, 0.0, -1.58], color: '#a5e4ff', lm: 10, out: 40, inn: 1, aim: [0, 0.6, 0] },
  // Fill_Left — единственная лампа, которая светит на правую (+X) половину лица спереди.
  // С 10 лм (×LM_TO_CD) стенка носа от угла глаза до ноздри и подглазья уходили в
  // серо-бурую полосу: там оставался только голубой Fill_Upper снизу. Сила — ROLE_GAIN, цвет
  // бледнее игрового #a5e4ff: насыщенный циан на тёплой коже даёт серые и оливковые тени.
  { name: 'Fill_Left', pos: [2.25, 3.0, -1.58], color: '#cfeaff', lm: 10, out: 90, inn: 30, aim: [0, 1.3, 0] },
  { name: 'Fill_Lower', pos: [0.99, 0.93, -0.33], color: '#a5e4ff', lm: 2.5, out: 45, inn: 30, aim: [0, 0.9, 0] },
  { name: 'Highlight_Right', pos: [-2.05, 2.0, -1.01], color: '#ffffff', lm: 50, out: 15, inn: 10, aim: [0, 1.62, 0] },
  { name: 'Highlight_Body', pos: [-1.79, 0.0, -1.19], color: '#ffffff', lm: 75, out: 55, inn: 1, aim: [0, 0.9, 0] },
  // Контровые лампы светят из-за спины V. Без тени они проходят сквозь голову и ложатся
  // полосами на обращённые к камере грани (стенка носа, складка века, ноздри, ушная раковина)
  // (карта тени сужена до верха тела: при всём конусе тексель ≈ 4 мм и нос свою стенку не затеняет)
  { name: 'Rim_Right', pos: [-2.25, 1.5, 1.58], color: '#bffeff', lm: 600, out: 75, inn: 1, aim: [0, 1.4, 0], shadow: { size: 2048, normalBias: 0.0015, radius: 3, intensity: 1, focus: 0.45 } },
  { name: 'Rim_Top', pos: [-0.12, 3.0, 0.7], color: '#e5f7ff', lm: 600, out: 25, inn: 1, aim: [0, 1.7, 0] },
  { name: 'Rim_Left_Head', pos: [0.66, 0.5, 1.98], color: '#ff1980', lm: 450, out: 90, inn: 1, aim: [0, 1.6, 0], shadow: { size: 2048, normalBias: 0.0015, radius: 3, intensity: 1, focus: 0.4 } },
  // Контровой тела: узкий конус, нацеленный ниже груди, до головы не достаёт (иначе по
  // нижнему краю челюсти горит неоновая линия)
  { name: 'Rim_Left_Body', pos: [0.94, 0.78, 1.78], color: '#ff1980', lm: 450, out: 36, inn: 1, aim: [0, 0.85, 0] },
];

/**
 * Перевод «люменов» игры в канделы three.js. Экспозиция игры (f/1.4, ISO 450) к
 * физическим единицам three не сводится — множители подобраны на глаз по кадрам
 * редактора: тёмные провалы, мягкий циан-белый и пурпурный контровой (в игре контровой
 * свет — мягкая кайма, а не неоновый контур, и волосы им не пересвечены).
 */
const LM_TO_CD = 0.032;
const ROLE_GAIN: Record<string, number> = {
  Rim_Right: 1.2,
  Rim_Top: 0.9,
  // выше — по краю завитка уха женщины горят ярко-розовые точки
  Rim_Left_Head: 1.15,
  Rim_Left_Body: 0.85,
  Main_Face: 1.6,
  Main_Top: 0.9,
  Main_Eyes: 1.8,
  Fill_Upper: 0.9,
  // ≈ 150 «лм» на голову: лампа в 3 м, при силе игры её вклад в тень лица ~1 %
  Fill_Left: 15,
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
      const sh = s.shadow;
      if (sh) {
        l.castShadow = true;
        l.shadow.mapSize.set(sh.size, sh.size);
        l.shadow.camera.near = 0.2;
        l.shadow.camera.far = 9;
        l.shadow.bias = -0.0004;
        // Малый сдвиг по нормали: с большим тень контровой лампы протекает в складки век
        l.shadow.normalBias = sh.normalBias;
        // В игре мягкие контактные тени (LSSM_ExtraSoft): размываем и не доводим до черноты
        l.shadow.radius = sh.radius;
        l.shadow.intensity = sh.intensity;
        l.shadow.focus = sh.focus ?? 1;
        // Слой камеры тени не 0 — в карту попадают только объекты этого слоя (WebGLShadowMap)
        if (sh.headOnly) l.shadow.camera.layers.set(HEAD_LAYER);
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
  /** точка прицеливания слота (без следования за головой) */
  readonly target = new THREE.Vector3();
  /** мягкое следование за головой на крупных планах, добавляется к прицелу */
  private follow = new THREE.Vector3();
  private aim = new THREE.Vector3();
  distance = 1;

  /** Сдвиг прицела за головой (м, мировые оси). */
  setFollow(v: THREE.Vector3) {
    if (v.equals(this.follow)) return;
    this.follow.copy(v);
    this.apply();
  }

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
    const aim = this.aim.copy(this.target).add(this.follow);
    this.camera.position.set(aim.x, aim.y, aim.z - this.distance);
    this.camera.lookAt(aim);
  }
}
