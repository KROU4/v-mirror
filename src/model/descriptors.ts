// Описания морфов лица, выведенные из калибровки (tools/calibrate):
//  * features — признаки MediaPipe на фронтальном рендере головы V с этим морфом;
//  * geo — смещения вершин 3D-головы (мм): ширина области, выступ вперёд, сдвиг вверх.
// Из них получаем (а) z-оценки для подбора по фото, (б) текстовое описание для LLM,
// (в) параметры формы для портрета-пиктограммы.
import maleMorphs from '../data/morphs.male.json';
import femaleMorphs from '../data/morphs.female.json';
import type { Gender, Loc } from './catalog';
import type { FeatureName, Features } from '../scan/faceFeatures';

export type MorphSlot = 'eyes' | 'nose' | 'mouth' | 'jaw' | 'ear';
export const MORPH_SLOTS: MorphSlot[] = ['eyes', 'nose', 'mouth', 'jaw', 'ear'];

interface GeoPart {
  n: number;
  dWidth: number;
  dHeight: number;
  fwd: number;
  up: number;
  out: number;
  cy: number;
}
interface Geo {
  maxDelta: number;
  all: GeoPart | null;
  center: GeoPart | null;
  side: GeoPart | null;
}
interface MorphRow {
  i: number;
  morph: string | null;
  features: Features | null;
  geo: Geo | null;
}
interface MorphFile {
  gender: Gender;
  base: Features;
  slots: Record<MorphSlot, MorphRow[]>;
}

const FILES: Record<Gender, MorphFile> = {
  male: maleMorphs as unknown as MorphFile,
  female: femaleMorphs as unknown as MorphFile,
};

/** Признаки, по которым фронтальное фото судит о слоте, и их веса. */
export const MATCH_FEATURES: Record<Exclude<MorphSlot, 'ear'>, Partial<Record<FeatureName, number>>> = {
  eyes: { eyeWidth: 1, eyeOpen: 1.2, eyeTilt: 1, eyeSpacing: 0.6 },
  nose: { noseWidth: 1.2, noseLength: 0.8, noseBridge: 0.4 },
  mouth: { mouthWidth: 1, upperLip: 1, lowerLip: 1 },
  jaw: { jawWidth: 1, chinWidth: 0.8, chinLength: 1, lowerFace: 0.5, faceLength: 0.4 },
};

// Сигналы геометрии (смысл: «больше» = положительное значение)
type Signal = { key: string; get: (g: Geo) => number | undefined; pos: Loc; neg: Loc };
const S = (key: string, get: Signal['get'], pos: [string, string], neg: [string, string]): Signal => ({
  key,
  get,
  pos: { ru: pos[0], en: pos[1] },
  neg: { ru: neg[0], en: neg[1] },
});

const GEO_SIGNALS: Record<MorphSlot, Signal[]> = {
  nose: [
    S('width', (g) => g.all?.out, ['широкие крылья', 'wide nostrils'], ['узкий', 'narrow']),
    S('proj', (g) => g.center?.fwd, ['выступающий', 'projecting'], ['плоский/короткий профиль', 'flat profile']),
    S('tip', (g) => g.center?.up, ['вздёрнутый кончик', 'upturned tip'], ['опущенный длинный кончик', 'droopy long tip']),
    S('bridge', (g) => g.center?.dHeight, ['длинная спинка', 'long bridge'], ['короткая спинка', 'short bridge']),
  ],
  jaw: [
    S('width', (g) => g.side?.out, ['широкая нижняя челюсть', 'wide jaw'], ['узкая челюсть', 'narrow jaw']),
    S('chinProj', (g) => g.center?.fwd, ['выступающий подбородок', 'projecting chin'], ['скошенный подбородок', 'receding chin']),
    S('chinLen', (g) => (g.center ? -g.center.up : undefined), ['длинный подбородок', 'long chin'], ['короткий подбородок', 'short chin']),
    S('angle', (g) => g.side?.dHeight, ['высокий угол челюсти', 'tall jaw angle'], ['мягкий угол', 'soft jaw angle']),
  ],
  mouth: [
    S('width', (g) => g.all?.out, ['широкий рот', 'wide mouth'], ['узкий рот', 'narrow mouth']),
    // Выступ губ вперёд в 3D: спереди он почти не виден, полноту губ задают фронтальные признаки ниже
    S('proj', (g) => g.all?.fwd, ['губы выступают вперёд', 'protruding lips'], ['губы втянуты', 'receding lips']),
    S('height', (g) => g.center?.dHeight, ['высокие губы', 'tall lips'], ['плоские губы', 'flat lips']),
    S('corners', (g) => g.side?.up, ['уголки рта приподняты', 'upturned corners'], ['уголки рта опущены', 'downturned corners']),
  ],
  ear: [
    S('protrude', (g) => g.side?.dWidth, ['оттопыренные', 'protruding'], ['прижатые', 'flat to head']),
    S('size', (g) => g.side?.dHeight, ['крупные', 'large'], ['маленькие', 'small']),
    S('pos', (g) => g.side?.up, ['посажены выше', 'set higher'], ['посажены ниже', 'set lower']),
  ],
  eyes: [
    S('depth', (g) => g.all?.fwd, ['навыкате', 'prominent'], ['глубоко посаженные', 'deep-set']),
  ],
};

