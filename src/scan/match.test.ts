import { describe, expect, it } from 'vitest';
import type { PhotoAnalysis } from './analyze';
import { getIndex } from '../model/catalog';
import { chroma, hairLike, hexToRgb, hueOf, rgbToLab, scaleLightness, skinLike, type RGB } from './colors';
import {
  colorKey,
  exposureFix,
  exposureK,
  EXPOSURE_K,
  relLuminance,
  expressionLoad,
  irisRing,
  LOCAL_COLOR_MAX_CONF,
  LOCAL_OVER_LLM_MARGIN,
  localSuggestions,
  mergeSuggestions,
  MORPH_EXPR_MAX_CONF,
  MORPH_MAX_CONF,
  SKIN_MAX_CONF,
  skinSuggestion,
  type Suggestion,
} from './match';

describe('кожа или волосы над лбом', () => {
  const skin = rgbToLab(hexToRgb('#d99076'));
  it('освещённый лоб светлее щёк — это кожа (Педро)', () => {
    expect(skinLike(hexToRgb('#f6c1ad'), skin)).toBe(true);
    expect(hairLike(hexToRgb('#f6c1ad'), skin)).toBe(false);
  });
  it('тёмные, седые и светлые волосы — не кожа', () => {
    for (const hex of ['#5a4232', '#2a2220', '#9a9894', '#c9b48a']) expect(hairLike(hexToRgb(hex), skin)).toBe(true);
  });
  it('лёгкая тень на коже — ещё кожа', () => {
    expect(hairLike(hexToRgb('#cf866d'), skin)).toBe(false);
  });
});

const photo = (blendshapes: Record<string, number>) => ({ blendshapes }) as unknown as PhotoAnalysis;

describe('мимика на фото', () => {
  it('нейтральное лицо не штрафуется', () => {
    for (const s of ['eyes', 'nose', 'mouth', 'jaw'] as const) expect(expressionLoad(photo({}), s)).toBe(0);
  });

  it('улыбка бьёт по рту и глазам сильнее, чем по носу', () => {
    const p = photo({ mouthSmileLeft: 0.8, mouthSmileRight: 0.7, cheekSquintLeft: 0.5, cheekSquintRight: 0.5 });
    expect(expressionLoad(p, 'mouth')).toBeCloseTo(0.75, 2);
    expect(expressionLoad(p, 'eyes')).toBeGreaterThan(0.5);
    expect(expressionLoad(p, 'nose')).toBeLessThan(0.3);
  });

  it('открытый рот мешает замеру челюсти', () => {
    expect(expressionLoad(photo({ jawOpen: 0.6 }), 'jaw')).toBeCloseTo(0.6, 2);
  });
});

describe('поправка экспозиции', () => {
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const Y = (c: number[]) => rgbToLab(c as RGB)[0];
  it('пересвеченное фото приводится к яркости образца игры; тон тот же, насыщенность чуть ниже', () => {
    const fix = exposureFix([250, 184, 160], '#a8886b');
    const brow = fix([164, 113, 102])!;
    const before = rgbToLab([164, 113, 102]);
    const after = rgbToLab(brow);
    expect(after[0]).toBeLessThan(before[0]);
    expect(hueOf(after)).toBeCloseTo(hueOf(before), 0);
    expect(chroma(after)).toBeLessThan(chroma(before));
    expect(chroma(after)).toBeGreaterThan(chroma(before) * 0.8);
    // яркость (линейная) умножена на тот же множитель, что у кожи
    const k = relLuminance([0xa8, 0x88, 0x6b]) / relLuminance([250, 184, 160]);
    expect(Y(scaleLightness([164, 113, 102], k))).toBeCloseTo(after[0], 1);
  });
  it('множитель — отношение линейных яркостей (как у scaleLightness), а не гамма-кодированных', () => {
    const skin: RGB = [217, 144, 118];
    const game = '#7c5740';
    expect(exposureK(skin, game)).toBeCloseTo(relLuminance(hexToRgb(game)) / relLuminance(skin), 6);
    const gamma = lum(hexToRgb(game)) / lum(skin);
    expect(exposureK(skin, game)).toBeLessThan(gamma * 0.7);
  });
  it('тёмные насыщенные волосы не сводятся к чёрному без оттенка', () => {
    const fix = exposureFix(hexToRgb('#f4a591'), '#9a6b58');
    const hair = rgbToLab(fix(hexToRgb('#422321'))!);
    expect(Math.hypot(hair[1], hair[2])).toBeGreaterThan(10);
  });
  it('без замера кожи цвета не меняются', () => {
    expect(exposureFix(undefined, '#a8886b')([10, 20, 30])).toEqual([10, 20, 30]);
  });
  it('множитель ограничен', () => {
    // серый: светлота как у серого с яркостью × нижний предел
    const g = exposureFix([255, 255, 255], '#101010')([200, 200, 200])!;
    const k = EXPOSURE_K[0];
    const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    expect(lin(g[1])).toBeCloseTo(lin(200) * k, 2);
  });
});

