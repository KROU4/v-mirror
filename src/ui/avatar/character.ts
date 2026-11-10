// V целиком: голова, глаза, брови, зубы, тело, руки, ногти, части наготы и причёска на
// одном скелете. Сборка по манифестам набора ассетов; внешний вид меняется заменой
// материалов и весов морфов, причёска, нагота и зубы догружаются отдельно.
import * as THREE from 'three';
import { isPackFileMissing } from '../../assets/pack';
import type { Gender } from '../../model/catalog';
import type {
  AssetStore,
  BodyManifest,
  DecalManifest,
  FaceManifest,
  HairHint,
  HairManifest,
  SkeletonJson,
  SkinManifest,
} from './assets';
import { loadJson } from './assets';
import { buildHeadIndex, resolveFaceLayer, transferHeadAttrs, type HeadIndex, type HeadPart } from './decals';
import { FaceRig } from './face';
import { morphWeight, resolveIntimate, type IntimateManifest } from './intimate';
import { morphTargetMatches, type AvatarLook } from './look';
import type { Materials } from './materials';
import { BodyAnimator, HandGuard, NailTwist } from './motion';
import { KEEP_RECENT, touchRecent } from './perf';
import { weldSeams } from './seams';
import { MasterSkeleton } from './skeleton';
import { HEAD_LAYER } from './stage';

const CODE: Record<Gender, 'pwa' | 'pma'> = { female: 'pwa', male: 'pma' };

type MorphMesh = THREE.SkinnedMesh & { morphTargetDictionary: Record<string, number>; morphTargetInfluences: number[] };

/** Порядок прозрачных слоёв поверх кожи. */
const ORDER = { faceDecal: 1, brows: 2, wet: 3, tear: 3, cap: 4, decal: 4, hairFringe: 6 };

function meshesOf(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) out.push(m);
  });
  return out;
}

/**
 * Нижний ряд ресниц: атрибут lashLow = 1 у вершин ниже центра глаза (позиции меша — в
 * осях привязки). Шейдер ресниц делает этот ряд короче и прозрачнее (Materials.lashes).
 */
export function markLowerLashes(g: THREE.BufferGeometry, eyeCenter: { l: number[]; r: number[] }) {
  const pos = g.getAttribute('position');
  if (!pos || g.getAttribute('lashLow')) return;
  const y0 = (eyeCenter.l[1] + eyeCenter.r[1]) / 2 - 0.001;
  const low = new Float32Array(pos.count);
  for (let i = 0; i < pos.count; i++) low[i] = pos.getY(i) < y0 ? 1 : 0;
  g.setAttribute('lashLow', new THREE.Float32BufferAttribute(low, 1));
}

/** Части нет в наборе: набор собран старой версией без неё (файл есть, а раздела в нём нет). */
function partMissing(detail: string): Error {
  const e = new Error(detail);
  e.name = 'PackPartMissing';
  return e;
}

/**
 * Отказ окончательный до смены набора: файла или раздела нет. Разовая ошибка чтения (перезапуск
 * dev-сервера, сбой чтения из папки, сеть) таким не считается — следующее изменение вида
 * пробует снова, и строка не помечается «не показано в 3D».
 */
export function isPartMissing(e: unknown): boolean {
  return isPackFileMissing(e) || (e instanceof Error && e.name === 'PackPartMissing');
}

/**
 * Необязательный JSON набора. Отказ остаётся в кеше, только когда файла нет (в старом наборе
 * каждое изменение вида иначе запрашивало бы его снова); при прочих ошибках кеш сбрасывается.
 */
function optionalJson<T>(rel: string, forget: (p: Promise<T>) => void): Promise<T> {
  const p: Promise<T> = loadJson<T>(rel).catch((e: unknown) => {
    if (!isPartMissing(e)) forget(p);
    throw e;
  });
  p.catch(() => {});
  return p;
}

const chunkOf = (name: string) => Number(/submesh_(\d+)/.exec(name)?.[1] ?? -1);

interface IntimateBuilt {
  id: string;
  file: string;
  kind: 'skin' | 'decal';
  /** подмеш (submesh_NN) → меш */
  subs: Map<number, MorphMesh>;
}

interface DecalBuilt {
  stem: string;
  file: string;
  kind: 'decal' | 'piercing';
  /** чанк → меш-образец (на сцене — его экземпляры, decalInstance) */
  subs: Map<number, MorphMesh>;
}

interface HairBuilt {
  group: THREE.Group;
  /** submesh-объекты по слоям, чтобы менять цвет без перезагрузки */
  parts: { core: THREE.SkinnedMesh; fringe?: THREE.SkinnedMesh; kind: string; doubleSided: boolean; index: number }[];
  stem: string;
}

export class Character {
  readonly root = new THREE.Group();
  readonly sk: MasterSkeleton;
  readonly face: FaceRig;
  readonly anim: BodyAnimator;
  private handGuard: HandGuard;
  private nailTwist: NailTwist;
  private morphMeshes: MorphMesh[] = [];
  private head: THREE.SkinnedMesh[] = [];
  private eyeballs: THREE.SkinnedMesh[] = [];
  private wet: THREE.SkinnedMesh[] = [];
  /** копии меша eye_wetness для блика слёзной кромки (тень и блик смешиваются по-разному) */
  private tear: THREE.SkinnedMesh[] = [];
  private lashes: THREE.SkinnedMesh[] = [];
  private brows: THREE.SkinnedMesh[] = [];
  private bodySkin: { mesh: THREE.SkinnedMesh; part: 'body' | 'arms' }[] = [];
  private nails: THREE.SkinnedMesh[] = [];
  private teeth: THREE.SkinnedMesh[] = [];
  private hairs = new Map<string, Promise<HairBuilt>>();
  /** то же, но уже собранные (синхронный обход для освобождения памяти) */
  private hairsReady = new Map<string, HairBuilt>();
  private intimateReady = new Map<string, IntimateBuilt>();
  private hairOn: HairBuilt[] = [];
  private hairKey = '';
  private hairOrder: string[] = [];
  private intimateM: Promise<IntimateManifest> | null = null;
  private intimateParts = new Map<string, Promise<IntimateBuilt>>();
  private intimateLive: IntimateBuilt[] = [];
  private intimateMeshOrder: string[] = [];
  private intimateMatOrder: string[] = [];
  private extras: Promise<void> | null = null;
  private hairManifest: Promise<HairManifest>;
  /** все glb, из которых этот персонаж брал меши (освобождаются в dispose) */
  private glbs = new Set<string>();
  readonly code: 'pwa' | 'pma';

