import { describe, expect, it } from 'vitest';
import { BLINK_OVERSHOOT, lidPose, SMILE } from './face';

describe('SMILE (строка «Зубы» — улыбка, а не оскал)', () => {
  it('уголки рта уходят наружу, назад и выше всей верхней губы', () => {
    expect(SMILE.corner[1]).toBeGreaterThan(SMILE.lipUp3[1]);
    expect(SMILE.corner[1]).toBeGreaterThan(SMILE.lipUpMid[1]);
    expect(SMILE.corner[0]).toBeGreaterThan(SMILE.lipUp3[0]);
    expect(SMILE.corner[2]).toBeGreaterThan(0);
  });

  it('верхняя губа поднимается полумесяцем: к краям сильнее, чем в центре', () => {
    expect(SMILE.lipUp2[1]).toBeGreaterThan(SMILE.lipUpMid[1]);
    expect(SMILE.lipUp3[1]).toBeGreaterThan(SMILE.lipUp2[1]);
    // центр почти на месте — иначе середина губы выгибается аркой (∩)
    expect(SMILE.lipUpMid[1]).toBeLessThanOrEqual(2.5);
  });

  it('нижняя губа опускается, а у краёв не поднимается', () => {
    expect(SMILE.lipDnMid[1]).toBeLessThan(0);
    expect(SMILE.lipDn2[1]).toBeLessThan(0);
    expect(SMILE.lipDn3[1]).toBeLessThanOrEqual(0);
  });

  it('нижняя губа уходит назад к зубам и не выворачивается', () => {
    expect(SMILE.lipDnMid[2]).toBeGreaterThanOrEqual(1.5);
    expect(SMILE.lipDn2[2]).toBeGreaterThanOrEqual(1.5);
  });

  it('щёки поднимаются на 2–5 мм', () => {
    expect(SMILE.cheek[1]).toBeGreaterThanOrEqual(2);
    expect(SMILE.cheek[1]).toBeLessThanOrEqual(5);
    expect(SMILE.cheekLow[1]).toBeGreaterThan(0);
  });
});

describe('lidPose', () => {
  it('открытые глаза без улыбки — веки в покое', () => {
    expect(lidPose(0, 0)).toEqual({ upper: 0, lower: 0 });
  });

  it('полное моргание доводит верхнее веко с перехлёстом, чтобы не оставалось щели', () => {
    const p = lidPose(1, 0);
    expect(p.upper).toBeCloseTo(BLINK_OVERSHOOT);
    expect(p.upper).toBeGreaterThanOrEqual(1.1);
    expect(p.lower).toBe(1);
  });

  it('улыбка «Зубы» почти не опускает верхнее веко — прищур идёт снизу', () => {
    const p = lidPose(0, 1);
    expect(p.upper).toBeLessThan(0.1);
    expect(p.lower).toBeGreaterThan(p.upper);
    expect(p.lower).toBeLessThan(0.5);
  });

  it('моргание во время улыбки не превышает полного хода', () => {
    const p = lidPose(1, 1);
    expect(p.upper).toBeCloseTo(BLINK_OVERSHOOT);
    expect(p.lower).toBe(1);
  });
});
