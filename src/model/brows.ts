// Форма бровей. В игре варианты — только номера; описания сделаны по текстурам формы
// (варианты 1–8 используют heb__base_d01…d08, 9–13 — d12…d16; одинаково для обоих типов тела).
import brows from '../data/brows.json';
import type { Loc, Option } from './catalog';

const DESC = brows as unknown as Record<string, Loc>;

export function browDescription(o: Option): Loc | null {
  if ((o.activates ?? []).some((a) => a.endsWith('color0')) || o.label.en === 'OFF') return { ru: 'без бровей', en: 'no eyebrows' };
  const n = parseInt(o.label.en, 10);
  return Number.isFinite(n) ? DESC[String(n)] ?? null : null;
}