  private constructor(
    readonly gender: Gender,
    private store: AssetStore,
    private mats: Materials,
    private skinM: SkinManifest,
    private faceM: FaceManifest,
    private bodyM: BodyManifest,
    skeleton: SkeletonJson,
  ) {
    this.code = CODE[gender];
    this.sk = new MasterSkeleton(skeleton);
    this.root.name = 'V_' + this.code;
    this.root.add(this.sk.root);
    this.face = new FaceRig(this.sk, bodyM.faceRig[this.code], gender);
    this.anim = new BodyAnimator(this.root);
    this.handGuard = new HandGuard(this.sk);
    this.nailTwist = new NailTwist(this.sk);
    this.hairManifest = loadJson<HairManifest>('tex/hair/manifest.json');
  }

  /** Голова, глаза, брови, тело, руки, ноги и бельё — то, без чего V не показывается. */
  static async build(gender: Gender, store: AssetStore, mats: Materials): Promise<Character> {
    const c = CODE[gender];
    const [skinM, faceM, bodyM, skeleton] = await Promise.all([
      loadJson<SkinManifest>('tex/skin/manifest.json'),
      loadJson<FaceManifest>('tex/face/manifest.json'),
      loadJson<BodyManifest>('body/manifest.json'),
      loadJson<SkeletonJson>(`body/skeleton.${c}.json`),
    ]);
    const ch = new Character(gender, store, mats, skinM, faceM, bodyM, skeleton);
    try {
      await ch.loadCore();
      // Без головы или тела V не показывается: пусть сцена покажет ошибку или портрет,
      // а не пустой «готовый» кадр
      if (!ch.head.length || !ch.bodySkin.length) throw new Error(`avatar: в glb ${ch.code} нет мешей головы или тела`);
    } catch (e) {
      ch.dispose();
      throw e;
    }
    return ch;
  }

  private add(mesh: THREE.SkinnedMesh, opts: { cast?: boolean; receive?: boolean } = {}) {
    mesh.removeFromParent();
    this.sk.bind(mesh);
    mesh.castShadow = opts.cast ?? true;
    mesh.receiveShadow = opts.receive ?? true;
    this.root.add(mesh);
    const mm = mesh as MorphMesh;
    if (mm.morphTargetDictionary && mm.morphTargetInfluences) this.morphMeshes.push(mm);
  }

  private glb(key: string) {
    const e = this.bodyM.glb[key];
    return e ? this.gltf(e.file) : Promise.resolve(null);
  }

  /**
   * glb из кеша AssetStore. add() уносит меши из сцены glb на скелет V, поэтому кешированная
   * сцена после этого пуста: каждый взятый файл запоминается и в dispose() выгружается из
   * кеша — новое тело того же пола разберёт его заново, а не получит пустую сцену.
   */
  private gltf(rel: string) {
    this.glbs.add(rel);
    return this.store.gltf(rel);
  }

  private dropGlb(rel: string) {
    this.glbs.delete(rel);
    this.store.dropGltf(rel);
  }

  private async loadCore() {
    const g = this.gender;
    const c = this.code;
    const fm = this.faceM.meshes[g];
    const legsKey = this.liftedLegsKey() ?? (g === 'female' ? `${c}_legs_cs_flat` : null);
    // Белья нет: в редакторе игры (без цензуры) V обнажена, а соски, гениталии и т. п.
    // выбираются строками тела (части наготы — prepareIntimate)
    const [head, eyes, brows, body, armL, armR, legs] = await Promise.all([
      this.gltf(`glb/h0_000_${c}__morphs.morphtarget.glb`),
      this.gltf(fm.eyes.glb),
      this.gltf(fm.eyebrows.glb),
      this.glb(`${c}_body`),
      this.glb(`${c}_arm_l`),
      this.glb(`${c}_arm_r`),
      legsKey ? this.glb(legsKey) : Promise.resolve(null),
    ]);

    for (const m of meshesOf(head.scene)) {
      this.add(m);
      m.layers.enable(HEAD_LAYER);
      this.head.push(m);
    }
    for (const m of meshesOf(eyes.scene)) {
      const role = fm.eyes.parts[m.name]?.role;
      if (role === 'eyelashes') {
        this.add(m, { cast: false });
        markLowerLashes(m.geometry, this.bodyM.faceRig[c].eyelids.eyeCenter);
        this.lashes.push(m);
      } else if (role === 'eye_wetness') {
        this.add(m, { cast: false, receive: false });
        m.renderOrder = ORDER.wet;
        this.wet.push(m);
        const t = new THREE.SkinnedMesh(m.geometry, m.material);
        t.name = m.name + '_tearline';
        t.bind(m.skeleton, m.bindMatrix);
        t.frustumCulled = false;
        t.renderOrder = ORDER.tear;
        t.visible = false;
        this.root.add(t);
        this.tear.push(t);
        const tm = t as MorphMesh;
        if (tm.morphTargetDictionary && tm.morphTargetInfluences) this.morphMeshes.push(tm);
      } else {
        this.add(m, { cast: false });
        this.eyeballs.push(m);
      }
    }
    for (const m of meshesOf(brows.scene)) {
      this.add(m, { cast: false });
      m.renderOrder = ORDER.brows;
      this.brows.push(m);
    }
    // Брови — слой кожи (Materials.browDecal): UV и касательные кожи под каждой вершиной
    for (const m of this.brows) this.skinUnder(m.geometry);
    const bodyMeshes = body ? meshesOf(body.scene) : [];
    for (const m of bodyMeshes) {
      // В редакторе у женского тела голени и стопы заменены ногами редактора (cs_flat)
      if (legs && chunkOf(m.name) >= 5) continue;
      this.add(m);
      this.bodySkin.push({ mesh: m, part: 'body' });
    }
    if (legs)
      for (const m of meshesOf(legs.scene)) {
        this.add(m);
        this.bodySkin.push({ mesh: m, part: 'body' });
      }
    for (const [arm, side] of [
      [armL, 'l'],
      [armR, 'r'],
    ] as const) {
      if (!arm) continue;
      for (const m of meshesOf(arm.scene)) {
        this.add(m);
        if (side === 'l' && chunkOf(m.name) === 3) {
          const pl = this.bodyM.materials.personalLink;
          m.material = await this.mats.standard('personal_link', pl.baseColor, pl.orm, pl.normal);
        } else this.bodySkin.push({ mesh: m, part: 'arms' });
      }
    }
    // Швы шея/торс/руки/ноги: торс главный, к нему подтягиваются остальные куски
    const seam = weldSeams([...this.bodySkin.filter((b) => b.part === 'body').map((b) => b.mesh), ...this.bodySkin.filter((b) => b.part === 'arms').map((b) => b.mesh), ...this.head]);
    if (import.meta.env.DEV) console.debug(`[avatar] швы ${this.code}: ${seam.welded} вершин, зазор до ${(seam.maxGap * 1000).toFixed(2)} мм`);
    this.root.updateMatrixWorld(true);
  }

