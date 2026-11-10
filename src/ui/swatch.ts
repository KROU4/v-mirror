// Colour swatches of the creator. The game draws each colour option with a thumbnail
// from its UI atlas (gradients, iris photos, nail art). With an asset pack connected
// the UI shows those thumbnails (swatchPackPath); without it, a CSS approximation built
// from committed colour facts (src/data/swatches.*.json, see tools/extract/build_swatches.py).
import type { CSSProperties } from 'react';
import type { Gender } from '../model/catalog';
import maleSwatches from '../data/swatches.male.json';
import femaleSwatches from '../data/swatches.female.json';

export type SwatchKind = 'gradient' | 'radial' | 'solid';
export type SwatchPattern = 'streaks' | 'iris' | 'metal' | 'none';

export interface SwatchDesc {
  kind: SwatchKind;
  /** colours, '#rrggbb' */
  stops: string[];
  /** stop positions 0..100; evenly spaced when absent */
  pos?: number[];
  /** CSS angle of a linear gradient (180 = top to bottom) */
  angle?: number;
  pattern?: SwatchPattern;
  /** iris band in % of the radius: [pupil edge, iris edge] */
  ring?: number[];
  /**
   * Vector motifs drawn over the colours (topmost first in the list order: first = bottom):
   * nail art and patterned lenses (hearts, skulls, webs, checkers…) as generic shapes.
   */
  motif?: SwatchMotif[];
}

export interface SwatchMotif {
  shape: string;
  /** shape colour */
  fg: string;
  /** background of shapes that fill the whole tile (checker) */
  bg?: string;
  /** extra colours (bands, flag, tip) */
  colors?: string[];
}

export interface SwatchSlot {
  /** option index -> swatch key is the same in every variant of the slot */
  stable: boolean;
  keys: string[];
  byIndex?: Record<string, string>;
}

export interface SwatchTable {
  version: number;
  gender: string;
  keys: Record<string, SwatchDesc>;
  slots: Record<string, SwatchSlot>;
}

/** Option fields the swatch lookup needs (a subset of catalog Option). */
export interface SwatchOption {
  i: number;
  icon?: string;
  hex?: string;
  iris?: string;
}

const TABLES: Record<Gender, SwatchTable> = {
  male: maleSwatches as SwatchTable,
  female: femaleSwatches as SwatchTable,
};

export function swatchTable(gender: Gender): SwatchTable {
  return TABLES[gender];
}

/** Key of a swatch: the game's icon name, or `<slot>_<index>` for options the game draws without one. */
export function swatchKey(slotId: string, option: SwatchOption): string {
  return option.icon || `${slotId}_${option.i}`;
}

const SAFE = /^[\w][\w.-]*$/;

/**
 * Path of the thumbnail inside the asset pack (for gameAssetUrl). With the option's icon
 * the shared per-icon image is used: it is right in every variant, including slots whose
 * option order differs between variants (lip and cheek makeup).
 */
export function swatchPackPath(gender: Gender, slotId: string, index: number, icon?: string): string {
  if (icon && SAFE.test(icon)) return `swatches/icons/${icon}.webp`;
  return `swatches/${gender}/${slotId}/${index}.webp`;
}

/** Descriptor for an option: committed colour facts, else a flat colour from the catalog. */
export function lookupSwatch(table: SwatchTable, slotId: string, option: SwatchOption): SwatchDesc | undefined {
  const own = table.keys[swatchKey(slotId, option)];
  if (own) return own;
  const flat = option.iris ?? option.hex;
  return flat ? { kind: 'solid', stops: [flat], pattern: 'none' } : undefined;
}

const HEX = /^#[0-9a-f]{6}$/i;
const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

function stopList(d: SwatchDesc): string {
  const pos = d.pos && d.pos.length === d.stops.length ? d.pos : undefined;
  const last = Math.max(1, d.stops.length - 1);
  const pairs = d.stops
    .map((s, k) => [s, pos ? pos[k] : (k * 100) / last] as const)
    .filter(([s]) => HEX.test(s));
  return pairs.map(([s, p]) => `${s} ${clampPct(p)}%`).join(', ');
}

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** Hair strands running root to tip. */
const STREAKS =
  'repeating-linear-gradient(90deg, rgba(255,255,255,.045) 0 1px, transparent 1px 3px, rgba(0,0,0,.07) 3px 4px, transparent 4px 7px, rgba(255,255,255,.03) 7px 8px, transparent 8px 13px)';
