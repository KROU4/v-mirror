import { describe, expect, it } from 'vitest';
import { getIndex } from './catalog';
import {
  activeVariants,
  decodeState,
  defaultState,
  encodeState,
  gameSheet,
  mulberry32,
  randomize,
  setSlot,
  slotValue,
  visibleSlots,
} from './state';

describe('каталог', () => {
  it('мужской и женский каталоги содержат ключевые слоты редактора', () => {
    for (const g of ['male', 'female'] as const) {
      const ids = getIndex(g).catalog.slots.map((s) => s.id);
      for (const id of ['skin_color', 'hairstyle', 'hair_color', 'eyes', 'eyes_color', 'nose', 'mouth', 'jaw', 'ear', 'eyebrows', 'cyberware_switcher', 'piercings', 'teeth', 'makeupEyes', 'nails_color']) {
        expect(ids, `${g}:${id}`).toContain(id);
      }
    }
    expect(getIndex('male').catalog.slots.map((s) => s.id)).toContain('beard');
    expect(getIndex('female').catalog.slots.map((s) => s.id)).toContain('breast');
  });

  it('у морфов лица 21 вариант у мужчины и 22 у женщины', () => {
    expect(getIndex('male').slotById.get('nose')!.variants[0].options).toHaveLength(21);
    expect(getIndex('female').slotById.get('nose')!.variants[0].options).toHaveLength(22);
  });
});

describe('зависимости опций', () => {
  it('цвет волос привязан к выбранной причёске', () => {
    let s = defaultState('male');
    const before = slotValue(s, 'hair_color')!.variant.name;
    const hs = slotValue(s, 'hairstyle')!;
    const other = hs.variant.options.find((o) => o.i !== hs.value && !(o.activates ?? []).some((a) => a.endsWith('_none')))!;
    s = setSlot(s, 'hairstyle', other.i);
    const after = slotValue(s, 'hair_color')!.variant.name;
    expect(after).not.toBe(before);
    expect(other.activates).toContain(after);
  });

  it('лысая причёска скрывает выбор цвета волос', () => {
    let s = defaultState('male');
    const hs = slotValue(s, 'hairstyle')!;
    const bald = hs.variant.options.find((o) => (o.activates ?? []).some((a) => a.endsWith('_none')))!;
    s = setSlot(s, 'hairstyle', bald.i);
    expect(visibleSlots(s).map((v) => v.slot.id)).not.toContain('hair_color');
  });

  it('без бороды не видны стиль и цвет бороды', () => {
    const s = defaultState('male');
    const beard = slotValue(s, 'beard')!;
    const off = setSlot(s, 'beard', beard.variant.options[0].i);
    const ids = visibleSlots(off).map((v) => v.slot.id);
    expect(ids).not.toContain('beard_color');
    const on = setSlot(s, 'beard', beard.variant.options[3].i);
    expect(visibleSlots(on).map((v) => v.slot.id)).toContain('beard_color');
  });

  it('у каждого слота не больше одного активного варианта', () => {
    for (const g of ['male', 'female'] as const) {
      for (let seed = 1; seed < 30; seed++) {
        const s = randomize(g, 1 + (seed % 10), mulberry32(seed));
        const active = activeVariants(s);
        for (const slot of getIndex(g).catalog.slots) {
          if (slot.auto) continue;
          const n = slot.variants.filter((v) => active.has(v.name) && v.options.length > 1).length;
          expect(n, `${g} ${slot.id} seed=${seed}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('экспорт', () => {
  it('ссылка кодирует и восстанавливает состояние', () => {
    const s = randomize('female', 7, mulberry32(42));
    const back = decodeState(encodeState(s))!;
    expect(gameSheet(back)).toEqual(gameSheet(s));
  });

  it('у нетронутой V все строки листа — значения по умолчанию', () => {
    for (const g of ['male', 'female'] as const) {
      const changed = gameSheet(defaultState(g)).filter((r) => !r.isDefault).map((r) => r.slotId);
      expect(changed, g).toEqual([]);
      expect(encodeState(defaultState(g)).length).toBeLessThan(30);
    }
  });

  it('«Случайно» не трогает тело', () => {
    for (const g of ['male', 'female'] as const) {
      const { catalog } = getIndex(g);
      const body = catalog.slots.find((s) => !s.auto && s.group !== 'head' && s.variants[0]?.options.length > 1)!;
      const v = body.variants[0];
      const base = { gender: g, values: { [v.name]: v.options[1].i } };
      expect(randomize(g, 5, mulberry32(7), true, base).values[v.name], `${g} ${body.id}`).toBe(v.options[1].i);
    }
  });

  it('лист для игры содержит номера в диапазоне', () => {
    for (const row of gameSheet(randomize('male', 10, mulberry32(3)))) {
      expect(row.number).toBeGreaterThanOrEqual(1);
      expect(row.number).toBeLessThanOrEqual(row.total);
    }
  });
});
