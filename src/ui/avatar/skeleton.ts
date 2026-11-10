// Один скелет на тело: иерархия из body/skeleton.<g>.json (в glb она плоская).
// Все skinned-меши (голова, глаза, брови, зубы, волосы, тело, руки, ногти, бельё)
// перепривязываются к его костям по имени и двигаются как одно целое.
import * as THREE from 'three';
import type { SkeletonJson } from './assets';

const IDENTITY = new THREE.Matrix4();

/**
 * Восемь влияний костей на вершину. Меши игры весят вершину на 8 костей (в glb —
 * JOINTS_0/1, WEIGHTS_0/1), а three берёт только первые 4: края кусков тела
 * расходятся в позе (щели на шее, плечах) и лямки белья мнутся. Дописываем вторую
 * четвёрку в стандартные куски шейдера — для всех skinned-материалов, включая тени.
 */
let skinning8 = false;
function patchSkinning8() {
  if (skinning8) return;
  skinning8 = true;
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  const swap = (chunk: string, from: string, to: string) => {
    if (!C[chunk].includes(from)) throw new Error(`three: в ${chunk} нет «${from}»`);
    C[chunk] = C[chunk].replace(from, to);
  };
  swap('skinning_pars_vertex', 'uniform mat4 bindMatrix;', 'attribute vec4 skinIndex1;\n\tattribute vec4 skinWeight1;\n\tuniform mat4 bindMatrix;');
  swap(
    'skinbase_vertex',
    'mat4 boneMatW = getBoneMatrix( skinIndex.w );',
    `mat4 boneMatW = getBoneMatrix( skinIndex.w );
	mat4 boneMatX1 = getBoneMatrix( skinIndex1.x );
	mat4 boneMatY1 = getBoneMatrix( skinIndex1.y );
	mat4 boneMatZ1 = getBoneMatrix( skinIndex1.z );
	mat4 boneMatW1 = getBoneMatrix( skinIndex1.w );`,
  );
  swap(
    'skinning_vertex',
    'skinned += boneMatW * skinVertex * skinWeight.w;',
    `skinned += boneMatW * skinVertex * skinWeight.w;
	skinned += boneMatX1 * skinVertex * skinWeight1.x;
	skinned += boneMatY1 * skinVertex * skinWeight1.y;
	skinned += boneMatZ1 * skinVertex * skinWeight1.z;
	skinned += boneMatW1 * skinVertex * skinWeight1.w;`,
  );
  swap(
    'skinnormal_vertex',
    'skinMatrix += skinWeight.w * boneMatW;',
    `skinMatrix += skinWeight.w * boneMatW;
	skinMatrix += skinWeight1.x * boneMatX1;
	skinMatrix += skinWeight1.y * boneMatY1;
	skinMatrix += skinWeight1.z * boneMatZ1;
	skinMatrix += skinWeight1.w * boneMatW1;`,
  );
}

/**
 * Перевести joints_1/weights_1 из glb в skinIndex1/skinWeight1. GLTFLoader уже
 * нормировал первую четвёрку весов к сумме 1, поэтому её доля восстанавливается как
 * 1 − Σ второй четвёрки. У мешей без второй четвёрки она нулевая (атрибут нужен
 * шейдеру всегда: пустой атрибут WebGL читает как (0,0,0,1)).
 */
export function eightInfluences(g: THREE.BufferGeometry) {
  if (g.getAttribute('skinIndex1')) return;
  const sw = g.getAttribute('skinWeight');
  if (!sw) return;
  const j1 = g.getAttribute('joints_1');
  const w1 = g.getAttribute('weights_1');
  const n = sw.count;
  const w0 = new Float32Array(n * 4);
  const i1 = new Uint16Array(n * 4);
  const ww1 = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    let rest = 0;
    if (j1 && w1)
      for (let c = 0; c < 4; c++) {
        i1[v * 4 + c] = j1.getComponent(v, c);
        ww1[v * 4 + c] = w1.getComponent(v, c);
        rest += ww1[v * 4 + c];
      }
    const s = Math.max(0, 1 - rest);
    let total = rest;
    for (let c = 0; c < 4; c++) {
      w0[v * 4 + c] = sw.getComponent(v, c) * s;
      total += w0[v * 4 + c];
    }
    if (total > 0 && Math.abs(total - 1) > 1e-4)
      for (let c = 0; c < 4; c++) {
        w0[v * 4 + c] /= total;
        ww1[v * 4 + c] /= total;
      }
  }
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(w0, 4));
  g.setAttribute('skinIndex1', new THREE.Uint16BufferAttribute(i1, 4));
  g.setAttribute('skinWeight1', new THREE.Float32BufferAttribute(ww1, 4));
  g.deleteAttribute('joints_1');
  g.deleteAttribute('weights_1');
}

