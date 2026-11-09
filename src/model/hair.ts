// Описания причёсок. Базовое — из тега игры (Buzz/Short/Long/Dreads) и имени меша;
// подробное — из src/data/hair.<g>.json (описано по рендерам мешей, см. tools/calibrate).
import hairMale from '../data/hair.male.json';
import hairFemale from '../data/hair.female.json';
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

export function hairLabel(o: Option, gender: Gender = 'male'): string {
  return hairDescription(gender, o).ru;
}
