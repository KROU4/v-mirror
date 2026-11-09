// Загрузка выгрузки игры: манифесты, glb и текстуры по /game/<путь от tools/local>.
// Все пути в манифестах заданы от tools/local, поэтому url = '/game/' + путь.
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export const gameUrl = (rel: string) => '/game/' + rel.replace(/^\/+/, '');

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
  type: 'hairCards' | 'cap' | 'accessory';
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
  fallbackColor?: string;
  roughness?: number;
  metalness?: number;
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
      submeshes: { glbMesh: string; doubleSided: boolean; kind: string }[];
      appearances: Record<string, (string | null)[]>;
    }
  >;
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
    underwear: Record<string, DecalMat[]>;
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
const jsonCache = new Map<string, Promise<unknown>>();
/** JSON из выгрузки (кешируется на всё приложение — манифесты не меняются за сессию). */
export function loadJson<T>(rel: string): Promise<T> {
  let p = jsonCache.get(rel);
  if (!p) {
    p = fetch(gameUrl(rel)).then((r) => {
      if (!r.ok) throw new Error(`${rel}: ${r.status}`);
      return r.json();
    });
    p.catch(() => jsonCache.delete(rel));
    jsonCache.set(rel, p);
  }
  return p as Promise<T>;
}

/** Есть ли файл (для необязательных частей выгрузки). */
export async function exists(rel: string): Promise<boolean> {
  try {
    const r = await fetch(gameUrl(rel), { method: 'HEAD' });
    return r.ok;
  } catch {
    return false;
  }
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
  private texLoader = new THREE.TextureLoader();
  anisotropy = 1;

  gltf(rel: string): Promise<GLTF> {
    let p = this.gltfs.get(rel);
    if (!p) {
      p = this.loader.loadAsync(gameUrl(rel));
      p.catch(() => this.gltfs.delete(rel));
      this.gltfs.set(rel, p);
    }
    return p;
  }

  /**
   * Текстура выгрузки: flipY = false (UV по соглашению glTF), цвет — sRGB, данные — линейные.
   * Промис разрешается, когда картинка загружена.
   */
  texture(rel: string, kind: TexKind, opts: TexOpts = {}): Promise<THREE.Texture> {
    const key = `${rel}|${kind}|${opts.repeat ? 'r' : 'c'}|${opts.lut ? 'l' : 'm'}`;
    let p = this.textures.get(key);
    if (!p) {
      p = this.texLoader.loadAsync(gameUrl(rel)).then((t) => {
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
        return t;
      });
      p.catch(() => this.textures.delete(key));
      this.textures.set(key, p);
    }
    return p;
  }

  /** То же, но null вместо ошибки (необязательная карта). */
  maybeTexture(rel: string | null | undefined, kind: TexKind, opts?: TexOpts): Promise<THREE.Texture | null> {
    if (!rel) return Promise.resolve(null);
    return this.texture(rel, kind, opts).catch(() => null);
  }

  dispose() {
    for (const p of this.textures.values()) p.then((t) => t.dispose()).catch(() => {});
    for (const p of this.gltfs.values())
      p.then((g) =>
        g.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh) m.geometry.dispose();
        }),
      ).catch(() => {});
    this.textures.clear();
    this.gltfs.clear();
  }
}
