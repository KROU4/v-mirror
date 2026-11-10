// Жизненный цикл персонажа: тело, освобождённое движком (IDLE_BODY_MS), собирается заново
// с теми же файлами и тем же кешем AssetStore — и снова с мешами головы и тела.
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./face', () => ({ FaceRig: class { update() {} mouthOpen = 0; eyesClosed = 0; teethTarget = 0 } }));
vi.mock('./motion', () => ({
  BodyAnimator: class { update() {} dispose() {} setClips() {} request() {} handUp = false },
  HandGuard: class { apply() {} },
  NailTwist: class { apply() {} },
}));
vi.mock('./skeleton', () => ({
  MasterSkeleton: class {
    root = new THREE.Group();
    bind() {}
    get() {}
  },
}));
vi.mock('./seams', () => ({ weldSeams: () => ({ welded: 0, maxGap: 0 }) }));

const MANIFESTS: Record<string, unknown> = {
  'tex/skin/manifest.json': {},
  'tex/face/manifest.json': {
    meshes: { female: { eyes: { glb: 'eyes.glb', parts: {} }, eyebrows: { glb: 'brows.glb', parts: {} }, teeth: { glb: 'teeth.glb', parts: {} } } },
  },
  'body/manifest.json': {
    glb: { pwa_body: { file: 'body.glb', submeshes: [] }, pwa_arm_l: { file: 'arm_l.glb', submeshes: [] }, pwa_arm_r: { file: 'arm_r.glb', submeshes: [] } },
    materials: { personalLink: {}, nails: { byGender: { pwa: {}, pma: {} } } },
    textures: {},
    headSkinColorToTone: {},
    defaultCharCreatorOutfit: { defaultTone: 't' },
    faceRig: { pwa: { eyelids: { eyeCenter: { l: [0, 0, 0], r: [0, 0, 0] } } } },
    animations: { files: { pwa: { file: 'anim.glb' } } },
  },
  'body/skeleton.pwa.json': { bones: [] },
  'tex/hair/manifest.json': { meshes: {}, hints: {}, materials: {}, textures: {}, cardSets: {}, profiles: {} },
};
vi.mock('./assets', () => ({ loadJson: (rel: string) => Promise.resolve(MANIFESTS[rel]) }));

const { Character } = await import('./character');

/** Кеш glb как у AssetStore: один разобранный glb на путь, пока его не выгрузят (dropGltf). */
class FakeStore {
  gltfs = new Map<string, Promise<{ scene: THREE.Group; animations: [] }>>();
  parsed = 0;
  gltf(rel: string) {
    let p = this.gltfs.get(rel);
    if (!p) {
      this.parsed++;
      const scene = new THREE.Group();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
      const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
      m.name = 'submesh_00_LOD_1';
      m.bind(new THREE.Skeleton([]));
      scene.add(m);
      p = Promise.resolve({ scene, animations: [] });
      this.gltfs.set(rel, p);
    }
    return p;
  }
  dropGltf(rel: string) {
    this.gltfs.delete(rel);
  }
}

const meshCount = (root: THREE.Object3D) => {
  let n = 0;
  root.traverse((o) => void ((o as THREE.Mesh).isMesh && n++));
  return n;
};

describe('Character: сборка после освобождения', () => {
  it('тело, собранное заново на том же кеше, не пустое', async () => {
    const store = new FakeStore();
    const a = await Character.build('female', store as never, {} as never);
    const first = meshCount(a.root);
    expect(first).toBeGreaterThan(0);
    a.dispose();
    // все glb, из которых персонаж брал меши, выгружены из кеша
    expect(store.gltfs.size).toBe(0);
    const b = await Character.build('female', store as never, {} as never);
    expect(meshCount(b.root)).toBe(first);
  });

  it('зубы есть и у тела, собранного заново после освобождения', async () => {
    const store = new FakeStore();
    const a = await Character.build('female', store as never, {} as never);
    const before = meshCount(a.root);
    await a.loadExtras(() => {});
    expect(meshCount(a.root)).toBe(before + 1);
    a.dispose();
    expect(store.gltfs.has('teeth.glb')).toBe(false);
    const b = await Character.build('female', store as never, {} as never);
    await b.loadExtras(() => {});
    expect(meshCount(b.root)).toBe(before + 1);
  });

  it('догрузка после dispose ничего не добавляет и не зовёт onChange', async () => {
    const store = new FakeStore();
    const a = await Character.build('female', store as never, {} as never);
    const before = meshCount(a.root);
    const onChange = vi.fn();
    const p = a.loadExtras(onChange);
    a.dispose();
    await p;
    expect(meshCount(a.root)).toBe(before);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('пустой glb головы или тела — ошибка, а не «готовая» пустая сцена', async () => {
    const store = new FakeStore();
    // сцены в кеше, из которых меши уже унесены (как было до исправления)
    for (const rel of ['glb/h0_000_pwa__morphs.morphtarget.glb', 'body.glb'])
      store.gltfs.set(rel, Promise.resolve({ scene: new THREE.Group(), animations: [] }));
    await expect(Character.build('female', store as never, {} as never)).rejects.toThrow(/нет мешей/);
  });
});
