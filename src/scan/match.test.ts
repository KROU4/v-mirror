import { describe, expect, it } from 'vitest';
import type { PhotoAnalysis } from './analyze';
import { exposureFix, expressionLoad, mergeSuggestions, type Suggestion } from './match';

const photo = (blendshapes: Record<string, number>) => ({ blendshapes }) as unknown as PhotoAnalysis;

describe('мимика на фото', () => {
  it('нейтральное лицо не штрафуется', () => {
    for (const s of ['eyes', 'nose', 'mouth', 'jaw'] as const) expect(expressionLoad(photo({}), s)).toBe(0);
  });

  it('улыбка бьёт по рту и глазам сильнее, чем по носу', () => {
    const p = photo({ mouthSmileLeft: 0.8, mouthSmileRight: 0.7, cheekSquintLeft: 0.5, cheekSquintRight: 0.5 });
    expect(expressionLoad(p, 'mouth')).toBeCloseTo(0.75, 2);
    expect(expressionLoad(p, 'eyes')).toBeGreaterThan(0.5);
    expect(expressionLoad(p, 'nose')).toBeLessThan(0.3);
  });

  it('открытый рот мешает замеру челюсти', () => {
    expect(expressionLoad(photo({ jawOpen: 0.6 }), 'jaw')).toBeCloseTo(0.6, 2);
  });
});

describe('поправка экспозиции', () => {
  it('пересвеченное фото приводится к тону образца игры', () => {
    const fix = exposureFix([250, 184, 160], '#a8886b');
    const brow = fix([164, 113, 102])!;
    expect(brow[0]).toBeCloseTo(164 * (0xa8 / 250), 0);
    expect(brow[1]).toBeLessThan(113);
  });
  it('без замера кожи цвета не меняются', () => {
    expect(exposureFix(undefined, '#a8886b')([10, 20, 30])).toEqual([10, 20, 30]);
  });
  it('множитель ограничен', () => {
    expect(exposureFix([255, 255, 255], '#101010')([200, 200, 200])![0]).toBeCloseTo(110, 0);
  });
});

describe('слияние подсказок', () => {
  it('в каждом слоте остаётся самая уверенная', () => {
    const a: Suggestion[] = [{ slotId: 'nose', value: 3, conf: 0.3, src: 'local' }];
    const b: Suggestion[] = [{ slotId: 'nose', number: 10, conf: 0.5, src: 'llm' }, { slotId: 'ear', number: 1, conf: 0.2, src: 'llm' }];
    const m = mergeSuggestions(a, b);
    expect(m.find((s) => s.slotId === 'nose')?.src).toBe('llm');
    expect(m).toHaveLength(2);
  });
});
