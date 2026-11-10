import { describe, expect, it } from 'vitest';
import {
  acesFilmicRGB,
  CAP_STUBBLE,
  capCoverage,
  catchlight,
  creaseSpecular,
  EYE_CATCHLIGHT,
  EYE_IRIS,
  HAIR_GRADE,
  browKey,
  DECAL_SAMPLER_BUDGET,
  decalSamplers,
  HAIR_GRADE_LIMITS,
  HAIR_TINT_LIMIT,
  gradeHair,
  hairAlbedo,
  hairGrade,
  inkFactor,
  isInkDecal,
  NOSE_EVEN,
  NOSE_SCATTER,
  SKIN_CREASE,
  noseEven,
  noseEvenMask,
  underEyeEven,
  underEyeMask,
  UNDER_EYE,
  MOUTH_EVEN,
  mouthEven,
  mouthEvenMask,
  decalDefines,
  noseFoldFade,
  SKIN_FALLOFF,
  SKIN_HUE_KEEP,
  SKIN_NORMAL_SCALE,
  skinScatter,
  skinToneMap,
  TATTOO_INK,
  Materials,
  scleraDim,
  texturesOf,
} from './materials';
import * as THREE from 'three';
import { defaultState, slotValue } from '../../model/state';
import type { AssetStore, BrowColour, BrowStyle, HairManifest, HairMaterial, SkinGender } from './assets';