  private liftedLegsKey(): string | null {
    const l = this.bodyM.legsLifted;
    if (!l) return null;
    const v = l[this.code];
    if (typeof v === 'string') return this.bodyM.glb[v] ? v : null;
    if (v && typeof v === 'object' && 'file' in v) {
      this.bodyM.glb[`${this.code}_legs_lifted`] = v;
      return `${this.code}_legs_lifted`;
    }
    return null;
  }

  /** Зубы, ногти и анимации — фоном, после показа V. */
  loadExtras(onChange: () => void): Promise<void> {
    if (this.extras) return this.extras;
    const c = this.code;
    const fm = this.faceM.meshes[this.gender];
    // Через this.gltf: add() уносит меши зубов из кешированной сцены, и в dispose() glb
    // должен выгрузиться из кеша, иначе следующее тело того же пола получит пустую сцену
    const teeth = this.gltf(fm.teeth.glb)
      .then((gl) => {
        if (this.disposed) return;
        for (const m of meshesOf(gl.scene)) {
          this.add(m, { cast: false });
          m.visible = false; // до материала
          this.teeth.push(m);
        }
      })
      .catch(() => {});
    const nails = Promise.all([this.glb(`${c}_nails_l`), this.glb(`${c}_nails_r`)])
      .then((gs) => {
        if (this.disposed) return;
        for (const gl of gs)
          if (gl)
            for (const m of meshesOf(gl.scene)) {
              this.add(m, { cast: false });
              m.visible = false;
              this.nails.push(m);
            }
      })
      .catch(() => {});
    // Клипы копируются (filterClip), сцена анимаций не разбирается — её можно оставить в кеше
    const anim = this.store
      .gltf(this.bodyM.animations.files[c].file)
      .then((gl) => {
        if (!this.disposed) this.anim.setClips(gl.animations, this.sk);
      })
      .catch(() => {});
    this.extras = Promise.all([teeth, nails, anim]).then(() => {
      if (this.disposed) return;
      this.root.updateMatrixWorld(true);
      onChange();
    });
    return this.extras;
  }

  // ---------------------------------------------------------------- внешний вид
  /**
   * Подготовить материалы для вида и вернуть функцию, которая их надевает (синхронно).
   * Так последний вызов побеждает: устаревший результат просто не применяется.
   */
  async prepare(look: AvatarLook): Promise<() => void> {
    const g = this.gender;
    const skinG = this.skinM[g];
    const tone = this.toneOf(look);
    const eye = (look.eyesApp && this.faceM.eyes_color[look.eyesApp]) || Object.entries(this.faceM.eyes_color).find(([k]) => k.includes(`_${this.code}__`))?.[1];
    const lash = (look.lashApp && this.faceM.eyelash_color[look.lashApp]) || Object.entries(this.faceM.eyelash_color).find(([k]) => k.startsWith(g + '__'))?.[1];
    const browStyle = look.browStyle ? this.faceM.eyebrows.styles[g][look.browStyle] : undefined;
    const browCol = (look.browApp && this.faceM.eyebrows.colors[look.browApp]) || Object.entries(this.faceM.eyebrows.colors).find(([k]) => k.startsWith(g + '__'))?.[1];
    const exception = this.faceM.eyebrows.exceptions.find((x) => x.gender === g && x.style === look.browStyle && x.app === look.browApp);
    const teethE = (look.teethApp && this.faceM.teeth[look.teethApp]) || this.faceM.teeth[`${g}_ht_000__basehead`];
    const nailE = (look.nailsApp && this.bodyM.materials.nails.byGender[this.code][look.nailsApp]) || Object.values(this.bodyM.materials.nails.byGender[this.code])[0];
    const texSets = this.bodyM.textures;

    const [headMat, bodyMat, armsMat, eyeMat, wetMat, tearMat, lashMat, browMat, teethMat, nailMat] = await Promise.all([
      this.mats.headSkin(skinG, g, look.skinApp, look.skinType),
      this.mats.bodySkin(texSets[`${this.code}_body`], `${this.code}_body`, tone),
      this.mats.bodySkin(texSets[`${this.code}_arms`], `${this.code}_arms`, tone),
      eye ? this.mats.eyeball(eye, tone) : null,
      eye ? this.mats.eyeShadow(eye) : null,
      eye ? this.mats.eyeTearline(eye).catch(() => null) : null,
      lash ? this.mats.lashes(lash, true) : null,
      browStyle && browCol ? this.mats.browDecal(skinG, g, look.skinApp, look.skinType, browStyle, browCol, exception?.gradientMapPng ?? browCol.gradientMapPng) : null,
      teethE ? this.mats.teeth(teethE).catch(() => null) : null,
      nailE ? this.mats.nails(nailE).catch(() => null) : null,
    ]);

    return () => {
      for (const m of this.head) m.material = headMat;
      for (const b of this.bodySkin) b.mesh.material = b.part === 'arms' ? armsMat : bodyMat;
      for (const m of this.eyeballs) if (eyeMat) m.material = eyeMat;
      for (const m of this.wet) {
        m.visible = !!wetMat;
        if (wetMat) m.material = wetMat;
      }
      for (const m of this.tear) {
        m.visible = !!tearMat;
        if (tearMat) m.material = tearMat;
      }
      for (const m of this.lashes) if (lashMat) m.material = lashMat;
      for (const m of this.brows) {
        m.visible = !!browMat;
        if (browMat) m.material = browMat;
      }
      for (const m of this.teeth) {
        m.visible = !!teethMat;
        if (teethMat) m.material = teethMat;
      }
      for (const m of this.nails) {
        m.visible = !!nailMat;
        if (nailMat) m.material = nailMat;
      }
      this.applyMorphs(look);
    };
  }

