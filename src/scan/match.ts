// Подбор вариантов по измерениям фото и применение подсказок к состоянию персонажа.
import { getIndex, type Gender, type Option, type Variant } from '../model/catalog';
import { MATCH_FEATURES, morphInfo, type MorphSlot } from '../model/descriptors';
import { setValue, slotValue, type CharacterState } from '../model/state';
import type { FeatureName } from './faceFeatures';
import type { PhotoAnalysis } from './analyze';
import { deltaE, hexToRgb, rgbToLab, type RGB } from './colors';

export type Source = 'local' | 'llm' | 'manual';

export interface Suggestion {
  slotId: string;
  /** индекс опции (поле i) в варианте, активном на момент подбора */
  value?: number;
  /** номер так, как его видит игрок (1-based) — так отвечает LLM */
  number?: number;
  /** ключ цвета (общий для всех вариантов цвета волос/бровей/бороды) */
  colorKey?: string;
  /** часть бороды по смыслу: '', chin, mustache, chin_sides… (у каждого стиля своя нумерация) */
  partKey?: string;
  hex?: string;
  conf: number;
  src: Source;
  why?: string;
}

export const colorKey = (o: Option) => (o.app ? o.app.split('__').pop()!.replace(/^\d+_/, '') : '');

/** Самый «полный» вариант слота — для палитр, общих у всех вариантов. */
function richestVariant(gender: Gender, slotId: string): Variant | undefined {
  const s = getIndex(gender).slotById.get(slotId);
  return s?.variants.reduce<Variant | undefined>((a, v) => (!a || v.options.length > a.options.length ? v : a), undefined);
}

function nearestColor(opts: Option[], rgb: RGB, field: 'hex' | 'iris', wL: number, plainOnly: boolean) {
  const target = rgbToLab(rgb);
  const pool = opts.filter((o) => (o[field] ?? o.hex) && (!plainOnly || o.rating[0] <= 3));
  const scored = pool
    .map((o) => ({ o, d: deltaE(target, rgbToLab(hexToRgb((o[field] ?? o.hex)!)), wL) }))
    .sort((a, b) => a.d - b.d);
  return scored;
}

function colorSuggestion(
  gender: Gender,
  slotId: string,
  rgb: RGB | undefined,
  opts: { field?: 'hex' | 'iris'; wL?: number; plainOnly?: boolean; why: string; confScale?: number },
): Suggestion | null {
  if (!rgb) return null;
  const v = richestVariant(gender, slotId);
  if (!v) return null;
  const scored = nearestColor(v.options, rgb, opts.field ?? 'hex', opts.wL ?? 1, opts.plainOnly ?? true);
  if (!scored.length) return null;
  const best = scored[0];
  const conf = Math.max(0.15, Math.min(0.95, 1 - best.d / 45)) * (opts.confScale ?? 1);
  return { slotId, value: best.o.i, colorKey: colorKey(best.o), hex: best.o.iris ?? best.o.hex, conf, src: 'local', why: `${opts.why}, ΔE ${best.d.toFixed(0)}` };
}

/** Морфы: ближайший вариант в пространстве z-оценок признаков. */
function morphSuggestion(gender: Gender, slot: Exclude<MorphSlot, 'ear'>, a: PhotoAnalysis): Suggestion {
  const info = morphInfo(gender, slot);
  const weights = MATCH_FEATURES[slot];
  const zPhoto: Partial<Record<FeatureName, number>> = {};
  for (const f of Object.keys(weights) as FeatureName[]) {
    const st = info.featureStats[f];
    if (!st) continue;
    zPhoto[f] = Math.max(-3, Math.min(3, (a.features[f] - st.mean) / st.sd));
  }
  const scored = info.options
    .map((o) => {
      let d = 0;
      for (const [f, w] of Object.entries(weights) as [FeatureName, number][]) {
        d += w * ((zPhoto[f] ?? 0) - (o.z[f] ?? 0)) ** 2;
      }
      return { o, d: Math.sqrt(d) };
    })
    .sort((x, y) => x.d - y.d);
  const best = scored[0], second = scored[1];
  const margin = second ? (second.d - best.d) / (second.d + 1e-6) : 0.5;
  const turn = Math.min(1, Math.max(0, (Math.abs(a.yaw) - 8) / 20));
  // Нос и челюсть с фронтального фото определяются слабее — честно режем уверенность
  const slotTrust = slot === 'eyes' || slot === 'mouth' ? 1 : 0.6;
  const conf = Math.max(0.1, Math.min(0.9, (0.35 + margin * 1.5 - best.d * 0.08) * slotTrust * (1 - turn * 0.6)));
  return { slotId: slot, value: best.o.i, conf, src: 'local', why: `ближе всего: ${best.o.text.ru}` };
}

