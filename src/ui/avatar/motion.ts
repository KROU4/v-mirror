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
