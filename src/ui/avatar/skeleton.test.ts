// Общий скелет: собственные кости причёсок (dyng_*) с одним именем, но разной позой привязки.
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { MasterSkeleton } from './skeleton';

const JSON_SK = {
  bones: [
    { name: 'Hips', parent: null, bindPosition: [0, 1, 0], bindQuaternion: [0, 0, 0, 1], localPosition: [0, 1, 0], localQuaternion: [0, 0, 0, 1] },
    { name: 'Head', parent: 'Hips', bindPosition: [0, 1.6, 0], bindQuaternion: [0, 0, 0, 1], localPosition: [0, 0.6, 0], localQuaternion: [0, 0, 0, 1] },
  ],
} as never;

/** Меш причёски из glb: свой плоский скелет Head + dyng-кость в точке world. */
function hairMesh(world: [number, number, number]): THREE.SkinnedMesh {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0, 1, 0, 1, 0, 0], 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], 4));
  const head = new THREE.Bone();
  head.name = 'Head';
  const dyng = new THREE.Bone();
  dyng.name = 'dyng_back_left_01';
  const inv = [new THREE.Matrix4().makeTranslation(0, -1.6, 0), new THREE.Matrix4().makeTranslation(-world[0], -world[1], -world[2])];
  const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  // своя bindMatrix: без неё three пересчитал бы обратные матрицы из текущей позы костей
  m.bind(new THREE.Skeleton([head, dyng], inv), new THREE.Matrix4());
  return m;
}

const worldY = (b: THREE.Bone) => {
  b.updateWorldMatrix(true, false);
  return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).y;
};

describe('MasterSkeleton: собственные кости причёсок', () => {
  it('кость с тем же именем, но другой позой привязки — своя: пряди не берут позу прежней причёски', () => {
    const sk = new MasterSkeleton(JSON_SK);
    const a = hairMesh([0, 1.4, 0.1]);
    const b = hairMesh([0, 1.55, 0.05]);
    sk.bind(a);
    sk.bind(b);
    const ba = a.skeleton.bones[1], bb = b.skeleton.bones[1];
    expect(ba).not.toBe(bb);
    expect(worldY(ba)).toBeCloseTo(1.4, 5);
    expect(worldY(bb)).toBeCloseTo(1.55, 5);
    expect(sk.extraCount).toBe(2);
  });

  it('одинаково привязанные меши делят кость; выгруженный меш снимает свои кости со скелета', () => {
    const sk = new MasterSkeleton(JSON_SK);
    const a = hairMesh([0, 1.4, 0.1]);
    const b = hairMesh([0, 1.4, 0.1]);
    sk.bind(a);
    sk.bind(b);
    expect(a.skeleton.bones[1]).toBe(b.skeleton.bones[1]);
    expect(sk.extraCount).toBe(1);
    const bone = a.skeleton.bones[1];
    sk.release(a);
    expect(bone.parent).not.toBeNull();
    sk.release(b);
    expect(bone.parent).toBeNull();
    expect(sk.extraCount).toBe(0);
    // повторный release и меш без своих костей — без ошибок
    sk.release(b);
    expect(sk.get('Head')?.name).toBe('Head');
  });
});
