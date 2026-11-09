// Процедурное лицо поверх клипов тела (клипы игры лицо не двигают): моргание,
// взгляд в камеру с саккадами, лёгкое размыкание губ на выдохе и «показ зубов».
// Кости лица — из восстановленной иерархии, поэтому подбородок и нижняя губа идут за челюстью.
import * as THREE from 'three';
import type { FaceRigSpec } from './assets';
import type { MasterSkeleton } from './skeleton';

const UP_LOCAL = new THREE.Vector3(0, 1, 0); // ось «открытия» челюсти и век в осях кости (faceRig)
const DEG = THREE.MathUtils.DEG2RAD;
const smooth = (x: number) => x * x * (3 - 2 * x);

/**
 * Улыбка раздела «Зубы»: сдвиг костей губ, мм в осях персонажа [наружу, вверх, назад].
 * Челюсть — около 2,15° (cc_behaviour.md §2.3, решение xf-studio для ui_expose_teeth).
 */
export const SMILE = {
  jawDeg: 2.15,
  // Верхняя губа: подъём растёт от центра к краям — линия губы идёт полумесяцем (∪)
  lipUpMid: [0.3, 2.4, -0.3],
  lipUp2: [1.5, 3.8, 0.4],
  lipUp3: [3.0, 5.5, 1.0],
  // кожа над верхней губой
  rowAMid: [0.2, 1.0, -0.2],
  rowA2: [1.2, 2.5, 0.3],
  rowA3: [4.0, 7.0, 1.8],
  rowBMid: [0, 0.5, 0],
  rowB2: [1.5, 2.5, 0.3],
  rowB3: [3.0, 4.5, 0.8],
  // Нижняя губа опускается немного, к краям не поднимается и уходит назад к зубам:
  // вперёд-вниз она выворачивается и открывает влажную внутреннюю сторону
  lipDnMid: [0.3, -1.0, 3.2],
  lipDn2: [1.0, -0.5, 3.6],
  lipDn3: [2.5, 0, 3.5],
  // кожа под нижней губой и у уголков (кости на челюсти)
  rowA4: [5.5, 8.5, 3.0],
  rowA5: [1.5, 0.5, 2.5],
  rowA6: [0.3, -1.5, 0.8],
  rowB4: [4.0, 6.5, 2.0],
  rowB5: [2.0, 2.5, 1.0],
  // уголки — вверх и назад, выше центра губ
  corner: [6.0, 9.5, 3.0],
  // щёки поднимаются и чуть выдаются вперёд, носогубная складка углубляется
  cheek: [0.8, 3.5, -1.0],
  cheekLow: [2.0, 5.0, 0.5],
  cheekJaw: [1.0, 1.5, 0.3],
} satisfies Record<string, number | [number, number, number]>;

type SmileKey = Exclude<keyof typeof SMILE, 'jawDeg'>;

/** Кости лица → смещение улыбки (и размыкание губ на выдохе, мм). */
const SMILE_BONES: [RegExp, SmileKey, [number, number, number]?][] = [
  [/^[lr]_J_mug_lip_up_[01]_JNT$/, 'lipUpMid', [0, 0.6, 0]],
  [/^[lr]_J_mug_lip_up_2_JNT$/, 'lipUp2', [0, 0.5, 0]],
  [/^[lr]_J_mug_lip_up_3_JNT$/, 'lipUp3'],
  [/^[lr]_J_mug_mouth_rowA_[01]_JNT$/, 'rowAMid'],
  [/^[lr]_J_mug_mouth_rowA_2_JNT$/, 'rowA2'],
  [/^[lr]_J_mug_mouth_rowA_3_JNT$/, 'rowA3'],
  [/^[lr]_J_mug_mouth_rowB_[01]_JNT$/, 'rowBMid'],
  [/^[lr]_J_mug_mouth_rowB_2_JNT$/, 'rowB2'],
  [/^[lr]_J_mug_mouth_rowB_3_JNT$/, 'rowB3'],
  [/^[lr]_J_mug_lip_dn_[01]_JNT$/, 'lipDnMid', [0, -0.8, 0]],
  [/^[lr]_J_mug_lip_dn_2_JNT$/, 'lipDn2', [0, -0.6, 0]],
  [/^[lr]_J_mug_lip_dn_3_JNT$/, 'lipDn3'],
  [/^[lr]_J_mug_mouth_rowA_4_JNT$/, 'rowA4'],
  [/^[lr]_J_mug_mouth_rowA_5_JNT$/, 'rowA5'],
  [/^[lr]_J_mug_mouth_rowA_6_JNT$/, 'rowA6'],
  [/^[lr]_J_mug_mouth_rowB_4_JNT$/, 'rowB4'],
  [/^[lr]_J_mug_mouth_rowB_5_JNT$/, 'rowB5'],
  [/^[lr]_J_mug_lip_corner_0_JNT$/, 'corner'],
  [/^[lr]_J_jaw_nosabial_row[ABC]_[01]_JNT$/, 'cheek'],
  [/^[lr]_J_jaw_nosabial_row[AB]_2_JNT$/, 'cheekLow'],
  [/^[lr]_J_jaw_nosabial_row(A_3|B_3|C_2)_JNT$/, 'cheekJaw'],
];