describe('texturesOf sees the textures of shader patches', () => {
  // A texture missing from texturesOf is freed by the memory trim while the material still
  // samples it: brow gradients and hair ramps then uploaded from a closed ImageBitmap (black).
  const store = {
    texture: (rel: string) => Promise.resolve(Object.assign(new THREE.Texture(), { name: rel })),
    maybeTexture: (rel: string | null | undefined) => Promise.resolve(rel ? Object.assign(new THREE.Texture(), { name: rel }) : null),
  } as unknown as AssetStore;
  const names = (m: THREE.Material) => [...texturesOf(m)].map((t) => t.name).sort();

  const skin = {
    maps: { normal: 'hn.png', roughness: 'hr.png', detailNormal: 'hd.png', microDetailNormal: 'hm.png' },
    params: { DetailNormalInfluence: 1, MicroDetailInfluence: 1, MicroDetailUVScale01: 1 },
    skinTypes: { d01: { albedo: 'ha.png' } },
    skinTones: { t01: { byskinType: {}, tintColor: '#ffffff', tintScale: 0 } },
  } as unknown as SkinGender;

  it('brows: a skin decal — strands, shadow layer, gradient and relief over the head skin maps', async () => {
    const mats = new Materials(store, null);
    const style = { diffuseRGBA: 'd.png', secondaryAlpha: 's.png', normal: 'n.png' } as BrowStyle;
    const colour = { DiffuseAlpha: 1, GradientMapIntensity: 2, SecondaryDiffuseColor: '#3e312a', SecondaryDiffuseAlphaIntensity: 0.6, gradientMapPng: 'g.png' } as BrowColour;
    const m = await mats.browDecal(skin, 'female', 't01', 'd01', style, colour, 'g.png');
    // без тайлового микрорельефа: в шейдере кожи 16 блоков текстур
    expect(names(m)).toEqual(['d.png', 'g.png', 'ha.png', 'hd.png', 'hn.png', 'hr.png', 'n.png', 's.png']);
    expect(m.transparent && !m.depthWrite).toBe(true);
    expect(m.defines).toMatchObject({ FACE_DECAL: '', DECAL_MAP: '', DECAL_GRADIENT: '', DECAL_DOUBLE: '', DECAL_NORMAL: '' });
  });

  it('face decal: no secondary mask or roughness defines without their maps and weights', async () => {
    const mats = new Materials(store, null);
    const m = await mats.faceDecal(skin, 'male', null, 'd01', 'ink', { type: 'decal', diffuse: 'i.png', diffuseColor: '#000000', diffuseAlpha: 1 } as never);
    expect(Object.keys(m.defines ?? {})).toEqual(expect.arrayContaining(['FACE_DECAL', 'DECAL_MAP']));
    for (const k of ['DECAL_SEC', 'DECAL_ROUGH', 'DECAL_METAL', 'DECAL_GRADIENT', 'DECAL_DOUBLE', 'DECAL_NORMAL']) expect(m.defines).not.toHaveProperty(k);
  });

  it('hair cards: packed map, alpha and the colour ramp', async () => {
    const mats = new Materials(store, null);
    const hm = {
      cardSets: { long01: { packed: 'p.png', alpha: 'a' } },
      profiles: { brown: { ramp: 'r.png' } },
      textures: { a: { file: 'a.png' } },
    } as unknown as HairManifest;
    const m = { type: 'hairCards', cardSet: 'long01', profile: 'brown' } as HairMaterial;
    expect(names(await mats.hairCards(hm, m, 'core', true))).toEqual(['a.png', 'p.png', 'r.png']);
  });

  it('hair accessory: baked albedo + ORM of the game material, not the grey atlas mean', async () => {
    const mats = new Materials(store, null);
    const hm = { textures: { alb: { file: 'acc_albedo.png' }, orm: { file: 'acc_orm.png' } } } as unknown as HairManifest;
    const baked = await mats.accessory({ type: 'accessory', albedo: 'alb', orm: 'orm', fallbackColor: '#86817a', roughness: 0.256, metalness: 0.781 } as HairMaterial, hm);
    expect(names(baked)).toEqual(['acc_albedo.png', 'acc_orm.png']);
    expect(baked.color.getHex()).toBe(0xffffff);
    expect([baked.roughness, baked.metalness]).toEqual([1, 1]);
    const plain = await mats.accessory({ type: 'accessory', fallbackColor: '#9a9ea3', roughness: 0, metalness: 1 } as HairMaterial);
    expect(plain.map).toBeNull();
    expect(plain.roughness).toBeGreaterThanOrEqual(0.08);
  });

  it('piercing: узорный цвет — миниатюра редактора, металл — не белый и с умеренным отражением', async () => {
    const mats = new Materials(store, null);
    const marble = await mats.piercing({ type: 'piercing', colour: '#a2a7b0', metalness: 1, roughness: 0.3, name: 'mixed', pattern: 'swatches/icons/Piercing_mixed.webp' });
    expect(names(marble)).toEqual(['swatches/icons/Piercing_mixed.webp']);
    const silver = await mats.piercing({ type: 'piercing', colour: '#c5cecc', metalness: 1, roughness: 0.3, name: 'silver' });
    expect(silver.map).toBeNull();
    expect(Math.max(silver.color.r, silver.color.g, silver.color.b)).toBeLessThanOrEqual(0.75 * new THREE.Color('#c5cecc').g + 1e-6);
    expect(silver.envMapIntensity).toBeLessThan(0.9);
    const pearl = await mats.piercing({ type: 'piercing', colour: '#c0bab3', metalness: 0, roughness: 0.25, name: 'pearl' });
    expect(pearl.color.getHexString()).toBe(new THREE.Color('#c0bab3').getHexString());
  });
});

