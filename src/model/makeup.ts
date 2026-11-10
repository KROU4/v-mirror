// Стили макияжа глаз словами — по форме декали игры (hx_eyes_makeup_01_dNN, альфа слоя) и
// кадрам 3D-редактора. Ключ — номер стиля в подписи строки (01…36), а не номер в промпте
// (там 1 — «нет»). «graphic» — рисунок, а не обычный макияж: модель выбирает их только когда
// такой рисунок явно виден на фото.
import type { Option } from './catalog';

interface EyeMakeupStyle {
  en: string;
  graphic?: boolean;
}

export const EYE_MAKEUP_STYLES: Readonly<Record<number, EyeMakeupStyle>> = {
  1: { en: 'solid upper-lid shadow, dot under eye' },
  2: { en: 'winged cat-eye liner' },
  3: { en: 'soft shadow, sharp wing with drips', graphic: true },
  4: { en: 'soft smoky all around' },
  5: { en: 'heavy smudged smoky with glitter' },
  6: { en: 'light shimmer on upper lid' },
  7: { en: 'soft dark smoky all around' },
  8: { en: 'thin natural upper liner' },
  9: { en: 'line under eye flicking up', graphic: true },
  10: { en: 'wide black band (mask)', graphic: true },
  11: { en: 'black block on outer eye', graphic: true },
  12: { en: 'floating crease line', graphic: true },
  13: { en: 'streaks with drips', graphic: true },
  14: { en: 'flames', graphic: true },
  15: { en: 'butterfly spray', graphic: true },
  16: { en: 'double arcs', graphic: true },
  17: { en: 'rectangle on lid', graphic: true },
  18: { en: 'bold dark lid with long wing' },
  // тень у этой декали полупрозрачная (альфа d19 слабая): на V — стрелка с лёгкой тенью, не смоки
  19: { en: 'liner wing with light lid shadow' },
  20: { en: 'deep dark smoky, soft edges' },
  21: { en: 'spiky strokes', graphic: true },
  22: { en: 'lightning bolt', graphic: true },
  23: { en: 'big arrow wing', graphic: true },
  24: { en: 'hearts and lettering', graphic: true },
  25: { en: 'vertical war-paint stripe', graphic: true },
  26: { en: 'paint splatter', graphic: true },
  27: { en: 'shadow under lower lid only' },
  28: { en: 'smoky with scribbles', graphic: true },
  29: { en: 'grungy smudge with drips', graphic: true },
  30: { en: 'tribal marks', graphic: true },
  31: { en: 'liner with lettering', graphic: true },
  32: { en: 'small soft spot at outer corner' },
  33: { en: 'triple-line bracket', graphic: true },
  34: { en: 'geometric blocks', graphic: true },
  35: { en: 'round smoky with chevrons', graphic: true },
  36: { en: 'small marks and lettering', graphic: true },
};

/**
 * Стиль, который ставится, когда модель видит макияж глаз, но номер стиля не назвала:
 * тонкая подводка по линии ресниц — самый нейтральный из обычных стилей.
 */
export const EYE_MAKEUP_FALLBACK = 8;

/** Номер стиля в подписи варианта строки «Макияж глаз» (01 → 1); «нет» — 0. */
export function eyeMakeupStyleNo(o: Option): number {
  const m = typeof o.meshHint === 'string' ? /makeup_eyes_(\d+)$/.exec(o.meshHint) : null;
  return m ? Number(m[1]) : 0;
}

/** Описание стиля для промпта. */
export function eyeMakeupWords(o: Option): string {
  const no = eyeMakeupStyleNo(o);
  if (!no) return 'none';
  const s = EYE_MAKEUP_STYLES[no];
  if (!s) return o.label.en;
  return s.graphic ? `${s.en} (graphic)` : s.en;
}