/** Diagonal sheen of polished metal. */
const SHEEN = 'linear-gradient(115deg, transparent 30%, rgba(255,255,255,.22) 48%, transparent 66%)';
/** Radial fibres of an iris. */
const FIBRES =
  'repeating-conic-gradient(from 0deg, rgba(0,0,0,.2) 0deg 2deg, rgba(255,255,255,.07) 2deg 3deg, transparent 3deg 6deg)';

// ------------------------------------------------------------------ motifs
// Plain geometry in a 32×32 box. f = shape colour, m = the whole motif (bg, colors).
type MotifDraw = (f: string, m: SwatchMotif) => string;
const ring = (r: number, f: string, w: number, extra = '') => `<circle cx='16' cy='16' r='${r}' fill='none' stroke='${f}' stroke-width='${w}'${extra}/>`;
const SPLATTER: [number, number, number][] = [
  [16, 17, 4], [11, 13, 2.2], [21, 12, 2], [9, 21, 1.8], [23, 21, 2.4], [16, 8, 1.4], [26, 15, 1.2], [6, 15, 1.1], [14, 25, 1.5], [19, 26, 1], [12, 6, 0.9], [27, 9, 0.8], [5, 9, 0.8], [24, 27, 0.9], [7, 26, 0.8], [29, 22, 0.7], [3, 20, 0.7], [20, 4, 0.7],
];

