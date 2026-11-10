import { describe, expect, it } from 'vitest';
import maleCatalog from '../data/catalog.male.json';
import femaleCatalog from '../data/catalog.female.json';
import {
  lookupSwatch,
  MOTIFS,
  motifLayer,
  swatchKey,
  swatchPackPath,
  swatchStyle,
  swatchTable,
  type SwatchDesc,
  type SwatchOption,
  type SwatchTable,
} from './swatch';

type Cat = { slots: { id: string; variants: { options: SwatchOption[] }[] }[] };
const CATALOGS = { male: maleCatalog as unknown as Cat, female: femaleCatalog as unknown as Cat };

describe('swatchStyle', () => {
  it('draws a solid colour', () => {
    expect(swatchStyle({ kind: 'solid', stops: ['#112233'] })).toEqual({ backgroundColor: '#112233' });
  });

  it('draws a linear gradient with even stops and the given angle', () => {
    const s = swatchStyle({ kind: 'gradient', angle: 180, stops: ['#000000', '#808080', '#ffffff'] });
    expect(s.backgroundImage).toBe('linear-gradient(180deg, #000000 0%, #808080 50%, #ffffff 100%)');
    expect(s.backgroundColor).toBe('#000000');
  });

  it('uses explicit stop positions and defaults the angle to top-to-bottom', () => {
    const s = swatchStyle({ kind: 'gradient', stops: ['#000000', '#ffffff', '#ff0000'], pos: [0, 20, 100] });
    expect(s.backgroundImage).toBe('linear-gradient(180deg, #000000 0%, #ffffff 20%, #ff0000 100%)');
  });

  it('layers hair strands over the ramp and a sheen over metals', () => {
    const hair = swatchStyle({ kind: 'gradient', angle: 180, stops: ['#3a3129', '#291a11'], pattern: 'streaks' });
    const layers = String(hair.backgroundImage);
    expect(layers.startsWith('repeating-linear-gradient(90deg')).toBe(true);
    expect(layers.endsWith('linear-gradient(180deg, #3a3129 0%, #291a11 100%)')).toBe(true);
    const metal = swatchStyle({ kind: 'gradient', stops: ['#b58e5a', '#efc67b'], pattern: 'metal' });
    expect(String(metal.backgroundImage)).toMatch(/^linear-gradient\(115deg/);
  });

  it('draws an iris: clean pupil and sclera, fibres across the iris band', () => {
    const d: SwatchDesc = {
      kind: 'radial',
      stops: ['#080b08', '#234b64', '#afaaa5'],
      pos: [0, 40, 100],
      pattern: 'iris',
      ring: [20, 68],
    };
    const layers = String(swatchStyle(d).backgroundImage);
    expect(layers).toContain('#080b08 0 20%');
    expect(layers).toContain('repeating-conic-gradient');
    expect(layers.endsWith('radial-gradient(circle closest-side at 50% 50%, #080b08 0%, #234b64 40%, #afaaa5 100%)')).toBe(
      true,
    );
  });

  it('ignores malformed colours and empty descriptors', () => {
    expect(swatchStyle(undefined)).toEqual({ backgroundColor: 'transparent' });
    expect(swatchStyle({ kind: 'gradient', stops: ['red; x', 'url(a)'] })).toEqual({ backgroundColor: 'transparent' });
    const s = swatchStyle({ kind: 'gradient', stops: ['#000000', 'nope', '#ffffff'] });
    expect(s.backgroundImage).toBe('linear-gradient(180deg, #000000 0%, #ffffff 100%)');
  });

  it('draws motif layers above the colour stops, last listed on top', () => {
    const s = swatchStyle({
      kind: 'gradient',
      stops: ['#33cc66', '#118844'],
      motif: [
        { shape: 'diagstripes', fg: '#c35bd0' },
        { shape: 'heart', fg: '#eef0f4' },
      ],
    });
    const layers = String(s.backgroundImage).split(', url(');
    expect(layers).toHaveLength(2);
    expect(decodeURIComponent(layers[0])).toContain("fill='#eef0f4'");
    expect(String(s.backgroundImage).endsWith('linear-gradient(180deg, #33cc66 0%, #118844 100%)')).toBe(true);
    expect(s.backgroundSize).toBe('cover');
  });

  it('drops a motif with an unknown shape or a bad colour', () => {
    expect(motifLayer({ shape: 'heart', fg: '#ff0000' })).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(motifLayer({ shape: 'toString', fg: '#ff0000' })).toBeNull();
    expect(motifLayer({ shape: 'nope', fg: '#ff0000' })).toBeNull();
    expect(motifLayer({ shape: 'heart', fg: "red'/><script>" })).toBeNull();
    expect(motifLayer({ shape: 'flag', fg: '#ffffff', colors: ['#24448a', 'url(x)'] })).toBeNull();
    const s = swatchStyle({ kind: 'solid', stops: ['#112233'], motif: [{ shape: 'nope', fg: '#ffffff' }] });
    expect(s).toEqual({ backgroundColor: '#112233' });
  });
});

describe('swatchPackPath', () => {
  it('prefers the shared per-icon image', () => {
    expect(swatchPackPath('female', 'hair_color', 0, 'BrownLiquorice')).toBe('swatches/icons/BrownLiquorice.webp');
  });
  it('falls back to the per-index image for options without an icon', () => {
    expect(swatchPackPath('male', 'teeth', 0)).toBe('swatches/male/teeth/0.webp');
    expect(swatchPackPath('male', 'teeth', 0, '../x')).toBe('swatches/male/teeth/0.webp');
  });
});

describe('lookupSwatch', () => {
  const table: SwatchTable = {
    version: 1,
    gender: 'male',
    keys: { Gold: { kind: 'solid', stops: ['#aa8800'] }, teeth_0: { kind: 'solid', stops: ['#eeeeee'] } },
    slots: {},
  };
  it('finds by icon, then by slot and index, then falls back to the catalog colour', () => {
    expect(lookupSwatch(table, 'teeth', { i: 2, icon: 'Gold' })?.stops).toEqual(['#aa8800']);
    expect(lookupSwatch(table, 'teeth', { i: 0 })?.stops).toEqual(['#eeeeee']);
    expect(lookupSwatch(table, 'teeth', { i: 9, icon: 'Unknown', hex: '#123456' })).toEqual({
      kind: 'solid',
      stops: ['#123456'],
      pattern: 'none',
    });
    expect(lookupSwatch(table, 'teeth', { i: 9 })).toBeUndefined();
    expect(swatchKey('teeth', { i: 3 })).toBe('teeth_3');
  });
});

describe('committed swatch data', () => {
  for (const gender of ['male', 'female'] as const) {
    it(`${gender}: every option of every colour slot has a textured descriptor`, () => {
      const table = swatchTable(gender);
      const missing: string[] = [];
      let colourSlots = 0;
      for (const slot of CATALOGS[gender].slots) {
        const variants = slot.variants.filter((v) => v.options.some((o) => o.hex || o.iris));
        if (!variants.length) continue;
        colourSlots++;
        expect(table.slots[slot.id], slot.id).toBeDefined();
        for (const v of variants)
          for (const o of v.options) if (!table.keys[swatchKey(slot.id, o)]) missing.push(`${slot.id}:${o.i}`);
      }
      expect(missing).toEqual([]);
      expect(colourSlots).toBe(gender === 'male' ? 14 : 13);
    });

    it(`${gender}: descriptors hold only colour facts`, () => {
      for (const d of Object.values(swatchTable(gender).keys)) {
        expect(['gradient', 'radial', 'solid']).toContain(d.kind);
        expect(d.stops.length).toBeGreaterThan(0);
        for (const s of d.stops) expect(s).toMatch(/^#[0-9a-f]{6}$/);
        if (d.pos) expect(d.pos.length).toBe(d.stops.length);
      }
    });

    it(`${gender}: patterned nails and lenses carry drawable motifs`, () => {
      const keys = swatchTable(gender).keys;
      const withMotif = Object.entries(keys).filter(([, d]) => d.motif?.length);
      expect(withMotif.length).toBeGreaterThanOrEqual(70);
      for (const [key, d] of withMotif)
        for (const m of d.motif ?? []) {
          expect(Object.hasOwn(MOTIFS, m.shape), `${key}: ${m.shape}`).toBe(true);
          expect(motifLayer(m), key).not.toBeNull();
        }
      expect(keys.MultiLayerSkull.motif?.[0].shape).toBe('skull');
      expect(keys.Thumb_nail_checker.motif?.[0].shape).toBe('checker');
    });
  }

  it('hair colours are ramps with strands, natural eyes are irises', () => {
    const t = swatchTable('female');
    expect(t.keys.BrownLiquorice).toMatchObject({ kind: 'gradient', pattern: 'streaks' });
    expect(t.keys.GradientBlue).toMatchObject({ kind: 'radial', pattern: 'iris' });
    expect(t.keys.Piercing_gold).toMatchObject({ pattern: 'metal' });
  });
});
