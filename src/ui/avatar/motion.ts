// Клипы тела из ui_*.anims игры (body/anim/ui_<g>.glb) на общем скелете:
// повороты всех костей, смещение только у Root и Hips (остальные смещения рига
// анимации на пару сантиметров отличаются от привязки меша), без масштаба.
import * as THREE from 'three';
import type { MasterSkeleton } from './skeleton';
import { clipPlan, type BodyMode, type ClipStep } from './slots';

const DROP = new Set(['Trajectory', 'reference_joint', 'WeaponLeft', 'WeaponRight']);
const FADE = 0.5;

/** Оставить в клипе только то, что можно применить к скелету меша. */
export function filterClip(clip: THREE.AnimationClip, sk: MasterSkeleton): THREE.AnimationClip {
  const tracks = clip.tracks.filter((t) => {
    const dot = t.name.lastIndexOf('.');
    const node = t.name.slice(0, dot);
    const prop = t.name.slice(dot + 1);
    if (DROP.has(node) || !sk.bones.has(node)) return false;
    if (prop === 'quaternion') return true;
    if (prop === 'position') return node === 'Root' || node === 'Hips';
    return false;
  });
  return new THREE.AnimationClip(clip.name, clip.duration, tracks);
}

/**
 * Руки никогда не закрывают лицо. Клипы применяются только поворотами на скелете меша,
 * а его кости на пару сантиметров отличаются от рига анимации: у женского тела в
 * ui_expose_hand_loop кисть поднимается выше, чем в игре, и пальцы ложатся на подбородок.
 * Кончик среднего пальца держим не выше Head − below (м по вертикали) и не ближе face (м
 * по горизонтали) к лицу, пока он на уровне лица.
 */
export const HAND_GUARD = { below: 0.15, face: 0.08, faceBand: 0.14 };

/**
 * Насколько сдвинуть кончик пальца (мировые оси, м), чтобы он не заходил на лицо.
 * head — мировая позиция кости Head, face — середина лица. null — сдвиг не нужен.
 */
