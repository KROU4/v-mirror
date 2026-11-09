// Геометрические признаки лица по 478 точкам MediaPipe Face Landmarker.
// Одна и та же функция считает признаки и для фото пользователя, и для рендеров
// морфов головы V (см. tools/calibrate), поэтому их можно сравнивать напрямую.

export interface Pt {
  x: number;
  y: number;
  z?: number;
}

export type FeatureName =
  | 'eyeWidth'
  | 'eyeOpen'
  | 'eyeTilt'
  | 'eyeSpacing'
  | 'noseWidth'
  | 'noseLength'
  | 'noseBridge'
  | 'mouthWidth'
  | 'upperLip'
  | 'lowerLip'
  | 'jawWidth'
  | 'chinWidth'
  | 'faceLength'
  | 'lowerFace'
  | 'chinLength'
  | 'cheekWidth';

export type Features = Record<FeatureName, number>;

/** Какие признаки описывают каждый морф-слот редактора. */
export const SLOT_FEATURES: Record<'eyes' | 'nose' | 'mouth' | 'jaw', FeatureName[]> = {
  eyes: ['eyeWidth', 'eyeOpen', 'eyeTilt', 'eyeSpacing'],
  nose: ['noseWidth', 'noseLength', 'noseBridge'],
  mouth: ['mouthWidth', 'upperLip', 'lowerLip'],
  jaw: ['jawWidth', 'chinWidth', 'lowerFace', 'chinLength', 'faceLength'],
};

// Индексы точек канонической сетки MediaPipe
const L = {
  rEyeOuter: 33, rEyeInner: 133, rEyeTop: 159, rEyeBottom: 145,
  lEyeOuter: 263, lEyeInner: 362, lEyeTop: 386, lEyeBottom: 374,
  rIris: 468, lIris: 473,
  noseTip: 1, noseBridgeTop: 168, subnasale: 2, rAlar: 98, lAlar: 327, rBridge: 193, lBridge: 417,
  mouthR: 61, mouthL: 291, upperLipTop: 0, upperLipIn: 13, lowerLipIn: 14, lowerLipBottom: 17,
  rCheek: 234, lCheek: 454, rJaw: 172, lJaw: 397, rChin: 150, lChin: 379, chin: 152, forehead: 10,
} as const;

const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a: Pt, b: Pt): Pt => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * @param lm  точки в пикселях (x,y) — если на входе нормализованные координаты,
 *            передайте ширину/высоту изображения, чтобы учесть соотношение сторон.
 */
export function computeFeatures(lmIn: Pt[], width = 1, height = 1): Features {
  const lm = lmIn.map((p) => ({ x: p.x * width, y: p.y * height }));
  const p = (i: number) => lm[i];

  // Выравниваем по линии глаз (компенсация наклона головы)
  const rc = p(L.rIris) ?? mid(p(L.rEyeOuter), p(L.rEyeInner));
  const lc = p(L.lIris) ?? mid(p(L.lEyeOuter), p(L.lEyeInner));
  const ang = Math.atan2(lc.y - rc.y, lc.x - rc.x);
  const cos = Math.cos(-ang);
  const sin = Math.sin(-ang);
  const R = lm.map((q) => ({ x: q.x * cos - q.y * sin, y: q.x * sin + q.y * cos }));
  const r = (i: number) => R[i];

  const iod = d(r(L.rIris) ?? rc, r(L.lIris) ?? lc);
  const eyeWR = d(r(L.rEyeOuter), r(L.rEyeInner));
  const eyeWL = d(r(L.lEyeOuter), r(L.lEyeInner));
  const eyeW = (eyeWR + eyeWL) / 2;
  const eyeH = (Math.abs(r(L.rEyeTop).y - r(L.rEyeBottom).y) + Math.abs(r(L.lEyeTop).y - r(L.lEyeBottom).y)) / 2;
  // наклон: внешний уголок выше внутреннего => положительный (в градусах)
  const tiltR = (Math.atan2(r(L.rEyeInner).y - r(L.rEyeOuter).y, r(L.rEyeInner).x - r(L.rEyeOuter).x) * 180) / Math.PI;
  const tiltL = (Math.atan2(r(L.lEyeInner).y - r(L.lEyeOuter).y, r(L.lEyeOuter).x - r(L.lEyeInner).x) * 180) / Math.PI;

  const cheekW = Math.abs(r(L.lCheek).x - r(L.rCheek).x);
  const faceH = Math.abs(r(L.chin).y - r(L.forehead).y);
  const mouthW = d(r(L.mouthR), r(L.mouthL));

  return {
    eyeWidth: eyeW / iod,
    eyeOpen: eyeH / eyeW,
    eyeTilt: (tiltR + tiltL) / 2,
    eyeSpacing: Math.abs(r(L.lEyeInner).x - r(L.rEyeInner).x) / eyeW,
    noseWidth: Math.abs(r(L.lAlar).x - r(L.rAlar).x) / iod,
    noseLength: Math.abs(r(L.subnasale).y - r(L.noseBridgeTop).y) / iod,
    noseBridge: Math.abs(r(L.lBridge).x - r(L.rBridge).x) / iod,
    mouthWidth: mouthW / iod,
    upperLip: Math.abs(r(L.upperLipIn).y - r(L.upperLipTop).y) / mouthW,
    lowerLip: Math.abs(r(L.lowerLipBottom).y - r(L.lowerLipIn).y) / mouthW,
    jawWidth: Math.abs(r(L.lJaw).x - r(L.rJaw).x) / cheekW,
    chinWidth: Math.abs(r(L.lChin).x - r(L.rChin).x) / cheekW,
    faceLength: faceH / cheekW,
    lowerFace: Math.abs(r(L.chin).y - r(L.subnasale).y) / faceH,
    chinLength: Math.abs(r(L.chin).y - r(L.lowerLipBottom).y) / iod,
    cheekWidth: cheekW / iod,
  };
}

/** Признаки, по которым у фронтального фото есть смысл судить о слоте. */
export function pickFeatures(f: Features, names: FeatureName[]): number[] {
  return names.map((n) => f[n]);
}
