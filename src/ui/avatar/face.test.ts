import { describe, expect, it } from 'vitest';
import { BLINK_OVERSHOOT, GAZE_LIMIT, gazeAngles, lidPose, mouthOpenFor, SMILE, smileFor } from './face';

describe.each(['male', 'female'] as const)('smileFor(%s) — строка «Зубы»: улыбка, а не оскал', (g) => {
  const s = smileFor(g);

  it('уголки рта уходят наружу, назад и выше всей верхней губы', () => {
    expect(s.corner[1]).toBeGreaterThan(s.lipUp3[1]);
    expect(s.corner[1]).toBeGreaterThan(s.lipUpMid[1]);
    expect(s.corner[0]).toBeGreaterThan(s.lipUp3[0]);
    expect(s.corner[2]).toBeGreaterThan(0);
  });

  it('верхняя губа поднимается полумесяцем (∪) и открывает верхние резцы', () => {
    expect(s.lipUp2[1]).toBeGreaterThan(s.lipUpMid[1]);
    expect(s.lipUp3[1]).toBeGreaterThan(s.lipUp2[1]);
    // при подъёме центра меньше ~3 мм резцы остаются под губой (оскал нижним рядом)
    expect(s.lipUpMid[1]).toBeGreaterThanOrEqual(3);
  });

  it('нижняя губа прикрывает нижний ряд: не опускается, к краям поднимается вслед за уголками', () => {
    expect(s.lipDnMid[1]).toBeGreaterThanOrEqual(0);
    expect(s.lipDnMid[1]).toBeLessThan(s.lipUpMid[1] / 2);
    expect(s.lipDn2[1]).toBeGreaterThanOrEqual(s.lipDnMid[1]);
    expect(s.lipDn3[1]).toBeGreaterThan(s.lipDn2[1]);
    // но ниже уголка — иначе губы смыкаются в уголках
    expect(s.lipDn3[1]).toBeLessThan(s.corner[1]);
    expect(s.lipDn3[0]).toBeLessThan(s.corner[0]);
  });

  it('нижняя губа прижата к зубам, но не подворачивается внутрь (изнанка не выходит лентой)', () => {
    expect(s.lipDnMid[2]).toBeGreaterThanOrEqual(0.8);
    expect(s.lipDnMid[2]).toBeLessThanOrEqual(1.5);
    expect(s.lipDn2[2]).toBeLessThanOrEqual(1.5);
  });

  it('щёки поднимаются на 2–5 мм, челюсть приоткрыта на 0,8–1,8°', () => {
    expect(s.cheek[1]).toBeGreaterThanOrEqual(2);
    expect(s.cheek[1]).toBeLessThanOrEqual(5);
    expect(s.cheekLow[1]).toBeGreaterThan(0);
    expect(s.jawDeg).toBeGreaterThanOrEqual(0.8);
    expect(s.jawDeg).toBeLessThanOrEqual(1.8);
  });
});

describe('smileFor: у женского лица губы полнее', () => {
  const f = smileFor('female');
  const m = smileFor('male');

  it('мужская улыбка — базовая SMILE', () => {
    expect(m).toBe(SMILE);
  });

  it('верхняя губа и уголки поднимаются выше, челюсть и нижняя губа опускаются меньше', () => {
    expect(f.lipUpMid[1]).toBeGreaterThan(m.lipUpMid[1]);
    expect(f.lipUp2[1]).toBeGreaterThan(m.lipUp2[1]);
    expect(f.corner[1]).toBeGreaterThan(m.corner[1]);
    expect(f.jawDeg).toBeLessThan(m.jawDeg);
    expect(f.lipDnMid[1]).toBeGreaterThanOrEqual(m.lipDnMid[1]);
  });

  it('остальные кости берутся из базовой улыбки', () => {
    expect(f.cheek).toEqual(m.cheek);
    expect(f.rowA3).toEqual(m.rowA3);
  });
});

describe('gazeAngles (пределы взгляда)', () => {
  const DEG = Math.PI / 180;
  const dir = (yawDeg: number, pitchDeg: number) => ({
    x: Math.sin(yawDeg * DEG) * Math.cos(pitchDeg * DEG),
    y: Math.sin(pitchDeg * DEG),
    z: -Math.cos(yawDeg * DEG) * Math.cos(pitchDeg * DEG),
  });

  it('цель прямо перед лицом — взгляд прямо', () => {
    const g = gazeAngles(dir(0, 0));
    expect(g.yaw).toBeCloseTo(0, 6);
    expect(g.pitch).toBeCloseTo(0, 6);
  });

  it('в пределах — без изменений', () => {
    const g = gazeAngles(dir(-10, -8));
    expect(g.yaw / DEG).toBeCloseTo(-10, 4);
    expect(g.pitch / DEG).toBeCloseTo(-8, 4);
  });

  it('вверх не больше GAZE_LIMIT.up (≈5°): при опущенной голове глаза не закатываются', () => {
    expect(GAZE_LIMIT.up).toBeLessThanOrEqual(6);
    expect(gazeAngles(dir(0, 30)).pitch / DEG).toBeCloseTo(GAZE_LIMIT.up, 4);
  });

  it('вниз и в стороны — ограничено', () => {
    expect(gazeAngles(dir(0, -60)).pitch / DEG).toBeCloseTo(-GAZE_LIMIT.down, 4);
    expect(gazeAngles(dir(80, 0)).yaw / DEG).toBeCloseTo(GAZE_LIMIT.yaw, 4);
    expect(gazeAngles(dir(-80, 0)).yaw / DEG).toBeCloseTo(-GAZE_LIMIT.yaw, 4);
  });
});

describe('mouthOpenFor', () => {
  it('губы сомкнуты без улыбки (дыхание их не размыкает)', () => {
    expect(mouthOpenFor(0)).toBe(0);
  });

  it('открытие рта следует за улыбкой и ограничено 0..1', () => {
    expect(mouthOpenFor(0.5)).toBe(0.5);
    expect(mouthOpenFor(1.3)).toBe(1);
    expect(mouthOpenFor(-0.2)).toBe(0);
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