describe('слияние подсказок', () => {
  it('в каждом слоте остаётся самая уверенная', () => {
    const a: Suggestion[] = [{ slotId: 'nose', value: 3, conf: 0.3, src: 'local' }];
    const b: Suggestion[] = [{ slotId: 'nose', number: 10, conf: 0.5, src: 'llm' }, { slotId: 'ear', number: 1, conf: 0.2, src: 'llm' }];
    const m = mergeSuggestions(a, b);
    expect(m.find((s) => s.slotId === 'nose')?.src).toBe('llm');
    expect(m).toHaveLength(2);
  });
  it('замер цвета (0,62) не перебивает ответ модели (0,52)', () => {
    const local: Suggestion[] = [{ slotId: 'hair_color', colorKey: 'black_carbon', conf: 0.62, src: 'local' }];
    const llm: Suggestion[] = [{ slotId: 'hair_color', number: 3, conf: 0.52, src: 'llm' }];
    expect(mergeSuggestions(local, llm)[0].src).toBe('llm');
    expect(mergeSuggestions(llm, local)[0].src).toBe('llm');
  });
  it('замер перебивает модель, только если намного увереннее', () => {
    const local: Suggestion[] = [{ slotId: 'eyes', value: 2, conf: 0.4, src: 'local' }];
    const llm: Suggestion[] = [{ slotId: 'eyes', number: 3, conf: 0.15, src: 'llm' }];
    expect(mergeSuggestions(local, llm)[0].src).toBe('local');
    expect(0.4 - 0.15).toBeGreaterThan(LOCAL_OVER_LLM_MARGIN);
  });
});

/** Фото с цветами из замера (analyze.ts) и нейтральным лицом. */
const colourPhoto = (c: Record<string, string>, extra: Partial<PhotoAnalysis> = {}) =>
  ({
    monochrome: false,
    colors: Object.fromEntries(Object.entries(c).map(([k, hex]) => [k, { hex, rgb: hexToRgb(hex) }])),
    features: {},
    blendshapes: {},
    yaw: 0,
    pitch: 0,
    beardScore: 0,
    lipstickScore: 0,
    hairCoverage: 0.9,
    hairSamples: 200,
    ...extra,
  }) as unknown as PhotoAnalysis;