  /** Тон кожи тела (01_ca_pale…) по цвету кожи головы. */
  private toneOf(look: AvatarLook): string {
    return (look.skinApp && this.bodyM.headSkinColorToTone[look.skinApp]) || this.bodyM.defaultCharCreatorOutfit.defaultTone;
  }

  // ---------------------------------------------------------------- нагота
  private intimateManifest(): Promise<IntimateManifest> {
    // Отсутствие файла запоминается до смены набора (движок и персонаж пересоздаются вместе с ним)
    if (!this.intimateM) this.intimateM = optionalJson<IntimateManifest>('body/intimate.json', (p) => this.intimateM === p && (this.intimateM = null));
    return this.intimateM;
  }

  private buildIntimate(m: IntimateManifest, id: string): Promise<IntimateBuilt> {
    let p = this.intimateParts.get(id);
    if (!p) {
      p = (async () => {
        const info = m.meshes[id];
        if (!info) throw new Error('intimate: нет меша ' + id);
        const gl = await this.gltf(info.file);
        const subs = new Map<number, MorphMesh>();
        for (const mesh of meshesOf(gl.scene)) {
          mesh.removeFromParent();
          // свои кости dyng_penis_* у каждого файла (skeleton.bind, owner)
          this.sk.bind(mesh, info.file);
          const decal = info.kind === 'decal';
          mesh.castShadow = !decal;
          mesh.receiveShadow = true;
          mesh.renderOrder = decal ? ORDER.decal : 0;
          mesh.visible = false;
          this.root.add(mesh);
          subs.set(chunkOf(mesh.name), mesh as MorphMesh);
        }
        const built: IntimateBuilt = { id, file: info.file, kind: info.kind, subs };
        if (this.intimateParts.get(id) === p) this.intimateReady.set(id, built);
        return built;
      })();
      p.catch(() => this.intimateParts.delete(id));
      this.intimateParts.set(id, p);
    }
    return p;
  }

  /**
   * Части наготы для вида (body/intimate.json): какие меши показать, их материалы под тон
   * кожи и веса морфов (размер гениталий, грудь у декалей). Возвращает функцию «надеть».
   * Без файла наготы в наборе V остаётся как есть.
   */
  async prepareIntimate(look: AvatarLook): Promise<() => void> {
    const m = await this.intimateManifest();
    const res = resolveIntimate(m, this.code, look.body, this.toneOf(look));
    const built = await Promise.all(res.parts.map((p) => this.buildIntimate(m, p.mesh).catch(() => null)));
    const assign: (() => void)[] = [];
    const usedMats: string[] = [];
    await Promise.all(
      res.parts.map(async (part, k) => {
        const b = built[k];
        if (!b) return;
        for (const s of part.submeshes) {
          const def = m.materials[s.material];
          const mesh = b.subs.get(s.index);
          if (!def || !mesh) continue;
          usedMats.push(s.material);
          const mat = await (def.type === 'skin' ? this.mats.intimateSkin(s.material, def) : this.mats.intimateDecal(s.material, def, /hairstyle/.test(part.mesh))).catch(() => null);
          if (mat) assign.push(() => ((mesh.material = mat), (mesh.visible = true)));
        }
      }),
    );
    return () => {
      for (const p of this.intimateLive) for (const mesh of p.subs.values()) mesh.visible = false;
      this.intimateLive = built.filter((b): b is IntimateBuilt => !!b);
      for (const a of assign) a();
      // Размер гениталий и грудь: веса из appliesTo; прочие цели (GarmentSupport) — 0
      for (const b of this.intimateLive)
        for (const mesh of b.subs.values()) {
          const inf = mesh.morphTargetInfluences;
          if (!inf || !mesh.morphTargetDictionary) continue;
          for (const [name, i] of Object.entries(mesh.morphTargetDictionary)) inf[i] = morphWeight(res, b.id, name);
        }
      this.evictIntimate(m, this.intimateLive.map((b) => b.id), usedMats);
    };
  }

  /** Освободить давно снятые части наготы: меши, материалы и их текстуры. */
  private evictIntimate(m: IntimateManifest, meshes: string[], mats: string[]) {
    const mm = touchRecent(this.intimateMeshOrder, meshes, KEEP_RECENT.intimateMeshes);
    this.intimateMeshOrder = mm.order;
    for (const id of mm.evict) {
      const p = this.intimateParts.get(id);
      this.intimateParts.delete(id);
      this.intimateReady.delete(id);
      p?.then((b) => {
        for (const mesh of b.subs.values()) {
          mesh.removeFromParent();
          this.freeBound(mesh);
        }
        this.dropGlb(b.file);
      }).catch(() => {});
    }
    const mt = touchRecent(this.intimateMatOrder, mats, KEEP_RECENT.intimateMaterials);
    this.intimateMatOrder = mt.order;
    const texOf = (name: string) => {
      const d = m.materials[name];
      if (!d) return [];
      return d.type === 'skin' ? [d.albedo, d.normal, d.orm] : [d.diffuse, d.normal, d.roughness];
    };
    const keepTex = new Set(mt.order.flatMap(texOf));
    for (const name of mt.evict) {
      this.mats.releaseIntimate(name);
      for (const t of texOf(name)) if (t && !keepTex.has(t)) this.store.dropTexture(t);
    }
  }

