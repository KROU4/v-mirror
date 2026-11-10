import { describe, expect, it } from 'vitest';
import { BLINK, BLINK_OVERSHOOT, blinkAt, blinkDuration, GAZE_LIMIT, gazeAngles, LID_FOLLOW, lidFollow, lidPose, mouthOpenFor, nextBlinkDelay, SMILE, smileFor } from './face';

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

  it('видны оба ряда (ui_expose_teeth): нижняя губа немного опускается, к краям поднимается вслед за уголками', () => {
    expect(s.lipDnMid[1]).toBeLessThanOrEqual(0);
    // но опускается слабее, чем поднимается верхняя, — улыбка, а не оскал
    expect(-s.lipDnMid[1]).toBeLessThan(s.lipUpMid[1] / 2);
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

  it('щёки поднимаются на 2–5 мм, челюсть приоткрыта на 1,5–2,3° (в игре около 2,15°)', () => {
    expect(s.cheek[1]).toBeGreaterThanOrEqual(2);
    expect(s.cheek[1]).toBeLessThanOrEqual(5);
    expect(s.cheekLow[1]).toBeGreaterThan(0);
    expect(s.jawDeg).toBeGreaterThanOrEqual(1.5);
    expect(s.jawDeg).toBeLessThanOrEqual(2.3);
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

describe('lidFollow', () => {
  const D = Math.PI / 180;
  it('взгляд вверх поднимает верхнее веко, вниз — опускает; знак — по ходу закрытия', () => {
    const up = lidFollow(5 * D, 0, 30, -10);
    expect(up.upper).toBeCloseTo(-LID_FOLLOW.upper * 5, 6); // против закрытия (+30)
    expect(up.lower).toBeCloseTo(-LID_FOLLOW.lower * 5, 6); // нижнее закрывается в −: вверх — чуть прикрыто
    const down = lidFollow(-8 * D, 0, 30, -10);
    expect(down.upper).toBeCloseTo(LID_FOLLOW.upper * 8, 6);
    expect(lidFollow(5 * D, 0, -30, 10).upper).toBeCloseTo(LID_FOLLOW.upper * 5, 6);
  });
  it('при сомкнутых веках слежения нет, прямой взгляд — без поправки', () => {
    expect(lidFollow(5 * D, 1, 30, -10)).toEqual({ upper: -0, lower: -0 });
    const z = lidFollow(0, 0, 30, -10);
    expect(Math.abs(z.upper) + Math.abs(z.lower)).toBe(0);
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

describe('моргание: редкое и короткое, как у человека в покое', () => {
  it('одно моргание 120–180 мс, пауза 3–6 с', () => {
    expect(blinkDuration()).toBeGreaterThanOrEqual(0.12);
    expect(blinkDuration()).toBeLessThanOrEqual(0.18);
    expect(nextBlinkDelay(0)).toBe(3);
    expect(nextBlinkDelay(0.999999)).toBeCloseTo(6, 3);
    expect(blinkAt(-0.01)).toBe(0);
    expect(blinkAt(BLINK.close + BLINK.hold / 2)).toBe(1);
    expect(blinkAt(blinkDuration())).toBe(0);
  });

  it('за 10 минут при 60 fps: 10–20 морганий в минуту, глаза закрыты меньше чем в 3 % кадров', () => {
    // тот же автомат, что FaceRig.blinkCurve, с детерминированным «случайным» разбросом
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
    const dt = 1 / 60;
    let next = nextBlinkDelay(rnd());
    let t = -1;
    let double = false;
    let blinks = 0;
    let closed = 0;
    const frames = 10 * 60 * 60;
    for (let f = 0; f < frames; f++) {
      let v = 0;
      if (t < 0) {
        next -= dt;
        if (next <= 0) {
          t = 0;
          blinks++;
          double = rnd() < BLINK.double;
        }
      } else {
        t += dt;
        v = blinkAt(t);
        if (t >= blinkDuration()) {
          t = -1;
          next = double ? BLINK.doubleGap : nextBlinkDelay(rnd());
          double = false;
        }
      }
      if (v > 0.5) closed++;
    }
    const perMin = blinks / 10;
    expect(perMin).toBeGreaterThanOrEqual(10);
    expect(perMin).toBeLessThanOrEqual(20);
    expect(closed / frames).toBeLessThan(0.03);
  });
});
