import { describe, expect, it } from 'vitest';
import { bodyModeFor, cameraShot, cameraSlotFor, clipPlan, showcaseClipFor } from './slots';

describe('cameraSlotFor', () => {
  it('без строки — кадр кожи', () => {
    expect(cameraSlotFor(undefined)).toBe('UI_Skin');
  });

  it('строки лица и волос — по таблице игры', () => {
    expect(cameraSlotFor('eyes_color')).toBe('UI_Eyes');
    expect(cameraSlotFor('teeth')).toBe('UI_Teeth');
    expect(cameraSlotFor('hair_color')).toBe('UI_Hairs');
    expect(cameraSlotFor('beard_color')).toBe('UI_Hairs');
    expect(cameraSlotFor('nails_color')).toBe('UI_FingerNails');
  });

  it('цвет бровей — общий кадр головы (опечатка игры)', () => {
    expect(cameraSlotFor('eyebrows_color')).toBe('UI_HeadPreview');
  });

  it('помада: _none/_glossy/_matte — голова, остальное — губы', () => {
    expect(cameraSlotFor('makeupLips', 'face', 'makeupLips_glossy')).toBe('UI_HeadPreview');
    expect(cameraSlotFor('makeupLips', 'face', 'makeupLips_none')).toBe('UI_HeadPreview');
    expect(cameraSlotFor('makeupLips', 'face', 'makeupLips_02')).toBe('UI_Lips');
  });

  it('прочие строки — по группе', () => {
    expect(cameraSlotFor('breast', 'body')).toBe('UI_Preview');
    expect(cameraSlotFor('arm_tattoo', 'arms')).toBe('UI_FingerNails');
    expect(cameraSlotFor('piercing', 'face')).toBe('UI_HeadPreview');
  });

  it('имена из прототипа объекта не ломают поиск', () => {
    expect(cameraSlotFor('toString', 'face')).toBe('UI_HeadPreview');
    expect(cameraSlotFor('constructor', 'body')).toBe('UI_Preview');
  });
});

describe('cameraShot', () => {
  it('мужской кадр головы на 5 см выше женского', () => {
    const f = cameraShot('UI_HeadPreview', 'female');
    const m = cameraShot('UI_HeadPreview', 'male');
    expect(m.target[1] - f.target[1]).toBeCloseTo(0.05);
    expect(f.distance).toBe(1.2);
  });

  it('рост — дальний план, кожа и волосы — средний', () => {
    expect(cameraShot('UI_Preview', 'female').distance).toBeGreaterThan(5);
    expect(cameraShot('UI_Skin', 'male').distance).toBe(2);
    expect(cameraShot('UI_Hairs', 'female').distance).toBe(2);
    expect(cameraShot('UI_FingerNails', 'female').target[1]).toBeLessThan(cameraShot('UI_Skin', 'female').target[1]);
  });
});

describe('позы и клипы', () => {
  it('режим тела по слоту', () => {
    expect(bodyModeFor('UI_Preview')).toBe('fullbody');
    expect(bodyModeFor('UI_FingerNails')).toBe('hand');
    expect(bodyModeFor('UI_Teeth')).toBe('closeup');
  });

  it('показ части лица только для своих слотов', () => {
    expect(showcaseClipFor('UI_Eyes')).toBe('ui_closeup_shot_eyes');
    expect(showcaseClipFor('UI_Jaw')).toBe('ui_closeup_shot_chin');
    expect(showcaseClipFor('UI_Skin')).toBeNull();
  });

  const names = (s: { clip: string }[]) => s.map((x) => x.clip);

  it('первый показ — сразу цикл крупного плана', () => {
    expect(names(clipPlan(null, 'closeup', null))).toEqual(['ui_closeup_shot']);
    expect(clipPlan(null, 'closeup', null).at(-1)?.loop).toBe(true);
  });

  it('крупный план → рост и обратно', () => {
    expect(names(clipPlan('closeup', 'fullbody', null))).toEqual(['ui_closeup_to_fullbody', 'ui_fullbody_shot']);
    expect(names(clipPlan('fullbody', 'closeup', 'ui_closeup_shot_eyes'))).toEqual(['ui_fullbody_to_closeup', 'ui_closeup_shot_eyes', 'ui_closeup_shot']);
  });

  it('рука: вход, цикл и выход', () => {
    expect(names(clipPlan('closeup', 'hand', null))).toEqual(['ui_expose_hand_start', 'ui_expose_hand_loop']);
    expect(names(clipPlan('hand', 'hand', null))).toEqual(['ui_expose_hand_loop']);
    expect(names(clipPlan('hand', 'fullbody', null))).toEqual(['ui_expose_hand_end', 'ui_closeup_to_fullbody', 'ui_fullbody_shot']);
    expect(names(clipPlan('fullbody', 'hand', null))).toEqual(['ui_fullbody_to_closeup', 'ui_expose_hand_start', 'ui_expose_hand_loop']);
  });

  it('однократные клипы не зациклены, последний — цикл', () => {
    const plan = clipPlan('hand', 'closeup', 'ui_closeup_shot_lips');
    expect(plan.slice(0, -1).every((s) => !s.loop)).toBe(true);
    expect(plan.at(-1)).toEqual({ clip: 'ui_closeup_shot', loop: true });
  });
});
