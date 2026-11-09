// Разделы списка настроек для текста «Копировать список»: группы слотов редактора
// в порядке, близком к игре. На экране список идёт сплошным, как в игре.
import type { Loc } from '../model/catalog';

export interface Line {
  id: string;
  label: Loc;
  slots: string[];
}

export const LINES: Line[] = [
  { id: 'skin', label: { ru: 'Кожа', en: 'Skin' }, slots: ['skin_color', 'skin_type_switcher'] },
  { id: 'hair', label: { ru: 'Волосы', en: 'Hair' }, slots: ['hairstyle', 'hair_color'] },
  { id: 'eyes', label: { ru: 'Глаза', en: 'Eyes' }, slots: ['eyes', 'eyes_color', 'eyebrows', 'eyebrows_color', 'eyelash_color'] },
  { id: 'face', label: { ru: 'Лицо', en: 'Face' }, slots: ['nose', 'mouth', 'jaw', 'ear', 'teeth'] },
  { id: 'beard', label: { ru: 'Борода', en: 'Beard' }, slots: ['beard', 'beard_part', 'beard_color'] },
  {
    id: 'mods',
    label: { ru: 'Модификации', en: 'Mods' },
    slots: ['cyberware_switcher', 'scars', 'facial_tattoo_switcher', 'piercings', 'piercings_color'],
  },
  {
    id: 'makeup',
    label: { ru: 'Макияж', en: 'Makeup' },
    slots: [
      'makeupEyes', 'makeupEyes_color', 'makeupLips_type', 'makeupLips', 'makeupLips_color',
      'makeupCheeks', 'makeupCheeks_color', 'makeupPimples', 'makeupPimples_color',
    ],
  },
  {
    id: 'body',
    label: { ru: 'Тело', en: 'Body' },
    slots: [
      'breast', 'nipples_switcher', 'body_tattoo_switcher', 'body_scars_switcher', 'genitals_switcher',
      'genitals_size', 'pubic_hair', 'pubic_hair_color', 'nails_l', 'nails_color',
    ],
  },
];

export const LINE_OF_SLOT = new Map<string, Line>(LINES.flatMap((l) => l.slots.map((s) => [s, l] as const)));
