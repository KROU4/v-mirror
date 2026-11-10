// Загрузка набора ассетов игры (asset pack): манифесты, glb и текстуры. Все пути в
// манифестах заданы от корня набора (tools/local в разработке); адрес файла даёт
// src/assets/pack.ts — /game/<путь> в dev или blob: из подключённой папки.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { fetchGameJson, gameAssetUrl } from '../../assets/pack';

// ------------------------------------------------------------------ манифесты (данные, без логики)
/* Поля описаны ровно настолько, насколько их читает движок; остальное — unknown. */
export interface SkinToneEntry {
  albedo: string;
  tintColor: string;
  tintScale: number;
}
export interface SkinGender {
  maps: { normal: string; roughness: string; detailNormal: string; microDetailNormal: string };
  params: { DetailNormalInfluence: number; MicroDetailInfluence: number; MicroDetailUVScale01: number };
  skinTypes: Record<string, { albedo: string }>;
  skinTones: Record<string, { byskinType: Record<string, SkinToneEntry>; tintColor: string; tintScale: number }>;
}
export interface SkinManifest {
  female: SkinGender;
  male: SkinGender;
}

export interface FacePart {
  glb: string;
  parts: Record<string, { chunk: number; role: string }>;
}
export interface EyeEntry {
  eyeball: { shader: string; maps: { albedo: string; normal?: string | null; orm?: string | null } };
  eye_wetness?: {
    maps: { maskA: string; maskRGBA?: string };
    params: { ShadowColor: string; Intensity: number; Exponent: number; WetnessStrength?: number };
  };
}
export interface LashEntry {
  eyelashes: { maps: { alpha: string }; suggestedColor: { product: string } };
}
export interface TeethEntry {
  teeth_gums_tongue: {
    shader: string;
    maps: { albedo: string; normal?: string; orm?: string; tintColorMask?: string };
    params: { TintColor?: string; TintScale?: number };
  };
}
export interface BrowStyle {
  diffuseRGBA: string;
  secondaryAlpha: string;
  normal: string;
}
export interface BrowColour {
  DiffuseAlpha: number;
  GradientMapIntensity: number;
  SecondaryDiffuseColor: string;
  SecondaryDiffuseAlphaIntensity: number;
  gradientMapPng: string;
  suggestedStrandColor: string;
}
export interface FaceManifest {
  meshes: Record<'female' | 'male', { eyes: FacePart; eyebrows: FacePart; teeth: FacePart }>;
  eyes_color: Record<string, EyeEntry>;
  eyelash_color: Record<string, LashEntry>;
  teeth: Record<string, TeethEntry>;
  eyebrows: {
    styles: Record<'female' | 'male', Record<string, BrowStyle>>;
    colors: Record<string, BrowColour>;
    exceptions: { gender: string; style: string; app: string; gradientMapPng: string }[];
  };
}

export interface HairMaterial {
  type: 'hairCards' | 'cap' | 'accessory' | 'beardShadow';
  /** карточки бороды (hairCards): свои параметры master-материала бороды */
  beard?: boolean;
  cardSet?: string;
  profile?: string;
  roughnessScale?: number;
  roughnessBias?: number;
  shadowStrength?: number;
  diffuse?: string | null;
  diffuseConstant?: number | null;
  mask?: string | null;
  gradientLUT?: string;
  secondaryMask?: string | null;
  secondaryMaskInfluence?: number;
  secondaryMaskUVScale?: number;
  diffuseColor?: string;
  diffuseAlpha?: number;
  shadowMin?: number;
  shadowRoughness?: number;
  fallbackColor?: string;
  roughness?: number;
  metalness?: number;
}
/** Часть сборки бороды: меш, его appearance и номера показанных чанков (chunkMask игры). */
export interface BeardComponent {
  mesh: string;
  app: string;
  chunks: number[];
}
export interface HairHint {
  meshes: string[];
  colours: Record<string, Record<string, string>>;
}
export interface HairManifest {
  textures: Record<string, { file: string; colorSpace: string }>;
  cardSets: Record<string, { alpha: string | null; packed: string }>;
  profiles: Record<string, { ramp: string }>;
  materials: Record<string, HairMaterial>;
  meshes: Record<
    string,
    {
      glb: string;
      submeshes: { glbMesh: string; doubleSided: boolean; kind: string; chunk?: number }[];
      appearances: Record<string, (string | null)[]>;
      /** меш с морфами лица (борода): веса — как у головы */
      morphs?: boolean;
    }
  >;
  /** бороды: app части бороды → app цвета → компоненты (нет в наборах старее бород) */
  beards?: { apps: Record<string, Record<string, BeardComponent[]>> };
  hints: Record<'female' | 'male', Record<string, HairHint>>;
  hintsPlain?: Record<'female' | 'male', Record<string, HairHint>>;
}

