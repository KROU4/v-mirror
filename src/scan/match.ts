// Подбор вариантов по измерениям фото и применение подсказок к состоянию персонажа.
import { getIndex, type Gender, type Loc, type Option, type Variant } from '../model/catalog';
import { MATCH_FEATURES, morphInfo, type MorphSlot } from '../model/descriptors';
import { setValue, slotValue, type CharacterState } from '../model/state';
import type { FeatureName } from './faceFeatures';
import type { PhotoAnalysis } from './analyze';
import { chroma, deltaE, hexToRgb, rgbToHex, rgbToLab, scaleLightness, type Lab, type RGB } from './colors';
import { lookupSwatch, swatchTable } from '../ui/swatch';

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
  /** пояснение: от замера — ru/en, от модели — строка на языке запроса */
  why?: string | Loc;
}

export const colorKey = (o: Option) => (o.app ? o.app.split('__').pop()!.replace(/^\d+_/, '') : '');

/** Самый «полный» вариант слота — для палитр, общих у всех вариантов. */
function richestVariant(gender: Gender, slotId: string): Variant | undefined {
  const s = getIndex(gender).slotById.get(slotId);
  return s?.variants.reduce<Variant | undefined>((a, v) => (!a || v.options.length > a.options.length ? v : a), undefined);
}

/**
 * Цвет радужки варианта: самый насыщенный стоп внутренней половины кольца из swatches.*.json
 * (там видна сама радужка). Среднее по кольцу захватывало серо-голубой внешний ободок:
 * карая радужка (gradient_brown) становилась нейтрально-серой, и любой тёплый карий глаз
 * уходил в жёлтый.
 */
export function irisRing(gender: Gender, slotId: string, o: Option): string | undefined {
  const d = lookupSwatch(swatchTable(gender), slotId, o);
  if (d?.kind === 'radial' && d.pattern === 'iris' && d.ring?.length === 2 && d.pos?.length === d.stops.length) {
    const [a, b] = d.ring;
    const mid = (a + b) / 2;
    const inRing = d.stops.filter((_, k) => d.pos![k] >= a && d.pos![k] <= mid);
    if (inRing.length) return inRing.reduce((best, s) => (chroma(rgbToLab(hexToRgb(s))) > chroma(rgbToLab(hexToRgb(best))) ? s : best));
  }
  return o.iris ?? o.hex;
}

/**
 * Цвет волос варианта: средний цвет образца (стопы градиента из swatches.*.json, в линейном
 * свете). Один hex каталога у разных цветов бывает одинаковым (brown_liquorice и
 * black_salt_n_pepper — оба #322c28) и не передаёт рыжину или седину градиента.
 */
export function swatchMean(gender: Gender, slotId: string, o: Option): string | undefined {
  const d = lookupSwatch(swatchTable(gender), slotId, o);
  if (!d || d.stops.length < 2) return o.hex;
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const enc = (v: number) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const rgb = d.stops.map(hexToRgb);
  return rgbToHex([0, 1, 2].map((c) => enc(rgb.reduce((s, x) => s + lin(x[c]), 0) / rgb.length)) as RGB);
}

type ColorField = 'hex' | 'iris' | 'ring' | 'swatch';

function optionColor(gender: Gender, slotId: string, o: Option, field: ColorField): string | undefined {
  if (field === 'ring') return irisRing(gender, slotId, o);
  if (field === 'swatch') return swatchMean(gender, slotId, o);
  return o[field] ?? o.hex;
}

/**
 * Потолок уверенности локальных цветовых замеров (как SKIN_MAX_CONF у кожи): свет фото,
 * краска и тени сильно сдвигают цвет, и обычный ответ модели (0,5–0,65) должен их перебивать.
 */
export const LOCAL_COLOR_MAX_CONF = { hair: 0.45, eyes: 0.45, brows: 0.4 };

function nearestColor(opts: Option[], rgb: RGB, field: 'hex' | 'iris', wL: number, plainOnly: boolean) {
  return nearestBy(opts, rgb, (o) => o[field] ?? o.hex, wL, plainOnly);
}

/**
 * Самая «необычная» оценка (rating[0]), которая ещё считается естественным цветом: платиновый
 * блонд, красное мерло, седой «оружейный металл» и рыжая клубника — 4.
 */
export const PLAIN_RATING = 4;

