import { describe, expect, it } from 'vitest';
import { CATALOGS, getIndex } from '../model/catalog';
import { packSwatchPath, slotHasSwatches } from './SwatchChip';
import { lookupSwatch, swatchTable } from './swatch';

describe('образцы цвета в строках и сетке', () => {
  it('слоты с образцами — ровно цветовые слоты редактора', () => {
    const { slotById } = getIndex('male');
    const hair = slotById.get('hair_color')!;
    expect(slotHasSwatches('male', 'hair_color', hair.variants[0])).toBe(true);
    const nose = slotById.get('nose')!;
    expect(slotHasSwatches('male', 'nose', nose.variants[0])).toBe(false);
    const teeth = slotById.get('teeth')!;
    expect(slotHasSwatches('male', 'teeth', teeth.variants[0])).toBe(true);
  });

  it('у каждого цвета есть текстурное описание, а не плоская заливка, кроме однотонных в игре', () => {
    for (const g of ['male', 'female'] as const) {
      const table = swatchTable(g);
      let textured = 0;
      let total = 0;
      for (const s of CATALOGS[g].slots) {
        if (!table.slots[s.id]) continue;
        for (const v of s.variants)
          for (const o of v.options) {
            const d = lookupSwatch(table, s.id, o);
            if (!d) continue;
            total++;
            if (d.kind !== 'solid' || (d.pattern && d.pattern !== 'none')) textured++;
          }
      }
      expect(total).toBeGreaterThan(500);
      expect(textured / total).toBeGreaterThan(0.9);
    }
  });

  it('путь миниатюры в наборе: по иконке, по номеру только в устойчивых слотах', () => {
    expect(packSwatchPath('male', 'hair_color', { i: 0, icon: 'BrownLiquorice' })).toBe('swatches/icons/BrownLiquorice.webp');
    // натуральные зубы — без иконки в игре, но слот устойчив: картинка по номеру
    expect(packSwatchPath('male', 'teeth', { i: 0 })).toBe('swatches/male/teeth/0.webp');
    // без иконки в неустойчивом слоте файла нет — не запрашиваем (иначе 404 в консоли)
    expect(packSwatchPath('male', 'makeupLips_color', { i: 3 })).toBeNull();
    // имя иконки с недопустимыми символами не превращается в путь
    expect(packSwatchPath('male', 'teeth', { i: 9, icon: '../x' })).toBe('swatches/male/teeth/9.webp');
  });
});
