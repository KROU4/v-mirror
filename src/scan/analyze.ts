// Локальный анализ фото: точки лица, геометрия, цвета. Бесплатно, без сети.
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { computeFeatures, type Features, type Pt } from './faceFeatures';
import { detect } from './landmarker';
import {
  chroma,
  hairLike,
  irisColor,
  luminance,
  pixelsAround,
  rgbToHex,
  rgbToLab,
  robustColor,
  samplerFrom,
  type RGB,
} from './colors';

export interface Measured {
  hex: string;
  rgb: RGB;
}

export interface PhotoAnalysis {
  width: number;
  height: number;
  landmarks: Pt[];
  features: Features;
  /** поворот головы (градусы), если сильный — геометрия ненадёжна */
  yaw: number;
  pitch: number;
  colors: {
    skin?: Measured;
    iris?: Measured;
    brows?: Measured;
    lips?: Measured;
    hair?: Measured;
    chin?: Measured;
  };
  /** 0..1: тёмная растительность на подбородке/щеках относительно кожи */
  beardScore: number;
  /** 0..1: тёмная полоса над верхней губой (усы) */
  mustacheScore?: number;
  /** 0..1: тёмные нижние щёки у линии челюсти (полная борода, бакенбарды) */
  sideBeardScore?: number;
  /** 0..1: губы заметно насыщеннее кожи (помада) */
  lipstickScore: number;
  /** доля «не кожи» над лбом: 0 — лысина/выбрито, 1 — густые волосы */
  hairCoverage: number;
  /** сколько пикселей волос (не похожих на кожу) ушло в замер цвета волос */
  hairSamples: number;
  /** чёрно-белое фото: цвета кожи, глаз, волос и губ по нему не определить */
  monochrome: boolean;
  blendshapes: Record<string, number>;
}

/** Сколько пикселей «не кожа» в полосе бровей нужно, чтобы считать бровь измеренной. */
export const BROW_MIN_PX = 24;

const m = (c: RGB | null): Measured | undefined => (c ? { rgb: c, hex: rgbToHex(c) } : undefined);

