import { describe, expect, it } from 'vitest';
import {
  acesFilmicRGB,
  CAP_STUBBLE,
  capCoverage,
  EYE_IRIS,
  NOSE_EVEN,
  noseEven,
  noseFoldFade,
  SKIN_FALLOFF,
  SKIN_HUE_KEEP,
  SKIN_NORMAL_SCALE,
  skinScatter,
  skinToneMap,
} from './materials';

const s2l = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const l2s = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055);
/** sRGB-альбедо (0–255) под белым светом силы e → отношение G/R на экране */
const screenGR = (srgb: [number, number, number], e: number, map: (c: [number, number, number]) => [number, number, number]) => {
  const out = map(srgb.map((v) => s2l(v / 255) * e) as [number, number, number]).map(l2s);
  return out[1] / out[0];
};

describe('SKIN_NORMAL_SCALE (единое соглашение карт нормалей)', () => {
  it('OpenGL без зеркалирования X: та же шкала у головы, тела, рук и белья', () => {
    expect([...SKIN_NORMAL_SCALE]).toEqual([1, 1]);
  });
});

describe('skinToneMap (оттенок кожи в полутени)', () => {
  // кончик носа и щека мужчины, альбедо d01
  const noseTip: [number, number, number] = [148, 91, 79];
  const albedoGR = noseTip[1] / noseTip[0];

  it('обычный ACES в полутени краснит нос (воспроизводит «обгоревший» нос)', () => {
    expect(screenGR(noseTip, 0.8, (c) => acesFilmicRGB(c))).toBeLessThan(albedoGR - 0.05);
  });

  it('при полном сохранении (keep = 1) оттенок альбедо держится в полутени и на свету', () => {
    for (const e of [0.5, 0.8, 1.2]) {
      const gr = screenGR(noseTip, e, (c) => skinToneMap(c, 1));
      expect(Math.abs(gr - albedoGR)).toBeLessThan(0.04);
    }
  });

  it('по умолчанию — половинное сохранение: тени теплее, чем при полном, но не «обгоревшие», как у ACES', () => {
    expect(SKIN_HUE_KEEP).toBeGreaterThanOrEqual(0.3);
    expect(SKIN_HUE_KEEP).toBeLessThanOrEqual(0.7);
    const def = screenGR(noseTip, 0.5, (c) => skinToneMap(c));
    expect(def).toBeLessThan(screenGR(noseTip, 0.5, (c) => skinToneMap(c, 1)));
    expect(def).toBeGreaterThan(screenGR(noseTip, 0.5, (c) => acesFilmicRGB(c)));
  });

  it('при keep = 0 совпадает с обычным ACES, серый не меняется', () => {
    const c: [number, number, number] = [0.3, 0.1, 0.08];
    const a = acesFilmicRGB(c);
    skinToneMap(c, 0).forEach((v, i) => expect(v).toBeCloseTo(a[i], 6));
    const g = skinToneMap([0.2, 0.2, 0.2]);
    expect(g[0]).toBeCloseTo(g[1], 4);
    expect(g[1]).toBeCloseTo(g[2], 4);
  });

  it('не темнее и не светлее обычного ACES по яркости заметно', () => {
    const c: [number, number, number] = [0.25, 0.1, 0.07];
    const lum = (x: number[]) => 0.2126 * x[0] + 0.7152 * x[1] + 0.0722 * x[2];
    expect(Math.abs(lum(skinToneMap(c)) - lum(acesFilmicRGB(c)))).toBeLessThan(0.03);
  });
});

