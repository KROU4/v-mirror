// Типы и загрузка каталога редактора (данные извлечены из Cyberpunk 2077 2.5,
// см. tools/extract). Здесь только структура опций — без ассетов игры.
import maleJson from '../data/catalog.male.json';
import femaleJson from '../data/catalog.female.json';

export type Gender = 'male' | 'female';
export type Loc = { ru: string; en: string };

export interface Option {
  i: number;
  label: Loc;
  tags: string[];
  rating: [number, number];
  /** Свитчер: какие варианты других слотов включает эта опция */
  activates?: string[];
  /** Свитчер: имя меша/ресурса, на который ссылается опция (подсказка для описания) */
  meshHint?: string | string[];
  /** Морф: имя blendshape в голове игрока */
  morph?: string;
  /** Внешний вид: имя appearance в игре */
  app?: string;
  icon?: string;
  hex?: string;
  iris?: string;
}

export type VariantType = 'switcher' | 'morph' | 'appearance';

export interface Variant {
  name: string;
  type: VariantType;
  enabled: boolean;
  defaultIndex: number;
  link: string | null;
  randomizeCategory: string;
  options: Option[];
  /** [имя свитчера, индекс опции] — кто включает этот вариант */
  controlledBy?: [string, number][];
}

export type Group = 'head' | 'body' | 'arms';

export interface Slot {
  id: string;
  group: Group;
  order: number;
  label: Loc;
  auto: boolean;
  variants: Variant[];
}

export interface Catalog {
  gender: Gender;
  gameVersion: string;
  source: string;
  slots: Slot[];
}

export const CATALOGS: Record<Gender, Catalog> = {
  male: maleJson as unknown as Catalog,
  female: femaleJson as unknown as Catalog,
};

export interface CatalogIndex {
  catalog: Catalog;
  variantByName: Map<string, Variant>;
  slotOfVariant: Map<string, Slot>;
  slotById: Map<string, Slot>;
}

const indexCache = new Map<Gender, CatalogIndex>();

export function getIndex(gender: Gender): CatalogIndex {
  const hit = indexCache.get(gender);
  if (hit) return hit;
  const catalog = CATALOGS[gender];
  const variantByName = new Map<string, Variant>();
  const slotOfVariant = new Map<string, Slot>();
  const slotById = new Map<string, Slot>();
  for (const s of catalog.slots) {
    slotById.set(s.id, s);
    for (const v of s.variants) {
      variantByName.set(v.name, v);
      slotOfVariant.set(v.name, s);
    }
  }
  const idx = { catalog, variantByName, slotOfVariant, slotById };
  indexCache.set(gender, idx);
  return idx;
}

/** Номер опции так, как он виден игроку (1-based позиция в списке). */
export function displayNumber(variant: Variant, optionIndex: number): number {
  const pos = variant.options.findIndex((o) => o.i === optionIndex);
  return pos < 0 ? optionIndex + 1 : pos + 1;
}

export function optionByIndex(variant: Variant, optionIndex: number): Option | undefined {
  return variant.options.find((o) => o.i === optionIndex);
}

export const GROUP_LABEL: Record<Group, Loc> = {
  head: { ru: 'Голова', en: 'Head' },
  body: { ru: 'Тело', en: 'Body' },
  arms: { ru: 'Руки', en: 'Arms' },
};