  private applyMorphs(look: AvatarLook) {
    const beard: MorphMesh[] = [];
    for (const b of this.beardOn)
      for (const p of b.parts) {
        const m = p.core as MorphMesh;
        if (m.morphTargetDictionary && m.morphTargetInfluences) beard.push(m);
      }
    for (const m of [...this.morphMeshes, ...beard, ...this.decalLive.values()]) {
      const inf = m.morphTargetInfluences;
      inf.fill(0);
      for (const [name, i] of Object.entries(m.morphTargetDictionary)) {
        if (/nails_[lr]_nails_[lr]$/.test(name)) inf[i] = look.longNails ? 1 : 0;
        else if (look.morphs.some((x) => morphTargetMatches(name, x))) inf[i] = 1;
      }
    }
  }

  // ---------------------------------------------------------------- волосы
  private async hint(look: AvatarLook): Promise<{ hm: HairManifest; hint: HairHint } | null> {
    if (!look.hairHint) return null;
    const hm = await this.hairManifest;
    const plain = hm.hintsPlain?.[this.gender]?.[look.hairHint];
    const cyber = hm.hints[this.gender]?.[look.hairHint];
    const hint = look.hairCyberware ? cyber ?? plain : plain ?? cyber;
    return hint ? { hm, hint } : null;
  }

  private buildHair(hm: HairManifest, stem: string): Promise<HairBuilt> {
    let p = this.hairs.get(stem);
    if (!p) {
      p = (async () => {
        const info = hm.meshes[stem];
        if (!info) throw new Error('hair: нет меша ' + stem);
        const gl = await this.gltf(info.glb);
        const group = new THREE.Group();
        group.name = 'hair_' + stem;
        const parts: HairBuilt['parts'] = [];
        for (const m of meshesOf(gl.scene)) {
          const index = info.submeshes.findIndex((s) => s.glbMesh === m.name);
          const sub = info.submeshes[index];
          if (!sub) continue;
          m.removeFromParent();
          this.sk.bind(m);
          m.receiveShadow = true;
          m.layers.enable(HEAD_LAYER);
          group.add(m);
          const part: HairBuilt['parts'][number] = { core: m, kind: sub.kind, doubleSided: sub.doubleSided, index };
          if (sub.kind === 'cards') {
            m.castShadow = true;
            const f = new THREE.SkinnedMesh(m.geometry, m.material);
            f.name = m.name + '_fringe';
            f.bind(m.skeleton, m.bindMatrix);
            f.frustumCulled = false;
            f.renderOrder = ORDER.hairFringe;
            // Борода: морфы лица у кромки те же, что у основного прохода (общий массив весов)
            const mm = m as MorphMesh;
            if (mm.morphTargetInfluences) {
              f.morphTargetDictionary = mm.morphTargetDictionary;
              f.morphTargetInfluences = mm.morphTargetInfluences;
            }
            group.add(f);
            part.fringe = f;
          } else {
            m.castShadow = sub.kind !== 'cap' && sub.kind !== 'shadow';
            if (sub.kind === 'cap') m.renderOrder = ORDER.cap;
            if (sub.kind === 'shadow') m.renderOrder = ORDER.decal;
          }
          // Борода: меш с морфами лица (форма подбородка, челюсти, рта)
          if (info.morphs) m.frustumCulled = false;
          parts.push(part);
        }
        const built = { group, parts, stem };
        if (this.hairs.get(stem) === p) this.hairsReady.set(stem, built);
        return built;
      })();
      p.catch(() => this.hairs.delete(stem));
      this.hairs.set(stem, p);
    }
    return p;
  }

  /** Причёска и цвет волос. Возвращает функцию «надеть» (или null, если вызов устарел/нечего менять). */
  async prepareHair(look: AvatarLook): Promise<() => void> {
    const h = await this.hint(look);
    if (!h) {
      return () => {
        for (const b of this.hairOn) this.root.remove(b.group);
        this.hairOn = [];
        this.hairKey = '';
      };
    }
    const { hm, hint } = h;
    const built = await Promise.all(hint.meshes.map((s) => this.buildHair(hm, s).catch(() => null)));
    const assign: (() => void)[] = [];
    for (const b of built) {
      if (!b) continue;
      const info = hm.meshes[b.stem];
      const appNames = Object.keys(info.appearances);
      const app = (look.hairColour && hint.colours[look.hairColour]?.[b.stem]) || appNames[0];
      const keys = info.appearances[app] ?? info.appearances[appNames[0]] ?? [];
      for (const part of b.parts) {
        const key = keys[part.index];
        const mdef = key ? hm.materials[key] : undefined;
        if (!mdef) {
          assign.push(() => {
            part.core.visible = false;
            if (part.fringe) part.fringe.visible = false;
          });
          continue;
        }
        if (mdef.type === 'hairCards') {
          // Карточки рисуем с двух сторон: у одиночных чанков в игре есть обратные грани
          // в соседних карточках, а без них причёска выглядит редкой
          const [core, fringe] = await Promise.all([
            this.mats.hairCards(hm, mdef, 'core', true),
            this.mats.hairCards(hm, mdef, 'fringe', true),
          ]).catch(() => [null, null]);
          assign.push(() => {
            part.core.visible = !!core;
            if (core) part.core.material = core;
            if (part.fringe) {
              part.fringe.visible = !!fringe;
              if (fringe) part.fringe.material = fringe;
            }
          });
        } else {
          const mat = await (mdef.type === 'cap' ? this.mats.hairCap(hm, mdef) : this.mats.accessory(mdef, hm)).catch(() => null);
          assign.push(() => {
            part.core.visible = !!mat;
            if (mat) part.core.material = mat;
          });
        }
      }
    }
    const key = built.map((b) => b?.stem ?? '').join('|');
    return () => {
      if (key !== this.hairKey) {
        for (const b of this.hairOn) this.root.remove(b.group);
        this.hairOn = built.filter((b): b is HairBuilt => !!b);
        for (const b of this.hairOn) this.root.add(b.group);
        this.hairKey = key;
        this.evictHair(hm);
      }
      for (const a of assign) a();
    };
  }

