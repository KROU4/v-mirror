// Нагота V, как в редакторе игры: соски, тату и шрамы тела, гениталии, их размер и
// лобковые волосы — отдельные меши поверх тела (body/intimate.json). Здесь только выбор
// частей и весов морфов по строкам каталога, без three.js.

/** Строки каталога, от которых зависят части intimate.json. */
export const INTIMATE_SLOTS = [
  'breast',
  'nipples_switcher',
  'body_tattoo_switcher',
  'body_scars_switcher',
  'genitals_switcher',
  'genitals_size',
  'pubic_hair',
  'pubic_hair_color',
] as const;

export type IntimateSlot = (typeof INTIMATE_SLOTS)[number];

/** Выбор строки: активный вариант и индекс опции каталога. */
export interface SlotPick {
  variant: string;
  i: number;
}
export type BodyPicks = Partial<Record<IntimateSlot, SlotPick>>;

export interface IntimatePartSpec {
  mesh: string;
  visibleSubmeshes: number[];
  /** материалы по тону кожи: [тон][индекс подмеша] */
  materialsByTone?: Record<string, (string | null)[]>;
  /** материалы без тона (цвет лобковых волос): [индекс подмеша] */
  materials?: (string | null)[];
}
export interface IntimateOption {
  parts?: IntimatePartSpec[];
  appliesTo?: { mesh: string; target: string; targetIndex?: number }[];
  influence?: number;
}
export interface IntimateVariant {
  type: string;
  options: Record<string, IntimateOption>;
}
export interface IntimateMesh {
  file: string;
  kind: 'skin' | 'decal';
  submeshes: { index: number; name: string }[];
  morphTargets?: string[];
  extraJoints?: string[];
}
export interface IntimateSkinMat {
  type: 'skin';
  albedo: string;
  normal?: string | null;
  orm?: string | null;
}
export interface IntimateDecalMat {
  type: 'decal';
  diffuse: string;
  diffuseColor?: string;
  diffuseAlpha?: number;
  normal?: string | null;
  normalAlpha?: number;
  roughness?: string | null;
  roughnessMetalnessAlpha?: number;
}
export type IntimateMat = IntimateSkinMat | IntimateDecalMat;
export interface IntimateManifest {
  tones: string[];
  meshes: Record<string, IntimateMesh>;
  materials: Record<string, IntimateMat>;
  genders: Record<'pwa' | 'pma', Record<string, { variants: Record<string, IntimateVariant> }>>;
}

/** Имена, которые в обычном объекте меняют прототип, а не создают ключ. */
const PROTO_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Что показать: подмеши меша и материал каждого. */
export interface ResolvedPart {
  mesh: string;
  /** индекс подмеша → имя материала */
  submeshes: { index: number; material: string }[];
}
export interface IntimateResolved {
  parts: ResolvedPart[];
  /** меш → (имя цели морфа → вес); цели, которых тут нет, — 0 */
  morphs: Record<string, Record<string, number>>;
}

function optionOf(m: IntimateManifest, code: 'pwa' | 'pma', slot: IntimateSlot, pick: SlotPick | undefined): IntimateOption | undefined {
  if (!pick) return undefined;
  return m.genders[code]?.[slot]?.variants[pick.variant]?.options[String(pick.i)];
}

/**
 * Части и морфы для выбора. tone — тон кожи тела (01_ca_pale…); если у части нет материала
 * этого тона, берётся первый из перечисленных.
 */
export function resolveIntimate(m: IntimateManifest, code: 'pwa' | 'pma', picks: BodyPicks, tone: string): IntimateResolved {
  const parts = new Map<string, Map<number, string>>();
  const morphs = Object.create(null) as Record<string, Record<string, number>>;
  for (const slot of INTIMATE_SLOTS) {
    const o = optionOf(m, code, slot, picks[slot]);
    if (!o) continue;
    for (const p of o.parts ?? []) {
      if (!m.meshes[p.mesh]) continue;
      const byTone = p.materialsByTone;
      const mats = byTone ? byTone[tone] ?? Object.values(byTone)[0] ?? [] : p.materials ?? [];
      const subs = parts.get(p.mesh) ?? new Map<number, string>();
      for (const s of p.visibleSubmeshes) {
        const mat = mats[s] ?? (mats.length === 1 ? mats[0] : null);
        if (mat && m.materials[mat]) subs.set(s, mat);
      }
      if (subs.size) parts.set(p.mesh, subs);
    }
    // Набор — недоверенный ввод (его можно получить от другого человека): число — только число
    const w = typeof o.influence === 'number' && Number.isFinite(o.influence) ? o.influence : 1;
    for (const a of o.appliesTo ?? []) {
      // тело (body:pwa_body) морфы груди получает по имени из каталога, здесь — только меши наготы
      if (typeof a?.mesh !== 'string' || typeof a?.target !== 'string' || a.mesh.includes(':')) continue;
      // ключи из набора не попадают в объекты с прототипом (__proto__ дописал бы Object.prototype)
      if (PROTO_KEYS.has(a.mesh) || PROTO_KEYS.has(a.target)) continue;
      (morphs[a.mesh] ??= Object.create(null) as Record<string, number>)[a.target] = w;
    }
  }
  return {
    parts: [...parts].map(([mesh, subs]) => ({ mesh, submeshes: [...subs].sort((a, b) => a[0] - b[0]).map(([index, material]) => ({ index, material })) })),
    morphs,
  };
}

/** Меши наготы с морфами груди: им нужен тот же вес, что у тела (у морфа без appliesTo — 0). */
export function morphWeight(res: IntimateResolved, mesh: string, target: string): number {
  return res.morphs[mesh]?.[target] ?? 0;
}

/** Кости «болтания» пениса, которых нет в скелете тела: у каждого меша — свои, на Hips. */
export const isDangleBone = (name: string) => name.startsWith('dyng_penis');

/** Доля непрозрачности тёмного ореола лобковых волос (см. limitations intimate.json): гасим его. */
export function pubicHaloAlpha(luma: number): number {
  const t = Math.min(1, Math.max(0, luma / 0.05));
  return t * t * (3 - 2 * t);
}
