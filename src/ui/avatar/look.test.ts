import { describe, expect, it } from 'vitest';
import type { Gender } from '../../model/catalog';
import { defaultState, setSlot, slotValue } from '../../model/state';
import { lookOf, morphTargetMatches } from './look';

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