const FEATURE_TEXT: Partial<Record<FeatureName, { pos: Loc; neg: Loc }>> = {
  eyeWidth: { pos: { ru: 'большие глаза', en: 'large eyes' }, neg: { ru: 'небольшие глаза', en: 'small eyes' } },
  eyeOpen: { pos: { ru: 'широко открытые, круглые', en: 'round, open' }, neg: { ru: 'узкий разрез', en: 'narrow, hooded' } },
  eyeTilt: { pos: { ru: 'миндалевидные, с подъёмом', en: 'upswept, almond' }, neg: { ru: 'опущенные внешние уголки', en: 'downturned' } },
  eyeSpacing: { pos: { ru: 'широко посажены', en: 'wide-set' }, neg: { ru: 'близко посажены', en: 'close-set' } },
};

const LIPS_TEXT = { pos: { ru: 'полные губы', en: 'full lips' }, neg: { ru: 'тонкие губы', en: 'thin lips' } };

interface Stats {
  mean: number;
  sd: number;
}
function stats(vals: number[]): Stats {
  const v = vals.filter((x) => Number.isFinite(x));
  const mean = v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, v.length)) || 1e-6;
  return { mean, sd };
}

export interface MorphOptionInfo {
  i: number;
  /** z-оценки признаков MediaPipe относительно всех вариантов слота */
  z: Partial<Record<FeatureName, number>>;
  /** z-оценки геометрических сигналов */
  geoZ: Record<string, number>;
  text: Loc;
}

export interface MorphSlotInfo {
  slot: MorphSlot;
  featureStats: Partial<Record<FeatureName, Stats>>;
  options: MorphOptionInfo[];
}

const cache = new Map<string, MorphSlotInfo>();