describe('hairGrade (поправка цвета волос по значкам)', () => {
  const s2lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const hexLin = (h: string): [number, number, number] => [1, 3, 5].map((i) => s2lin(parseInt(h.slice(i, i + 2), 16) / 255)) as [number, number, number];
  /** оттенок CIELAB (°) линейного цвета */
  const hueOf = (c: readonly number[]) => {
    const m = [
      [0.4124, 0.3576, 0.1805],
      [0.2126, 0.7152, 0.0722],
      [0.0193, 0.1192, 0.9505],
    ];
    const [x, y, z] = m.map((r) => r[0] * c[0] + r[1] * c[1] + r[2] * c[2]);
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    const a = 500 * (f(x / 0.95047) - f(y));
    const b = 200 * (f(y) - f(z / 1.08883));
    return ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  };
  /** насыщенность CIELAB (C*) линейного цвета */
  const chromaOf = (c: readonly number[]) => {
    const m = [
      [0.4124, 0.3576, 0.1805],
      [0.2126, 0.7152, 0.0722],
      [0.0193, 0.1192, 0.9505],
    ];
    const [x, y, z] = m.map((r) => r[0] * c[0] + r[1] * c[1] + r[2] * c[2]);
    const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
    return Math.hypot(500 * (f(x / 0.95047) - f(y)), 200 * (f(y) - f(z / 1.08883)));
  };
  const dHue = (a: number, b: number) => ((a - b + 540) % 360) - 180;
  /** кусочно-линейная рампа по стопам (как профиль .hp в наборе): интерполяция 8-битных sRGB */
  const ramp = (stops: [number, string][]) => (t: number) => {
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    let k = 0;
    while (k < stops.length - 1 && stops[k + 1][0] < t) k++;
    const [p0, h0] = stops[k];
    const [p1, h1] = stops[Math.min(k + 1, stops.length - 1)];
    const w = p1 > p0 ? Math.min(1, Math.max(0, (t - p0) / (p1 - p0))) : 0;
    const a = rgb(h0), b = rgb(h1);
    return a.map((x, i) => s2lin((x + (b[i] - x) * w) / 255)) as [number, number, number];
  };
  // Профили игры (base\characters\common\hair	extures\hair_profiles\*.hp): стопы корень→кончик и ID
  const PROFILES = {
    red_merlot: {
      rt: ramp([[0, '#615b5d'], [0.172794, '#745d6b'], [0.610294, '#c94a56'], [1, '#803636']]),
      id: ['#857d6c', '#bfb492', '#7f7070', '#9c6060'],
      icon: '#422720',
    },
    red_apple: {
      rt: ramp([[0.02589, '#948b7a'], [0.38835, '#b53b3b'], [1, '#ef5a5a']]),
      id: ['#eac184', '#d5c9c9', '#e5de90', '#f43838', '#b2a078'],
      icon: '#8f4928',
    },
  } as const;

  it('у каждого цвета волос каталога есть поправка, скальп берёт её по имени LUT', () => {
    for (const g of ['female', 'male'] as const) {
      const apps = slotValue(defaultState(g), 'hair_color')!.variant.options.map((o) => o.app!);
      expect(apps.length).toBe(35);
      for (const a of apps) expect(HAIR_GRADE, a).toHaveProperty(a.replace(/^\d+_/, ''));
    }
    expect(hairAlbedo('hh_cap_grad__red_merlot').toArray()).toEqual(hairAlbedo('red_merlot').toArray());
    expect(hairGrade('hh_cap_grad__red_merlot')).toBe(HAIR_GRADE.red_merlot);
    expect(hairAlbedo('unknown_profile').toArray()).toEqual(hairAlbedo(null).toArray());
  });

  it('поправка в пределах: яркость и насыщенность ограничены, сдвиг каналов слабый', () => {
    for (const [p, g] of Object.entries(HAIR_GRADE)) {
      expect(g.k, p).toBeGreaterThanOrEqual(HAIR_GRADE_LIMITS.k[0]);
      expect(g.k, p).toBeLessThanOrEqual(HAIR_GRADE_LIMITS.k[1]);
      expect(g.s, p).toBeGreaterThanOrEqual(HAIR_GRADE_LIMITS.s[0]);
      expect(g.s, p).toBeLessThanOrEqual(HAIR_GRADE_LIMITS.s[1]);
      for (const x of g.tint ?? []) {
        expect(x, p).toBeGreaterThanOrEqual(HAIR_TINT_LIMIT[0]);
        expect(x, p).toBeLessThanOrEqual(HAIR_TINT_LIMIT[1]);
      }
    }
  });

  it('мерло и красное яблоко: оттенок прядей по всей длине рядом со значком, зелёных прядей нет', () => {
    for (const [name, pr] of Object.entries(PROFILES)) {
      const g = HAIR_GRADE[name];
      const iconHue = hueOf(hexLin(pr.icon));
      const idMean = [0, 1, 2].map((i) => pr.id.reduce((s, h) => s + hexLin(h)[i], 0) / pr.id.length);
      // средняя прядь по длине (корень→кончик, ID — среднее)
      for (let t = 0.3; t <= 1.0001; t += 0.1) {
        const c = gradeHair(pr.rt(t).map((x, i) => x * idMean[i]) as [number, number, number], g);
        expect(Math.abs(dHue(hueOf(c), iconHue)), `${name} t=${t.toFixed(1)}`).toBeLessThan(25);
      }
      // середина длины — в пределах ±20° от значка
      const mid = gradeHair(pr.rt(0.5).map((x, i) => x * idMean[i]) as [number, number, number], g);
      expect(Math.abs(dHue(hueOf(mid), iconHue)), name).toBeLessThan(20);
      // ни одна прядь (любой стоп ID, любая длина), красная в рампе, не становится зеленее красной
      for (const idHex of pr.id)
        for (let t = 0; t <= 1.0001; t += 0.05) {
          const raw = pr.rt(t).map((x, i) => x * hexLin(idHex)[i]) as [number, number, number];
          const c = gradeHair(raw, g);
          if (raw[0] < 1.1 * raw[1] || chromaOf(raw) < 12) continue; // почти серая прядь: оттенок неустойчив
          expect(c[0], `${name} id ${idHex} t=${t.toFixed(2)}`).toBeGreaterThan(c[1]);
          // и оттенок отдельной пряди поправка сдвигает слабо
          expect(Math.abs(dHue(hueOf(c), hueOf(raw))), `${name} id ${idHex} t=${t.toFixed(2)}`).toBeLessThan(25);
        }
    }
  });
});


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

  it('щетина над верхней губой не выравнивается (иначе «молочные усы»)', () => {
    expect(noseEvenMask(0.5, 0.27)).toBe(1);
    expect(noseEvenMask(0.47, 0.31)).toBeGreaterThan(0.9);
    // под ноздрями (v ≈ 0,322–0,334) — верхняя губа: 0,35–0,37
    for (const u of [0.45, 0.5, 0.55]) for (const v of [0.345, 0.355, 0.365]) expect(noseEvenMask(u, v)).toBe(0);
  });
});

