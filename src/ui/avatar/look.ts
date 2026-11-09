// Что надеть на V: из состояния редактора — имена appearance и мешей игры,
// по которым движок берёт текстуры из манифестов tools/local. Без three.js.
import type { Gender } from '../../model/catalog';
import type { CharacterState } from '../../model/state';
import { slotValue, visibleSlots } from '../../model/state';

export interface AvatarLook {
  gender: Gender;
  /** имена морфов из каталога (h011, t0_000_wa_base__full_breast_small, …), без 'None' */
  morphs: string[];
  /** app цвета кожи: h0_000_pwa__basehead__01_ca_pale */
  skinApp: string | null;
  /** тип кожи (meshHint): h0_000__basehead, h0_000__basehead_d02 … */
  skinType: string;
  /** ключ причёски в hints манифеста волос (033_player); null — без волос */
  hairHint: string | null;
  /** активен вариант с имплантом (hairstyle_cyberware) — меши *_cyberware_01 */
  hairCyberware: boolean;
  /** app цвета волос: 05_brown_liquorice */
  hairColour: string | null;
  eyesApp: string | null;
  /** стиль бровей (heb_000__basehead_01); null — бровей нет */
  browStyle: string | null;
  browApp: string | null;
  lashApp: string | null;
  teethApp: string | null;
  nailsApp: string | null;
  /** «Длинные» ногти: морф ногтей */
  longNails: boolean;
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
  return {
    gender: state.gender,
    morphs,
    skinApp: val('skin_color')?.option?.app ?? null,
    skinType: first(val('skin_type_switcher')?.option?.meshHint) ?? 'h0_000__basehead',
    hairHint: hint && hint !== 'none' ? hint : null,
    hairCyberware: hs?.variant.name === 'hairstyle_cyberware',
    hairColour: val('hair_color')?.option?.app ?? null,
    eyesApp: val('eyes_color')?.option?.app ?? null,
    browStyle: brows ? first(brows.meshHint) : null,
    browApp: val('eyebrows_color')?.option?.app ?? null,
    lashApp: val('eyelash_color')?.option?.app ?? null,
    teethApp: val('teeth')?.option?.app ?? null,
    nailsApp: val('nails_color')?.option?.app ?? null,
    longNails,
  };
}

/** Морф каталога включает цели меша с тем же именем или с суффиксом (_breast, …). */
export function morphTargetMatches(target: string, morph: string): boolean {
  return target === morph || target.startsWith(morph + '_');
}
