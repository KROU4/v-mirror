import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { BodyAnimator, HAND_GUARD, handGuardShift, solveTwoBone } from './motion';
import type { MasterSkeleton } from './skeleton';

const NAMES = [
  'ui_closeup_shot',
  'ui_closeup_shot_chin',
  'ui_closeup_shot_hair',
  'ui_closeup_to_fullbody',
  'ui_fullbody_shot',
  'ui_fullbody_to_closeup',
  'ui_expose_hand_start',
  'ui_expose_hand_loop',
  'ui_expose_hand_end',
];

function setup() {
  const root = new THREE.Group();
  const hips = new THREE.Bone();
  hips.name = 'Hips';
  root.add(hips);
  const sk = { bones: new Map([['Hips', hips]]) } as unknown as MasterSkeleton;
  const clips = NAMES.map(
    (n) => new THREE.AnimationClip(n, 1, [new THREE.QuaternionKeyframeTrack('Hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]),
  );
  return { anim: new BodyAnimator(root), clips, sk };
}

describe('BodyAnimator', () => {
  it('поза до загрузки клипов применяется сразу циклом, без переходов', () => {
    const { anim, clips, sk } = setup();
    anim.request('fullbody');
    expect(anim.clip).toBeNull();
    anim.setClips(clips, sk);
    expect(anim.clip).toBe('ui_fullbody_shot');
  });

  it('строки головы не запускают «показы» лица на теле', () => {
    const { anim, clips, sk } = setup();
    anim.setClips(clips, sk);
    anim.request('closeup');
    expect(anim.clip).toBe('ui_closeup_shot');
    anim.request('closeup');
    expect(anim.clip).toBe('ui_closeup_shot');
  });

  it('переход closeup → fullbody идёт через клип-переход и заканчивается циклом', () => {
    const { anim, clips, sk } = setup();
    anim.setClips(clips, sk);
    anim.request('closeup');
    anim.request('fullbody');
    expect(anim.clip).toBe('ui_closeup_to_fullbody');
    anim.update(1.2);
    expect(anim.clip).toBe('ui_fullbody_shot');
    anim.request('closeup');
    expect(anim.clip).toBe('ui_fullbody_to_closeup');
    anim.update(1.2);
    expect(anim.clip).toBe('ui_closeup_shot');
  });

  it('transitioning: истина, пока играет клип-переход, и ложь в цикле позы', () => {
    const { anim, clips, sk } = setup();
    expect(anim.transitioning).toBe(false);
    anim.setClips(clips, sk);
    anim.request('closeup');
    expect(anim.transitioning).toBe(false);
    anim.request('hand');
    expect(anim.transitioning).toBe(true);
    anim.update(1.2);
    expect(anim.clip).toBe('ui_expose_hand_loop');
    expect(anim.transitioning).toBe(false);
    // выход из ногтей ускорен: клип 1 с заканчивается раньше чем за 1 с
    anim.request('closeup');
    expect(anim.transitioning).toBe(true);
    anim.update(0.4);
    expect(anim.clip).toBe('ui_expose_hand_end');
    anim.update(0.3);
    expect(anim.clip).toBe('ui_closeup_shot');
    expect(anim.transitioning).toBe(false);
  });

  it('handUp: улыбка ждёт только выхода из позы ногтей, а не переезда «рост → крупный план»', () => {
    const { anim, clips, sk } = setup();
    anim.setClips(clips, sk);
    anim.request('fullbody');
    anim.update(1.2);
    anim.request('closeup');
    expect(anim.clip).toBe('ui_fullbody_to_closeup');
    expect(anim.transitioning).toBe(true);
    expect(anim.handUp).toBe(false);
    anim.update(1.2);
    anim.request('hand');
    expect(anim.handUp).toBe(true);
    anim.update(1.2);
    expect(anim.clip).toBe('ui_expose_hand_loop');
    expect(anim.handUp).toBe(true);
    anim.request('closeup');
    expect(anim.handUp).toBe(true);
    anim.update(1.2);
    expect(anim.clip).toBe('ui_closeup_shot');
    expect(anim.handUp).toBe(false);
  });

  it('рука: выход из позы ногтей проигрывает ui_expose_hand_end', () => {
    const { anim, clips, sk } = setup();
    anim.setClips(clips, sk);
    anim.request('closeup');
    anim.request('hand');
    expect(anim.clip).toBe('ui_expose_hand_start');
    anim.update(1.2);
    expect(anim.clip).toBe('ui_expose_hand_loop');
    anim.request('closeup');
    expect(anim.clip).toBe('ui_expose_hand_end');
    anim.update(1.2);
    expect(anim.clip).toBe('ui_closeup_shot');
  });
});

describe('HandGuard: рука не закрывает лицо', () => {
  const head = new THREE.Vector3(0, 1.56, 0);
  const face = new THREE.Vector3(0, 1.58, -0.07);

  it('кончик пальца ниже Head − 15 см и в стороне от лица — без поправки', () => {
    expect(handGuardShift(new THREE.Vector3(0.05, 1.3, -0.25), head, face)).toBeNull();
  });

  it('кончик у подбородка опускается до Head − 15 см', () => {
    const s = handGuardShift(new THREE.Vector3(0, 1.48, -0.22), head, face)!;
    expect(s).not.toBeNull();
    expect(1.48 + s.y).toBeCloseTo(head.y - HAND_GUARD.below);
  });

  it('на уровне лица кончик не подходит к лицу ближе 8 см по горизонтали', () => {
    // голова опущена к руке: ограничение по высоте уже соблюдено, но палец у самого лица
    const lowHead = new THREE.Vector3(0, 1.7, 0);
    const lowFace = new THREE.Vector3(0, 1.52, -0.07);
    const tip = new THREE.Vector3(0.02, 1.5, -0.1);
    const s = handGuardShift(tip, lowHead, lowFace)!;
    expect(s).not.toBeNull();
    const after = tip.clone().add(s);
    expect(Math.hypot(after.x - lowFace.x, after.z - lowFace.z)).toBeCloseTo(HAND_GUARD.face);
  });
});

describe('solveTwoBone', () => {
  function chain() {
    const root = new THREE.Group();
    const upper = new THREE.Bone();
    const lower = new THREE.Bone();
    const end = new THREE.Bone();
    upper.position.set(0, 1.4, 0);
    lower.position.set(0, -0.3, 0);
    end.position.set(0, -0.25, 0);
    // локоть согнут вперёд, кисть поднята
    lower.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -2.2);
    root.add(upper);
    upper.add(lower);
    lower.add(end);
    root.updateMatrixWorld(true);
    return { root, upper, lower, end };
  }

  it('запястье приходит в достижимую цель, длины костей не меняются', () => {
    const { upper, lower, end } = chain();
    const start = end.getWorldPosition(new THREE.Vector3());
    const target = start.clone().add(new THREE.Vector3(0, -0.1, 0));
    solveTwoBone(upper, lower, end, target);
    const got = end.getWorldPosition(new THREE.Vector3());
    expect(got.distanceTo(target)).toBeLessThan(1e-4);
    const s = upper.getWorldPosition(new THREE.Vector3());
    const e = lower.getWorldPosition(new THREE.Vector3());
    expect(e.distanceTo(s)).toBeCloseTo(0.3, 5);
    expect(got.distanceTo(e)).toBeCloseTo(0.25, 5);
  });

  it('недостижимая цель — рука вытягивается в её сторону', () => {
    const { upper, lower, end } = chain();
    const target = new THREE.Vector3(0, 1.4, -2);
    solveTwoBone(upper, lower, end, target);
    const s = upper.getWorldPosition(new THREE.Vector3());
    const got = end.getWorldPosition(new THREE.Vector3());
    expect(got.distanceTo(s)).toBeCloseTo(0.55, 3);
    expect(got.clone().sub(s).normalize().dot(target.clone().sub(s).normalize())).toBeGreaterThan(0.999);
  });
});