/** Доля хода века на полное моргание: с 1,0 у V остаётся щель (веко доходит до ~90 % зазора). */
export const BLINK_OVERSHOOT = 1.12;
/** Прищур улыбки: в основном поднимается нижнее веко (щёки), верхнее почти не двигается. */
export const SMILE_SQUINT = { upper: 0.04, lower: 0.35 };

/** Угол век (доля хода) для моргания blink 0..1 и улыбки teeth 0..1. */
export function lidPose(blink: number, teeth: number): { upper: number; lower: number } {
  const b = THREE.MathUtils.clamp(blink, 0, 1);
  const t = THREE.MathUtils.clamp(teeth, 0, 1);
  return {
    upper: Math.min(BLINK_OVERSHOOT, b * BLINK_OVERSHOOT + SMILE_SQUINT.upper * t * (1 - b)),
    lower: Math.max(b, SMILE_SQUINT.lower * t),
  };
}

interface Offset {
  bone: THREE.Bone;
  rest: THREE.Vector3;
  /** смещение в осях родителя на 1 м сдвига по осям персонажа (bind) */
  basis: THREE.Matrix3;
  /** сдвиг (м) в осях персонажа: +Y вверх, −Z вперёд, +X вправо от V */
  teeth: THREE.Vector3;
  breath: THREE.Vector3;
}

interface Corner {
  bone: THREE.Bone;
  rest: THREE.Vector3;
  center: THREE.Vector3;
  axis: THREE.Vector3;
}

/** Мировая матрица привязки родителя кости → поворот «оси персонажа → оси родителя». */
function parentBasis(sk: MasterSkeleton, bone: THREE.Bone): THREE.Matrix3 {
  const pName = (bone.parent as THREE.Bone | null)?.name ?? '';
  const pw = sk.bindWorld.get(pName) ?? new THREE.Matrix4();
  const q = new THREE.Quaternion();
  pw.decompose(new THREE.Vector3(), q, new THREE.Vector3());
  return new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q.invert()));
}

export class FaceRig {
  private jaw?: THREE.Bone;
  private jawRest = new THREE.Quaternion();
  private lidsUp: { bone: THREE.Bone; rest: THREE.Quaternion }[] = [];
  private lidsDn: { bone: THREE.Bone; rest: THREE.Quaternion }[] = [];
  private corners: Corner[] = [];
  private offsets: Offset[] = [];
  private eyes: { bone: THREE.Bone; rest: THREE.Quaternion; fwd: THREE.Vector3 }[] = [];
  private head?: THREE.Bone;
  private headBindQ = new THREE.Quaternion();
  private upperDeg: number;
  private lowerDeg: number;

  // состояние
  private time = 0;
  private nextBlink = 1.2;
  private blinkT = -1;
  private doubleBlink = false;
  private saccadeAt = 0;
  private sacTarget = new THREE.Vector2();
  private sac = new THREE.Vector2();
  private look = new THREE.Vector2();
  private teethAmount = 0;
  private mouth = 0;
  /** 0..1 — показать зубы (раздел «Зубы») */
  teethTarget = 0;
  /** Для проверки кадров: зафиксировать моргание (0..1) вместо случайного; null — как обычно. */
  blinkOverride: number | null = null;

  /** Насколько разомкнуты губы (0..1): от этого зависит, сколько света попадает в рот. */
  get mouthOpen() {
    return this.mouth;
  }

  private lidsClosed = 0;
  /** Насколько закрыты веки (0 — открыты, 1 — сомкнуты). */
  get eyesClosed() {
    return this.lidsClosed;
  }