export function localSuggestions(gender: Gender, a: PhotoAnalysis): Suggestion[] {
  const out: (Suggestion | null)[] = [];
  const c = a.colors;
  out.push(colorSuggestion(gender, 'skin_color', c.skin?.rgb, { wL: 0.9, plainOnly: false, why: 'тон кожи щёк и лба' }));
  out.push(colorSuggestion(gender, 'eyes_color', c.iris?.rgb, { field: 'iris', wL: 0.5, why: 'цвет радужки' }));
  const hairConf = 0.4 + 0.5 * a.hairCoverage;
  out.push(colorSuggestion(gender, 'hair_color', c.hair?.rgb, { wL: 0.8, why: 'волосы над лбом', confScale: hairConf }));
  out.push(colorSuggestion(gender, 'eyebrows_color', c.brows?.rgb, { wL: 0.7, why: 'цвет бровей' }));
  out.push(colorSuggestion(gender, 'eyelash_color', c.brows?.rgb, { wL: 0.7, why: 'по цвету бровей', confScale: 0.6 }));
  for (const slot of ['eyes', 'nose', 'mouth', 'jaw'] as const) out.push(morphSuggestion(gender, slot, a));

  const { slotById } = getIndex(gender);
  if (gender === 'male' && slotById.get('beard')) {
    const beard = slotById.get('beard')!.variants[0];
    if (a.beardScore < 0.25) out.push({ slotId: 'beard', value: beard.options[0].i, conf: 0.55, src: 'local', why: 'подбородок не темнее кожи' });
    else {
      out.push({ slotId: 'beard', value: beard.options[Math.min(3, beard.options.length - 1)].i, conf: 0.25 + a.beardScore * 0.2, src: 'local', why: 'тёмная зона на подбородке — тип бороды лучше уточнить моделью' });
      out.push(colorSuggestion(gender, 'beard_color', (c.chin ?? c.brows)?.rgb, { wL: 0.7, why: 'цвет щетины' }));
    }
  }
  const lipsType = slotById.get('makeupLips_type')?.variants[0];
  if (lipsType) {
    if (a.lipstickScore > 0.5) {
      out.push({ slotId: 'makeupLips_type', value: lipsType.options[1]?.i ?? 1, conf: 0.4 + a.lipstickScore * 0.3, src: 'local', why: 'губы заметно насыщеннее кожи' });
      out.push(colorSuggestion(gender, 'makeupLips_color', c.lips?.rgb, { wL: 0.8, plainOnly: false, why: 'цвет губ' }));
    } else {
      out.push({ slotId: 'makeupLips_type', value: lipsType.options[0].i, conf: 0.45, src: 'local', why: 'помады не видно' });
    }
  }
  return out.filter((x): x is Suggestion => !!x);
}

/** Объединение: для каждого слота берём подсказку с большей уверенностью. */
export function mergeSuggestions(...lists: Suggestion[][]): Suggestion[] {
  const best = new Map<string, Suggestion>();
  for (const list of lists) {
    for (const s of list) {
      const prev = best.get(s.slotId);
      if (!prev || s.conf > prev.conf) best.set(s.slotId, s);
    }
  }
  return [...best.values()];
}

/** Применяет подсказки с учётом зависимостей (сначала свитчеры, потом зависимые цвета). */
export function applySuggestions(base: CharacterState, sugg: Suggestion[]): CharacterState {
  let st = base;
  const { slotById } = getIndex(base.gender);
  const order = (s: Suggestion) => {
    const slot = slotById.get(s.slotId);
    const isSwitch = slot?.variants.some((v) => v.type === 'switcher');
    return (isSwitch ? 0 : 1000) + (slot?.order ?? 0);
  };
  const sorted = [...sugg].sort((a, b) => order(a) - order(b));
  for (let pass = 0; pass < 3; pass++) {
    for (const s of sorted) {
      const cur = slotValue(st, s.slotId);
      if (!cur) continue;
      const opts = cur.variant.options;
      let target: Option | undefined;
      if (s.colorKey) target = opts.find((o) => colorKey(o) === s.colorKey);
      if (!target && s.partKey !== undefined)
        target = opts.find((o) => (typeof o.meshHint === 'string' ? o.meshHint.split('__')[2] ?? '' : '') === s.partKey) ?? opts[0];
      if (!target && s.number !== undefined) target = opts[s.number - 1];
      if (!target && s.value !== undefined) target = opts.find((o) => o.i === s.value);
      if (!target && s.hex) target = nearestColor(opts, hexToRgb(s.hex), 'hex', 1, false)[0]?.o;
      if (target) st = setValue(st, cur.variant.name, target.i);
    }
  }
  return st;
}
