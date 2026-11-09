// Кадр камеры и поза V для выбранной строки — как в редакторе игры
// (tools/local/research/cc_behaviour.md, §1 и §2). Чистые функции, без three.js.
import type { Gender } from '../../model/catalog';

export type CameraSlot =
  | 'UI_HeadPreview'
  | 'UI_Eyes'
  | 'UI_Nose'
  | 'UI_Lips'
  | 'UI_Jaw'
  | 'UI_Teeth'
  | 'UI_Hairs'
  | 'UI_Skin'
  | 'UI_FingerNails'
  | 'UI_Preview';

/** Точка прицеливания в метрах от ступней (Y вверх, glTF) и дистанция cameraZoom. */
export interface CameraShot {
  target: [number, number, number];
  distance: number;
}

/** Игровые слоты (prefab empty_room_char_creation_*.ent): (X, Y, Z) игры → (x, z, −y) glTF. */
const HEAD: Record<Gender, [number, number, number]> = { female: [-0.03, 1.62, 0], male: [-0.03, 1.67, 0] };
/**
 * Ногти: в игре (0, 1,45) и 2,2 м — «грудь и поднятая кисть», макушка у самого края кадра.
 * У нас сверху кадр закрывает плашка заголовка: макушка мужчины срезана, волосы женщины
 * уходят под плашку. Кадр чуть дальше и выше — голова целиком, кисть и грудь в кадре.
 */
const NAILS: Record<Gender, [number, number, number]> = { female: [0, 1.5, 0], male: [-0.03, 1.53, 0] };
const NAILS_DISTANCE = 2.6;
const FULL: Record<Gender, [number, number, number]> = { female: [0, 0.9, 0], male: [0, 0.95, 0] };

export function cameraShot(slot: CameraSlot, gender: Gender): CameraShot {
  switch (slot) {
    case 'UI_Hairs':
    case 'UI_Skin':
      return { target: HEAD[gender], distance: 2.0 };
    case 'UI_FingerNails':
      return { target: NAILS[gender], distance: NAILS_DISTANCE };
    case 'UI_Preview':
      return { target: FULL[gender], distance: 8.3 };
    default:
      return { target: HEAD[gender], distance: 1.2 };
  }
}

const BY_SLOT: Record<string, CameraSlot> = {
  skin_color: 'UI_Skin',
  skin_type_switcher: 'UI_Skin',
  hairstyle: 'UI_Hairs',
  hair_color: 'UI_Hairs',
  beard: 'UI_Hairs',
  beard_part: 'UI_Hairs',
  beard_color: 'UI_Hairs',
  eyes: 'UI_Eyes',
  eyes_color: 'UI_Eyes',
  eyebrows: 'UI_Eyes',
  eyelash_color: 'UI_Eyes',
  makeupEyes: 'UI_Eyes',
  makeupEyes_color: 'UI_Eyes',
  // В игре опечатка: скрипт сверяет с 'eyesbrows_color', поэтому цвет бровей — общий кадр головы
  eyebrows_color: 'UI_HeadPreview',
  nose: 'UI_Nose',
  mouth: 'UI_Lips',
  makeupLips_type: 'UI_Lips',
  makeupLips_color: 'UI_Lips',
  jaw: 'UI_Jaw',
  teeth: 'UI_Teeth',
  nails_l: 'UI_FingerNails',
  nails_color: 'UI_FingerNails',
  holstered_data: 'UI_FingerNails',
};

/**
 * Слот камеры для строки каталога (characterCreationBodyMorphMenu.GetSlotName).
 * variantName нужен для «Помады»: варианты _none / _glossy / _matte дают общий кадр головы.
 */
export function cameraSlotFor(slotId: string | undefined, group?: string, variantName?: string): CameraSlot {
  if (!slotId) return 'UI_Skin';
  if (slotId === 'makeupLips') return /_(none|glossy|matte)$/.test(variantName ?? '') ? 'UI_HeadPreview' : 'UI_Lips';
  if (Object.hasOwn(BY_SLOT, slotId)) return BY_SLOT[slotId];
  if (group === 'body') return 'UI_Preview';
  if (group === 'arms') return 'UI_FingerNails';
  return 'UI_HeadPreview';
}

/** Поза тела: крупный план головы, рост или поднятая рука (ногти). */
export type BodyMode = 'closeup' | 'fullbody' | 'hand';

export function bodyModeFor(slot: CameraSlot): BodyMode {
  if (slot === 'UI_Preview') return 'fullbody';
  if (slot === 'UI_FingerNails') return 'hand';
  return 'closeup';
}

export interface ClipStep {
  clip: string;
  loop: boolean;
  /** скорость проигрывания (1 — как в игре) */
  speed?: number;
}

/**
 * Выход из позы ногтей ускорен: клип 2,6 с, и всё это время голова опущена, а взгляд
 * исподлобья — улыбка строки «Зубы» после него запаздывает больше чем на 3 с.
 */
export const HAND_END_SPEED = 1.6;

/**
 * Очередь клипов тела при переходе из позы `from` в позу `to` (§2.2): переходы
 * closeup↔fullbody, вход/выход «руки» для ногтей. На всех строках головы тело играет
 * только цикл ui_closeup_shot: клипы ui_closeup_shot_<часть> в игре — аддитивные клипы
 * ЛИЦА (§2.3), а на теле они поднимают руку к лицу и уводят голову из кадра.
 */
export function clipPlan(from: BodyMode | null, to: BodyMode): ClipStep[] {
  const steps: ClipStep[] = [];
  if (from === 'hand' && to !== 'hand') steps.push({ clip: 'ui_expose_hand_end', loop: false, speed: HAND_END_SPEED });
  const base = from === 'hand' ? 'closeup' : from;
  if (to === 'fullbody') {
    if (base !== 'fullbody' && base !== null) steps.push({ clip: 'ui_closeup_to_fullbody', loop: false });
    steps.push({ clip: 'ui_fullbody_shot', loop: true });
  } else if (to === 'hand') {
    if (base === 'fullbody') steps.push({ clip: 'ui_fullbody_to_closeup', loop: false });
    if (from !== 'hand') steps.push({ clip: 'ui_expose_hand_start', loop: false });
    steps.push({ clip: 'ui_expose_hand_loop', loop: true });
  } else {
    if (base === 'fullbody') steps.push({ clip: 'ui_fullbody_to_closeup', loop: false });
    steps.push({ clip: 'ui_closeup_shot', loop: true });
  }
  return steps;
}
