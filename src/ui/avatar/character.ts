// V целиком: голова, глаза, брови, зубы, тело, руки, ногти, бельё и причёска на одном
// скелете. Сборка по манифестам выгрузки; внешний вид меняется заменой материалов и
// весов морфов, причёска и зубы догружаются отдельно.
import * as THREE from 'three';
import type { Gender } from '../../model/catalog';
import type {
  AssetStore,
  BodyManifest,
  FaceManifest,
  HairHint,
  HairManifest,
  SkeletonJson,
  SkinManifest,
} from './assets';
import { loadJson } from './assets';
import { FaceRig } from './face';
import { morphTargetMatches, type AvatarLook } from './look';
import type { Materials } from './materials';
import { BodyAnimator } from './motion';
import { weldSeams } from './seams';
import { MasterSkeleton } from './skeleton';

const CODE: Record<Gender, 'pwa' | 'pma'> = { female: 'pwa', male: 'pma' };

type MorphMesh = THREE.SkinnedMesh & { morphTargetDictionary: Record<string, number>; morphTargetInfluences: number[] };

/** Порядок прозрачных слоёв поверх кожи. */
const ORDER = { brows: 2, wet: 3, cap: 4, decal: 4, hairFringe: 6 };

function meshesOf(root: THREE.Object3D): THREE.SkinnedMesh[] {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) out.push(m);
  });
  return out;
}

const chunkOf = (name: string) => Number(/submesh_(\d+)/.exec(name)?.[1] ?? -1);

/**
 * Перенести дельты морфов груди с торса на бюстгальтер: каждой вершине белья —
 * дельта ближайшей вершины тела (поиск по сетке 2 см). Белье игры этих морфов не имеет.
 */