export function morphInfo(gender: Gender, slot: MorphSlot): MorphSlotInfo {
  const ck = `${gender}:${slot}`;
  const hit = cache.get(ck);
  if (hit) return hit;
  const file = FILES[gender];
  const rows = file.slots[slot] ?? [];
  const featNames = Object.keys(slot === 'ear' ? {} : MATCH_FEATURES[slot]) as FeatureName[];
  if (slot === 'eyes') featNames.push(...(['eyeWidth', 'eyeOpen', 'eyeTilt', 'eyeSpacing'] as FeatureName[]).filter((n) => !featNames.includes(n)));
  const featureStats: Partial<Record<FeatureName, Stats>> = {};
  for (const f of featNames) featureStats[f] = stats(rows.map((r) => r.features?.[f] ?? NaN));
  const signals = GEO_SIGNALS[slot];
  const sigStats: Record<string, Stats> = {};
  for (const s of signals) sigStats[s.key] = stats(rows.map((r) => (r.geo ? s.get(r.geo) ?? 0 : 0)));

  const options: MorphOptionInfo[] = rows.map((r) => {
    const z: Partial<Record<FeatureName, number>> = {};
    for (const f of featNames) {
      const st = featureStats[f]!;
      const v = r.features?.[f];
      z[f] = v === undefined ? 0 : (v - st.mean) / st.sd;
    }
    const geoZ: Record<string, number> = {};
    for (const s of signals) {
      const v = r.geo ? s.get(r.geo) ?? 0 : 0;
      geoZ[s.key] = (v - sigStats[s.key].mean) / sigStats[s.key].sd;
    }
    // Текст: самые выраженные сигналы (|z| ≥ 0.8), не более трёх
    const parts: { w: number; t: Loc }[] = [];
    for (const s of signals) {
      const zz = geoZ[s.key];
      if (Math.abs(zz) >= 0.8) parts.push({ w: Math.abs(zz), t: zz > 0 ? s.pos : s.neg });
    }
    if (slot === 'mouth') {
      // «Полные/тонкие» — по видимой высоте губ спереди, как их видят пользователь и модель
      const lips = (z.upperLip ?? 0) + (z.lowerLip ?? 0);
      if (Math.abs(lips) >= 1.6) parts.push({ w: Math.abs(lips) / 1.4, t: lips > 0 ? LIPS_TEXT.pos : LIPS_TEXT.neg });
    }
    if (slot === 'eyes') {
      for (const [f, tx] of Object.entries(FEATURE_TEXT) as [FeatureName, { pos: Loc; neg: Loc }][]) {
        const zz = z[f] ?? 0;
        if (Math.abs(zz) >= 0.8) parts.push({ w: Math.abs(zz) * 1.1, t: zz > 0 ? tx.pos : tx.neg });
      }
    }
    parts.sort((a, b) => b.w - a.w);
    const top = parts.slice(0, 3);
    const strong = (p: { w: number; t: Loc }, lang: 'ru' | 'en') =>
      p.w >= 1.6 ? `${p.t[lang]} (${lang === 'ru' ? 'сильно' : 'strong'})` : p.t[lang];
    const text: Loc = r.geo
      ? top.length
        ? { ru: top.map((p) => strong(p, 'ru')).join(', '), en: top.map((p) => strong(p, 'en')).join(', ') }
        : { ru: 'близко к базовому', en: 'close to default' }
      : { ru: 'базовая форма', en: 'default shape' };
    return { i: r.i, z, geoZ, text };
  });

  const info = { slot, featureStats, options };
  cache.set(ck, info);
  return info;
}

/**
 * Параметры формы для портрета (-1…1): по z-оценкам геометрии/признаков.
 * Используются только для схематичной пиктограммы, не для подбора.
 */
export interface ShapeParams {
  eyeSize: number;
  eyeOpen: number;
  eyeTilt: number;
  noseWidth: number;
  noseLength: number;
  mouthWidth: number;
  lipFull: number;
  jawWidth: number;
  chinLen: number;
  earOut: number;
}

const clamp1 = (x: number) => Math.max(-1, Math.min(1, x / 2));

export function shapeParams(gender: Gender, sel: Partial<Record<MorphSlot, number>>): ShapeParams {
  const pick = (slot: MorphSlot) => morphInfo(gender, slot).options.find((o) => o.i === (sel[slot] ?? 0));
  const e = pick('eyes'), n = pick('nose'), m = pick('mouth'), j = pick('jaw'), r = pick('ear');
  return {
    eyeSize: clamp1(e?.z.eyeWidth ?? 0),
    eyeOpen: clamp1(e?.z.eyeOpen ?? 0),
    eyeTilt: clamp1(e?.z.eyeTilt ?? 0),
    noseWidth: clamp1(n?.geoZ.width ?? 0),
    noseLength: clamp1(-(n?.geoZ.tip ?? 0)),
    mouthWidth: clamp1(m?.geoZ.width ?? 0),
    lipFull: clamp1(((m?.z.upperLip ?? 0) + (m?.z.lowerLip ?? 0)) / 2),
    jawWidth: clamp1(j?.geoZ.width ?? 0),
    chinLen: clamp1(j?.geoZ.chinLen ?? 0),
    earOut: clamp1(r?.geoZ.protrude ?? 0),
  };
}