export interface BodyGlb {
  file: string;
  submeshes: { index: number; material: string }[];
  morphTargets?: string[];
}
export interface BodyTexSet {
  albedoByTone: Record<string, string>;
  normal: string;
  orm: string;
}
export interface DecalMat {
  submesh: number;
  shader: 'standard' | 'decal';
  baseColor: string;
  orm?: string;
  normal?: string;
  baseColorScaleLinear?: [number, number, number];
  roughness?: number;
  metalness?: number;
}
export interface NailMat {
  albedo: string;
  orm: string;
  normal: string;
}
export interface BodyManifest {
  glb: Record<string, BodyGlb>;
  materials: {
    personalLink: { baseColor: string; orm: string; normal: string };
    /** бельё в выгрузке есть, но редактор, как игра, показывает V без него */
    underwear?: Record<string, DecalMat[]>;
    nails: { byGender: Record<'pwa' | 'pma', Record<string, NailMat>> };
  };
  textures: Record<string, BodyTexSet>;
  headSkinColorToTone: Record<string, string>;
  defaultCharCreatorOutfit: { defaultTone: string };
  faceRig: Record<'pwa' | 'pma', FaceRigSpec>;
  animations: { files: Record<'pwa' | 'pma', { file: string }> };
  /** параллельная выгрузка может добавить ноги с приподнятой пяткой (lifted_feet) */
  legsLifted?: Record<string, BodyGlb | string>;
}
export interface FaceRigSpec {
  jaw: { joint: string };
  eyelids: {
    upperRoots: string[];
    lowerRoots: string[];
    cornerJoints: string[];
    eyeCenter: { l: [number, number, number]; r: [number, number, number] };
    blinkUpperDeg: number;
    blinkLowerDeg: number;
  };
  eyes: { joints: string[] };
}

export interface SkeletonBone {
  name: string;
  parent: string | null;
  bindPosition: [number, number, number];
  bindQuaternion: [number, number, number, number];
  localPosition: [number, number, number];
  localQuaternion: [number, number, number, number];
}
export interface SkeletonJson {
  bones: SkeletonBone[];
}

// ------------------------------------------------------------------ загрузчики
/** JSON набора (кешируется в pack.ts, пока набор не сменится). */
export function loadJson<T>(rel: string): Promise<T> {
  return fetchGameJson<T>(rel);
}

export type TexKind = 'color' | 'data';
export interface TexOpts {
  repeat?: boolean;
  /** без мипмапов и с линейной фильтрацией — для LUT и рамп */
  lut?: boolean;
}

/**
 * Кеш GPU-ресурсов одного движка: glb разбираются один раз, текстуры создаются один раз
 * на (путь, тип). dispose() освобождает всё, что успело загрузиться.
 */
export class AssetStore {
  private loader = new GLTFLoader();
  private gltfs = new Map<string, Promise<GLTF>>();
  private textures = new Map<string, Promise<THREE.Texture>>();
  /** загруженные текстуры по ключу (для вытеснения неиспользуемых) */
  private loaded = new Map<string, THREE.Texture>();
  /**
   * Картинки декодируются вне главного потока (createImageBitmap), а не в кадре первой
   * отрисовки, как у HTMLImageElement. Ориентация и альфа — как в файле (flipY = false).
   */
  private bmpLoader =
    typeof createImageBitmap === 'function'
      ? new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
      : null;
  private texLoader = new THREE.TextureLoader();
  anisotropy = 1;

  /** Сколько текстур в кеше и сколько они занимают на GPU (RGBA8 с мипами), МБ. */
  get textureCount() {
    return this.loaded.size;
  }
  get textureMB() {
    return this.sizeMB(this.loaded.values());
  }