describe('цвета по замеру (регрессия: Зендая, Педро)', () => {
  const pick = (g: 'male' | 'female', slot: string, a: PhotoAnalysis) => localSuggestions(g, a).find((s) => s.slotId === slot);
  it('каштаново-рыжие волосы на светлой коже — Red Merlot, а не чёрный', () => {
    const s = pick('female', 'hair_color', colourPhoto({ skin: '#f4a591', hair: '#422321' }));
    expect(s?.colorKey).toBe('red_merlot');
  });
  it('тёмно-каштановые волосы — каштановый цвет', () => {
    const s = pick('male', 'hair_color', colourPhoto({ skin: '#d99076', hair: '#5a4232' }));
    expect(s?.colorKey).toMatch(/^brown_/);
  });
  it('тёплая карая радужка — Gradient Brown, а не жёлтая', () => {
    const s = pick('female', 'eyes_color', colourPhoto({ skin: '#f4a591', iris: '#4c2e21' }));
    expect(s?.colorKey).toBe('gradient_brown');
  });
  it('цвет кольца радужки — из внутренней половины, без серого ободка', () => {
    const brown = getIndex('female').slotById.get('eyes_color')!.variants[0].options.find((o) => colorKey(o) === 'gradient_brown')!;
    expect(irisRing('female', 'eyes_color', brown)).toBe('#37312f');
  });
  it('у локальных цветов потолок уверенности ниже обычного ответа модели', () => {
    const all = localSuggestions('male', colourPhoto({ skin: '#d99076', hair: '#5a4232', iris: '#4c2e21', brows: '#3a2a20', chin: '#5a4a40' }, { beardScore: 0.8 }));
    const conf = (id: string) => all.find((s) => s.slotId === id)?.conf ?? 0;
    expect(conf('hair_color')).toBeLessThanOrEqual(LOCAL_COLOR_MAX_CONF.hair);
    expect(conf('eyes_color')).toBeLessThanOrEqual(LOCAL_COLOR_MAX_CONF.eyes);
    for (const id of ['eyebrows_color', 'eyelash_color', 'beard_color']) expect(conf(id)).toBeLessThanOrEqual(LOCAL_COLOR_MAX_CONF.brows);
  });
});

describe('морфы на лице с мимикой', () => {
  it('замер формы при улыбке и прищуре — не выше MORPH_EXPR_MAX_CONF', () => {
    const a = colourPhoto({}, { blendshapes: { mouthSmileLeft: 0.9, mouthSmileRight: 0.9, eyeSquintLeft: 0.7, eyeSquintRight: 0.7 } });
    for (const s of localSuggestions('male', a).filter((x) => x.slotId === 'eyes' || x.slotId === 'mouth')) expect(s.conf).toBeLessThanOrEqual(MORPH_EXPR_MAX_CONF);
  });
  it('нейтральное лицо — не выше MORPH_MAX_CONF', () => {
    for (const s of localSuggestions('female', colourPhoto({})).filter((x) => ['eyes', 'nose', 'mouth', 'jaw'].includes(x.slotId))) expect(s.conf).toBeLessThanOrEqual(MORPH_MAX_CONF);
  });
});

describe('тон кожи по фото (регрессия на трёх референсах)', () => {
  // Средние цвета кожи референсов после замера по щекам без бликов (analyze.ts)
  const idx = (hex: string, g: 'male' | 'female') => {
    const n = parseInt(hex.slice(1), 16);
    return skinSuggestion(g, [(n >> 16) & 255, (n >> 8) & 255, n & 255])!.value!;
  };
  it('освещённое лицо средне-смуглого человека не уходит в самые светлые тона', () => {
    expect(idx('#cc856b', 'male')).toBeGreaterThanOrEqual(2); // Педро: не 01/02
    expect(idx('#ec9f8b', 'female')).toBeGreaterThanOrEqual(2); // Зендая
    expect(idx('#cc856b', 'male')).toBeLessThanOrEqual(9);
    expect(idx('#ec9f8b', 'female')).toBeLessThanOrEqual(9);
  });
  it('тёмная кожа на фото даёт тёмные тона, светлая — светлые', () => {
    expect(idx('#5a3a2a', 'male')).toBeGreaterThanOrEqual(9);
    expect(idx('#f6d2c0', 'female')).toBeLessThanOrEqual(1);
  });
  it('уверенность ниже ответа модели', () => {
    expect(skinSuggestion('male', [204, 133, 107])!.conf).toBeLessThanOrEqual(SKIN_MAX_CONF);
  });
});