function transferMorphs(from: THREE.SkinnedMesh[], to: THREE.SkinnedMesh[], names: string[]) {
  const CELL = 0.02;
  const grid = new Map<string, number[]>();
  const pts: number[] = [];
  const deltas: number[][] = names.map(() => []);
  for (const m of from) {
    const dict = m.morphTargetDictionary ?? {};
    const pos = m.geometry.getAttribute('position');
    const md = names.map((n) => {
      const i = Object.entries(dict).find(([k]) => morphTargetMatches(k, n))?.[1];
      return i === undefined ? null : m.geometry.morphAttributes.position?.[i];
    });
    if (md.every((x) => !x)) continue;
    for (let v = 0; v < pos.count; v++) {
      const id = pts.length / 3;
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      pts.push(x, y, z);
      names.forEach((_, k) => {
        const a = md[k];
        deltas[k].push(a ? a.getX(v) : 0, a ? a.getY(v) : 0, a ? a.getZ(v) : 0);
      });
      const key = `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
      const cell = grid.get(key);
      if (cell) cell.push(id);
      else grid.set(key, [id]);
    }
  }
  if (!pts.length) return;
  for (const m of to) {
    const g = m.geometry;
    const pos = g.getAttribute('position');
    const out = names.map(() => new Float32Array(pos.count * 3));
    for (let v = 0; v < pos.count; v++) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
      let best = -1;
      let bd = Infinity;
      for (let r = 1; r <= 3 && best < 0; r++)
        for (let i = -r; i <= r; i++)
          for (let j = -r; j <= r; j++)
            for (let k = -r; k <= r; k++) {
              const cell = grid.get(`${cx + i},${cy + j},${cz + k}`);
              if (!cell) continue;
              for (const id of cell) {
                const d = (pts[id * 3] - x) ** 2 + (pts[id * 3 + 1] - y) ** 2 + (pts[id * 3 + 2] - z) ** 2;
                if (d < bd) (bd = d), (best = id);
              }
            }
      if (best < 0) continue;
      names.forEach((_, n) => out[n].set(deltas[n].slice(best * 3, best * 3 + 3), v * 3));
    }
    const ma = g.morphAttributes;
    const base = ma.position?.length ?? 0;
    ma.position = [...(ma.position ?? []), ...out.map((a) => new THREE.Float32BufferAttribute(a, 3))];
    if (ma.normal) ma.normal = [...ma.normal, ...out.map(() => new THREE.Float32BufferAttribute(new Float32Array(pos.count * 3), 3))];
    g.morphTargetsRelative = true;
    // Имена целей у glTF-меша заданы загрузчиком — дописываем новые вручную
    const dict = { ...(m.morphTargetDictionary ?? {}) };
    names.forEach((n, k) => (dict[n + '_breast'] = base + k));
    m.morphTargetDictionary = dict;
    m.morphTargetInfluences = [...(m.morphTargetInfluences ?? []), ...names.map(() => 0)];
  }
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
  private morphMeshes: MorphMesh[] = [];
  private head: THREE.SkinnedMesh[] = [];
  private eyeballs: THREE.SkinnedMesh[] = [];
  private wet: THREE.SkinnedMesh[] = [];
  private lashes: THREE.SkinnedMesh[] = [];
  private brows: THREE.SkinnedMesh[] = [];
  private bodySkin: { mesh: THREE.SkinnedMesh; part: 'body' | 'arms' }[] = [];
  private nails: THREE.SkinnedMesh[] = [];
  private teeth: THREE.SkinnedMesh[] = [];
  private hairs = new Map<string, Promise<HairBuilt>>();
  private hairOn: HairBuilt[] = [];
  private hairKey = '';
  private extras: Promise<void> | null = null;
  private hairManifest: Promise<HairManifest>;
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
    this.face = new FaceRig(this.sk, bodyM.faceRig[this.code]);
    this.anim = new BodyAnimator(this.root);
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
    await ch.loadCore();
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
    return e ? this.store.gltf(e.file) : Promise.resolve(null);
  }

  private async loadCore() {
    const g = this.gender;
    const c = this.code;
    const fm = this.faceM.meshes[g];
    const legsKey = this.liftedLegsKey() ?? (g === 'female' ? `${c}_legs_cs_flat` : null);
    const under = g === 'female' ? [`${c}_underwear_panties`, `${c}_underwear_bra`] : [`${c}_underwear_boxers`];
    const [head, eyes, brows, body, armL, armR, legs, ...uw] = await Promise.all([
      this.store.gltf(`glb/h0_000_${c}__morphs.morphtarget.glb`),
      this.store.gltf(fm.eyes.glb),
      this.store.gltf(fm.eyebrows.glb),
      this.glb(`${c}_body`),
      this.glb(`${c}_arm_l`),
      this.glb(`${c}_arm_r`),
      legsKey ? this.glb(legsKey) : Promise.resolve(null),
      ...under.map((k) => this.glb(k)),
    ]);

    for (const m of meshesOf(head.scene)) {
      this.add(m);
      this.head.push(m);
    }
    for (const m of meshesOf(eyes.scene)) {
      const role = fm.eyes.parts[m.name]?.role;
      if (role === 'eyelashes') {
        this.add(m, { cast: false });
        this.lashes.push(m);
      } else if (role === 'eye_wetness') {
        this.add(m, { cast: false, receive: false });
        m.renderOrder = ORDER.wet;
        this.wet.push(m);
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
    // Бельё всегда надето: в редакторе V показана в «цензурном» виде
    const uwKeys = g === 'female' ? ['pwa|panties', 'pwa|bra'] : ['pma|boxers'];
    for (let i = 0; i < uw.length; i++) {
      const gl = uw[i];
      if (!gl) continue;
      const list = this.bodyM.materials.underwear[uwKeys[i]] ?? [];
      const ms = meshesOf(gl.scene);
      if (uwKeys[i] === 'pwa|bra') {
        const torso = bodyMeshes.filter((m) => chunkOf(m.name) <= 2);
        transferMorphs(torso, ms, ['t0_000_wa_base__full_breast_small', 't0_000_wa_base__full_breast_big']);
      }
      for (const m of ms) {
        const d = list.find((x) => x.submesh === chunkOf(m.name));
        if (d?.shader === 'decal') {
          this.add(m, { cast: false });
          m.renderOrder = ORDER.decal;
          m.material = await this.mats.decal(d);
        } else {
          this.add(m);
          m.material = d ? await this.mats.standard('underwear', d.baseColor, d.orm, d.normal, false) : new THREE.MeshStandardMaterial({ color: '#2a1228', roughness: 0.6 });
        }
      }
    }
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
    const teeth = this.store
      .gltf(fm.teeth.glb)
      .then((gl) => {
        for (const m of meshesOf(gl.scene)) {
          this.add(m, { cast: false });
          m.visible = false; // до материала
          this.teeth.push(m);
        }
      })
      .catch(() => {});
    const nails = Promise.all([this.glb(`${c}_nails_l`), this.glb(`${c}_nails_r`)])
      .then((gs) => {
        for (const gl of gs)
          if (gl)
            for (const m of meshesOf(gl.scene)) {
              this.add(m, { cast: false });
              m.visible = false;
              this.nails.push(m);
            }
      })
      .catch(() => {});
    const anim = this.store
      .gltf(this.bodyM.animations.files[c].file)
      .then((gl) => this.anim.setClips(gl.animations, this.sk))
      .catch(() => {});
    this.extras = Promise.all([teeth, nails, anim]).then(() => {
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
    const tone = (look.skinApp && this.bodyM.headSkinColorToTone[look.skinApp]) || this.bodyM.defaultCharCreatorOutfit.defaultTone;
    const eye = (look.eyesApp && this.faceM.eyes_color[look.eyesApp]) || Object.entries(this.faceM.eyes_color).find(([k]) => k.includes(`_${this.code}__`))?.[1];
    const lash = (look.lashApp && this.faceM.eyelash_color[look.lashApp]) || Object.entries(this.faceM.eyelash_color).find(([k]) => k.startsWith(g + '__'))?.[1];
    const browStyle = look.browStyle ? this.faceM.eyebrows.styles[g][look.browStyle] : undefined;
    const browCol = (look.browApp && this.faceM.eyebrows.colors[look.browApp]) || Object.entries(this.faceM.eyebrows.colors).find(([k]) => k.startsWith(g + '__'))?.[1];
    const exception = this.faceM.eyebrows.exceptions.find((x) => x.gender === g && x.style === look.browStyle && x.app === look.browApp);
    const teethE = (look.teethApp && this.faceM.teeth[look.teethApp]) || this.faceM.teeth[`${g}_ht_000__basehead`];
    const nailE = (look.nailsApp && this.bodyM.materials.nails.byGender[this.code][look.nailsApp]) || Object.values(this.bodyM.materials.nails.byGender[this.code])[0];
    const texSets = this.bodyM.textures;

    const [headMat, bodyMat, armsMat, eyeMat, wetMat, lashMat, browMat, teethMat, nailMat] = await Promise.all([
      this.mats.headSkin(skinG, g, look.skinApp, look.skinType),
      this.mats.bodySkin(texSets[`${this.code}_body`], `${this.code}_body`, tone),
      this.mats.bodySkin(texSets[`${this.code}_arms`], `${this.code}_arms`, tone),
      eye ? this.mats.eyeball(eye) : null,
      eye ? this.mats.eyeWetness(eye) : null,
      lash ? this.mats.lashes(lash, true) : null,
      browStyle && browCol ? this.mats.brows(browStyle, browCol, exception?.gradientMapPng ?? browCol.gradientMapPng) : null,
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

  private applyMorphs(look: AvatarLook) {
    for (const m of this.morphMeshes) {
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
        const gl = await this.store.gltf(info.glb);
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
          group.add(m);
          const part: HairBuilt['parts'][number] = { core: m, kind: sub.kind, doubleSided: sub.doubleSided, index };
          if (sub.kind === 'cards') {
            m.castShadow = true;
            const f = new THREE.SkinnedMesh(m.geometry, m.material);
            f.name = m.name + '_fringe';
            f.bind(m.skeleton, m.bindMatrix);
            f.frustumCulled = false;
            f.renderOrder = ORDER.hairFringe;
            group.add(f);
            part.fringe = f;
          } else {
            m.castShadow = sub.kind !== 'cap';
            if (sub.kind === 'cap') m.renderOrder = ORDER.cap;
          }
          parts.push(part);
        }
        return { group, parts, stem };
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
          const mat = await (mdef.type === 'cap' ? this.mats.hairCap(hm, mdef) : this.mats.accessory(mdef)).catch(() => null);
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
      }
      for (const a of assign) a();
    };
  }

  update(dt: number, camera: THREE.Vector3) {
    this.anim.update(dt);
    this.face.update(dt, camera);
  }

  dispose() {
    this.anim.dispose();
  }
}
