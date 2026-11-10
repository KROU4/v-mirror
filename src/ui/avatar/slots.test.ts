import { describe, expect, it } from 'vitest';
import { bodyModeFor, cameraShot, cameraSlotFor, clipPlan, HAND_END_SPEED, isCloseupFocus, type BodyMode } from './slots';

describe('cameraSlotFor', () => {
  it('без строки — кадр кожи', () => {
    expect(cameraSlotFor(undefined)).toBe('UI_Skin');
  });

  it('строки лица и волос — по таблице игры', () => {
    expect(cameraSlotFor('eyes_color')).toBe('UI_Eyes');
    expect(cameraSlotFor('teeth')).toBe('UI_Teeth');
    expect(cameraSlotFor('hair_color')).toBe('UI_Hairs');
    expect(cameraSlotFor('beard')).toBe('UI_Jaw');
    expect(cameraSlotFor('beard_part')).toBe('UI_Jaw');
    expect(cameraSlotFor('beard_color')).toBe('UI_Jaw');
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

describe('кадр ногтей', () => {
  // высота кадра 2·d·tan(7,5°); сверху ~10 % кадра закрывает плашка заголовка
  const top = (g: 'female' | 'male') => {
    const s = cameraShot('UI_FingerNails', g);
    const half = s.distance * Math.tan((7.5 * Math.PI) / 180);
    return s.target[1] + half - 0.2 * half;
  };

  it('макушка (≈ 1,76 м у мужчины, 1,70 м у женщины в позе руки) не уходит под заголовок', () => {
    expect(top('male')).toBeGreaterThan(1.76);
    expect(top('female')).toBeGreaterThan(1.7);
  });

  it('опущенная кисть (≈ 1,3 м) остаётся в кадре', () => {
    for (const g of ['female', 'male'] as const) {
      const s = cameraShot('UI_FingerNails', g);
      expect(s.target[1] - s.distance * Math.tan((7.5 * Math.PI) / 180)).toBeLessThan(1.25);
    }
  });
});

describe('позы и клипы', () => {
  it('режим тела по слоту', () => {
    expect(bodyModeFor('UI_Preview')).toBe('fullbody');
    expect(bodyModeFor('UI_FingerNails')).toBe('hand');
    expect(bodyModeFor('UI_Teeth')).toBe('closeup');
  });

  const names = (s: { clip: string }[]) => s.map((x) => x.clip);

  it('первый показ — сразу цикл крупного плана', () => {
    expect(names(clipPlan(null, 'closeup'))).toEqual(['ui_closeup_shot']);
    expect(clipPlan(null, 'closeup').at(-1)?.loop).toBe(true);
  });

  it('крупный план → рост и обратно', () => {
    expect(names(clipPlan('closeup', 'fullbody'))).toEqual(['ui_closeup_to_fullbody', 'ui_fullbody_shot']);
    expect(names(clipPlan('fullbody', 'closeup'))).toEqual(['ui_fullbody_to_closeup', 'ui_closeup_shot']);
  });

  it('рука: вход, цикл и выход', () => {
    expect(names(clipPlan('closeup', 'hand'))).toEqual(['ui_expose_hand_start', 'ui_expose_hand_loop']);
    expect(names(clipPlan('hand', 'hand'))).toEqual(['ui_expose_hand_loop']);
    expect(names(clipPlan('hand', 'fullbody'))).toEqual(['ui_expose_hand_end', 'ui_closeup_to_fullbody', 'ui_fullbody_shot']);
    expect(names(clipPlan('fullbody', 'hand'))).toEqual(['ui_fullbody_to_closeup', 'ui_expose_hand_start', 'ui_expose_hand_loop']);
  });

  it('выход из позы ногтей ускорен, остальные клипы — с родной скоростью', () => {
    const plan = clipPlan('hand', 'closeup');
    expect(plan[0]).toMatchObject({ clip: 'ui_expose_hand_end', speed: HAND_END_SPEED });
    expect(HAND_END_SPEED).toBeGreaterThan(1);
    expect(plan.slice(1).every((s) => s.speed === undefined)).toBe(true);
  });

  it('однократные клипы не зациклены, последний — цикл', () => {
    const plan = clipPlan('hand', 'closeup');
    expect(plan.slice(0, -1).every((s) => !s.loop)).toBe(true);
    expect(plan.at(-1)).toEqual({ clip: 'ui_closeup_shot', loop: true });
  });

  it('тело никогда не играет «показы» лица ui_closeup_shot_<часть> (§2.2–2.3)', () => {
    const modes: (BodyMode | null)[] = [null, 'closeup', 'fullbody', 'hand'];
    for (const from of modes)
      for (const to of ['closeup', 'fullbody', 'hand'] as BodyMode[])
        expect(names(clipPlan(from, to)).filter((c) => c.startsWith('ui_closeup_shot_'))).toEqual([]);
  });
});

describe('isCloseupFocus (подзаголовок прячется на крупных планах лица)', () => {
  it('глаза, нос, губы, челюсть, зубы и общий кадр головы — крупный план', () => {
    for (const id of ['eyes', 'nose', 'mouth', 'jaw', 'teeth', 'ears']) expect(isCloseupFocus(id, 'head')).toBe(true);
  });

  it('кожа, причёска, ногти и тело — нет', () => {
    for (const id of ['skin_color', 'hairstyle', 'nails_l']) expect(isCloseupFocus(id, 'head')).toBe(false);
    expect(isCloseupFocus('breast', 'body')).toBe(false);
    expect(isCloseupFocus(undefined)).toBe(false);
  });
});

describe('frameZoom: кадр во весь рост на телефоне', () => {
  it('строки тела на телефоне не отъезжают вслед за крупными планами', async () => {
    const { frameZoom } = await import('./engine');
    // телефон 390×844: холст 390×387, снизу плашка описания 70 px
    const body = frameZoom('UI_Preview', 390, 387, 390, 70);
    const head = frameZoom('UI_Eyes', 390, 387, 390, 70);
    expect(body).toBeGreaterThan(head * 1.2);
    // V (1,75 м) в кадре 8,3 м с FOV 15° — около 85 % видимой над плашкой высоты
    const visible = (2 * 8.3 * Math.tan((7.5 * Math.PI) / 180)) / body;
    const fill = 1.75 / (visible * ((387 - 70) / 387));
    expect(fill).toBeGreaterThan(0.8);
    expect(fill).toBeLessThan(0.92);
  });

  it('на широком экране кадры прежние', async () => {
    const { frameZoom } = await import('./engine');
    expect(frameZoom('UI_Preview', 1920, 1080, 1920, 0)).toBe(1);
    expect(frameZoom('UI_Eyes', 1920, 1080, 1920, 0)).toBe(1);
    // узкий промежуток между колонками: крупный план отъезжает, во весь рост — нет
    expect(frameZoom('UI_Eyes', 1920, 1080, 600, 0)).toBeCloseTo((600 / 1080) * 1.3, 6);
    expect(frameZoom('UI_Preview', 1920, 1080, 600, 0)).toBe(1);
  });
});
