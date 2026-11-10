import { describe, expect, it } from 'vitest';
import { getIndex } from './catalog';
import { hairDescription, hairDescriptions } from './hair';
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

    it(`у каждой формы бровей есть описание (${g})`, () => {
      const opts = getIndex(g).slotById.get('eyebrows')!.variants[0].options;
      for (const o of opts) expect(browDescription(o)?.ru.length ?? 0, `бровь ${o.label.en}`).toBeGreaterThan(3);
    });
  }
});