function nearestBy(opts: Option[], rgb: RGB, color: (o: Option) => string | undefined, wL: number, plainOnly: boolean) {
  const target = rgbToLab(rgb);
  return opts
    .filter((o) => color(o) && (!plainOnly || o.rating[0] <= PLAIN_RATING))
    .map((o) => ({ o, d: deltaE(target, rgbToLab(hexToRgb(color(o)!)), wL) }))
    .sort((a, b) => a.d - b.d);
}

function colorSuggestion(
  gender: Gender,
  slotId: string,
  rgb: RGB | undefined,
  opts: { field?: ColorField; wL?: number; plainOnly?: boolean; why: Loc; confScale?: number; maxConf?: number },
): Suggestion | null {
  if (!rgb) return null;
  const v = richestVariant(gender, slotId);
  if (!v) return null;
  const field = opts.field ?? 'hex';
  const scored = nearestBy(v.options, rgb, (o) => optionColor(gender, slotId, o, field), opts.wL ?? 1, opts.plainOnly ?? true);
  if (!scored.length) return null;
  const best = scored[0];
  const conf = Math.min(opts.maxConf ?? 0.95, Math.max(0.15, Math.min(0.95, 1 - best.d / 45)) * (opts.confScale ?? 1));
  return { slotId, value: best.o.i, colorKey: colorKey(best.o), hex: best.o.iris ?? best.o.hex, conf, src: 'local', why: { ru: `${opts.why.ru}, ΔE ${best.d.toFixed(0)}`, en: `${opts.why.en}, ΔE ${best.d.toFixed(0)}` } };
}

/** Светлота кожи на фото, которую считаем самой светлой и самой тёмной кожей игры. */
export const SKIN_PHOTO_L: [number, number] = [85, 45];
/** Локальный подбор кожи — только подсказка: ответ модели (conf ≥ 0.3) должен его перебивать. */
export const SKIN_MAX_CONF = 0.3;

/**
 * Светлота L* щеки отрисованной V по тонам кожи в порядке каталога (01 pale … 12 dark), замер
 * по кадрам редактора при его свете. Светлота значка (hex каталога) порядку игры не следует:
 * amber по значку третий по светлоте, limestone шестой, а на V они на своих местах.
 */
export const SKIN_RENDER_L = [51, 54, 43, 38, 38, 40, 37, 30, 31, 31, 25, 15];

const hueDeg = (l: Lab) => (Math.atan2(l[2], l[1]) * 180) / Math.PI;

/**
 * Тон кожи в относительной шкале. Освещённое лицо на фото имеет L* 70–80, а V в редакторе —
 * от 15 до 54: абсолютное ΔE всегда выбирало бы самый светлый тон. Светлота фото в типичном
 * диапазоне SKIN_PHOTO_L переводится в ранг тона по светлоте отрисованной V (SKIN_RENDER_L), а
 * среди соседей по рангу выбирается тон с ближайшим оттенком (угол a*, b* значка — только он).
 */
export function skinSuggestion(gender: Gender, rgb: RGB | undefined): Suggestion | null {
  if (!rgb) return null;
  const v = richestVariant(gender, 'skin_color');
  if (!v) return null;
  const table = v.options.length === SKIN_RENDER_L.length;
  const sw = v.options
    .map((o, k) => ({ o, k }))
    .filter(({ o }) => o.hex)
    .map(({ o, k }) => {
      const lab = rgbToLab(hexToRgb(o.hex!));
      // Тонов не столько, сколько в таблице (другая версия каталога) — светлота значка
      return { o, lab, L: table ? SKIN_RENDER_L[k] : lab[0] };
    });
  if (!sw.length) return null;
  const sorted = [...sw].sort((a, b) => b.L - a.L);
  const photo = rgbToLab(rgb);
  const [light, dark] = SKIN_PHOTO_L;
  const t = Math.max(0, Math.min(1, (light - photo[0]) / (light - dark)));
  const pos = t * (sorted.length - 1);
  const lo = Math.floor(pos), hi = Math.min(sorted.length - 1, lo + 1);
  const targetL = sorted[lo].L + (sorted[hi].L - sorted[lo].L) * (pos - lo);
  const hue = hueDeg(photo);
  const scored = sw
    .map((x) => ({ ...x, d: Math.abs(x.L - targetL) / 4 + (Math.abs(hueDeg(x.lab) - hue) / 15) * 0.5 }))
    .sort((a, b) => a.d - b.d);
  const best = scored[0];
  const conf = Math.max(0.15, SKIN_MAX_CONF * (1 - Math.min(1, best.d / 3)));
  const rank = Math.round(t * 100);
  return {
    slotId: 'skin_color',
    value: best.o.i,
    colorKey: colorKey(best.o),
    hex: best.o.hex,
    conf,
    src: 'local',
    why: {
      ru: `светлота кожи с поправкой на свет фото (${rank}% от светлой к тёмной)`,
      en: `skin lightness corrected for photo lighting (${rank}% from light to dark)`,
    },
  };
}

