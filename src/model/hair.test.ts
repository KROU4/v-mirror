import { describe, expect, it } from 'vitest';
import { getIndex } from './catalog';
import { hairDescription, hairDescriptions, hairKey } from './hair';
import { browDescription } from './brows';

describe('описания причёсок и бровей', () => {
  for (const g of ['male', 'female'] as const) {
    it(`у каждой причёски есть описание по рендеру (${g})`, () => {
      const opts = getIndex(g).slotById.get('hairstyle')!.variants[0].options;
      const generic = new Set(['короткая', 'очень короткая / выбритая', 'длинная или собранная', 'дреды / косички']);
      const missing = opts.filter((o) => generic.has(hairDescription(g, o).ru)).map((o) => o.i + 1);
      expect(missing, `варианты без описания: ${missing.join(', ')}`).toEqual([]);
    });

    it(`описания причёсок в промпте уникальны (${g})`, () => {
      const opts = getIndex(g).slotById.get('hairstyle')!.variants[0].options;
      const en = hairDescriptions(g, opts).map((d) => d.en);
      const dup = en.filter((t, k) => en.indexOf(t) !== k);
      expect(dup, `повторы: ${dup.join(' | ')}`).toEqual([]);
      // разные меши не должны описываться одинаково: повтор допустим только у общего меша
      const byText = new Map<string, Set<string>>();
      opts.forEach((o) => {
        const t = hairDescription(g, o).en;
        byText.set(t, (byText.get(t) ?? new Set()).add(String(o.meshHint)));
      });
      const clash = [...byText].filter(([, keys]) => keys.size > 1).map(([t]) => t);
      expect(clash).toEqual([]);
    });

    it(`закрученный кок 047 описан с выбритыми боками, а не просто «короткие бока» (${g})`, () => {
      // меш — андеркат с выбритыми до кожи висками: для густых боков модель не должна его брать
      const opts = getIndex(g).slotById.get('hairstyle')!.variants[0].options;
      const o = opts.find((x) => hairKey(x) === '047_swirl_pomp')!;
      expect(hairDescription(g, o).en).toMatch(/shaved/);
      expect(hairDescription(g, o).ru).toMatch(/выбриты/);
    });

    it(`у каждой формы бровей есть описание (${g})`, () => {
      const opts = getIndex(g).slotById.get('eyebrows')!.variants[0].options;
      for (const o of opts) expect(browDescription(o)?.ru.length ?? 0, `бровь ${o.label.en}`).toBeGreaterThan(3);
    });
  }

  it('длина причёсок по рендеру мешей: мужская 27 до плеч, женская 11 до ключиц', () => {
    const m = getIndex('male').slotById.get('hairstyle')!.variants[0].options;
    const f = getIndex('female').slotById.get('hairstyle')!.variants[0].options;
    expect(hairDescription('male', m[26]).en).toMatch(/shoulders/);
    expect(hairDescription('male', m[26]).en).not.toMatch(/neck/);
    expect(hairDescription('female', f[10]).en).toMatch(/collarbone/);
    expect(hairDescription('female', f[10]).en).not.toMatch(/^long/);
  });
});