describe('noseEven (альбедо носа по щекам)', () => {
  const lin = (c: [number, number, number]) => c.map((v) => s2l(v / 255)) as [number, number, number];
  const gr = (c: number[]) => l2s(c[1]) / l2s(c[0]);
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // образцы альбедо d01 (sRGB): спинка носа и средняя по щекам
  const maleBridge = lin([146, 90, 77]);
  const maleCheeks = lin([165, 116, 100]);
  const femaleBridge = lin([174, 136, 119]);
  const femaleCheeks = lin([172, 123, 101]);

  it('мужской нос светлеет и теряет лишнюю красноту', () => {
    const out = noseEven(maleBridge, maleCheeks);
    expect(lum(out)).toBeGreaterThan(lum(maleBridge) * 1.2);
    expect(lum(out)).toBeLessThanOrEqual(lum(maleCheeks) * 1.01);
    expect(gr(out)).toBeGreaterThan(gr(maleBridge) + 0.04);
    expect(gr(out)).toBeLessThanOrEqual(gr(maleCheeks) + 0.01);
  });

  it('нос, уже как щёки (женское альбедо), почти не меняется', () => {
    const out = noseEven(femaleBridge, femaleCheeks);
    out.forEach((v, i) => expect(Math.abs(v - femaleBridge[i]) / femaleBridge[i]).toBeLessThan(0.02));
  });

  it('провалы ноздрей не высветляются', () => {
    const hole = lin([45, 22, 20]);
    expect(lum(noseEven(hole, maleCheeks))).toBeCloseTo(lum(hole), 4);
  });

  it('поры и веснушки сохраняют контраст: поправка по размытому альбедо одна на соседние пиксели', () => {
    const pore = maleBridge.map((v) => v * 0.6) as [number, number, number];
    const a = noseEven(maleBridge, maleCheeks, 1, NOSE_EVEN, maleBridge);
    const b = noseEven(pore, maleCheeks, 1, NOSE_EVEN, maleBridge);
    b.forEach((v, i) => expect(v / a[i]).toBeCloseTo(0.6, 6));
  });

  it('вне эллипса носа (mask = 0) цвет не трогается', () => {
    expect(noseEven(maleBridge, maleCheeks, 0)).toEqual(maleBridge);
  });

  it('подъём яркости ограничен', () => {
    expect(NOSE_EVEN.maxLift).toBeLessThanOrEqual(1.4);
    expect(NOSE_EVEN.amount).toBeLessThanOrEqual(1);
  });
});

describe('noseFoldFade (складка «стенка носа — щека»)', () => {
  it('на штрихе (u 0,52–0,545, v 0,24–0,30) детальный рельеф почти погашен, с обеих сторон носа', () => {
    for (const [u, v] of [
      [0.522, 0.243],
      [0.533, 0.263],
      [0.525, 0.298],
      [1 - 0.525, 0.27],
    ])
      expect(noseFoldFade(u, v)).toBeLessThan(0.2);
  });

  it('спинка носа, щёки, веки и губы не затронуты', () => {
    for (const [u, v] of [
      [0.5, 0.26],
      [0.62, 0.32],
      [0.38, 0.32],
      [0.53, 0.18],
      [0.5, 0.4],
    ])
      expect(noseFoldFade(u, v)).toBeCloseTo(1, 6);
  });
});

describe('скаттер кожи и радужка', () => {
  it('«завёрнутый» свет тёплый: по цвету спада рассеяния #ffb2a5, красного больше всего', () => {
    const s = skinScatter();
    expect(s.x).toBeGreaterThan(s.y * 1.8);
    expect(s.y).toBeGreaterThan(s.z);
    expect(s.x).toBeCloseTo(SKIN_FALLOFF.amount, 6);
    expect(s.z).toBeGreaterThan(0.1);
  });

  it('радужка: слабая карта нормалей и умеренное отражение окружения, без зажима шероховатости', () => {
    expect(EYE_IRIS.normal).toBeLessThanOrEqual(0.4);
    expect(EYE_IRIS.envMap).toBeGreaterThanOrEqual(0.3);
    expect(EYE_IRIS.envMap).toBeLessThanOrEqual(0.4);
    expect('roughMin' in EYE_IRIS).toBe(false);
  });
});

describe('CAP_STUBBLE (щетина выбритой части)', () => {
  it('сквозь декаль видна кожа, но выбритая часть темнее кожи', () => {
    const cov = capCoverage();
    expect(cov).toBeGreaterThan(CAP_STUBBLE.floor);
    expect(cov).toBeLessThan(0.75);
    expect(cov).toBeGreaterThan(0.35);
  });

  it('точка щетины помещается в ячейку', () => {
    expect(CAP_STUBBLE.radius).toBeLessThan(0.5);
    expect(CAP_STUBBLE.scale).toBeGreaterThan(100);
  });
});