describe('ч/б фото', () => {
  it('цветовые подсказки не выдаются', () => {
    const a = {
      monochrome: true,
      colors: { skin: { rgb: [175, 175, 175], hex: '#afafaf' }, iris: { rgb: [64, 64, 64], hex: '#404040' }, hair: { rgb: [189, 189, 189], hex: '#bdbdbd' }, brows: { rgb: [107, 107, 107], hex: '#6b6b6b' }, lips: { rgb: [88, 88, 88], hex: '#585858' }, chin: { rgb: [66, 66, 66], hex: '#424242' } },
      features: {},
      blendshapes: {},
      yaw: 0,
      pitch: 0,
      beardScore: 1,
      lipstickScore: 0,
      hairCoverage: 0.9,
      hairSamples: 200,
    } as unknown as PhotoAnalysis;
    const ids = localSuggestions('male', a).map((s) => s.slotId);
    for (const id of ['skin_color', 'eyes_color', 'hair_color', 'eyebrows_color', 'eyelash_color', 'beard_color', 'makeupLips_color']) expect(ids).not.toContain(id);
    expect(ids).toContain('beard');
  });
});

describe('кожа, брови, ресницы и борода по замеру (раунд 3)', () => {
  const pick = (g: 'male' | 'female', slot: string, a: PhotoAnalysis) => localSuggestions(g, a).find((s) => s.slotId === slot);
  const photo = (c: Record<string, string>, extra: Partial<PhotoAnalysis> = {}) =>
    ({
      monochrome: false,
      colors: Object.fromEntries(Object.entries(c).map(([k, hex]) => [k, { hex, rgb: hexToRgb(hex) }])),
      features: {},
      blendshapes: {},
      yaw: 0,
      pitch: 0,
      beardScore: 0,
      lipstickScore: 0,
      hairCoverage: 0.9,
      hairSamples: 200,
      ...extra,
    }) as unknown as PhotoAnalysis;
  const grey = (L: number) => {
    // тёплая кожа заданной светлоты
    for (let v = 0; v < 256; v++) {
      const rgb: RGB = [Math.min(255, v * 1.25), v, Math.max(0, v * 0.85)];
      if (rgbToLab(rgb)[0] >= L) return rgb;
    }
    return [255, 255, 255] as RGB;
  };
  it('кожа ранжируется по светлоте отрисованной V: светлое фото — светлые тоны, тёмное — тёмные', () => {
    const opts = getIndex('male').slotById.get('skin_color')!.variants[0].options;
    const pos = (L: number) => opts.findIndex((o) => o.i === skinSuggestion('male', grey(L))!.value);
    expect(pos(86)).toBeLessThanOrEqual(1);
    expect(pos(44)).toBeGreaterThanOrEqual(10);
    expect(pos(60)).toBeGreaterThan(pos(80));
  });
  it('брови светлее волос берут цвет волос, ресницы — ключ бровей', () => {
    const a = photo({ skin: '#d99076', hair: '#2e1a16', brows: '#9f6b61' });
    const hair = pick('male', 'hair_color', a)!;
    const brows = pick('male', 'eyebrows_color', a)!;
    const lash = pick('male', 'eyelash_color', a)!;
    expect(brows.colorKey).toBe(hair.colorKey);
    expect(brows.conf).toBeLessThanOrEqual(hair.conf);
    expect(lash.colorKey).toBe(brows.colorKey);
  });
  it('без замера бровей они берут цвет волос', () => {
    const a = photo({ skin: '#d99076', hair: '#2e1a16' });
    expect(pick('male', 'eyebrows_color', a)?.colorKey).toBe(pick('male', 'hair_color', a)?.colorKey);
  });
  it('борода на ч/б фото — лишь грубая заготовка с низкой уверенностью', () => {
    const s = pick('male', 'beard', photo({}, { monochrome: true, beardScore: 0.9 }))!;
    expect(s.conf).toBeLessThanOrEqual(0.2);
    expect(String((s.why as { en: string }).en)).toMatch(/rough/);
  });
});
