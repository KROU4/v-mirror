// Что надеть на V: из состояния редактора — имена appearance и мешей игры,
// по которым движок берёт текстуры из манифестов tools/local. Без three.js.
import type { Gender } from '../../model/catalog';
import type { CharacterState } from '../../model/state';
import { slotValue, visibleSlots } from '../../model/state';
import type { FaceLayerPick } from './decals';
import { INTIMATE_SLOTS, type BodyPicks } from './intimate';

export interface AvatarLook {
  gender: Gender;
  /** имена морфов из каталога (h011, t0_000_wa_base__full_breast_small, …), без 'None' */
  morphs: string[];
  /** app цвета кожи: h0_000_pwa__basehead__01_ca_pale */
  skinApp: string | null;
  /** значок тона кожи (sRGB hex): брови и декали умножаются на «свой цвет / кожа» */
  skinHex: string | null;
  /** тип кожи (meshHint): h0_000__basehead, h0_000__basehead_d02 … */
  skinType: string;
  /** ключ причёски в hints манифеста волос (033_player); null — без волос */
  hairHint: string | null;
  /** активен вариант с имплантом (hairstyle_cyberware) — меши *_cyberware_01 */
  hairCyberware: boolean;
  /** app цвета волос: 05_brown_liquorice */
  hairColour: string | null;
  /** борода: app части бороды (hb_000_pma__big_beard__chin, beard_part); null — без бороды */
  beardApp: string | null;
  /** app цвета бороды (05_brown_liquorice) */
  beardColour: string | null;
  eyesApp: string | null;
  /** стиль бровей (heb_000__basehead_01); null — бровей нет */
  browStyle: string | null;
  browApp: string | null;
  lashApp: string | null;
  teethApp: string | null;
  nailsApp: string | null;
  /** «Длинные» ногти: морф ногтей */
  longNails: boolean;
  /** строки наготы (соски, тату и шрамы тела, гениталии, размер, лобковые волосы и их цвет) */
  body: BodyPicks;
  /** слои лица: макияж, веснушки, изъяны, тату, шрамы, кибер-импланты, пирсинг (tex/face/decals.json) */
  faceLayers: FaceLayerPick[];
}


const first = (h: string | string[] | undefined | null): string | null => (Array.isArray(h) ? h[0] ?? null : h ?? null);

export function lookOf(state: CharacterState): AvatarLook {
  const val = (id: string) => slotValue(state, id);
  const morphs: string[] = [];
  let longNails = false;
  for (const vs of visibleSlots(state)) {
    const m = vs.variant.type === 'morph' ? vs.option?.morph : undefined;
    if (!m || m === 'None') continue;
    if (/__nails_[lr]/.test(m)) longNails = true;
    else morphs.push(m);
  }
  const hs = val('hairstyle');
  const hint = first(hs?.option?.meshHint);
  const brows = val('eyebrows')?.option;
  const beardHint = state.gender === 'male' ? first(val('beard_part')?.option?.meshHint) : null;
  const body: BodyPicks = {};
  for (const id of INTIMATE_SLOTS) {
    const v = val(id);
    if (v) body[id] = { variant: v.variant.name, i: v.value };
  }
  return {
    gender: state.gender,
    morphs,
    skinApp: val('skin_color')?.option?.app ?? null,
    skinHex: val('skin_color')?.option?.hex ?? null,
    skinType: first(val('skin_type_switcher')?.option?.meshHint) ?? 'h0_000__basehead',
    hairHint: hint && hint !== 'none' ? hint : null,
    hairCyberware: hs?.variant.name === 'hairstyle_cyberware',
    hairColour: val('hair_color')?.option?.app ?? null,
    beardApp: beardHint && beardHint !== 'none' ? beardHint : null,
    beardColour: val('beard_color')?.option?.app ?? null,
    eyesApp: val('eyes_color')?.option?.app ?? null,
    browStyle: brows ? first(brows.meshHint) : null,
    browApp: val('eyebrows_color')?.option?.app ?? null,
    lashApp: val('eyelash_color')?.option?.app ?? null,
    teethApp: val('teeth')?.option?.app ?? null,
    nailsApp: val('nails_color')?.option?.app ?? null,
    longNails,
    body,
    faceLayers: faceLayersOf(state),
  };
}

/** Строки слоёв лица: стиль (meshHint варианта) и строка его цвета (app appearance). */
const STYLE_COLOUR: [style: string, colour: string | null][] = [
  ['makeupEyes', 'makeupEyes_color'],
  ['makeupLips', 'makeupLips_color'],
  ['makeupCheeks', 'makeupCheeks_color'],
  ['makeupPimples', 'makeupPimples_color'],
  ['piercings', 'piercings_color'],
  ['facial_tattoo_switcher', null],
];

/**
 * Optional parts of the asset pack. A pack built by an older exporter can lack them; the engine
 * reports such a part once (EngineEvents.onMissing) and its rows are marked «not shown in 3D».
 */
export type PackPart = 'faceLayers' | 'beards' | 'intimate';

/** Rows drawn by each optional part of the pack. */
export const PACK_PART_SLOTS: Readonly<Record<PackPart, readonly string[]>> = {
  faceLayers: [...STYLE_COLOUR.flatMap(([s, c]) => (c ? [s, c] : [s])), 'makeupLips_type', 'scars', 'cyberware_switcher'],
  beards: ['beard', 'beard_part', 'beard_color'],
  intimate: INTIMATE_SLOTS,
};

/** The row is not drawn by the 3D model because its part is missing from the connected pack. */
export function notIn3d(slotId: string, missing: ReadonlySet<PackPart>): boolean {
  for (const part of missing) if (PACK_PART_SLOTS[part].includes(slotId)) return true;
  return false;
}

/**
 * Что рисовать поверх головы. Стиль задаёт базу app игры (meshHint опции), цвет — appearance в
 * ней. У тату appearance — тон кожи ({g}__{tone}), у кибер-импланта — номер импланта и тон
 * кожи, у шрамов app опции и есть appearance общей базы hx_000__scars.
 */
export function faceLayersOf(state: CharacterState): FaceLayerPick[] {
  const out: FaceLayerPick[] = [];
  const val = (id: string) => slotValue(state, id);
  for (const [style, colour] of STYLE_COLOUR) {
    const base = first(val(style)?.option?.meshHint);
    if (!base || base === 'none') continue;
    const app = colour ? val(colour)?.option?.app : '{g}__{tone}';
    out.push({ slot: style, base, app: app && app !== 'None' ? app : null });
  }
  const scar = val('scars')?.option?.app;
  if (scar && scar !== 'None') out.push({ slot: 'scars', base: 'hx_000__scars', app: scar });
  const cw = val('cyberware_switcher')?.option;
  const n = cw?.activates?.map((a) => /^cyberware_(\d+)$/.exec(a)?.[1]).find(Boolean);
  if (cw && first(cw.meshHint) && n && n !== '00') out.push({ slot: 'cyberware_switcher', base: first(cw.meshHint)!, app: `hx_000_{code}__cyberware_${n}__{tone}` });
  return out;
}

/** Морф каталога включает цели меша с тем же именем или с суффиксом (_breast, …). */
export function morphTargetMatches(target: string, morph: string): boolean {
  return target === morph || target.startsWith(morph + '_');
}
