// Состояние персонажа и правила видимости опций, повторяющие логику редактора игры:
// свитчер (причёска, борода, имплант, тип макияжа губ…) включает зависимые варианты
// других слотов (цвет волос под конкретную причёску, части бороды и т.д.).
import {
  displayNumber,
  getIndex,
  optionByIndex,
  type Gender,
  type Loc,
  type Option,
  type Slot,
  type Variant,
} from './catalog';

export interface CharacterState {
  gender: Gender;
  /** имя варианта -> индекс опции (поле `i` опции) */
  values: Record<string, number>;
}

export function defaultState(gender: Gender): CharacterState {
  return { gender, values: {} };
}

/**
 * Значение по умолчанию, которое реально показывает редактор. У части цветовых
 * вариантов опции начинаются с i=1 при defaultIndex=0 — тогда это первая опция.
 */
export function effectiveDefault(v: Variant): number {
  if (v.options.some((o) => o.i === v.defaultIndex)) return v.defaultIndex;
  return v.options[0]?.i ?? 0;
}

export function getValue(state: CharacterState, v: Variant): number {
  const set = state.values[v.name];
  if (set !== undefined && v.options.some((o) => o.i === set)) return set;
  return effectiveDefault(v);
}

export function getOption(state: CharacterState, v: Variant): Option | undefined {
  return optionByIndex(v, getValue(state, v));
}

/** Множество активных (включённых) вариантов при данном состоянии. */
export function activeVariants(state: CharacterState): Set<string> {
  const { variantByName } = getIndex(state.gender);
  const memo = new Map<string, boolean>();
  const visiting = new Set<string>();

  const isActive = (name: string): boolean => {
    const cached = memo.get(name);
    if (cached !== undefined) return cached;
    const v = variantByName.get(name);
    if (!v) return false;
    if (visiting.has(name)) return v.enabled; // защита от циклов
    visiting.add(name);
    let res: boolean;
    const ctrls = (v.controlledBy ?? []).filter(([sw]) => variantByName.has(sw));
    if (ctrls.length) {
      res = ctrls.some(([sw, idx]) => {
        const swv = variantByName.get(sw)!;
        return isActive(sw) && getValue(state, swv) === idx;
      });
    } else {
      res = v.enabled;
    }
    visiting.delete(name);
    memo.set(name, res);
    return res;
  };

  const out = new Set<string>();
  for (const name of variantByName.keys()) if (isActive(name)) out.add(name);
  return out;
}

export interface VisibleSlot {
  slot: Slot;
  variant: Variant;
  value: number;
  option: Option | undefined;
}

/** Слоты, которые сейчас видны в редакторе (как в игре), в игровом порядке. */
export function visibleSlots(state: CharacterState): VisibleSlot[] {
  const { catalog } = getIndex(state.gender);
  const active = activeVariants(state);
  const out: VisibleSlot[] = [];
  for (const slot of catalog.slots) {
    if (slot.auto) continue;
    const variant = slot.variants.find((v) => active.has(v.name));
    if (!variant || variant.options.length < 2) continue;
    const value = getValue(state, variant);
    out.push({ slot, variant, value, option: optionByIndex(variant, value) });
  }
  return out;
}

export function setValue(state: CharacterState, variantName: string, i: number): CharacterState {
  return { ...state, values: { ...state.values, [variantName]: i } };
}

/** Значение слота по id (берётся активный вариант). */
export function slotValue(state: CharacterState, slotId: string): VisibleSlot | undefined {
  const { slotById } = getIndex(state.gender);
  const slot = slotById.get(slotId);
  if (!slot) return undefined;
  const active = activeVariants(state);
  const variant = slot.variants.find((v) => active.has(v.name));
  if (!variant) return undefined;
  const value = getValue(state, variant);
  return { slot, variant, value, option: optionByIndex(variant, value) };
}

/** Выбрать опцию по слоту (в активном варианте). */
export function setSlot(state: CharacterState, slotId: string, i: number): CharacterState {
  const cur = slotValue(state, slotId);
  if (!cur) return state;
  return setValue(state, cur.variant.name, i);
}

// ------------------------------------------------------------------ randomizer
type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Как «Plain-to-Punk» в игре: 1 — обыденно, 10 — максимально панково.
 * При keepBody слоты тела берутся из `base` (если он того же пола) и не трогаются.
 */
export function randomize(gender: Gender, punk: number, rng: Rng = Math.random, keepBody = true, base?: CharacterState): CharacterState {
  const { catalog } = getIndex(gender);
  const values: Record<string, number> = keepBody && base?.gender === gender ? { ...base.values } : {};
  for (const slot of catalog.slots) {
    if (slot.auto || (keepBody && slot.group !== 'head')) continue;
    for (const v of slot.variants) {
      if (!v.options.length) continue;
      const pool = v.options.filter((o) => o.rating[0] <= punk && punk <= o.rating[1]);
      const from = pool.length ? pool : v.options;
      values[v.name] = from[Math.floor(rng() * from.length)].i;
    }
  }
  return { gender, values };
}

// ------------------------------------------------------------------ export
export interface SheetRow {
  slotId: string;
  group: Slot['group'];
  label: Loc;
  number: number;
  total: number;
  value: Loc;
  hex?: string;
  isDefault: boolean;
}

export function gameSheet(state: CharacterState): SheetRow[] {
  return visibleSlots(state).map(({ slot, variant, value, option }) => ({
    slotId: slot.id,
    group: slot.group,
    label: slot.label,
    number: displayNumber(variant, value),
    total: variant.options.length,
    value: option?.label ?? { ru: String(value), en: String(value) },
    hex: option?.iris ?? option?.hex,
    isDefault: value === effectiveDefault(variant),
  }));
}

/** Компактная сериализация для ссылки: только отличия от значений по умолчанию у активных вариантов. */
export function encodeState(state: CharacterState): string {
  const active = activeVariants(state);
  const { variantByName } = getIndex(state.gender);
  const diff: Record<string, number> = {};
  for (const [name, i] of Object.entries(state.values)) {
    const v = variantByName.get(name);
    if (v && active.has(name) && v.options.some((o) => o.i === i) && i !== effectiveDefault(v)) diff[name] = i;
  }
  const json = JSON.stringify({ g: state.gender === 'male' ? 'm' : 'f', v: diff });
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeState(code: string): CharacterState | null {
  try {
    const b64 = code.replace(/-/g, '+').replace(/_/g, '/');
    const json = decodeURIComponent(escape(atob(b64)));
    const o = JSON.parse(json) as { g: string; v: Record<string, number> };
    const gender: Gender = o.g === 'f' ? 'female' : 'male';
    const { variantByName } = getIndex(gender);
    const values: Record<string, number> = {};
    for (const [k, i] of Object.entries(o.v ?? {})) {
      if (variantByName.has(k) && Number.isInteger(i)) values[k] = i;
    }
    return { gender, values };
  } catch {
    return null;
  }
}