  constructor(sk: MasterSkeleton, spec: FaceRigSpec) {
    this.upperDeg = spec.eyelids.blinkUpperDeg;
    this.lowerDeg = spec.eyelids.blinkLowerDeg;
    this.jaw = sk.get(spec.jaw.joint);
    if (this.jaw) this.jawRest.copy(sk.restQuat.get(this.jaw.name)!);
    const rot = (names: string[]) =>
      names.flatMap((n) => {
        const bone = sk.get(n);
        return bone ? [{ bone, rest: sk.restQuat.get(n)!.clone() }] : [];
      });
    this.lidsUp = rot(spec.eyelids.upperRoots);
    this.lidsDn = rot(spec.eyelids.lowerRoots);

    // Уголки век — дети face_root: их позиция поворачивается вокруг центра глаза
    for (const n of spec.eyelids.cornerJoints) {
      const bone = sk.get(n);
      if (!bone) continue;
      const pName = (bone.parent as THREE.Bone).name;
      const inv = sk.bindWorld.get(pName)!.clone().invert();
      const c = n.startsWith('l_') ? spec.eyelids.eyeCenter.l : spec.eyelids.eyeCenter.r;
      const center = new THREE.Vector3().fromArray(c).applyMatrix4(inv);
      const axis = new THREE.Vector3(1, 0, 0).applyMatrix3(parentBasis(sk, bone)).normalize();
      this.corners.push({ bone, rest: sk.restPos.get(n)!.clone(), center, axis });
    }

    // Губы и щёки: смещения в осях персонажа (мм → м). «Зубы» в игре (ui_expose_teeth) —
    // мягкая улыбка с приоткрытыми зубами при почти сомкнутом прикусе: уголки уходят наружу,
    // назад и заметно вверх, верхняя губа поднимается к краям сильнее, чем в центре (∪),
    // нижняя опускается немного и прижимается к зубам, щёки приподняты. Ровный подъём всей
    // верхней губы при опущенном центре нижней даёт щель ∩ или прямоугольный оскал.
    const add = (re: RegExp, teeth: [number, number, number], breath: [number, number, number] = [0, 0, 0]) => {
      for (const [name, bone] of sk.bones) {
        if (!re.test(name)) continue;
        const side = name.startsWith('l_') ? -1 : name.startsWith('r_') ? 1 : 0;
        this.offsets.push({
          bone,
          rest: sk.restPos.get(name)!.clone(),
          basis: parentBasis(sk, bone),
          teeth: new THREE.Vector3(teeth[0] * side, teeth[1], teeth[2]).multiplyScalar(0.001),
          breath: new THREE.Vector3(breath[0] * side, breath[1], breath[2]).multiplyScalar(0.001),
        });
      }
    };
    for (const [re, key, breath] of SMILE_BONES) add(re, SMILE[key], breath);

    this.head = sk.get('Head');
    if (this.head) sk.bindWorld.get('Head')!.decompose(new THREE.Vector3(), this.headBindQ, new THREE.Vector3());
    for (const n of spec.eyes.joints) {
      const bone = sk.get(n);
      if (!bone) continue;
      // направление «вперёд» глаза (−Z персонажа) в осях родителя (Head)
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.headBindQ.clone().invert());
      this.eyes.push({ bone, rest: sk.restQuat.get(n)!.clone(), fwd });
    }
  }

  private blinkCurve(dt: number): number {
    if (this.blinkT < 0) {
      this.nextBlink -= dt;
      if (this.nextBlink <= 0) {
        this.blinkT = 0;
        this.doubleBlink = Math.random() < 0.15;
      }
      return 0;
    }
    this.blinkT += dt;
    const t = this.blinkT;
    const CLOSE = 0.1;
    const HOLD = 0.03;
    const OPEN = 0.23;
    let v: number;
    if (t < CLOSE) v = smooth(t / CLOSE);
    else if (t < CLOSE + HOLD) v = 1;
    else if (t < CLOSE + HOLD + OPEN) v = 1 - smooth((t - CLOSE - HOLD) / OPEN);
    else {
      v = 0;
      this.blinkT = -1;
      this.nextBlink = this.doubleBlink ? 0.12 : 1.8 + Math.random() * 1.6;
      this.doubleBlink = false;
    }
    return v;
  }

  /**
   * Кадр лица. Вызывать после mixer.update и до отрисовки; camera — мировая позиция камеры.
   * Кости лица пишутся от позы привязки, поэтому ничего не накапливается.
   */
  update(dt: number, camera: THREE.Vector3) {
    this.time += dt;
    const natural = this.blinkCurve(dt);
    const blink = this.blinkOverride ?? natural;
    // Зубы: плавный вход и выход за ~0,4 с
    const k = 1 - Math.exp(-dt / 0.13);
    this.teethAmount += (this.teethTarget - this.teethAmount) * k;
    const teeth = this.teethAmount;
    // Дыхание ртом: губы чуть размыкаются раз в ~11 с примерно на 2 с
    const phase = (this.time % 11) / 11;
    const breath = phase > 0.15 && phase < 0.38 ? Math.sin(((phase - 0.15) / 0.23) * Math.PI) ** 2 : 0;

    this.mouth = Math.max(teeth, 0.35 * breath);
    if (this.jaw) {
      const deg = -(0.7 * breath) * (1 - teeth) - SMILE.jawDeg * teeth;
      this.jaw.quaternion.copy(this.jawRest).multiply(new THREE.Quaternion().setFromAxisAngle(UP_LOCAL, deg * DEG));
    }
    const tmp = new THREE.Vector3();
    for (const o of this.offsets) {
      tmp.copy(o.teeth).multiplyScalar(teeth).addScaledVector(o.breath, breath * (1 - teeth)).applyMatrix3(o.basis);
      o.bone.position.copy(o.rest).add(tmp);
    }

    // Веки: моргание с небольшим перехлёстом до полного смыкания, прищур улыбки — снизу
    const lid = lidPose(blink, teeth);
    this.lidsClosed = Math.min(1, lid.upper);
    for (const l of this.lidsUp) l.bone.quaternion.copy(l.rest).multiply(new THREE.Quaternion().setFromAxisAngle(UP_LOCAL, this.upperDeg * lid.upper * DEG));
    for (const l of this.lidsDn) l.bone.quaternion.copy(l.rest).multiply(new THREE.Quaternion().setFromAxisAngle(UP_LOCAL, this.lowerDeg * lid.lower * DEG));
    for (const c of this.corners) {
      const a = this.upperDeg * 0.5 * Math.min(1, lid.upper) * DEG;
      c.bone.position.copy(c.rest).sub(c.center).applyAxisAngle(c.axis, a).add(c.center);
    }

    this.updateEyes(dt, camera);
  }

  private updateEyes(dt: number, camera: THREE.Vector3) {
    if (!this.head || !this.eyes.length) return;
    // Саккады: новая точка каждые 0,8–2,5 с, переход за ~40 мс
    if (this.time >= this.saccadeAt) {
      this.saccadeAt = this.time + 0.8 + Math.random() * 1.7;
      this.sacTarget.set((Math.random() - 0.5) * 6 * DEG, (Math.random() - 0.5) * 3.5 * DEG);
    }
    this.sac.lerp(this.sacTarget, 1 - Math.exp(-dt / 0.04));
    this.head.updateWorldMatrix(true, false);
    const inv = this.head.matrixWorld.clone().invert();
    const camLocal = camera.clone().applyMatrix4(inv);
    // направление на камеру от середины между глазами — в осях персонажа (bind)
    const mid = new THREE.Vector3();
    for (const e of this.eyes) mid.add(e.bone.position);
    mid.multiplyScalar(1 / this.eyes.length);
    const dirB = camLocal.sub(mid).normalize().applyQuaternion(this.headBindQ);
    const yaw = THREE.MathUtils.clamp(Math.atan2(dirB.x, -dirB.z), -25 * DEG, 25 * DEG);
    const pitch = THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dirB.y, -1, 1)), -15 * DEG, 15 * DEG);
    this.look.lerp(new THREE.Vector2(yaw, pitch), 1 - Math.exp(-dt / 0.08));
    const y = this.look.x + this.sac.x;
    const p = this.look.y + this.sac.y;
    const want = new THREE.Vector3(Math.sin(y) * Math.cos(p), Math.sin(p), -Math.cos(y) * Math.cos(p)).applyQuaternion(this.headBindQ.clone().invert());
    for (const e of this.eyes) {
      const d = new THREE.Quaternion().setFromUnitVectors(e.fwd, want);
      e.bone.quaternion.copy(d).multiply(e.rest);
    }
  }
}