export async function analyzePhoto(img: HTMLImageElement | HTMLCanvasElement): Promise<PhotoAnalysis> {
  const w = img instanceof HTMLImageElement ? img.naturalWidth : img.width;
  const h = img instanceof HTMLImageElement ? img.naturalHeight : img.height;
  const res = await detect(img);
  const lm = res.faceLandmarks[0] as NormalizedLandmark[] | undefined;
  if (!lm) throw new Error('NO_FACE');
  const features = computeFeatures(lm, w, h);

  // Поворот головы из матрицы трансформации
  let yaw = 0, pitch = 0;
  const mat = res.facialTransformationMatrixes?.[0]?.data;
  if (mat) {
    yaw = (Math.atan2(-mat[8], Math.hypot(mat[9], mat[10])) * 180) / Math.PI;
    pitch = (Math.atan2(mat[9], mat[10]) * 180) / Math.PI;
  }

  const s = samplerFrom(img, w, h);
  const P = (i: number) => lm[i];
  const iod = Math.hypot((P(468).x - P(473).x) * w, (P(468).y - P(473).y) * h) / w; // в долях ширины

  // Кожа: щёки и скулы без лба (он чаще всего в блике и под чёлкой); светлую половину пикселей
  // отбрасываем — это блики вспышки и софтбокса, а не цвет кожи
  const skin = robustColor(pixelsAround(s, [P(50), P(280), P(118), P(347), P(205), P(425), P(187), P(411)], iod * 0.07), 0.3, 0.45);
  const irisL = irisColor(s, P(468), P(469));
  const irisR = irisColor(s, P(473), P(474));
  const iris = irisL && irisR ? ([0, 1, 2].map((k) => (irisL[k] + irisR[k]) / 2) as RGB) : irisL ?? irisR;
  const skinLab = skin ? rgbToLab(skin) : null;
  // Освещённый лоб светлее щёк, но того же тона: это кожа, а не светлые волосы (hairLike)
  const notSkin = (c: RGB) => (skinLab ? hairLike(c, skinLab) : true);
  // Брови: полоса между верхней (70/63/105/66/107) и нижней (46/53/52/65/55) кромкой брови —
  // её середина держится на волосках и при нахмуренных бровях. В замер идут только пиксели
  // «не кожа», из них самая тёмная часть (сами волоски, а не просвет кожи между ними). Мало
  // таких пикселей — бровь не измерена (null): цвет бровей возьмётся от волос, а не от кожи
  const BROW_PAIRS = [[70, 46], [63, 53], [105, 52], [66, 65], [107, 55], [300, 276], [293, 283], [334, 282], [296, 295], [336, 285]];
  const browPts: Pt[] = BROW_PAIRS.map(([u, d]) => ({ x: (P(u).x + P(d).x) / 2, y: (P(u).y + P(d).y) / 2 }));
  const browPx = pixelsAround(s, browPts, iod * 0.06).filter(notSkin);
  const brows = browPx.length >= BROW_MIN_PX ? robustColor(browPx, 0.02, 0.85) : null;
  const lips = robustColor(pixelsAround(s, [P(0), P(17), P(37), P(267), P(84), P(314)], iod * 0.03), 0.2, 0.2);
  const chin = robustColor(pixelsAround(s, [P(152), P(175), P(199), P(171), P(396), P(136), P(365)], iod * 0.06), 0.1, 0.1);
  // Усы: полоса над верхней губой (между основанием носа и губой), бакенбарды и щёки бороды —
  // нижняя часть щёк у линии челюсти. По ним отличаем полную бороду от усов со щетиной
  const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
  const mustache = robustColor(pixelsAround(s, [lerp(P(164), P(0), 0.5), lerp(P(165), P(37), 0.5), lerp(P(391), P(267), 0.5)], iod * 0.035), 0.1, 0.1);
  const jawSide = robustColor(pixelsAround(s, [lerp(P(58), P(172), 0.5), lerp(P(288), P(397), 0.5), lerp(P(214), P(135), 0.5), lerp(P(434), P(364), 0.5)], iod * 0.05), 0.1, 0.1);

  // Волосы. «Вверх» — по направлению от подбородка ко лбу; «вбок» — перпендикуляр к нему.
  const vx = P(10).x - P(152).x, vy = P(10).y - P(152).y;
  const up = (p: Pt, k: number): Pt => ({ x: p.x + vx * k, y: p.y + vy * k });
  // Полоса поперёк лба на высоте k: 7 точек на ширину лба (между висками 54 и 284)
  const halfW = Math.hypot((P(284).x - P(54).x) * w, (P(284).y - P(54).y) * h) / 2;
  const len = Math.hypot(vx * w, vy * h) || 1;
  const px0 = (-vy * h) / len, py0 = (vx * w) / len;
  const band = (k: number): RGB[] => {
    const c = up(P(10), k);
    const pts: Pt[] = [];
    for (let j = -3; j <= 3; j++) pts.push({ x: c.x + (px0 * halfW * j * 0.25) / w, y: c.y + (py0 * halfW * j * 0.25) / h });
    return pixelsAround(s, pts, iod * 0.035);
  };
  // Линия роста волос: идём от точки 10 вверх до первых ДВУХ подряд полос, где больше половины
  // пикселей не кожа (одна полоса — это часто блик или тень складки на лбу).
  // Средний цвет по смеси лба и волос давал светлый или рыжий тон вместо тёмных волос.
  const hairy = (k: number) => {
    const px = band(k);
    return px.length > 0 && px.filter(notSkin).length / px.length > 0.5;
  };
  let hairline = -1;
  for (let k = 0, prev = hairy(0); k <= 0.3 + 1e-9; k += 0.02) {
    const next = hairy(k + 0.02);
    if (prev && next) {
      hairline = k;
      break;
    }
    prev = next;
  }
  const hairPts = [up(P(10), 0.12), up(P(10), 0.2), up(P(109), 0.12), up(P(338), 0.12), up(P(67), 0.08), up(P(297), 0.08)];
  const hairPx = pixelsAround(s, hairPts, iod * 0.08);
  const hairOnly = (hairline >= 0 ? [...band(hairline + 0.03), ...band(hairline + 0.06)] : hairPx).filter(notSkin);
  const hair = hairOnly.length >= 40 ? robustColor(hairOnly, 0.1, 0.25) : null;

  const darkScore = (c: RGB | null) => (skin && c ? Math.max(0, Math.min(1, (0.88 - luminance(c) / Math.max(1, luminance(skin))) / 0.35)) : 0);
  const beardScore = darkScore(chin);
  const mustacheScore = darkScore(mustache);
  const sideBeardScore = darkScore(jawSide);
  let lipstickScore = 0;
  if (skin && lips) {
    const ls = rgbToLab(lips), ss = rgbToLab(skin);
    lipstickScore = Math.max(0, Math.min(1, (chroma(ls) - chroma(ss) - 12) / 25));
  }
  const hairCoverage = skin && hairPx.length ? hairPx.filter(notSkin).length / hairPx.length : 0;
  // Ч/б фото: у кожи, губ, подбородка и волос почти нет насыщенности (у цветных фото > 15)
  const chromas = [skin, lips, chin, hair].filter((c): c is RGB => !!c).map((c) => chroma(rgbToLab(c)));
  const monochrome = chromas.length > 0 && chromas.reduce((a, b) => a + b, 0) / chromas.length < 4;

  const blendshapes: Record<string, number> = {};
  for (const c of res.faceBlendshapes?.[0]?.categories ?? []) blendshapes[c.categoryName] = c.score;

  return {
    width: w,
    height: h,
    landmarks: lm.map((p) => ({ x: p.x, y: p.y, z: p.z })),
    features,
    yaw,
    pitch,
    colors: { skin: m(skin), iris: m(iris), brows: m(brows), lips: m(lips), hair: m(hair), chin: m(chin) },
    beardScore,
    mustacheScore,
    sideBeardScore,
    lipstickScore,
    hairCoverage,
    hairSamples: hairOnly.length,
    monochrome,
    blendshapes,
  };
}
