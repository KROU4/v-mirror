// Форма бровей. В игре варианты — только номера; описания сделаны по текстурам формы
// (вариант N использует текстуру heb__base_dNN, одинаковую для обоих типов тела).
import brows from '../data/brows.json';
import type { Loc, Option } from './catalog';

const DESC = brows as unknown as Record<string, Loc>;

export function browDescription(o: Option): Loc | null {
  if ((o.activates ?? []).some((a) => a.endsWith('color0')) || o.label.en === 'OFF') return { ru: 'без бровей', en: 'no eyebrows' };
  const n = parseInt(o.label.en, 10);
  return Number.isFinite(n) ? DESC[String(n)] ?? null : null;
}