/** Generic shapes for nail art and patterned lenses (no game artwork). */
export const MOTIFS: Record<string, MotifDraw> = {
  heart: (f) => `<path d='M16 27C6 19.5 3 14.5 6 9.6c2.6-3.8 7.2-3.5 10 .6 2.8-4.1 7.4-4.4 10-.6 3 4.9 0 9.9-10 17.4z' fill='${f}'/>`,
  skull: (f) =>
    `<path fill-rule='evenodd' fill='${f}' d='M16 5c-6.1 0-10 3.9-10 9.4 0 3.4 1.7 5.6 3.6 6.7V25h12.8v-3.9c1.9-1.1 3.6-3.3 3.6-6.7C26 8.9 22.1 5 16 5zM12 12a2.7 2.7 0 1 0 .01 0zM20 12a2.7 2.7 0 1 0 .01 0zM16 17l1.8 3h-3.6z'/><path d='M13 25v-2.5M16 25v-2.5M19 25v-2.5' stroke='${f}' stroke-width='1.2' opacity='.5'/>`,
  cross: (f) => `<path d='M14 3.5h4v7h7v4h-7v14h-4v-14H7v-4h7z' fill='${f}'/>`,
  x: (f) => `<path d='M6 6l20 20M26 6L6 26' stroke='${f}' stroke-width='5.5'/>`,
  spiral: (f) => `<path d='M16 16a1 1 0 0 1 2 0a3 3 0 0 1-6 0a5 5 0 0 1 10 0a7 7 0 0 1-14 0a9 9 0 0 1 18 0a11 11 0 0 1-22 0a13 13 0 0 1 26 0' fill='none' stroke='${f}' stroke-width='1.7'/>`,
  web: (f) => {
    const pts = (r: number) => Array.from({ length: 8 }, (_, k) => `${(16 + r * Math.cos((k * Math.PI) / 4)).toFixed(1)},${(16 + r * Math.sin((k * Math.PI) / 4)).toFixed(1)}`).join(' ');
    const spokes = Array.from({ length: 8 }, (_, k) => `M16 16L${(16 + 16 * Math.cos((k * Math.PI) / 4)).toFixed(1)} ${(16 + 16 * Math.sin((k * Math.PI) / 4)).toFixed(1)}`).join('');
    return `<path d='${spokes}' stroke='${f}' stroke-width='1.1'/>` + [4.5, 9, 13.5].map((r) => `<polygon points='${pts(r)}' fill='none' stroke='${f}' stroke-width='1.1'/>`).join('');
  },
  checker: (f, m) => {
    let s = `<rect width='32' height='32' fill='${m.bg ?? 'transparent'}'/>`;
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) if ((x + y) % 2 === 0) s += `<rect x='${x * 8}' y='${y * 8}' width='8' height='8' fill='${f}'/>`;
    return s;
  },
  dots: (f) => [6, 16, 26].flatMap((y, j) => [6, 16, 26].map((x) => `<circle cx='${x + (j % 2) * 5 - 2}' cy='${y}' r='2.6' fill='${f}'/>`)).join(''),
  star: (f) => `<path d='M16 4l3.5 7.6 8.3.9-6.2 5.6 1.8 8.2L16 22.1 8.6 26.3l1.8-8.2-6.2-5.6 8.3-.9z' fill='${f}'/>`,
  flag: (f, m) => {
    const [blue, red] = m.colors ?? ['#24448a', '#c8202c'];
    const star = (x: number, y: number) => `<path transform='translate(${x} ${y}) scale(.32)' d='M16 4l3.5 7.6 8.3.9-6.2 5.6 1.8 8.2L16 22.1 8.6 26.3l1.8-8.2-6.2-5.6 8.3-.9z' fill='${f}'/>`;
    return `<rect width='32' height='18' fill='${blue}'/>${star(3, 2)}${star(16, 2)}${star(9.5, 9)}` + [18, 25].map((y) => `<rect y='${y}' width='32' height='3.5' fill='${red}'/><rect y='${y + 3.5}' width='32' height='3.5' fill='${f}'/>`).join('');
  },
  flame: (f) => `<path d='M9 30c-4-5-2-10 2-13-1 4 1 6 3 6-2-6 2-11 6-14-1 5 3 7 4 11 1-2 1-4 0-6 4 4 5 11 0 16z' fill='${f}'/>`,
  splatter: (f) => SPLATTER.map(([x, y, r]) => `<circle cx='${x}' cy='${y}' r='${r}' fill='${f}'/>`).join('') + `<path d='M16 20v9' stroke='${f}' stroke-width='1.6'/>`,
  warning: (f) => `<path d='M16 4.5L29 27H3z' fill='none' stroke='${f}' stroke-width='2.6' stroke-linejoin='round'/><path d='M16 11v8' stroke='${f}' stroke-width='2.8'/><circle cx='16' cy='22.6' r='1.6' fill='${f}'/>`,
  zigzag: (f) => `<path d='M-2 12l8-6 8 8 8-8 8 8 6-4M-2 26l8-6 8 8 8-8 8 8 6-4' fill='none' stroke='${f}' stroke-width='3.5'/>`,
  curves: (f) => `<path d='M4 32C8 18 18 12 32 9M10 32c4-11 12-15 22-17M17 32c3-8 8-10 15-12' fill='none' stroke='${f}' stroke-width='1.8'/>`,
  drip: (f) => `<path d='M0 0h32v9c-1 0-1.5 2-1.5 6s-2.5 4-2.5 0V10c-1.5 0-2 1-2 3s-2.5 2-2.5 0V9c-2 0-2 1.5-2 7s-3 5-3 0V9h-3c0 2-.5 3-1.5 3S10 11 10 9H8c0 4-.5 9-2 9s-2-5-2-9H0z' fill='${f}'/>`,
  medcross: (f) => `<path d='M7 7l18 18M25 7L7 25' stroke='${f}' stroke-width='4.5'/><path d='M16 3v26' stroke='${f}' stroke-width='3'/>`,
  glyph: (f) => `<path d='M6 8h9M10 5v13c0 3-2 5-4 6M7 13h6M19 6l2 3M18 12h9M22 9v16M18 25l4-4 5 4M18 17h9' fill='none' stroke='${f}' stroke-width='2' stroke-linecap='round'/>`,
  textline: (f) => `<path d='M5 12h22M5 16.5h16M5 21h20' stroke='${f}' stroke-width='2.2'/>`,
  trefoil: (f) =>
    ring(12, f, 2.4) + `<circle cx='11' cy='12.5' r='3' fill='${f}'/><circle cx='21' cy='12.5' r='3' fill='${f}'/><circle cx='16' cy='9.5' r='3' fill='${f}'/><path d='M16 12v12M11 15l5 5 5-5' fill='none' stroke='${f}' stroke-width='2'/>`,
  hexagon: (f) => `<path d='M16 4l10.4 6v12L16 28 5.6 22V10z' fill='none' stroke='${f}' stroke-width='2.6'/><path d='M16 10.5l4.8 2.75v5.5L16 21.5l-4.8-2.75v-5.5z' fill='${f}'/>`,
  target: (f) => ring(12.5, f, 2.4) + ring(6.5, f, 2.4) + `<circle cx='16' cy='16' r='2' fill='${f}'/>`,
  ring: (f) => ring(10.5, f, 5),
  segments: (f) => ring(12, f, 1.6, " stroke-dasharray='7 3'") + ring(7.5, f, 1.2) + `<circle cx='16' cy='16' r='3.6' fill='${f}'/>`,
  grid: (f) => {
    let s = ring(13, f, 1.2);
    for (let y = 8; y <= 24; y += 2.6) for (let x = 8; x <= 24; x += 2.6) if ((x - 16) ** 2 + (y - 16) ** 2 < 64) s += `<rect x='${x.toFixed(1)}' y='${y.toFixed(1)}' width='1.5' height='1.5' fill='${f}'/>`;
    return s;
  },
  slit: (f) => ring(12.5, f, 1.4) + `<ellipse cx='16' cy='16' rx='2.6' ry='11' fill='${f}'/>`,
  cat: (f) => ring(13, f, 1.6) + `<path d='M8.5 11l1.5-5.5 4 3.5h4l4-3.5 1.5 5.5c1 1.5 1.5 3 1.5 5 0 5-3.5 8.5-8.5 8.5S7 21 7 16c0-2 .5-3.5 1.5-5z' fill='${f}'/>`,
  double: (f) => `<circle cx='11' cy='16' r='7.5' fill='none' stroke='${f}' stroke-width='3'/><circle cx='21' cy='16' r='7.5' fill='none' stroke='${f}' stroke-width='3'/><circle cx='11' cy='16' r='2.2' fill='${f}'/><circle cx='21' cy='16' r='2.2' fill='${f}'/>`,
  crescent: (f) => ring(11.5, f, 2.2) + `<path d='M14 8v12a4 4 0 0 1-6 3.5M18 8v16' fill='none' stroke='${f}' stroke-width='2.4'/>`,
  wave: (f) => `<rect y='12' width='32' height='9' fill='${f}' opacity='.35'/><rect y='14.5' width='32' height='4' fill='${f}' opacity='.8'/>`,
  squarespiral: (f) => `<path d='M8 25V8h17v14H12V12h9v6h-5' fill='none' stroke='${f}' stroke-width='2.6'/>`,
  veins: (f) => `<path d='M4 6l5 7-3 6 5 8M20 3l-2 7 5 5-2 8 4 6M27 9l-4 4' fill='none' stroke='${f}' stroke-width='1.1'/>`,
  plaid: (f) => `<path d='M0 9h32M0 22h32' stroke='${f}' stroke-width='3.5' opacity='.6'/><path d='M10 0v32M23 0v32' stroke='${f}' stroke-width='2.2' opacity='.45'/>`,
  diag: (f) => `<path d='M32 6v26H6z' fill='${f}'/>`,
  vstripe: (f) => `<rect x='13' width='6' height='32' fill='${f}'/>`,
  hbands: (f) => `<path d='M0 19h32M0 23h32' stroke='${f}' stroke-width='1.4'/>`,
  tip: (f, m) => {
    const cs = m.colors?.length ? m.colors : [f];
    const w = 32 / cs.length;
    return cs.map((c, k) => `<rect x='${(k * w).toFixed(2)}' y='24' width='${w.toFixed(2)}' height='8' fill='${c}'/>`).join('');
  },
  bands: (f, m) => {
    const cs = m.colors?.length ? m.colors : [f];
    const w = 32 / cs.length;
    return cs.map((c, k) => `<rect x='${(k * w).toFixed(2)}' width='${(w + 0.2).toFixed(2)}' height='32' fill='${c}'/>`).join('');
  },
  clouds: (f) => `<g fill='${f}' opacity='.75'><circle cx='10' cy='12' r='4'/><circle cx='15' cy='10' r='5'/><circle cx='20' cy='13' r='3.6'/><circle cx='23' cy='22' r='3'/><circle cx='26' cy='20' r='2.4'/></g>`,
  diagstripes: (f) => `<path d='M-4 12L12-4M-4 24L24-4M0 32L32 0M8 36L36 8M20 36L36 20' stroke='${f}' stroke-width='3.2' opacity='.85'/>`,
};

