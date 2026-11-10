import { describe, expect, it } from 'vitest';
import type { PhotoAnalysis } from './analyze';
import { getIndex } from '../model/catalog';
import { morphInfo } from '../model/descriptors';
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
  LIPS_NONE_CONF,
  localSuggestions,
  mergeSuggestions,
  MORPH_EXPR_MAX_CONF,
  MORPH_MAX_CONF,
  SKIN_MAX_CONF,
  skinSuggestion,
  type Suggestion,
  photoEyeOpenZ,
  PHOTO_EYE_OPEN,
  HEAVY_LID_EYES,
  HEAVY_LID_Z,
  heavyLidRows,
  screenHeavyLids,
  beardKind,
  beardStyleKey,
  BEARD_KIND_STYLE,
  linkedColorKey,
  NATURAL_BROW_KEYS,
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

describe('скан на трёх референсах (раунд 4)', () => {
  const pick = (g: 'male' | 'female', slot: string, a: PhotoAnalysis) => localSuggestions(g, a).find((s) => s.slotId === slot);
  /** Признаки глаз и мимика — замеры MediaPipe на фото Киану, Педро и Зендаи (w3/scan/before_local). */
  const FACES = {
    keanu: { f: { eyeWidth: 0.435, eyeOpen: 0.266, eyeTilt: 5.776, eyeSpacing: 1.178 }, b: { eyeSquintLeft: 0.81, eyeSquintRight: 0.6, eyeBlinkLeft: 0.15, eyeBlinkRight: 0.08 } },
    pedro: { f: { eyeWidth: 0.4, eyeOpen: 0.244, eyeTilt: 1.753, eyeSpacing: 1.333 }, b: { eyeSquintLeft: 0.55, eyeSquintRight: 0.42, eyeBlinkLeft: 0.25, eyeBlinkRight: 0.15, mouthSmileLeft: 0.8, mouthSmileRight: 0.76 } },
    zendaya: { f: { eyeWidth: 0.448, eyeOpen: 0.309, eyeTilt: 6.965, eyeSpacing: 1.102 }, b: { eyeSquintLeft: 0.46, eyeSquintRight: 0.42, eyeBlinkLeft: 0.14, eyeBlinkRight: 0.04 } },
  };
  const face = (k: keyof typeof FACES) => colourPhoto({}, { features: FACES[k].f, blendshapes: FACES[k].b } as unknown as Partial<PhotoAnalysis>);
  const eyeNo = (g: 'male' | 'female', a: PhotoAnalysis) => {
    const v = getIndex(g).slotById.get('eyes')!.variants[0];
    return v.options.findIndex((o) => o.i === pick(g, 'eyes', a)!.value) + 1;
  };

  it('раскрытие глаз фото сравнивается с нормой фото, прищур и моргание возвращаются', () => {
    expect(photoEyeOpenZ(face('pedro'))).toBeGreaterThan(-1);
    expect(photoEyeOpenZ(face('keanu'))).toBeGreaterThan(-1);
    expect(photoEyeOpenZ(face('zendaya'))).toBeGreaterThan(photoEyeOpenZ(face('pedro')));
    const narrow = colourPhoto({}, { features: { eyeOpen: PHOTO_EYE_OPEN.mean - 2 * PHOTO_EYE_OPEN.sd } } as unknown as Partial<PhotoAnalysis>);
    expect(photoEyeOpenZ(narrow)).toBeCloseTo(-2, 5);
  });

  it('прищур на фото не даёт полуприкрытых «сонных» глаз', () => {
    for (const k of ['keanu', 'pedro'] as const) expect([...heavyLidRows('male')], k).not.toContain(eyeNo('male', face(k)));
  });

  it('форма глаз модели с тяжёлыми веками при открытых глазах на фото уступает замеру', () => {
    const heavyRow = [...heavyLidRows('male')][0];
    expect(heavyRow).toBeDefined();
    const a = face('pedro');
    const llm: Suggestion[] = [
      { slotId: 'eyes', number: heavyRow, conf: 0.9, src: 'llm' },
      { slotId: 'nose', number: 2, conf: 0.9, src: 'llm' },
    ];
    const screened = screenHeavyLids('male', a, llm);
    expect(screened.map((s) => s.slotId)).toEqual(['nose']);
    const merged = mergeSuggestions(localSuggestions('male', a), screened);
    const eyes = merged.find((s) => s.slotId === 'eyes')!;
    expect(eyes.src).toBe('local');
    expect([...heavyLidRows('male')]).not.toContain(eyeNo('male', a));
    // Узкие глаза на фото (или без замера) — ответ модели остаётся
    const narrow = colourPhoto({}, { features: { eyeOpen: PHOTO_EYE_OPEN.mean - 2 * PHOTO_EYE_OPEN.sd } } as unknown as Partial<PhotoAnalysis>);
    expect(screenHeavyLids('male', narrow, llm)).toHaveLength(2);
    expect(screenHeavyLids('male', null, llm)).toHaveLength(2);
  });

  it('тяжёлые веки: узкий разрез по данным рендеров у обоих тел и добавка по кадрам редактора', () => {
    const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
    for (const g of ['male', 'female'] as const) {
      const morphs = new Set(getIndex(g).slotById.get('eyes')!.variants[0].options.map((o) => o.morph));
      for (const m of HEAVY_LID_EYES[g]) expect(morphs.has(m), `${g} ${m}`).toBe(true);
      // каждый вариант, который описание называет «narrow, hooded», — в списке
      const rows = heavyLidRows(g);
      morphInfo(g, 'eyes').options.forEach((o, k) => {
        if ((o.z.eyeOpen ?? 0) <= HEAVY_LID_Z) expect(rows.has(k + 1), `${g} ${k + 1}`).toBe(true);
        if (/narrow, hooded/.test(o.text.en)) expect(rows.has(k + 1), `${g} ${k + 1} ${o.text.en}`).toBe(true);
      });
    }
    // номера строк в промпте и замере (каталог 2.5): у мужского — и 9 «deep-set, downturned,
    // narrow, hooded» (раньше скан ставил её Педро), у женского список не пуст
    expect(sorted(heavyLidRows('male'))).toEqual([7, 9, 12, 18, 19, 20, 21]);
    expect(sorted(heavyLidRows('female'))).toEqual([6, 18, 20, 21, 22]);
  });

  it('при раскрытии глаз около нормы и прищуре скан не берёт варианты с узким разрезом', () => {
    for (const g of ['male', 'female'] as const) {
      const info = morphInfo(g, 'eyes');
      for (const k of ['keanu', 'pedro', 'zendaya'] as const) {
        const no = eyeNo(g, face(k));
        expect(info.options[no - 1].z.eyeOpen ?? 0, `${g} ${k} → ${no}`).toBeGreaterThan(HEAVY_LID_Z);
        expect([...heavyLidRows(g)], `${g} ${k}`).not.toContain(no);
      }
    }
  });

  it('по-настоящему узкие глаза при спокойном лице могут получить тяжёлое веко', () => {
    const narrow = colourPhoto({}, { features: { eyeWidth: 0.44, eyeOpen: 0.22, eyeTilt: 3.4, eyeSpacing: 1.2 } } as unknown as Partial<PhotoAnalysis>);
    expect(photoEyeOpenZ(narrow)).toBeLessThan(-1);
    expect(eyeNo('male', narrow)).toBeGreaterThan(0);
  });

  it('тип бороды по зонам: полная, короткая с усами, щетина', () => {
    expect(beardKind({ beardScore: 1, mustacheScore: 1, sideBeardScore: 1 })).toBe('full'); // Киану
    expect(beardKind({ beardScore: 1, mustacheScore: 0.96, sideBeardScore: 0.69 })).toBe('short'); // Педро
    expect(beardKind({ beardScore: 0.4, mustacheScore: 0.2, sideBeardScore: 0.1 })).toBe('stubble');
    const style = (a: Partial<PhotoAnalysis>) => {
      const s = pick('male', 'beard', colourPhoto({ skin: '#d99076', hair: '#2e1a16' }, a))!;
      const o = getIndex('male').slotById.get('beard')!.variants[0].options.find((x) => x.i === s.value)!;
      return beardStyleKey('male', o);
    };
    expect(style({ beardScore: 1, mustacheScore: 1, sideBeardScore: 1 })).toBe(BEARD_KIND_STYLE.full);
    expect(style({ beardScore: 1, mustacheScore: 0.96, sideBeardScore: 0.69 })).toBe(BEARD_KIND_STYLE.short);
    expect(style({ beardScore: 0.4 })).toBe(BEARD_KIND_STYLE.stubble);
    expect(style({ beardScore: 0.1 })).toBe('');
  });

  it('цвет бороды — как у волос, а не рыжая щетина на коже', () => {
    const a = colourPhoto({ skin: '#d99076', hair: '#2e1a16', chin: '#68413d' }, { beardScore: 1, mustacheScore: 1, sideBeardScore: 0.7 });
    expect(pick('male', 'beard_color', a)?.colorKey).toBe(linkedColorKey('beard_color', pick('male', 'hair_color', a)!.colorKey!));
    expect(pick('male', 'beard_color', a)?.colorKey).not.toMatch(/ginger|merlot/);
  });

  it('у крашеных рыжих волос брови тёмные (Зендая)', () => {
    const a = colourPhoto({ skin: '#f4a591', hair: '#512f2c', brows: '#754943' });
    expect(pick('female', 'hair_color', a)?.colorKey).toBe('red_merlot');
    expect(pick('female', 'eyebrows_color', a)?.colorKey).toBe('brown_liquorice');
    expect(pick('female', 'eyelash_color', a)?.colorKey).toBe('brown_liquorice');
    expect(pick('female', 'eyebrows_color', a)?.hex).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('связанные цвета: брови и ресницы естественные, борода хранит седину', () => {
    expect(linkedColorKey('eyebrows_color', 'black_salt_n_pepper')).toBe('brown_liquorice');
    expect(linkedColorKey('eyebrows_color', 'black_carbon')).toBe('black_carbon');
    expect(linkedColorKey('eyelash_color', 'pink_magenta')).toBe('brown_liquorice');
    expect(linkedColorKey('beard_color', 'black_salt_n_pepper')).toBe('black_salt_n_pepper');
    expect(linkedColorKey('beard_color', 'blue_sapphire')).toBe('brown_liquorice');
    // Red Merlot — краска: борода, как и брови, тёмно-каштановая; натуральная рыжина остаётся
    expect(linkedColorKey('beard_color', 'red_merlot')).toBe('brown_liquorice');
    expect(linkedColorKey('beard_color', 'ginger_strawberry')).toBe('ginger_strawberry');
    // все ключи существуют в палитре бровей игры
    const keys = new Set(getIndex('male').slotById.get('eyebrows_color')!.variants.flatMap((v) => v.options.map(colorKey)));
    for (const k of NATURAL_BROW_KEYS) expect(keys.has(k), k).toBe(true);
  });

  it('цвет помады не выдаётся, если итоговый тип помады «нет»', () => {
    for (const g of ['male', 'female'] as const) expect(getIndex(g).slotById.get('makeupLips_type')!.variants[0].options[0].label.en).toBe('OFF');
    const local: Suggestion[] = [
      { slotId: 'makeupLips_type', value: 0, conf: LIPS_NONE_CONF, src: 'local' },
      { slotId: 'makeupLips_color', number: 1, conf: 0.35, src: 'local' },
    ];
    expect(mergeSuggestions(local).some((x) => x.slotId === 'makeupLips_color')).toBe(false);
    // модель включила блеск — цвет остаётся
    const llm: Suggestion[] = [{ slotId: 'makeupLips_type', number: 3, conf: 0.6, src: 'llm' }];
    const m = mergeSuggestions(local, llm);
    expect(m.find((x) => x.slotId === 'makeupLips_type')?.number).toBe(3);
    expect(m.some((x) => x.slotId === 'makeupLips_color')).toBe(true);
    // модель сказала «нет» (номер 1) — локальный цвет снимается
    expect(mergeSuggestions(local, [{ slotId: 'makeupLips_type', number: 1, conf: 0.6, src: 'llm' }]).some((x) => x.slotId === 'makeupLips_color')).toBe(false);
  });
});