export function handGuardShift(tip: THREE.Vector3, head: THREE.Vector3, face: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 | null {
  out.set(0, 0, 0);
  const maxY = head.y - HAND_GUARD.below;
  if (tip.y > maxY) out.y = maxY - tip.y;
  const y = tip.y + out.y;
  if (y > face.y - HAND_GUARD.faceBand) {
    const dx = tip.x - face.x;
    const dz = tip.z - face.z;
    const d = Math.hypot(dx, dz);
    if (d < HAND_GUARD.face) {
      // прямо перед лицом (d ≈ 0) — уводим в сторону камеры (−Z)
      if (d > 1e-6) {
        const k = (HAND_GUARD.face - d) / d;
        out.x += dx * k;
        out.z += dz * k;
      } else out.z -= HAND_GUARD.face;
    }
  }
  return out.lengthSq() > 1e-10 ? out : null;
}

const _q = new THREE.Quaternion();
const _qp = new THREE.Quaternion();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Vector3();
const _w = new THREE.Vector3();

/** Повернуть кость на мировой поворот q (поверх текущей позы). Мировые матрицы ветки обновляются. */
function rotateWorld(bone: THREE.Bone, q: THREE.Quaternion) {
  bone.getWorldQuaternion(_qp);
  _qp.premultiply(q);
  if (bone.parent) {
    bone.parent.getWorldQuaternion(_q).invert();
    _qp.premultiply(_q);
  }
  bone.quaternion.copy(_qp);
  bone.updateMatrixWorld(true);
}

/**
 * Аналитический IK по двум костям: upper (плечо) и lower (локоть) поворачиваются так,
 * чтобы end (запястье) пришло в target; плоскость сгиба локтя сохраняется.
 */
export function solveTwoBone(upper: THREE.Bone, lower: THREE.Bone, end: THREE.Bone, target: THREE.Vector3) {
  upper.updateMatrixWorld(true);
  upper.getWorldPosition(_s);
  lower.getWorldPosition(_e);
  end.getWorldPosition(_w);
  const la = _e.distanceTo(_s);
  const lb = _w.distanceTo(_e);
  if (la < 1e-6 || lb < 1e-6) return;
  const lc = THREE.MathUtils.clamp(target.distanceTo(_s), Math.abs(la - lb) + 1e-4, la + lb - 1e-4);
  // 1) локоть: внутренний угол под нужное расстояние плечо — запястье
  _a.subVectors(_s, _e).normalize();
  _b.subVectors(_w, _e).normalize();
  const cur = Math.acos(THREE.MathUtils.clamp(_a.dot(_b), -1, 1));
  const want = Math.acos(THREE.MathUtils.clamp((la * la + lb * lb - lc * lc) / (2 * la * lb), -1, 1));
  _c.crossVectors(_a, _b);
  if (_c.lengthSq() > 1e-12 && Math.abs(want - cur) > 1e-6) {
    rotateWorld(lower, _q.setFromAxisAngle(_c.normalize(), want - cur).clone());
    end.getWorldPosition(_w);
  }
  // 2) плечо: направить плечо — запястье на цель кратчайшим поворотом
  _a.subVectors(_w, _s).normalize();
  _b.subVectors(target, _s).normalize();
  if (_a.dot(_b) < 1 - 1e-9) rotateWorld(upper, new THREE.Quaternion().setFromUnitVectors(_a, _b));
}

/** Поправка рук после кадра анимации: кисть не поднимается к лицу (HAND_GUARD). */
export class HandGuard {
  private head?: THREE.Bone;
  /** середина лица в осях кости Head */
  private faceLocal = new THREE.Vector3();
  private arms: { upper: THREE.Bone; lower: THREE.Bone; hand: THREE.Bone; tip: THREE.Bone }[] = [];
  private headW = new THREE.Vector3();
  private faceW = new THREE.Vector3();
  private tipW = new THREE.Vector3();
  private shift = new THREE.Vector3();
  private target = new THREE.Vector3();

  constructor(sk: MasterSkeleton) {
    this.head = sk.get('Head');
    const hb = sk.bindWorld.get('Head');
    // поверхность лица в позе привязки: на 2 см выше кости Head, z = −7 см (кончик носа −7,6 см)
    if (hb) this.faceLocal.set(hb.elements[12], hb.elements[13] + 0.02, -0.07).applyMatrix4(hb.clone().invert());
    for (const side of ['Left', 'Right']) {
      const upper = sk.get(`${side}Arm`);
      const lower = sk.get(`${side}ForeArm`);
      const hand = sk.get(`${side}Hand`);
      const tip = sk.get(`${side}HandMiddle3`);
      if (upper && lower && hand && tip) this.arms.push({ upper, lower, hand, tip });
    }
  }

  /** Вызывать после mixer.update; root — корень персонажа (его мировые матрицы обновляются). */
  apply(root: THREE.Object3D) {
    if (!this.head || !this.arms.length) return;
    root.updateMatrixWorld(true);
    this.head.getWorldPosition(this.headW);
    this.faceW.copy(this.faceLocal).applyMatrix4(this.head.matrixWorld);
    for (const a of this.arms) {
      a.tip.getWorldPosition(this.tipW);
      if (!handGuardShift(this.tipW, this.headW, this.faceW, this.shift)) continue;
      a.hand.getWorldPosition(this.target).add(this.shift);
      solveTwoBone(a.upper, a.lower, a.hand, this.target);
    }
  }
}

/**
 * Поза ногтей: тыльная сторона поднятой кисти к камере. Клип ui_expose_hand_loop на
 * скелете мужского меша держит кисть ребром к камере — ногтей не видно, и строка теряет
 * смысл. Кисть доворачивается вокруг оси предплечья (пронация), не больше maxDeg; кости
 * скрутки предплечья (*_Wrist_0..2_JNT) идут следом долями twist, чтобы запястье не
 * перекручивалось «фантиком».
 */
export const NAIL_TWIST = { maxDeg: 75, flexDeg: 45, twist: [0.3, 0.6, 0.85], tau: 0.25 };

/**
 * Угол (рад) поворота вокруг оси axis, который ближе всего доводит back (нормаль тыла
 * кисти) до toCam (направление на камеру); |угол| ≤ maxDeg. Векторы — единичные.
 */
export function twistToFace(axis: THREE.Vector3, back: THREE.Vector3, toCam: THREE.Vector3, maxDeg = NAIL_TWIST.maxDeg): number {
  const b = back.clone().addScaledVector(axis, -back.dot(axis));
  const c = toCam.clone().addScaledVector(axis, -toCam.dot(axis));
  if (b.lengthSq() < 1e-8 || c.lengthSq() < 1e-8) return 0;
  const ang = Math.atan2(axis.dot(new THREE.Vector3().crossVectors(b, c)), b.dot(c));
  const m = THREE.MathUtils.degToRad(maxDeg);
  return THREE.MathUtils.clamp(ang, -m, m);
}

/** Доворот поднятой кисти тылом к камере в позе ногтей (NAIL_TWIST). */
export class NailTwist {
  private arms: { side: 1 | -1; fore: THREE.Bone; hand: THREE.Bone; mid: THREE.Bone; index: THREE.Bone; pinky: THREE.Bone; twist: THREE.Bone[] }[] = [];
  private w = 0;
  private pE = new THREE.Vector3();
  private pH = new THREE.Vector3();
  private pM = new THREE.Vector3();
  private pI = new THREE.Vector3();
  private pP = new THREE.Vector3();
  private axis = new THREE.Vector3();
  private back = new THREE.Vector3();
  private toCam = new THREE.Vector3();
  private q = new THREE.Quaternion();

  constructor(sk: MasterSkeleton) {
    for (const [side, s, sign] of [
      ['Left', 'l', 1],
      ['Right', 'r', -1],
    ] as const) {
      const fore = sk.get(`${side}ForeArm`);
      const hand = sk.get(`${side}Hand`);
      const mid = sk.get(`${side}HandMiddle3`);
      const index = sk.get(`${side}HandIndex1`);
      const pinky = sk.get(`${side}HandPinky1`);
      const twist = [0, 1, 2].map((k) => sk.get(`${s}_Wrist_${k}_JNT`)).filter((b): b is THREE.Bone => !!b);
      if (fore && hand && mid && index && pinky) this.arms.push({ side: sign, fore, hand, mid, index, pinky, twist });
    }
  }

  /**
   * Кости, которые доворот менял в прошлом кадре: before — поворот до доворота, after — после.
   * Кости без дорожек в клипах (скрутка предплечья) микшер не переписывает, и без отката
   * доворот копился бы от кадра к кадру.
   */
  private touched = new Map<THREE.Bone, { before: THREE.Quaternion; after: THREE.Quaternion }>();

  private turn(bone: THREE.Bone, axis: THREE.Vector3, angle: number) {
    let t = this.touched.get(bone);
    if (!t) this.touched.set(bone, (t = { before: new THREE.Quaternion(), after: new THREE.Quaternion() }));
    // до первого доворота в этом кадре: повторный доворот той же кости не затирает before
    if (!this.turned.has(bone)) t.before.copy(bone.quaternion);
    this.turned.add(bone);
    rotateWorld(bone, this.q.setFromAxisAngle(axis, angle));
    t.after.copy(bone.quaternion);
  }
  private turned = new Set<THREE.Bone>();

  /** Нормаль тыла кисти (мировые оси) и её середина → this.back, this.pH. */
  private handBack(a: (typeof this.arms)[number]) {
    a.hand.getWorldPosition(this.pH);
    a.mid.getWorldPosition(this.pM);
    a.index.getWorldPosition(this.pI);
    a.pinky.getWorldPosition(this.pP);
    // тыл кисти: (пальцы × поперёк ладони), у правой кисти — с обратным знаком
    this.back
      .crossVectors(this.pM.sub(this.pH).normalize(), this.pP.sub(this.pI).normalize())
      .normalize()
      .multiplyScalar(a.side);
  }

  /** После HandGuard: on — поза ногтей (рука поднята), camera — мировая позиция камеры. */
  apply(dt: number, on: boolean, camera: THREE.Vector3) {
    for (const [bone, t] of this.touched) if (bone.quaternion.equals(t.after)) bone.quaternion.copy(t.before);
    this.touched.clear();
    this.w += ((on ? 1 : 0) - this.w) * (1 - Math.exp(-dt / NAIL_TWIST.tau));
    if (this.w < 1e-3 || !this.arms.length) return;
    // поднятая кисть — та, что выше
    let a = this.arms[0];
    let best = -Infinity;
    for (const arm of this.arms) {
      arm.hand.getWorldPosition(this.pH);
      if (this.pH.y > best) {
        best = this.pH.y;
        a = arm;
      }
    }
    this.turned.clear();
    a.fore.getWorldPosition(this.pE);
    this.handBack(a);
    this.axis.subVectors(this.pH, this.pE).normalize();
    this.toCam.subVectors(camera, this.pH).normalize();
    // 1) пронация вокруг оси предплечья (с костями скрутки)
    const ang = twistToFace(this.axis, this.back, this.toCam) * this.w;
    if (Math.abs(ang) > 1e-4) {
      a.twist.forEach((b, i) => this.turn(b, this.axis, ang * (NAIL_TWIST.twist[i] ?? 1)));
      this.turn(a.hand, this.axis, ang);
    }
    // 2) Предплечье смотрит почти в камеру — одной пронацией тыл кисти к ней не повернуть.
    // Остаток добирает сгиб запястья (кратчайший поворот кисти), не больше flexDeg.
    this.handBack(a);
    const flex = Math.min(Math.acos(THREE.MathUtils.clamp(this.back.dot(this.toCam), -1, 1)), THREE.MathUtils.degToRad(NAIL_TWIST.flexDeg)) * this.w;
    const ax = this.pE.crossVectors(this.back, this.toCam);
    if (flex > 1e-4 && ax.lengthSq() > 1e-10) this.turn(a.hand, ax.normalize(), flex);
  }
}

export class BodyAnimator {
  private mixer: THREE.AnimationMixer;
  private clips = new Map<string, THREE.AnimationClip>();
  private current: THREE.AnimationAction | null = null;
  private queue: ClipStep[] = [];
  private mode: BodyMode | null = null;
  private pending: BodyMode | null = null;

  constructor(root: THREE.Object3D) {
    this.mixer = new THREE.AnimationMixer(root);
    this.mixer.addEventListener('finished', (e) => {
      if ((e as unknown as { action: THREE.AnimationAction }).action === this.current) this.advance();
    });
  }

  get ready() {
    return this.clips.size > 0;
  }

  /** Имя клипа, который играет (или в который идёт переход) сейчас. */
  get clip(): string | null {
    return this.current?.getClip().name ?? null;
  }

  /** Играет клип-переход между позами (или он ещё в очереди). */
  get transitioning(): boolean {
    if (!this.current) return false;
    return this.queue.length > 0 || this.current.loop !== THREE.LoopRepeat;
  }

  /**
   * Рука поднята или опускается после ногтей (клипы ui_expose_hand_*, играют или в очереди).
   * Лицевой граф игры от клипов тела не зависит: улыбка «Зубы» ждёт только выхода из позы
   * ногтей (голова там наклонена к руке), а не переезда «рост → крупный план».
   */
  get handUp(): boolean {
    const isHand = (n: string) => n.startsWith('ui_expose_hand');
    if (!this.current) return false;
    return isHand(this.current.getClip().name) || this.queue.some((s) => isHand(s.clip));
  }

  setClips(clips: THREE.AnimationClip[], sk: MasterSkeleton) {
    for (const c of clips) this.clips.set(c.name, filterClip(c, sk));
    if (this.pending) {
      const p = this.pending;
      this.pending = null;
      this.mode = null; // клипы пришли только сейчас: начинаем сразу с цикла, без переходов
      this.request(p);
    }
  }

  /** Перейти в позу (крупный план / рост / рука), при необходимости через клипы-переходы. */
  request(mode: BodyMode) {
    if (!this.ready) {
      this.pending = mode;
      return;
    }
    if (mode === this.mode) return;
    const plan = clipPlan(this.mode, mode).filter((s) => this.clips.has(s.clip));
    this.mode = mode;
    if (!plan.length) return;
    this.queue = plan;
    this.advance();
  }

  private advance(): void {
    const step = this.queue.shift();
    if (!step) return;
    const clip = this.clips.get(step.clip);
    if (!clip) return this.advance();
    const action = this.mixer.clipAction(clip);
    action.reset();
    action.setLoop(step.loop ? THREE.LoopRepeat : THREE.LoopOnce, step.loop ? Infinity : 1);
    action.clampWhenFinished = !step.loop;
    action.enabled = true;
    action.setEffectiveWeight(1);
    action.setEffectiveTimeScale(step.speed ?? 1);
    action.play();
    if (this.current && this.current !== action) this.current.crossFadeTo(action, FADE, false);
    this.current = action;
  }

  update(dt: number) {
    this.mixer.update(dt);
  }

  dispose() {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.mixer.getRoot());
  }
}