export const MORPH_MAX_CONF = 0.4;
/** Замер формы на лице с мимикой (улыбка растягивает рот, прищур сужает глаза). */
export const MORPH_EXPR_MAX_CONF = 0.25;

/** Морфы: ближайший вариант в пространстве z-оценок признаков. */
function morphSuggestion(gender: Gender, slot: Exclude<MorphSlot, 'ear'>, a: PhotoAnalysis): Suggestion {
  const info = morphInfo(gender, slot);
  const weights = MATCH_FEATURES[slot];
  const zPhoto: Partial<Record<FeatureName, number>> = {};
  for (const f of Object.keys(weights) as FeatureName[]) {
    const st = info.featureStats[f];
    // признак не измерен (точки не нашлись) — он не сдвигает выбор ни к одному варианту
    if (!st || !Number.isFinite(a.features[f])) continue;
    zPhoto[f] =Math.max(-3, Math.min(3, (a.features[f] - st.mean) / st.sd));
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
  // Поворот и наклон головы искажают пропорции одинаково сильно
  const turn = Math.min(1, Math.max(0, Math.max(Math.abs(a.yaw) - 8, Math.abs(a.pitch ?? 0) - 8) / 20));
  // Нос и челюсть с фронтального фото определяются слабее — честно режем уверенность
  const slotTrust = slot === 'eyes' || slot === 'mouth' ? 1 : 0.6;
  // Мимика искажает замер: улыбка растягивает рот и поднимает щёки, прищур сужает глаза
  const expr = expressionLoad(a, slot);
  const note = expr > 0.35;
  // Не выше MORPH_MAX_CONF: обычный ответ модели о форме (0,3–0,45) должен перебивать замер.
  // С заметной мимикой (улыбка, прищур) замер — лишь ориентир: не выше MORPH_EXPR_MAX_CONF
  const cap = note ? MORPH_EXPR_MAX_CONF : MORPH_MAX_CONF;
  const conf = Math.max(0.1, Math.min(cap, (0.35 + margin * 1.5 - best.d * 0.08) * slotTrust * (1 - turn * 0.6) * (1 - expr * 0.7)));
  return {
    slotId: slot,
    value: best.o.i,
    conf,
    src: 'local',
    why: {
      ru: `ближе всего: ${best.o.text.ru}${note ? ' (мимика на фото — замер приблизительный)' : ''}`,
      en: `closest: ${best.o.text.en}${note ? ' (facial expression on the photo — rough measurement)' : ''}`,
    },
  };
}

/** Насколько выражение лица мешает замеру зоны (0 — нейтральное лицо, 1 — сильная мимика). */
export function expressionLoad(a: PhotoAnalysis, slot: Exclude<MorphSlot, 'ear'>): number {
  const b = a.blendshapes ?? {};
  const avg = (...k: string[]) => k.reduce((s, x) => s + (b[x] ?? 0), 0) / k.length;
  const smile = avg('mouthSmileLeft', 'mouthSmileRight');
  const open = b.jawOpen ?? 0;
  const squint = Math.max(avg('eyeSquintLeft', 'eyeSquintRight'), avg('cheekSquintLeft', 'cheekSquintRight'));
  const v = slot === 'mouth' ? Math.max(smile, open) : slot === 'eyes' ? Math.max(squint, smile * 0.8) : slot === 'jaw' ? open : smile * 0.3;
  return Math.max(0, Math.min(1, v));
}

export function localSuggestions(gender: Gender, a: PhotoAnalysis): Suggestion[] {
  const out: (Suggestion | null)[] = [];
  const c = a.colors;
  const { slotById } = getIndex(gender);
  // Ч/б фото: серые пиксели ничего не говорят о цвете кожи, глаз, волос и губ — цвет решает модель
  const colour = !a.monochrome;
  const skinS = colour ? skinSuggestion(gender, c.skin?.rgb) : null;
  out.push(skinS);
  // Поправка на экспозицию: одна общая яркость, без сдвига оттенка (см. exposureFix)
  const fix = exposureFix(c.skin?.rgb, skinS?.hex);
  if (colour) {
    const M = LOCAL_COLOR_MAX_CONF;
    out.push(colorSuggestion(gender, 'eyes_color', c.iris?.rgb, { field: 'ring', wL: 0.5, maxConf: M.eyes, why: { ru: 'цвет радужки', en: 'iris color' } }));
    // Волосы — только если над лбом их действительно видно (иначе в замер попадают лоб и фон)
    if (a.hairCoverage >= 0.3 && (a.hairSamples ?? 0) >= 40) {
      const hairConf = 0.4 + 0.5 * a.hairCoverage;
      out.push(colorSuggestion(gender, 'hair_color', fix(c.hair?.rgb), { field: 'swatch', wL: 0.8, maxConf: M.hair, why: { ru: 'волосы у линии роста', en: 'hair at the hairline' }, confScale: hairConf }));
    }
    // Брови: замер по тёмным волоскам между точками брови. Брови светлее волос локально не
    // выигрывают: замер на светлых бровях ловит кожу, а у почти всех людей брови не светлее
    // волос. Не измерены — берут цвет волос (как у модели, HAIR_LINKED)
    let browS = colorSuggestion(gender, 'eyebrows_color', fix(c.brows?.rgb), { field: 'swatch', wL: 0.7, maxConf: M.brows, why: { ru: 'цвет бровей', en: 'brow color' } });
    const hairS = out.find((x) => x?.slotId === 'hair_color') ?? null;
    if (hairS && (!browS || (c.brows && c.hair && rgbToLab(c.brows.rgb)[0] > rgbToLab(c.hair.rgb)[0] + 3))) {
      browS = { ...hairS, slotId: 'eyebrows_color', conf: Math.min(browS?.conf ?? 1, hairS.conf * 0.9), why: { ru: 'как цвет волос', en: 'same as the hair colour' } };
    }
    if (browS) {
      out.push(browS);
      // Ресницы — тот же ключ цвета, что у бровей (палитры общие), а не отдельный подбор по hex
      if (slotById.get('eyelash_color') && browS.colorKey)
        out.push({ slotId: 'eyelash_color', colorKey: browS.colorKey, hex: browS.hex, conf: browS.conf * 0.6, src: 'local', why: { ru: 'как цвет бровей', en: 'same as the brow colour' } });
    }
  }
  for (const slot of ['eyes', 'nose', 'mouth', 'jaw'] as const) out.push(morphSuggestion(gender, slot, a));

  if (gender === 'male' && slotById.get('beard')) {
    const beard = slotById.get('beard')!.variants[0];
    if (a.beardScore < 0.25) out.push({ slotId: 'beard', value: beard.options[0].i, conf: 0.55, src: 'local', why: { ru: 'подбородок не темнее кожи', en: 'chin is not darker than the skin' } });
    else {
      // Тип бороды по одному тёмному пятну на подбородке не определить: номер — лишь заготовка
      // (щетина при слабом сигнале, борода при сильном), уверенность низкая, чтобы любой
      // ответ модели её перебил. На ч/б фото — ещё ниже: тень и щетину не различить
      const strong = a.beardScore >= 0.6;
      const k = Math.min(beard.options.length - 1, strong ? 6 : 2);
      out.push({
        slotId: 'beard',
        value: beard.options[k].i,
        conf: colour ? Math.min(0.3, 0.2 + a.beardScore * 0.1) : 0.15,
        src: 'local',
        why: strong
          ? { ru: 'тёмная зона на подбородке — грубо, тип бороды лучше уточнить моделью', en: 'dark area on the chin — rough guess, refine the beard type with the AI model' }
          : { ru: 'слегка тёмный подбородок — грубо: возможно, щетина', en: 'slightly dark chin — rough guess: maybe stubble' },
      });
      if (colour) out.push(colorSuggestion(gender, 'beard_color', fix((c.chin ?? c.brows)?.rgb), { field: 'swatch', wL: 0.7, maxConf: LOCAL_COLOR_MAX_CONF.brows, why: { ru: 'цвет щетины', en: 'stubble color' } }));
    }
  }
  const lipsType = slotById.get('makeupLips_type')?.variants[0];
  if (lipsType) {
    if (a.lipstickScore > 0.5) {
      out.push({ slotId: 'makeupLips_type', value: lipsType.options[1]?.i ?? 1, conf: 0.4 + a.lipstickScore * 0.3, src: 'local', why: { ru: 'губы заметно насыщеннее кожи', en: 'lips are clearly more saturated than the skin' } });
    } else {
      out.push({ slotId: 'makeupLips_type', value: lipsType.options[0].i, conf: 0.45, src: 'local', why: { ru: 'помады не видно', en: 'no lipstick visible' } });
    }
  }
  // Цвет помады — всегда по цвету губ: если модель включит помаду, оттенок не останется
  // на первой опции списка («Чёрный»). applySuggestions применит его после свитчера типа.
  if (colour && slotById.get('makeupLips_color'))
    out.push(colorSuggestion(gender, 'makeupLips_color', c.lips?.rgb, { wL: 0.8, plainOnly: false, maxConf: 0.35, why: { ru: 'цвет губ', en: 'lip color' } }));
  return out.filter((x): x is Suggestion => !!x);
}

/** sRGB 0..255 → линейная яркость 0..1 (как в swatchMean). */
const linC = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** Относительная яркость Y (линейная). */
export const relLuminance = (x: RGB) => 0.2126 * linC(x[0]) + 0.7152 * linC(x[1]) + 0.0722 * linC(x[2]);

/**
 * Насколько насыщенность следует за светлотой при поправке (scaleLightness): 0,2 — подобрано по
 * фото Зендаи (каштаново-красные — Red Merlot) и тёмному каштану (Brown Liquorice, а не Merlot).
 */
export const EXPOSURE_CHROMA = 0.2;
/** Пределы множителя экспозиции (линейная яркость). */
export const EXPOSURE_K: [number, number] = [0.25, 1.6];

/**
 * Множитель экспозиции: отношение линейных яркостей Y «образец кожи игры / кожа на фото».
 * scaleLightness умножает именно линейную Y, поэтому и отношение берётся в линейном свете
 * (по гамма-кодированной яркости множитель выходил вдвое слабее, и волосы, брови и щетина
 * оставались светлыми — уходили в рыжий и блонд).
 */
export function exposureK(skinPhoto: RGB, skinGameHex: string): number {
  const k = relLuminance(hexToRgb(skinGameHex)) / Math.max(1e-4, relLuminance(skinPhoto));
  return Math.max(EXPOSURE_K[0], Math.min(EXPOSURE_K[1], k));
}

/**
 * Поправка экспозиции для волос, бровей и щетины: общий множитель яркости exposureK. Образец
 * выбран по относительной светлоте (skinSuggestion), поэтому множитель зависит только от
 * яркости фото. Меняется светлота L*, тон тот же: множитель по
 * каналам RGB сводил тёмные насыщенные волосы (каштан, рыжий) к почти чёрному без оттенка;
 * насыщенность лишь немного падает вместе со светлотой (EXPOSURE_CHROMA). Без замера кожи (или на ч/б фото, где образца нет) — без поправки.
 */
export function exposureFix(skinPhoto: RGB | undefined, skinGameHex: string | undefined): (c: RGB | undefined) => RGB | undefined {
  if (!skinPhoto || !skinGameHex) return (c) => c;
  const k = exposureK(skinPhoto, skinGameHex);
  return (c) => (c ? scaleLightness(c, k, EXPOSURE_CHROMA) : c);
}

/**
 * Насколько локальный замер должен быть увереннее ответа модели, чтобы его перебить: модель
 * видит фото целиком (свет, краску, мимику), а замер — несколько пикселей.
 */
export const LOCAL_OVER_LLM_MARGIN = 0.2;

/**
 * Объединение: в каждом слоте — подсказка с большей уверенностью, но ответ модели
 * перебивается замером, только если тот увереннее на LOCAL_OVER_LLM_MARGIN.
 */
export function mergeSuggestions(...lists: Suggestion[][]): Suggestion[] {
  const best = new Map<string, Suggestion>();
  const score = (s: Suggestion, other: Suggestion) => (s.src === 'local' && other.src === 'llm' ? s.conf - LOCAL_OVER_LLM_MARGIN : s.conf);
  for (const list of lists) {
    for (const s of list) {
      const prev = best.get(s.slotId);
      if (!prev || score(s, prev) > score(prev, s)) best.set(s.slotId, s);
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