describe('подглазья (UNDER_EYE)', () => {
  const lin = (c: [number, number, number]) => c.map((v) => s2l(v / 255)) as [number, number, number];
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const hue = (c: number[]) => {
    const [r, g, b] = c.map((v) => l2s(v));
    return (Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180) / Math.PI;
  };
  // образцы альбедо d01 (sRGB): тёмная дуга под веком и щека под ней
  const arc = lin([150, 115, 106]);
  const cheek = lin([168, 126, 106]);

  it('эллипс — под обоими глазами и на складке нижнего века, не на щеке, не на переносице и не на верхнем веке', () => {
    expect(underEyeMask(0.4, 0.273)).toBe(1);
    expect(underEyeMask(0.6, 0.273)).toBe(1);
    // складка нижнего века у внутреннего угла (мужчина: u 0,58, v 0,256–0,268)
    expect(underEyeMask(0.58, 0.262)).toBe(1);
    expect(underEyeMask(0.5, 0.273)).toBe(0);
    expect(underEyeMask(0.4, 0.32)).toBe(0);
    expect(underEyeMask(0.4, 0.22)).toBeLessThan(0.1);
  });

  it('дуга светлеет к щеке и теряет сиреневый оттенок, светлее щеки не больше чем на over', () => {
    const out = underEyeEven(arc, cheek);
    expect(lum(out)).toBeGreaterThan(lum(arc) * 1.15);
    expect(lum(out)).toBeGreaterThan(lum(cheek) * 0.99);
    expect(lum(out)).toBeLessThanOrEqual(lum(cheek) * UNDER_EYE.over * 1.01);
    expect(Math.abs(hue(out) - hue(cheek))).toBeLessThan(Math.abs(hue(arc) - hue(cheek)) * 0.4);
  });

  it('линия ресниц (почти чёрная) не высветляется, вне эллипса цвет прежний', () => {
    const lash = lin([40, 30, 28]);
    expect(lum(underEyeEven(lash, cheek))).toBeCloseTo(lum(lash), 4);
    // складка века (вдвое темнее щеки) — светлеет
    const crease = lin([118, 80, 70]);
    expect(lum(underEyeEven(crease, cheek))).toBeGreaterThan(lum(crease) * 1.5);
    expect(underEyeEven(arc, cheek, 0)).toEqual(arc);
  });
});

