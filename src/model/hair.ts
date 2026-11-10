// Описания причёсок. Базовое — из тега игры (Buzz/Short/Long/Dreads) и имени меша;
// подробное — из src/data/hair.<g>.json (описано по рендерам мешей, см. tools/calibrate).
import hairMale from '../data/hair.male.json';
import hairFemale from '../data/hair.female.json';
import twoTone from '../data/hair.twotone.json';
import type { Gender, Loc, Option } from './catalog';

type HairDesc = Record<string, Loc>; // ключ — имя меша (meshHint)
const DESC: Record<Gender, HairDesc> = {
  male: hairMale as HairDesc,
  female: hairFemale as HairDesc,
};

const TAG: Record<string, Loc> = {
  Buzz: { ru: 'очень короткая / выбритая', en: 'buzzed / shaved' },
  Short: { ru: 'короткая', en: 'short' },
  Long: { ru: 'длинная или собранная', en: 'long or tied up' },
  Dreads: { ru: 'дреды / косички', en: 'dreads / braids' },
  None: { ru: 'без волос', en: 'bald' },
};

export function hairKey(o: Option): string {
  const h = o.meshHint;
  return Array.isArray(h) ? h[0] : h ?? '';
}

export function hairDescription(gender: Gender, o: Option): Loc {
  if (hairKey(o) === 'none' || (o.activates ?? []).some((a) => a.endsWith('_none'))) return TAG.None;
  const d = DESC[gender][hairKey(o)];
  if (d) return d;
  return TAG[o.tags[0]] ?? { ru: 'причёска', en: 'hairstyle' };
}

/**
 * Описания всех вариантов списка, уникальные в пределах пола. Несколько строк редактора игры
 * используют один и тот же меш (например, хвост 27/28/36): у повторов указываем, с каким
 * номером они совпадают, чтобы модель не выбирала между одинаковыми подписями вслепую.
 */
export function hairDescriptions(gender: Gender, opts: Option[]): Loc[] {
  const seen = new Map<string, number[]>();
  return opts.map((o, k) => {
    const d = hairDescription(gender, o);
    const same = seen.get(d.en);
    if (!same) {
      seen.set(d.en, [k + 1]);
      return d;
    }
    const list = same.join(', ');
    same.push(k + 1);
    return { ru: `${d.ru} (тот же меш, что у ${list})`, en: `${d.en} (same mesh as ${list})` };
  });
}

export function hairLabel(o: Option, gender: Gender = 'male'): string {
  return hairDescription(gender, o).ru;
}

const TWO_TONE = twoTone as unknown as Record<Gender, Record<string, string[]>>;

/**
 * Цвета (app: 02_red_merlot…), которыми эта причёска в игре красится лишь частично: концы,
 * пряди или верх, остальное — естественный оттенок (src/data/hair.twotone.json, собран
 * tools/extract/hair_twotone.mjs по мешам игры). Например, длинные 32 с Red Merlot — каштан
 * с бордовыми концами.
 */
export function twoToneColours(gender: Gender, o: Option): readonly string[] {
  return TWO_TONE[gender]?.[hairKey(o)] ?? [];
}

/** Причёска с этим цветом волос (ключ без номера: red_merlot) в игре двухцветная. */
export function isTwoTone(gender: Gender, o: Option, colourKey: string): boolean {
  return twoToneColours(gender, o).some((app) => app.replace(/^\d+_/, '') === colourKey);
}
