import { describe, expect, it } from 'vitest';
import type { Gender } from '../../model/catalog';
import { defaultState, setSlot, slotValue } from '../../model/state';
import { faceLayersOf, lookOf, morphTargetMatches, notIn3d, PACK_PART_SLOTS } from './look';
import { getIndex } from '../../model/catalog';

describe('lookOf', () => {
  for (const g of ['female', 'male'] as Gender[]) {
    it(`${g}: вид по умолчанию собран из каталога`, () => {
      const look = lookOf(defaultState(g));
      expect(look.gender).toBe(g);
      expect(look.skinApp).toMatch(/^h0_000_p[wm]a__basehead__/);
      expect(look.skinType).toMatch(/^h0_000/);
      expect(look.eyesApp).toBeTruthy();
      expect(look.morphs).not.toContain('None');
      expect(look.longNails).toBe(false);
    });
  }

  it('причёска без мешей даёт hairHint = null, обычная — ключ hints', () => {
    const s0 = defaultState('female');
    const hs = slotValue(s0, 'hairstyle');
    expect(hs).toBeDefined();
    const opts = hs!.variant.options;
    const bald = opts.find((o) => (Array.isArray(o.meshHint) ? o.meshHint[0] : o.meshHint) === 'none');
    const withHair = opts.find((o) => {
      const h = Array.isArray(o.meshHint) ? o.meshHint[0] : o.meshHint;
      return h && h !== 'none';
    });
    expect(withHair).toBeDefined();
    expect(lookOf(setSlot(s0, 'hairstyle', withHair!.i)).hairHint).toBeTruthy();
    if (bald) expect(lookOf(setSlot(s0, 'hairstyle', bald.i)).hairHint).toBeNull();
  });

  it('морф ногтей не попадает в морфы лица, а включает длинные ногти', () => {
    const s0 = defaultState('female');
    const nails = slotValue(s0, 'nails_l');
    if (!nails) return; // строки ногтей нет в каталоге этого пола
    const long = nails.variant.options.find((o) => o.morph && o.morph !== 'None');
    if (!long) return;
    const look = lookOf(setSlot(s0, 'nails_l', long.i));
    expect(look.longNails).toBe(true);
    expect(look.morphs.some((m) => /__nails_[lr]/.test(m))).toBe(false);
  });
});

describe('lookOf: борода', () => {
  it('без бороды beardApp = null, со стилем — app части бороды и цвет', () => {
    const s0 = defaultState('male');
    const beard = slotValue(s0, 'beard')!;
    expect(lookOf(setSlot(s0, 'beard', beard.variant.options[0].i)).beardApp).toBeNull();
    const s1 = setSlot(s0, 'beard', beard.variant.options[3].i);
    const look = lookOf(s1);
    expect(look.beardApp).toMatch(/^hb_000_pma__/);
    expect(look.beardColour).toMatch(/^\d+_/);
  });
  it('у женского тела бороды нет', () => {
    expect(lookOf(defaultState('female')).beardApp).toBeNull();
  });
});

describe('faceLayersOf: слои лица', () => {
  const pick = (s: ReturnType<typeof defaultState>, id: string, at: (o: { meshHint?: string | string[]; app?: string; activates?: string[] }) => boolean) => {
    const o = slotValue(s, id)?.variant.options.find(at);
    expect(o, id).toBeDefined();
    return setSlot(s, id, o!.i);
  };
  const hint = (o: { meshHint?: string | string[] }) => (Array.isArray(o.meshHint) ? o.meshHint[0] : o.meshHint);

  it('с полным набором в 3D рисуются все строки головы; без части набора помечаются её строки', () => {
    for (const id of ['makeupEyes', 'piercings_color', 'scars', 'beard', 'pubic_hair']) expect(notIn3d(id, new Set())).toBe(false);
    expect(notIn3d('makeupLips_color', new Set(['faceLayers']))).toBe(true);
    expect(notIn3d('beard_color', new Set(['faceLayers']))).toBe(false);
    expect(notIn3d('beard_color', new Set(['beards']))).toBe(true);
    expect(notIn3d('hairstyle', new Set(['faceLayers', 'beards', 'intimate']))).toBe(false);
  });

  it('строки частей набора существуют в каталоге', () => {
    const ids = new Set([...getIndex('male').slotById.keys(), ...getIndex('female').slotById.keys()]);
    for (const list of Object.values(PACK_PART_SLOTS)) for (const id of list) expect(ids.has(id), id).toBe(true);
  });

  it('макияж глаз: база — meshHint стиля, appearance — app строки цвета', () => {
    let s = pick(defaultState('female'), 'makeupEyes', (o) => !!hint(o) && hint(o) !== 'none');
    s = pick(s, 'makeupEyes_color', (o) => !!o.app && o.app !== 'None');
    const l = faceLayersOf(s).find((x) => x.slot === 'makeupEyes');
    expect(l?.base).toMatch(/makeup_eyes/);
    expect(l?.app).toBe(slotValue(s, 'makeupEyes_color')?.option?.app);
  });

  it('тату лица: appearance по полу и тону кожи (шаблон)', () => {
    const s = pick(defaultState('male'), 'facial_tattoo_switcher', (o) => !!hint(o) && hint(o) !== 'none');
    expect(faceLayersOf(s).find((x) => x.slot === 'facial_tattoo_switcher')?.app).toBe('{g}__{tone}');
  });

  it('шрамы: общая база hx_000__scars, appearance — app опции', () => {
    const s = pick(defaultState('male'), 'scars', (o) => !!o.app && o.app !== 'None');
    expect(faceLayersOf(s).find((x) => x.slot === 'scars')).toEqual({ slot: 'scars', base: 'hx_000__scars', app: slotValue(s, 'scars')?.option?.app });
  });

  it('кибер-имплант: номер из activates и шаблон тона кожи', () => {
    const s = pick(defaultState('female'), 'cyberware_switcher', (o) => !!o.activates?.some((a) => /^cyberware_(?!00)\d+$/.test(a)));
    const l = faceLayersOf(s).find((x) => x.slot === 'cyberware_switcher');
    expect(l?.app).toMatch(/^hx_000_\{code\}__cyberware_\d+__\{tone\}$/);
  });

  it('по умолчанию без «none»-слоёв и без шрамов', () => {
    for (const g of ['female', 'male'] as Gender[]) {
      const ls = faceLayersOf(defaultState(g));
      expect(ls.every((l) => l.base && l.base !== 'none')).toBe(true);
      expect(ls.some((l) => l.slot === 'scars')).toBe(false);
    }
  });
});

describe('morphTargetMatches', () => {
  it('точное имя и имя с суффиксом', () => {
    expect(morphTargetMatches('h011', 'h011')).toBe(true);
    expect(morphTargetMatches('t0_000_wa_base__full_breast_big_breast', 't0_000_wa_base__full_breast_big')).toBe(true);
  });

  it('префикс без подчёркивания — другой морф', () => {
    expect(morphTargetMatches('h0110', 'h011')).toBe(false);
    expect(morphTargetMatches('h01', 'h011')).toBe(false);
  });
});
