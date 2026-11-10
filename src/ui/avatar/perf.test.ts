import { describe, expect, it } from 'vitest';
import { DPR, FrameStats, initialPixelRatio, nextPixelRatio, touchRecent } from './perf';

describe('touchRecent (освобождение давно снятых вариантов)', () => {
  it('keeps the current ones and the last `keep` removed, evicts older', () => {
    let o: string[] = [];
    o = touchRecent(o, ['a'], 2).order;
    o = touchRecent(o, ['b'], 2).order;
    o = touchRecent(o, ['c'], 2).order;
    const r = touchRecent(o, ['d'], 2);
    expect(r.evict).toEqual(['a']);
    expect(r.order).toEqual(['b', 'c', 'd']);
  });

  it('going back to a kept variant does not evict it', () => {
    const r = touchRecent(['a', 'b', 'c'], ['a'], 2);
    expect(r.evict).toEqual([]);
    expect(r.order).toEqual(['b', 'c', 'a']);
  });

  it('several variants in use at once, duplicates ignored', () => {
    const r = touchRecent(['x', 'y'], ['p', 'q', 'p'], 0);
    expect(r.evict).toEqual(['x', 'y']);
    expect(r.order).toEqual(['p', 'q']);
  });
});

describe('pixel ratio', () => {
  it('starts at the device ratio, capped at 2 and never below 1', () => {
    expect(initialPixelRatio(1)).toBe(1);
    expect(initialPixelRatio(1.5)).toBe(1.5);
    expect(initialPixelRatio(3)).toBe(2);
    expect(initialPixelRatio(undefined)).toBe(1);
  });

  it('steps down on slow frames, not below the minimum', () => {
    expect(nextPixelRatio(2, 30, 2)).toBe(1.75);
    expect(nextPixelRatio(DPR.min, 50, 2)).toBe(DPR.min);
  });

  it('steps back up on fast frames, not above the device', () => {
    expect(nextPixelRatio(1.5, 8, 2)).toBe(1.75);
    expect(nextPixelRatio(1, 8, 1)).toBe(1);
  });

  it('keeps the ratio in the comfortable band', () => {
    expect(nextPixelRatio(1.5, 19, 2)).toBe(1.5);
  });

  it('does not climb back to a ratio that was already too slow', () => {
    expect(nextPixelRatio(1.75, 10, 2, 1.75)).toBe(1.75);
    expect(nextPixelRatio(1.5, 10, 2, 1.75)).toBe(1.75);
  });
});

describe('FrameStats', () => {
  it('averages over a sliding window', () => {
    const s = new FrameStats();
    for (let i = 0; i < DPR.window; i++) s.push(10);
    expect(s.full).toBe(true);
    expect(s.avgMs).toBeCloseTo(10);
    for (let i = 0; i < DPR.window; i++) s.push(20);
    expect(s.avgMs).toBeCloseTo(20);
    expect(s.fps).toBeCloseTo(50);
    expect(s.frames).toBe(2 * DPR.window);
    // одиночные долгие кадры (загрузка) медиану не сдвигают
    for (let i = 0; i < 5; i++) s.push(100);
    expect(s.medianMs).toBe(20);
    s.reset();
    expect(s.full).toBe(false);
  });
});
