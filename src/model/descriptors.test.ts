import { describe, expect, it } from 'vitest';
import { getIndex } from './catalog';
import { MORPH_SLOTS, morphInfo, shapeParams } from './descriptors';

describe('описания морфов', () => {
  it('на каждый вариант морф-слота есть описание и калибровка', () => {
    for (const g of ['male', 'female'] as const) {
      for (const slot of MORPH_SLOTS) {
        const opts = getIndex(g).slotById.get(slot)!.variants[0].options;
        const info = morphInfo(g, slot);
        expect(info.options.map((o) => o.i), `${g}:${slot}`).toEqual(opts.map((o) => o.i));
        for (const o of info.options) expect(o.text.ru.length).toBeGreaterThan(3);
      }
    }
    if ((globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env.PRINT) {
      for (const slot of MORPH_SLOTS) {
        console.log(slot, morphInfo('male', slot).options.map((o) => `${o.i + 1}: ${o.text.ru}`).join(' | '));
      }
    }
  });

  it('полные и тонкие губы — по видимой высоте губ спереди', () => {
    for (const g of ['male', 'female'] as const) {
      for (const o of morphInfo(g, 'mouth').options) {
        const lips = (o.z.upperLip ?? 0) + (o.z.lowerLip ?? 0);
        if (o.text.en.includes('thin lips')) expect(lips, `${g} mouth ${o.i + 1}`).toBeLessThanOrEqual(-1.6);
        if (o.text.en.includes('full lips')) expect(lips, `${g} mouth ${o.i + 1}`).toBeGreaterThanOrEqual(1.6);
      }
    }
    // вариант 13 у женского тела спереди полнее среднего: «тонкими» его называть нельзя
    expect(morphInfo('female', 'mouth').options[12].text.en).not.toContain('thin lips');
  });

  it('параметры формы в диапазоне -1…1', () => {
    const p = shapeParams('female', { eyes: 5, nose: 3, mouth: 7, jaw: 13, ear: 17 });
    for (const v of Object.values(p)) {
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
