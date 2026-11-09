// Замер цветов по точкам MediaPipe и сравнение цветов в пространстве CIELAB.
import type { Pt } from './faceFeatures';

export type RGB = [number, number, number];
export type Lab = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export function rgbToHex([r, g, b]: RGB): string {
  return '#' + [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('');
}

export function rgbToLab([r, g, b]: RGB): Lab {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
}

/** Взвешенное ΔE76: wL < 1 ослабляет влияние освещённости фото. */
export function deltaE(a: Lab, b: Lab, wL = 1): number {
  return Math.hypot((a[0] - b[0]) * wL, a[1] - b[1], a[2] - b[2]);
}

export const luminance = ([r, g, b]: RGB) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const chroma = (lab: Lab) => Math.hypot(lab[1], lab[2]);

export interface Sampler {
  data: Uint8ClampedArray;
  w: number;
  h: number;
}

export function samplerFrom(source: CanvasImageSource, w: number, h: number): Sampler {
  const scale = Math.min(1, 1024 / Math.max(w, h));
  const cw = Math.round(w * scale), ch = Math.round(h * scale);
  const c = document.createElement('canvas');
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(source, 0, 0, cw, ch);
  return { data: ctx.getImageData(0, 0, cw, ch).data, w: cw, h: ch };
}

/** Пиксели в кругах вокруг точек (координаты нормализованы 0..1). */
export function pixelsAround(s: Sampler, pts: Pt[], radius: number): RGB[] {
  const out: RGB[] = [];
  const rpx = Math.max(1.5, radius * s.w);
  for (const p of pts) {
    const cx = p.x * s.w, cy = p.y * s.h;
    for (let y = Math.floor(cy - rpx); y <= cy + rpx; y++) {
      for (let x = Math.floor(cx - rpx); x <= cx + rpx; x++) {
        if (x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
        if ((x - cx) ** 2 + (y - cy) ** 2 > rpx * rpx) continue;
        const i = (y * s.w + x) * 4;
        out.push([s.data[i], s.data[i + 1], s.data[i + 2]]);
      }
    }
  }
  return out;
}

/** Робастный средний цвет: отбрасываем доли самых тёмных/светлых пикселей. */
export function robustColor(px: RGB[], dropDark = 0.15, dropLight = 0.15): RGB | null {
  if (px.length < 4) return null;
  const sorted = [...px].sort((a, b) => luminance(a) - luminance(b));
  const kept = sorted.slice(Math.floor(sorted.length * dropDark), Math.ceil(sorted.length * (1 - dropLight)));
  if (!kept.length) return null;
  const sum = kept.reduce((acc, c) => [acc[0] + c[0], acc[1] + c[1], acc[2] + c[2]] as RGB, [0, 0, 0] as RGB);
  return [sum[0] / kept.length, sum[1] / kept.length, sum[2] / kept.length];
}

/** Радужка: кольцо между зрачком и краем, без бликов. */
export function irisColor(s: Sampler, center: Pt, edge: Pt): RGB | null {
  const r = Math.hypot((edge.x - center.x) * s.w, (edge.y - center.y) * s.h);
  if (r < 2) return null;
  const px: RGB[] = [];
  const cx = center.x * s.w, cy = center.y * s.h;
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    for (let x = Math.floor(cx - r); x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy) / r;
      if (d < 0.38 || d > 0.85 || x < 0 || y < 0 || x >= s.w || y >= s.h) continue;
      const i = (y * s.w + x) * 4;
      px.push([s.data[i], s.data[i + 1], s.data[i + 2]]);
    }
  }
  return robustColor(px, 0.2, 0.25);
}