  // ---------------------------------------------------------------- борода
  private beardOn: HairBuilt[] = [];
  private beardKey = '';
  private beardOrder: string[] = [];

  /**
   * Борода: карточки волос и тень щетины (tex/hair/manifest.json, beards). Компоненты бороды
   * — меши с морфами лица; показаны только чанки из маски игры (так часть бороды «подбородок»
   * оставляет от полной бороды только подбородок). Возвращает функцию «надеть».
   */
  async prepareBeard(look: AvatarLook): Promise<() => void> {
    const hm = look.beardApp ? await this.hairManifest : null;
    // Набор собран до бород: в манифесте волос нет секции beards
    if (hm && !hm.beards) throw partMissing('hair manifest: no beards');
    const apps = hm?.beards?.apps[look.beardApp ?? ''];
    const comps = apps ? (look.beardColour ? apps[look.beardColour] : undefined) ?? apps.default ?? Object.values(apps)[0] : undefined;
    if (!hm || !comps?.length) return () => this.setBeard([], '');
    const built = await Promise.all(comps.map((c) => this.buildHair(hm, c.mesh).catch(() => null)));
    const assign: (() => void)[] = [];
    await Promise.all(
      comps.map(async (c, k) => {
        const b = built[k];
        if (!b) return;
        const info = hm.meshes[b.stem];
        const keys = info.appearances[c.app] ?? Object.values(info.appearances)[0] ?? [];
        const shown = new Set(c.chunks);
        for (const part of b.parts) {
          const sub = info.submeshes[part.index];
          const key = keys[part.index];
          const mdef = key ? hm.materials[key] : undefined;
          const hide = () => {
            part.core.visible = false;
            if (part.fringe) part.fringe.visible = false;
          };
          if (!mdef || !shown.has(sub?.chunk ?? part.index)) {
            assign.push(hide);
            continue;
          }
          if (mdef.type === 'hairCards') {
            const [core, fringe] = await Promise.all([this.mats.hairCards(hm, mdef, 'core', part.doubleSided), this.mats.hairCards(hm, mdef, 'fringe', part.doubleSided)]).catch(() => [null, null]);
            assign.push(() => {
              part.core.visible = !!core;
              if (core) part.core.material = core;
              if (part.fringe) {
                part.fringe.visible = !!fringe;
                if (fringe) part.fringe.material = fringe;
              }
            });
          } else {
            const mat = await (mdef.type === 'beardShadow' ? this.mats.beardShadow(hm, mdef) : this.mats.accessory(mdef, hm)).catch(() => null);
            assign.push(() => {
              part.core.visible = !!mat;
              if (mat) part.core.material = mat;
            });
          }
        }
      }),
    );
    const key = built.map((b) => b?.stem ?? '').join('|');
    return () => {
      this.setBeard(built.filter((b): b is HairBuilt => !!b), key);
      for (const a of assign) a();
      this.applyMorphs(look);
    };
  }

  private setBeard(on: HairBuilt[], key: string) {
    if (key === this.beardKey) return;
    for (const b of this.beardOn) this.root.remove(b.group);
    this.beardOn = on;
    for (const b of on) this.root.add(b.group);
    this.beardKey = key;
    const r = touchRecent(this.beardOrder, on.map((b) => b.stem), KEEP_RECENT.beard);
    this.beardOrder = r.order;
    this.hairManifest
      .then((hm) => {
        for (const stem of r.evict) {
          const p = this.hairs.get(stem);
          this.hairs.delete(stem);
          this.hairsReady.delete(stem);
          p?.then((b) => {
            b.group.traverse(this.freeBound);
            const glb = hm.meshes[stem]?.glb;
            if (glb) this.dropGlb(glb);
          }).catch(() => {});
        }
      })
      .catch(() => {});
  }

  // ---------------------------------------------------------------- слои лица
  private decalM: Promise<DecalManifest> | null = null;
  private decalParts = new Map<string, Promise<DecalBuilt>>();
  private decalReady = new Map<string, DecalBuilt>();
  /** показанные экземпляры: ключ «строка|меш|чанк» → меш на скелете V */
  private decalLive = new Map<string, MorphMesh>();
  private decalOrder: string[] = [];
  private headIndex: HeadIndex | null = null;

  private decalManifest(): Promise<DecalManifest> {
    if (!this.decalM) this.decalM = optionalJson<DecalManifest>('tex/face/decals.json', (p) => this.decalM === p && (this.decalM = null));
    return this.decalM;
  }

  /** Атрибуты кожи под мешем слоя (headUv, tangent) — для материала слоя лица. */
  private skinUnder(g: THREE.BufferGeometry, label = '') {
    if (g.getAttribute('headUv')) return;
    const t = transferHeadAttrs(g.getAttribute('position').array as Float32Array, this.headAttrs());
    g.setAttribute('headUv', new THREE.Float32BufferAttribute(t.uv, 2));
    if (t.tangent) g.setAttribute('tangent', new THREE.Float32BufferAttribute(t.tangent, 4));
    if (import.meta.env.DEV && t.misses) console.debug(`[avatar] слой ${label}: ${t.misses} вершин далеко от кожи`);
  }

