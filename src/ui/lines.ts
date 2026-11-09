// «Линии» схемы: группы слотов редактора в порядке, близком к игре.
import type { Loc } from '../model/catalog';

export interface Line {
  id: string;
  label: Loc;
  code: string;
  color: string;
  slots: string[];
}

export const LINES: Line[] = [
  { id: 'skin', code: 'S', label: { ru: 'Кожа', en: 'Skin' }, color: 'var(--line-skin)', slots: ['skin_color', 'skin_type_switcher'] },
  { id: 'hair', code: 'H', label: { ru: 'Волосы', en: 'Hair' }, color: 'var(--line-hair)', slots: ['hairstyle', 'hair_color'] },
  {
    id: 'eyes',
    code: 'E',
    label: { ru: 'Глаза', en: 'Eyes' },
    color: 'var(--line-eyes)',
    slots: ['eyes', 'eyes_color', 'eyebrows', 'eyebrows_color', 'eyelash_color'],
  },
  { id: 'face', code: 'F', label: { ru: 'Лицо', en: 'Face' }, color: 'var(--line-face)', slots: ['nose', 'mouth', 'jaw', 'ear', 'teeth'] },
  { id: 'beard', code: 'B', label: { ru: 'Борода', en: 'Beard' }, color: 'var(--line-beard)', slots: ['beard', 'beard_part', 'beard_color'] },
  {
    id: 'mods',
    code: 'M',
    label: { ru: 'Модификации', en: 'Mods' },
    color: 'var(--line-mods)',
    slots: ['cyberware_switcher', 'scars', 'facial_tattoo_switcher', 'piercings', 'piercings_color'],
  },
  {
    id: 'makeup',
    code: 'K',
    label: { ru: 'Макияж', en: 'Makeup' },
    color: 'var(--line-makeup)',
    slots: [
      'makeupEyes', 'makeupEyes_color', 'makeupLips_type', 'makeupLips', 'makeupLips_color',
      'makeupCheeks', 'makeupCheeks_color', 'makeupPimples', 'makeupPimples_color',
    ],
  },
  {
    id: 'body',
    code: 'T',
    label: { ru: 'Тело', en: 'Body' },
    color: 'var(--line-body)',
    slots: [
      'breast', 'nipples_switcher', 'body_tattoo_switcher', 'body_scars_switcher', 'genitals_switcher',
      'genitals_size', 'pubic_hair', 'pubic_hair_color', 'nails_l', 'nails_color',
    ],
  },
];

export const LINE_OF_SLOT = new Map<string, Line>(LINES.flatMap((l) => l.slots.map((s) => [s, l] as const)));