  /** Сколько видеопамяти (МБ) занимают эти текстуры. */
  sizeMB(textures: Iterable<THREE.Texture>) {
    let b = 0;
    for (const t of textures) {
      const img = t.image as { width?: number; height?: number } | undefined;
      b += (img?.width ?? 0) * (img?.height ?? 0) * 4 * (t.generateMipmaps ? 4 / 3 : 1);
    }
    return Math.round(b / 1e5) / 10;
  }

  /**
   * Освободить текстуры, которыми не пользуется ни один оставшийся материал (keep). Они
   * уходят из GPU и из кеша; понадобятся снова — загрузятся заново.
   */
  trim(keep: Set<THREE.Texture>) {
    for (const [key, t] of this.loaded) {
      if (keep.has(t)) continue;
      this.loaded.delete(key);
      this.textures.delete(key);
      freeTexture(t);
    }
  }

  gltf(rel: string): Promise<GLTF> {
    let p = this.gltfs.get(rel);
    if (!p) {
      p = gameAssetUrl(rel).then((url) => this.loader.loadAsync(url));
      p.catch(() => this.gltfs.delete(rel));
      this.gltfs.set(rel, p);
    }
    return p;
  }

  /** Выгрузить glb из кеша и освободить его геометрию (меш больше не нужен). */
  dropGltf(rel: string) {
    const p = this.gltfs.get(rel);
    if (!p) return;
    this.gltfs.delete(rel);
    p.then((g) =>
      g.scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      }),
    ).catch(() => {});
  }

  /** Освободить текстуру (все варианты загрузки этого файла). */
  dropTexture(rel: string) {
    for (const [key, p] of this.textures)
      if (key.startsWith(rel + '|')) {
        this.textures.delete(key);
        this.loaded.delete(key);
        p.then(freeTexture).catch(() => {});
      }
  }

  /**
   * Текстура выгрузки: flipY = false (UV по соглашению glTF), цвет — sRGB, данные — линейные.
   * Промис разрешается, когда картинка загружена.
   */
  texture(rel: string, kind: TexKind, opts: TexOpts = {}): Promise<THREE.Texture> {
    const key = `${rel}|${kind}|${opts.repeat ? 'r' : 'c'}|${opts.lut ? 'l' : 'm'}`;
    let p = this.textures.get(key);
    if (!p) {
      p = gameAssetUrl(rel).then((url) => this.load(url)).then((t) => {
        t.flipY = false;
        t.colorSpace = kind === 'color' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        const wrap = opts.repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
        t.wrapS = t.wrapT = wrap;
        if (opts.lut) {
          t.generateMipmaps = false;
          t.minFilter = THREE.LinearFilter;
          t.magFilter = THREE.LinearFilter;
        } else {
          t.anisotropy = this.anisotropy;
        }
        t.needsUpdate = true;
        if (this.textures.get(key) === mine) this.loaded.set(key, t);
        return t;
      });
      const mine = p;
      p.catch(() => {
        if (this.textures.get(key) === mine) this.textures.delete(key);
      });
      this.textures.set(key, p);
    }
    return p;
  }

  private async load(url: string): Promise<THREE.Texture> {
    if (!this.bmpLoader) return this.texLoader.loadAsync(url);
    return new THREE.Texture(await this.bmpLoader.loadAsync(url));
  }

  /** То же, но null вместо ошибки (необязательная карта). */
  maybeTexture(rel: string | null | undefined, kind: TexKind, opts?: TexOpts): Promise<THREE.Texture | null> {
    if (!rel) return Promise.resolve(null);
    return this.texture(rel, kind, opts).catch(() => null);
  }

  dispose() {
    for (const p of this.textures.values()) p.then(freeTexture).catch(() => {});
    for (const p of this.gltfs.values())
      p.then((g) =>
        g.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.geometry.dispose();
        }),
      ).catch(() => {});
    this.textures.clear();
    this.loaded.clear();
    this.gltfs.clear();
  }
}

/** Освободить текстуру на GPU и её ImageBitmap (память картинки браузер отдаёт только после close). */
function freeTexture(t: THREE.Texture) {
  t.dispose();
  const img = t.image as unknown;
  if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) img.close();
}