export class MasterSkeleton {
  readonly root: THREE.Bone;
  readonly bones = new Map<string, THREE.Bone>();
  /** мировые матрицы привязки (bind pose) из json — не зависят от текущей позы */
  readonly bindWorld = new Map<string, THREE.Matrix4>();
  readonly restPos = new Map<string, THREE.Vector3>();
  readonly restQuat = new Map<string, THREE.Quaternion>();
  /** кости, которых нет в json (dyng_* у причёсок): висят на Head */
  private extras = new Map<string, THREE.Bone>();

  constructor(json: SkeletonJson) {
    let root: THREE.Bone | null = null;
    for (const b of json.bones) {
      const bone = new THREE.Bone();
      bone.name = b.name;
      bone.position.fromArray(b.localPosition);
      bone.quaternion.fromArray(b.localQuaternion).normalize();
      this.bones.set(b.name, bone);
      this.restPos.set(b.name, bone.position.clone());
      this.restQuat.set(b.name, bone.quaternion.clone());
      this.bindWorld.set(
        b.name,
        new THREE.Matrix4().compose(
          new THREE.Vector3().fromArray(b.bindPosition),
          new THREE.Quaternion().fromArray(b.bindQuaternion).normalize(),
          new THREE.Vector3(1, 1, 1),
        ),
      );
      const parent = b.parent ? this.bones.get(b.parent) : undefined;
      if (parent) parent.add(bone);
      else if (!root) root = bone;
      else root.add(bone);
    }
    if (!root) throw new Error('skeleton.json: нет костей');
    this.root = root;
    this.root.updateMatrixWorld(true);
  }

  get(name: string): THREE.Bone | undefined {
    return this.bones.get(name) ?? this.extras.get(name);
  }

  /** Вернуть все кости в позу привязки (перед кадром анимации лицо собирается заново). */
  resetBone(name: string) {
    const b = this.bones.get(name);
    if (!b) return;
    b.position.copy(this.restPos.get(name)!);
    b.quaternion.copy(this.restQuat.get(name)!);
  }

  /**
   * Кость, которой нет в json: её мировая поза берётся из inverse bind matrix меша,
   * родитель — Head (динамические пряди волос в редакторе неподвижны относительно головы).
   * Кости «болтания» пениса (dyng_penis_*) висят на Hips, и у каждого меша свои: их позы
   * привязки в разных glb расходятся до 5 мм (intimate.json, loaderNotes).
   */
  private extraBone(name: string, inverseBind: THREE.Matrix4, owner: string): THREE.Bone {
    const hips = name.startsWith('dyng_penis') && this.bones.has('Hips');
    const key = hips ? owner + '|' + name : name;
    let bone = this.extras.get(key);
    if (bone) return bone;
    const parentName = hips ? 'Hips' : this.bones.has('Head') ? 'Head' : this.root.name;
    const parent = this.bones.get(parentName)!;
    const world = inverseBind.clone().invert();
    const local = this.bindWorld.get(parentName)!.clone().invert().multiply(world);
    bone = new THREE.Bone();
    bone.name = name;
    local.decompose(bone.position, bone.quaternion, bone.scale);
    parent.add(bone);
    this.extras.set(key, bone);
    return bone;
  }

  /**
   * Привязать skinned-меш из glb к общему скелету. Обратные матрицы привязки меша
   * остаются его собственными (совпадают с json до 0,26 мм). owner — имя файла меша
   * (для собственных костей наготы).
   */
  bind(mesh: THREE.SkinnedMesh, owner = mesh.uuid) {
    patchSkinning8();
    eightInfluences(mesh.geometry);
    const src = mesh.skeleton;
    const bones = src.bones.map((b, i) => this.bones.get(b.name) ?? this.extraBone(b.name, src.boneInverses[i], owner));
    mesh.bind(new THREE.Skeleton(bones, src.boneInverses.map((m) => m.clone())), IDENTITY);
    mesh.frustumCulled = false;
  }
}