describe('кожа вокруг рта (MOUTH_EVEN, «молочные усы»)', () => {
  const lin = (c: [number, number, number]) => c.map((v) => s2l(v / 255)) as [number, number, number];
  const lum = (c: number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  const sat = (c: number[]) => (c[0] - c[2]) / lum(c);
  // альбедо мужчины d01 (sRGB): щёки, бледная кайма в уголке рта, губа и тёмная щетина
  const cheek = lin([168, 120, 102]);
  const rim = lin([170, 132, 120]);
  const lip = lin([150, 80, 82]);
  const stubble = lin([120, 98, 92]);

  it('эллипс — над и под губами и в уголках, не на ноздрях и не на щеке', () => {
    for (const [u, v] of [[0.5, 0.365], [0.405, 0.395], [0.595, 0.395], [0.5, 0.43]]) expect(mouthEvenMask(u, v)).toBeGreaterThan(0.9);
    expect(mouthEvenMask(0.5, 0.325)).toBe(0);
    expect(mouthEvenMask(0.38, 0.32)).toBe(0);
    expect(mouthEvenMask(0.3, 0.4)).toBe(0);
  });

  it('бледная кайма темнеет до щеки и получает её оттенок', () => {
    const out = mouthEven(rim, cheek);
    expect(lum(out)).toBeLessThanOrEqual(lum(cheek) * 1.01);
    expect(Math.abs(sat(out) - sat(cheek))).toBeLessThan(Math.abs(sat(rim) - sat(cheek)) * 0.4);
  });

  it('губы и тёмная щетина не меняются', () => {
    for (const c of [lip, stubble]) {
      const out = mouthEven(c, cheek);
      out.forEach((v, i) => expect(v).toBeCloseTo(c[i], 5));
    }
    expect(mouthEven(rim, cheek, 0)).toEqual(rim);
    expect(MOUTH_EVEN.minGain).toBeGreaterThan(0.7);
  });
});

describe('decalDefines (ветки шейдера слоя лица)', () => {
  const none = { map: true, grad: false, sec: false, nrm: false, nAlpha: false, rough: false, metal: false, sec2: false };
  it('шум SecondaryMask с мелким повтором (макияж глаз ×30) — зерно, у шрамов (×1) — форма', () => {
    const eyes = decalDefines({ type: 'decal', diffuse: 'a.png', secondaryMask: 'n.png', secondaryMaskUVScale: 30, secondaryMaskInfluence: 1 }, { ...none, sec: true });
    expect(eyes.DECAL_SEC_GRAIN).toBe('');
    const scar = decalDefines({ type: 'decal', diffuse: 'a.png', secondaryMask: 'n.png', secondaryMaskUVScale: 1, secondaryMaskInfluence: 1 }, { ...none, sec: true });
    expect(scar.DECAL_SEC).toBe('');
    expect(scar.DECAL_SEC_GRAIN).toBeUndefined();
  });
  it('шероховатость без карты (глянцевая помада) — по значению движка по умолчанию', () => {
    const gloss = decalDefines({ type: 'decal', diffuse: 'a.png', roughnessMetalnessAlpha: 0.8, roughnessScale: 0.5 }, none);
    expect(gloss.DECAL_ROUGH_CONST).toBe('');
    expect(gloss.DECAL_ROUGH).toBeUndefined();
  });
  it('металл импланта — по карте металличности, золотая помада — по сдвигу', () => {
    const cyber = decalDefines({ type: 'decal', diffuse: 'a.png', roughnessMetalnessAlpha: 1, roughness: 'r.png', metalness: 'm.png', metalnessBias: 0 }, { ...none, rough: true, metal: true });
    expect(cyber.DECAL_METAL).toBe('');
    expect(cyber.DECAL_METAL_MAP).toBe('');
    const gold = decalDefines({ type: 'decal', diffuse: 'a.png', roughnessMetalnessAlpha: 0.1, metalnessBias: 1 }, none);
    expect(gold.DECAL_METAL).toBe('');
    expect(gold.DECAL_METAL_MAP).toBeUndefined();
    expect(decalDefines({ type: 'decal', diffuse: 'a.png' }, none).DECAL_METAL).toBeUndefined();
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

describe('EYE_CATCHLIGHT (одна искра в глазу)', () => {
  const dir = (() => {
    const l = Math.hypot(...EYE_CATCHLIGHT.dir);
    return EYE_CATCHLIGHT.dir.map((v) => v / l) as [number, number, number];
  })();
  const rot = (deg: number): [number, number, number] => {
    // луч, отклонённый от направления искры на deg градусов (поворот вокруг оси X)
    const a = (deg * Math.PI) / 180;
    const [x, y, z] = dir;
    return [x, y * Math.cos(a) - z * Math.sin(a), y * Math.sin(a) + z * Math.cos(a)];
  };

  it('полная яркость в центре, ноль за краем', () => {
    expect(catchlight(dir)).toBeCloseTo(1);
    expect(catchlight(rot(EYE_CATCHLIGHT.outerDeg + 1))).toBe(0);
    const mid = catchlight(rot((EYE_CATCHLIGHT.innerDeg + EYE_CATCHLIGHT.outerDeg) / 2));
    // мягкий край: между внутренним и внешним радиусом яркость спадает
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.95);
  });

  it('искра сверху слева, со стороны камеры; блики ламп почти погашены', () => {
    expect(dir[0]).toBeLessThan(0);
    expect(dir[1]).toBeGreaterThan(0);
    expect(dir[2]).toBeGreaterThan(0.5);
    expect(EYE_CATCHLIGHT.direct).toBeLessThan(0.25);
    // пятно небольшое: угловой радиус отражения не больше 10°
    expect(EYE_CATCHLIGHT.outerDeg).toBeLessThanOrEqual(10);
  });
});

describe('нос и складки кожи', () => {
  it('заворот на носу менее красный, но не гаснет', () => {
    const s = skinScatter();
    const avg = (s.x + s.y + s.z) / 3;
    const nose = [s.x, s.y, s.z].map((v) => v + (avg * NOSE_SCATTER.gain - v) * NOSE_SCATTER.neutral);
    expect(nose[0] / nose[1]).toBeLessThan(s.x / s.y);
    expect(nose[0] / nose[1]).toBeLessThan(1.4);
    expect(nose[0] + nose[1] + nose[2]).toBeGreaterThan(0.7 * (s.x + s.y + s.z));
  });

  it('блик в глубокой складке карты нормалей гаснет, на порах и ровной коже — полный', () => {
    expect(creaseSpecular(1)).toBe(1);
    expect(creaseSpecular(Math.cos((15 * Math.PI) / 180))).toBe(1);
    expect(creaseSpecular(0.5)).toBe(SKIN_CREASE.floor);
    expect(creaseSpecular(0.87)).toBeGreaterThan(SKIN_CREASE.floor);
    expect(creaseSpecular(0.87)).toBeLessThan(1);
  });
});

describe('тату: чернила умножают кожу', () => {
  const lstar = (c: readonly number[]) => {
    const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
  };
  const lin = (hex: string) => {
    const c = new THREE.Color(hex);
    return [c.r, c.g, c.b] as [number, number, number];
  };
  const mul = (skin: readonly number[], f: readonly number[]) => skin.map((v, i) => v * f[i]);
  const SKINS = ['#f2d3bd', '#c89a7e', '#8a5a40', '#4a2e22', '#2a1a14'];

  it('тату лица и тела распознаются по текстуре игры, шрамы и киберимпланты — нет', () => {
    expect(isInkDecal('tex/face/decals/head_tattoo__customisation_02_d01.png')).toBe(true);
    expect(isInkDecal('body/intimate/tex/tattoo_body__customisation_03_d01.png')).toBe(true);
    expect(isInkDecal('tex/face/decals/h0_000_pma__basehead_scars_d01.png')).toBe(false);
    expect(isInkDecal('tex/face/decals/hx_cyberware_01_d01.png')).toBe(false);
    expect(isInkDecal('body/intimate/tex/t0_000_pma_base__scars_d01_a.png')).toBe(false);
    expect(isInkDecal(null)).toBe(false);
  });

  it('фон текстуры (телесная «бумага») кожу не меняет, тату никогда не светлит кожу', () => {
    expect(inkFactor(lin(TATTOO_INK.paper), 1, 0.65).every((v) => Math.abs(v - 1) < 1e-6)).toBe(true);
    for (const tex of ['#ffffff', '#ff0000', '#e8d0b0', TATTOO_INK.paper])
      for (const a of [0, 0.3, 1]) expect(Math.max(...inkFactor(lin(tex), a, 0.7))).toBeLessThanOrEqual(1 + 1e-9);
  });

  it('чёрные чернила темнее кожи минимум на 25 L* на светлой и средней коже, темнее и на тёмной', () => {
    const f = inkFactor(lin('#141414'), 1, 0.65);
    for (const s of SKINS) {
      const skin = lin(s);
      const d = lstar(mul(skin, f)) - lstar(skin);
      if (lstar(skin) > 45) expect(d).toBeLessThan(-25);
      else expect(d).toBeLessThan(-5);
    }
  });

  it('тёмно-бирюзовый блэкворк игры только затемняет кожу, без оливково-бирюзового оттенка', () => {
    const f = inkFactor(lin('#1e2e29'), 1, 0.6);
    for (const s of SKINS) {
      const skin = lin(s);
      const c = mul(skin, f);
      // соотношение каналов кожи сохраняется (оттенок тот же), кожа заметно темнее
      expect(c[2] / c[0]).toBeCloseTo(skin[2] / skin[0], 1);
      expect(c[1] / c[0]).toBeCloseTo(skin[1] / skin[0], 1);
      expect(lstar(c)).toBeLessThan(lstar(skin) - (lstar(skin) > 45 ? 25 : 5));
    }
  });

  it('цветные чернила сохраняют оттенок: красное тату остаётся красным, а не серым', () => {
    const f = inkFactor(lin('#b01818'), 1, 0.7);
    const c = mul(lin('#c89a7e'), f);
    expect(c[0]).toBeGreaterThan(c[1] * 2);
  });
});

describe('склера на тёмной коже', () => {
  it('на тонах 11–12 альбедо глазного яблока приглушено, на светлых — нет', () => {
    expect(scleraDim('06_bl_dark')).toBeLessThanOrEqual(0.8);
    expect(scleraDim('06_bl_dark')).toBeGreaterThanOrEqual(0.75);
    expect(scleraDim('05_bl_espresso')).toBeLessThan(1);
    expect(scleraDim('05_bl_espresso')).toBeGreaterThan(scleraDim('06_bl_dark'));
    for (const t of ['01_ca_pale', '03_ca_senna_01_honey', '04_ca_almond_00_umber', null, undefined]) expect(scleraDim(t)).toBe(1);
  });
});

describe('browKey (кеш материала бровей)', () => {
  const def = { type: 'decal', diffuse: 'd.png', diffuseAlpha: 1, gradient: 'g.png', gradientIntensity: 1, secondaryDiffuseColor: '#4a3a30', normal: 'n.png' };
  it('любое поле слоя меняет ключ, порядок полей — нет', () => {
    expect(browKey({ ...def })).toBe(browKey(def));
    expect(browKey(Object.fromEntries(Object.entries(def).reverse()))).toBe(browKey(def));
    for (const [k, v] of [['gradientIntensity', 0.8], ['secondaryDiffuseColor', '#000000'], ['normal', 'n2.png']] as const)
      expect(browKey({ ...def, [k]: v }), k).not.toBe(browKey(def));
  });
});

describe('decalSamplers (текстурные блоки слоя лица)', () => {
  it('кибер-имплант с картами шероховатости и металла не помещается рядом с детальной картой кожи', () => {
    const all = { map: true, grad: false, sec: false, nrm: true, nAlpha: true, rough: true, metal: true, sec2: false };
    const cyber = decalDefines({ type: 'decal', diffuse: 'c.png', normalAlpha: 1, roughnessMetalnessAlpha: 1 } as never, all);
    expect(decalSamplers(cyber)).toBe(5);
    expect(decalSamplers(cyber)).toBeGreaterThan(DECAL_SAMPLER_BUDGET);
    // кожа (12 блоков) + слой в пределах бюджета ≤ 16
    const brow = decalDefines({ type: 'decal', diffuse: 'b.png', gradient: 'g.png', normalAlpha: 0.5, secondaryDiffuseAlphaIntensity: 1 } as never, { ...all, grad: true, sec2: true, nAlpha: false, rough: false, metal: false });
    expect(12 + decalSamplers(brow)).toBeLessThanOrEqual(16);
  });
});