  /** Индекс вершин головы в осях привязки (для transferHeadAttrs): один на голову, не на каждый меш слоя. */
  private headAttrs(): HeadIndex {
    if (!this.headIndex) {
      const copy = (a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, n: number) => {
        if (!a) return null;
        const out = new Float32Array(a.count * n);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < n; c++) out[i * n + c] = a.getComponent(i, c);
        return out;
      };
      const out: HeadPart[] = [];
      for (const m of this.head) {
        const pos = copy(m.geometry.getAttribute('position'), 3);
        const uv = copy(m.geometry.getAttribute('uv'), 2);
        if (pos && uv) out.push({ pos, uv, tangent: copy(m.geometry.getAttribute('tangent'), 4) });
      }
      this.headIndex = buildHeadIndex(out);
    }
    return this.headIndex;
  }

  private buildDecal(m: DecalManifest, stem: string): Promise<DecalBuilt> {
    let p = this.decalParts.get(stem);
    if (!p) {
      p = (async () => {
        const info = m.meshes[stem];
        if (!info) throw new Error('decal: нет меша ' + stem);
        const gl = await this.gltf(info.glb);
        const subs = new Map<number, MorphMesh>();
        for (const mesh of meshesOf(gl.scene)) {
          mesh.removeFromParent();
          this.sk.bind(mesh);
          // кожа под слоем: UV и касательные ближайших вершин головы (материал декали читает кожу по ним)
          if (info.kind === 'decal') this.skinUnder(mesh.geometry, `${stem}/${mesh.name}`);
          const sub = info.submeshes.find((s) => s.glbMesh === mesh.name);
          subs.set(sub?.chunk ?? chunkOf(mesh.name), mesh as MorphMesh);
        }
        const built: DecalBuilt = { stem, file: info.glb, kind: info.kind, subs };
        if (this.decalParts.get(stem) === p) this.decalReady.set(stem, built);
        return built;
      })();
      p.catch(() => this.decalParts.delete(stem));
      this.decalParts.set(stem, p);
    }
    return p;
  }

  /** Экземпляр чанка меша слоя для строки редактора (один меш может нужен двум строкам — свой экземпляр у каждой). */
  private decalInstance(key: string, tpl: MorphMesh, kind: 'decal' | 'piercing'): MorphMesh {
    let m = this.decalLive.get(key);
    if (!m) {
      const inst = new THREE.SkinnedMesh(tpl.geometry, tpl.material) as unknown as MorphMesh;
      inst.name = tpl.name + '_' + key;
      inst.bind(tpl.skeleton, tpl.bindMatrix);
      inst.frustumCulled = false;
      inst.castShadow = kind === 'piercing';
      inst.receiveShadow = true;
      inst.renderOrder = kind === 'decal' ? ORDER.faceDecal : 0;
      inst.layers.enable(HEAD_LAYER);
      if (tpl.morphTargetDictionary) {
        inst.morphTargetDictionary = tpl.morphTargetDictionary;
        inst.morphTargetInfluences = new Array(tpl.morphTargetInfluences.length).fill(0);
      }
      m = inst;
    }
    return m;
  }

  /**
   * Слои лица (tex/face/decals.json): макияж глаз, губ и скул, веснушки, изъяны, тату, шрамы,
   * кибер-импланты, пирсинг. Каждая строка — свои меши (чанки из маски игры) с материалом
   * appearance. Возвращает функцию «надеть» или null, когда менять нечего (те же меши с теми
   * же материалами): тогда движок не прогревает шейдеры и не держит полный fps впустую.
   * Без файла слоёв в наборе V остаётся как есть.
   */
  async prepareDecals(look: AvatarLook): Promise<(() => void) | null> {
    if (!look.faceLayers.length && !this.decalLive.size) return null;
    const m = await this.decalManifest();
    const tone = this.toneOf(look);
    const skinG = this.skinM[this.gender];
    const want: { key: string; build: Promise<DecalBuilt | null>; chunk: number; mat: Promise<THREE.Material | null> }[] = [];
    for (const pick of look.faceLayers) {
      for (const c of resolveFaceLayer(m.apps, pick, this.code, tone)) {
        const info = m.meshes[c.mesh];
        if (!info) continue;
        const keys = info.appearances[c.app] ?? [];
        const build = this.buildDecal(m, c.mesh).catch(() => null);
        for (const sub of info.submeshes) {
          if (!c.chunks.includes(sub.chunk)) continue;
          const mk = keys[sub.chunk];
          const def = mk ? m.materials[mk] : undefined;
          if (!def || !mk) continue;
          const mat =
            def.type === 'piercing'
              ? this.mats.piercing(def)
              : this.mats.faceDecal(skinG, this.gender, look.skinApp, look.skinType, mk, def);
          want.push({ key: `${pick.slot}|${c.mesh}|${sub.chunk}`, build, chunk: sub.chunk, mat: mat.catch(() => null) });
        }
      }
    }
    const ready = await Promise.all(want.map(async (w) => ({ w, b: await w.build, mat: await w.mat })));
    const shown = ready.filter(({ w, b, mat }) => b?.subs.get(w.chunk) && mat);
    if (shown.length === this.decalLive.size && shown.every(({ w, mat }) => this.decalLive.get(w.key)?.material === mat)) return null;
    return () => {
      const next = new Map<string, MorphMesh>();
      for (const { w, b, mat } of ready) {
        const tpl = b?.subs.get(w.chunk);
        if (!b || !tpl || !mat) continue;
        const inst = this.decalInstance(w.key, tpl, b.kind);
        inst.material = mat;
        next.set(w.key, inst);
      }
      for (const [k, mesh] of this.decalLive) if (!next.has(k)) mesh.removeFromParent();
      for (const mesh of next.values()) if (mesh.parent !== this.root) this.root.add(mesh);
      this.decalLive = next;
      this.applyMorphs(look);
      this.evictDecals([...new Set(ready.filter((r) => r.b).map((r) => r.b!.stem))]);
    };
  }

  /** Давно снятые меши слоёв лица: геометрия освобождается, glb выгружается из кеша. */
  private evictDecals(live: string[]) {
    const r = touchRecent(this.decalOrder, live, KEEP_RECENT.decals);
    this.decalOrder = r.order;
    for (const stem of r.evict) {
      const p = this.decalParts.get(stem);
      this.decalParts.delete(stem);
      this.decalReady.delete(stem);
      p?.then((b) => {
        b.subs.forEach(this.freeBound);
        this.dropGlb(b.file);
      }).catch(() => {});
    }
  }

  /** Давно снятые причёски: геометрия освобождается, glb выгружается из кеша. */
  /** Выгрузить меш, привязанный к скелету: геометрия и его собственные кости (dyng_*). */
  private freeBound = (o: THREE.Object3D) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) this.sk.release(o as THREE.SkinnedMesh);
    freeMesh(o);
  };

  private evictHair(hm: HairManifest) {
    const r = touchRecent(this.hairOrder, this.hairOn.map((b) => b.stem), KEEP_RECENT.hair);
    this.hairOrder = r.order;
    for (const stem of r.evict) {
      const p = this.hairs.get(stem);
      this.hairs.delete(stem);
      this.hairsReady.delete(stem);
      // материалы и текстуры причёски освобождает Materials.trim: на живых мешах их больше нет
      p?.then((b) => {
        b.group.traverse(this.freeBound);
        const glb = hm.meshes[stem]?.glb;
        if (glb) this.dropGlb(glb);
      }).catch(() => {});
    }
  }

  /** Материалы на мешах тела и в кеше причёсок, наготы и слоёв головы (их не освобождаем). */
  collectMaterials(out: Set<THREE.Material>) {
    const add = (o: THREE.Object3D) =>
      o.traverse((x) => {
        const m = (x as THREE.Mesh).material;
        if (Array.isArray(m)) m.forEach((y) => out.add(y));
        else if (m) out.add(m);
      });
    add(this.root);
    for (const p of this.hairsReady.values()) add(p.group);
    for (const b of this.intimateReady.values()) for (const m of b.subs.values()) add(m);
  }

  update(dt: number, camera: THREE.Vector3) {
    this.anim.update(dt);
    // клип поднимает кисть к лицу выше, чем в игре, — опускаем её до кадра лица
    this.handGuard.apply(this.root);
    // Поднятая кисть — тылом (ногтями) к камере
    this.nailTwist.apply(dt, this.anim.handUp, camera);
    // В позе ногтей голова наклонена к поднятой кисти — V смотрит на неё, а не в камеру
    this.face.update(dt, camera, this.anim.handUp ? this.raisedHand(this.gazeW) : null);
    // Свет внутри рта: чем плотнее сомкнуты губы, тем темнее зубы и язык
    const k = 0.3 + 0.7 * this.face.mouthOpen;
    for (const m of this.teeth) {
      const u = (m.material as THREE.Material).userData.skin as { uMouthLight?: { value: number } } | undefined;
      if (u?.uMouthLight) u.uMouthLight.value = k;
    }
    // Рельеф карты нормалей у кромки губ гаснет, пока рот открыт (SKIN_LIP_FADE)
    for (const m of [...this.head, ...this.decalLive.values()]) {
      const u = (m.material as THREE.Material).userData.skin as { uMouthOpen?: { value: number } } | undefined;
      if (u?.uMouthOpen) u.uMouthOpen.value = this.face.mouthOpen;
    }
    // Затенение у кромки век гаснет, пока веки сомкнуты
    const open = 1 - THREE.MathUtils.smoothstep(this.face.eyesClosed, 0.4, 0.9);
    for (const m of this.wet) {
      const u = (m.material as THREE.Material).userData.eyeShadow as { uEyesOpen?: { value: number } } | undefined;
      if (u?.uEyesOpen) u.uEyesOpen.value = open;
    }
  }

  private gazeW = new THREE.Vector3();
  private tmpW = new THREE.Vector3();

  /** Середина поднятой (более высокой) кисти — между запястьем и кончиком среднего пальца, мировые оси. */
  private raisedHand(out: THREE.Vector3): THREE.Vector3 | null {
    let best = -Infinity;
    for (const side of ['Left', 'Right']) {
      const hand = this.sk.get(`${side}Hand`);
      const tip = this.sk.get(`${side}HandMiddle3`);
      if (!hand || !tip) continue;
      hand.getWorldPosition(this.tmpW);
      const y = this.tmpW.y;
      if (y <= best) continue;
      best = y;
      tip.getWorldPosition(out).add(this.tmpW).multiplyScalar(0.5);
    }
    return best > -Infinity ? out : null;
  }

  /**
   * Насколько клип увёл голову от позы привязки (мировые оси, м). Камера крупных планов
   * мягко следует за этим сдвигом, чтобы лицо не уезжало из кадра.
   */
  headDrift(out: THREE.Vector3): THREE.Vector3 {
    const head = this.sk.get('Head');
    const bind = this.sk.bindWorld.get('Head');
    if (!head || !bind) return out.set(0, 0, 0);
    head.getWorldPosition(out);
    return out.sub(this.headBind.setFromMatrixPosition(bind).applyMatrix4(this.root.matrixWorld));
  }
  private headBind = new THREE.Vector3();

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.anim.dispose();
    this.root.traverse(freeMesh);
    // причёски и части наготы, которые сейчас сняты, на сцене не висят (и те, что ещё грузятся)
    for (const p of this.hairs.values()) p.then((b) => b.group.traverse(freeMesh)).catch(() => {});
    for (const p of this.intimateParts.values()) p.then((b) => b.subs.forEach(freeMesh)).catch(() => {});
    for (const p of this.decalParts.values()) p.then((b) => b.subs.forEach(freeMesh)).catch(() => {});
    // Меши унесены из кешированных сцен: эти glb больше никому не годятся
    for (const rel of [...this.glbs]) this.dropGlb(rel);
  }
  private disposed = false;
}

/** Геометрия меша и текстура костей его скелета (у каждого меша свой THREE.Skeleton). */
function freeMesh(o: THREE.Object3D) {
  const m = o as THREE.SkinnedMesh;
  if (!m.isMesh) return;
  m.geometry.dispose();
  // dispose() скелета идемпотентен: у прядей кромки и слёзной кромки скелет общий с основным мешем
  if (m.isSkinnedMesh) m.skeleton?.dispose();
}
