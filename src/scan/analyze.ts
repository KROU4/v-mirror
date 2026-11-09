// Локальный анализ фото: точки лица, геометрия, цвета. Бесплатно, без сети.
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { computeFeatures, type Features, type Pt } from './faceFeatures';
import { detect } from './landmarker';
import {
  chroma,
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
  /** 0..1: губы заметно насыщеннее кожи (помада) */
  lipstickScore: number;
  /** доля «не кожи» над лбом: 0 — лысина/выбрито, 1 — густые волосы */
  hairCoverage: number;
  blendshapes: Record<string, number>;
}

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

  const skin = robustColor(pixelsAround(s, [P(50), P(280), P(151), P(118), P(347)], iod * 0.09), 0.2, 0.2);
  const irisL = irisColor(s, P(468), P(469));
  const irisR = irisColor(s, P(473), P(474));
  const iris = irisL && irisR ? ([0, 1, 2].map((k) => (irisL[k] + irisR[k]) / 2) as RGB) : irisL ?? irisR;
  const brows = robustColor(pixelsAround(s, [P(105), P(66), P(334), P(296), P(63), P(293)], iod * 0.035), 0.05, 0.45);
  const lips = robustColor(pixelsAround(s, [P(0), P(17), P(37), P(267), P(84), P(314)], iod * 0.03), 0.2, 0.2);
  const chin = robustColor(pixelsAround(s, [P(152), P(175), P(199), P(171), P(396), P(136), P(365)], iod * 0.06), 0.1, 0.1);

  // Волосы: полоса над верхней точкой лба (10) и над висками
  const up = (p: Pt, k: number): Pt => {
    // «вверх» по направлению от подбородка ко лбу
    const vx = P(10).x - P(152).x, vy = P(10).y - P(152).y;
    return { x: p.x + vx * k, y: p.y + vy * k };
  };
  const hairPts = [up(P(10), 0.12), up(P(10), 0.2), up(P(109), 0.12), up(P(338), 0.12), up(P(67), 0.08), up(P(297), 0.08)];
  const hairPx = pixelsAround(s, hairPts, iod * 0.08);
  const hair = robustColor(hairPx, 0.1, 0.3);

  let beardScore = 0;
  if (skin && chin) {
    const ratio = luminance(chin) / Math.max(1, luminance(skin));
    beardScore = Math.max(0, Math.min(1, (0.88 - ratio) / 0.35));
  }
  let lipstickScore = 0;
  if (skin && lips) {
    const ls = rgbToLab(lips), ss = rgbToLab(skin);
    lipstickScore = Math.max(0, Math.min(1, (chroma(ls) - chroma(ss) - 12) / 25));
  }
  let hairCoverage = 0;
  if (skin && hairPx.length) {
    const sl = rgbToLab(skin);
    const notSkin = hairPx.filter((c) => {
      const l = rgbToLab(c);
      return Math.hypot(l[0] - sl[0], l[1] - sl[1], l[2] - sl[2]) > 18;
    }).length;
    hairCoverage = notSkin / hairPx.length;
  }

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
    lipstickScore,
    hairCoverage,
    blendshapes,
  };
}