/** CSS background-image of one motif layer, or null for an unknown shape or a bad colour. */
export function motifLayer(m: SwatchMotif): string | null {
  const draw = Object.hasOwn(MOTIFS, m.shape) ? MOTIFS[m.shape] : undefined;
  const colours = [m.fg, ...(m.bg ? [m.bg] : []), ...(m.colors ?? [])];
  if (!draw || !colours.every((c) => HEX.test(c))) return null;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' preserveAspectRatio='xMidYMid slice'>${draw(m.fg, m)}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Motif layers of a descriptor, topmost first (CSS lists the top background first). */
function motifLayers(desc: SwatchDesc): string[] {
  return (desc.motif ?? [])
    .map(motifLayer)
    .filter((x): x is string => !!x)
    .reverse();
}

/**
 * CSS background for a swatch descriptor. The result sets only background properties,
 * so the caller keeps control of size, border and shape.
 */
export function swatchStyle(desc: SwatchDesc | undefined): CSSProperties {
  const stops = desc?.stops.filter((s) => HEX.test(s)) ?? [];
  if (!desc || !stops.length) return { backgroundColor: 'transparent' };
  const base = stops[0];
  const motifs = motifLayers(desc);
  if (motifs.length) {
    // the motif sits on the colour stops: no iris fibres or hair streaks under a heart
    const body =
      desc.kind === 'radial' && stops.length > 1
        ? `radial-gradient(circle closest-side at 50% 50%, ${stopList(desc)})`
        : stops.length > 1
          ? `linear-gradient(${Number.isFinite(desc.angle) ? desc.angle : 180}deg, ${stopList(desc)})`
          : null;
    return {
      backgroundColor: desc.kind === 'radial' ? stops[stops.length - 1] : base,
      backgroundImage: [...motifs, ...(body ? [body] : [])].join(', '),
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    };
  }
  if (desc.kind === 'solid' || stops.length === 1) {
    const layers = desc.pattern === 'metal' ? [SHEEN] : desc.pattern === 'streaks' ? [STREAKS] : [];
    return layers.length ? { backgroundColor: base, backgroundImage: layers.join(', ') } : { backgroundColor: base };
  }
  const list = stopList(desc);
  if (desc.kind === 'radial') {
    const body = `radial-gradient(circle closest-side at 50% 50%, ${list})`;
    const layers: string[] = [];
    if (desc.pattern === 'iris') {
      const [inner, outer] = desc.ring && desc.ring.length === 2 ? desc.ring.map(clampPct) : [20, 68];
      const sclera = stops[stops.length - 1];
      const pupil = stops[0];
      // pupil and sclera stay clean; fibres show only across the iris band
      layers.push(
        `radial-gradient(circle closest-side at 50% 50%, ${pupil} 0 ${inner}%, ${rgba(pupil, 0)} ${Math.min(inner + 3, outer)}%, transparent ${outer}%, ${rgba(sclera, 0.85)} ${Math.min(outer + 4, 100)}%, ${sclera} 100%)`,
        FIBRES,
      );
    }
    layers.push(body);
    return { backgroundColor: stops[stops.length - 1], backgroundImage: layers.join(', ') };
  }
  const angle = Number.isFinite(desc.angle) ? desc.angle : 180;
  const body = `linear-gradient(${angle}deg, ${list})`;
  const layers = desc.pattern === 'streaks' ? [STREAKS, body] : desc.pattern === 'metal' ? [SHEEN, body] : [body];
  return { backgroundColor: base, backgroundImage: layers.join(', ') };
}

/** The creator's cut corner (bottom right), as on the game thumbnails. Optional for the UI. */
export const SWATCH_NOTCH_CLIP = 'polygon(0 0, 100% 0, 100% 89%, 89% 100%, 0 100%)';
