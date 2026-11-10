// Слои лица (макияж, веснушки, изъяны, тату, шрамы, кибер-импланты, пирсинг): какие меши и
// appearance игры показать для строк редактора и как декаль ложится на кожу головы. Без three.js.
import type { DecalManifest, FaceLayerComponent } from './assets';

/** Строка редактора, которую рисует слой лица. */
export interface FaceLayerPick {
  /** id строки (makeupEyes, scars, …) — у каждой строки свои экземпляры мешей */
  slot: string;
  /** база app игры: meshHint варианта (hx_000__basehead_makeup_eyes_03) или hx_000__scars / hx_000__cyberware */
  base: string;
  /**
   * appearance в этой базе. Шаблон: {g} — m/w, {code} — pma/pwa, {tone} — тон кожи
   * (01_ca_pale…): у тату и кибер-имплантов appearance зависит от тона кожи.
   */
  app: string | null;
}

export const fillApp = (tpl: string, code: 'pma' | 'pwa', tone: string) =>
  tpl.replace(/\{g\}/g, code === 'pma' ? 'm' : 'w').replace(/\{code\}/g, code).replace(/\{tone\}/g, tone);

/**
 * Компоненты слоя: appearance из выбора (цвет, тон кожи); если такого нет (цвет «нет», другой
 * пол в имени) — первая appearance этого пола, лучше того же тона; иначе — первая вообще.
 */
export function resolveFaceLayer(apps: DecalManifest['apps'], pick: FaceLayerPick, code: 'pma' | 'pwa', tone: string): FaceLayerComponent[] {
  const set = apps[pick.base];
  if (!set) return [];
  const names = Object.keys(set);
  if (!names.length) return [];
  const want = pick.app ? fillApp(pick.app, code, tone) : null;
  if (want && set[want]) return set[want];
  const g = code === 'pma' ? 'm' : 'w';
  const mine = names.filter((n) => n.includes(`_${code}_`) || n.startsWith(`${g}__`));
  const pool = mine.length ? mine : names;
  // тот же цвет у другого пола в имени app (i0_000_pwa__earring__01_silver → …_pma_…)
  if (want) {
    const swapped = want.replace(code === 'pma' ? '_pwa_' : '_pma_', `_${code}_`);
    if (set[swapped]) return set[swapped];
  }
  return set[pool.find((n) => n.endsWith('__' + tone)) ?? pool[0]];
}

/** Части головы (submesh): позиции, UV и касательные в осях привязки. */
export interface HeadPart {
  pos: ArrayLike<number>;
  uv: ArrayLike<number>;
  tangent?: ArrayLike<number> | null;
}

/**
 * Пространственный индекс вершин головы: все части в общих массивах, ячейки сетки с числовым
 * ключом. Строится один раз на голову (а не на каждый меш слоя): прежняя сетка со строковыми
 * ключами и объектом на вершину давала задачи главного потока по 100–280 мс на строку слоёв.
 */
export interface HeadIndex {
  pos: Float32Array;
  uv: Float32Array;
  tangent: Float32Array | null;
  cell: number;
  /** ключ ячейки → индексы вершин */
  cells: Map<number, number[]>;
}

const cellKey = (ix: number, iy: number, iz: number) => (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) | 0;

export function buildHeadIndex(head: readonly HeadPart[], cell = 0.004): HeadIndex {
  const total = head.reduce((n, h) => n + Math.floor(h.pos.length / 3), 0);
  const pos = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  const hasT = head.length > 0 && head.every((h) => !!h.tangent);
  const tangent = hasT ? new Float32Array(total * 4) : null;
  const cells = new Map<number, number[]>();
  let id = 0;
  for (const h of head) {
    const n = Math.floor(h.pos.length / 3);
    for (let i = 0; i < n; i++, id++) {
      const x = h.pos[i * 3], y = h.pos[i * 3 + 1], z = h.pos[i * 3 + 2];
      pos[id * 3] = x;
      pos[id * 3 + 1] = y;
      pos[id * 3 + 2] = z;
      uv[id * 2] = h.uv[i * 2];
      uv[id * 2 + 1] = h.uv[i * 2 + 1];
      if (tangent && h.tangent) for (let c = 0; c < 4; c++) tangent[id * 4 + c] = h.tangent[i * 4 + c];
      const k = cellKey(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
      const list = cells.get(k);
      if (list) list.push(id);
      else cells.set(k, [id]);
    }
  }
  return { pos, uv, tangent, cell, cells };
}

/**
 * Привязка декали к коже: меш слоя в игре — копия куска головы, сдвинутая на 0,2–0,5 мм по
 * нормали. Для каждой его вершины берётся ближайшая вершина головы и её UV (и касательная):
 * шейдер декали читает по ним альбедо, нормали и шероховатость кожи и меняет их, как
 * отложенная декаль игры, а не рисует свой цвет поверх готового кадра.
 * Возвращает UV головы (2 на вершину), касательные (4 на вершину, если есть у головы) и
 * число вершин, у которых ближайшая вершина головы дальше maxDist.
 */
export function transferHeadAttrs(
  decalPos: ArrayLike<number>,
  head: HeadIndex | readonly HeadPart[],
  maxDist = 0.003,
): { uv: Float32Array; tangent: Float32Array | null; misses: number } {
  const ix = Array.isArray(head) ? buildHeadIndex(head) : (head as HeadIndex);
  const { cell, cells, pos } = ix;
  const n = Math.floor(decalPos.length / 3);
  const uv = new Float32Array(n * 2);
  const tangent = ix.tangent ? new Float32Array(n * 4) : null;
  let misses = 0;
  for (let v = 0; v < n; v++) {
    const x = decalPos[v * 3];
    const y = decalPos[v * 3 + 1];
    const z = decalPos[v * 3 + 2];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let best = -1;
    let bd = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = cells.get(cellKey(cx + dx, cy + dy, cz + dz));
          if (!list) continue;
          for (let j = 0; j < list.length; j++) {
            const id = list[j];
            const ex = pos[id * 3] - x;
            const ey = pos[id * 3 + 1] - y;
            const ez = pos[id * 3 + 2] - z;
            const d = ex * ex + ey * ey + ez * ez;
            if (d < bd) {
              bd = d;
              best = id;
            }
          }
        }
    if (best < 0 || Math.sqrt(bd) > maxDist) misses++;
    if (best < 0) continue;
    uv[v * 2] = ix.uv[best * 2];
    uv[v * 2 + 1] = ix.uv[best * 2 + 1];
    if (tangent && ix.tangent) for (let c = 0; c < 4; c++) tangent[v * 4 + c] = ix.tangent[best * 4 + c];
  }
  return { uv, tangent, misses };
}
