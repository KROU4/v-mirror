import { describe, expect, it } from 'vitest';
import { isDangleBone, morphWeight, pubicHaloAlpha, resolveIntimate, type IntimateManifest } from './intimate';

const M: IntimateManifest = {
  tones: ['01_ca_pale', '06_bl_dark'],
  meshes: {
    pwa_nipple: { file: 'n.glb', kind: 'skin', submeshes: [{ index: 0, name: 's0' }] },
    pwa_scars: { file: 's.glb', kind: 'decal', submeshes: [0, 1, 2, 3].map((index) => ({ index, name: 's' + index })) },
    pwa_penis: { file: 'p.glb', kind: 'skin', submeshes: [{ index: 0, name: 's0' }] },
    pwa_penis_hairstyle_01: { file: 'ph.glb', kind: 'decal', submeshes: [{ index: 0, name: 's0' }] },
  },
  materials: {
    nip_pale: { type: 'skin', albedo: 'a.jpg' },
    nip_dark: { type: 'skin', albedo: 'b.jpg' },
    scar0: { type: 'decal', diffuse: 's0.png' },
    scar1: { type: 'decal', diffuse: 's1.png' },
    pen: { type: 'skin', albedo: 'p.jpg' },
    bush_black: { type: 'decal', diffuse: 'h.png', diffuseColor: '#656259' },
  },
  genders: {
    pma: {},
    pwa: {
      breast: {
        variants: {
          breast: {
            type: 'morph',
            options: {
              '0': {
                appliesTo: [
                  { mesh: 'body:pwa_body', target: 'big' },
                  { mesh: 'pwa_nipple', target: 't0_small_breast' },
                  { mesh: 'pwa_scars', target: 't0_small_breast' },
                ],
                influence: 1,
              },
              '1': { appliesTo: [], influence: 0 },
            },
          },
        },
      },
      nipples_switcher: {
        variants: {
          nipples: {
            type: 'switcher',
            options: {
              '0': { parts: [] },
              '1': { parts: [{ mesh: 'pwa_nipple', visibleSubmeshes: [0], materialsByTone: { '01_ca_pale': ['nip_pale'], '06_bl_dark': ['nip_dark'] } }] },
            },
          },
        },
      },
      body_scars_switcher: {
        variants: {
          body_scars: {
            type: 'switcher',
            options: {
              '2': { parts: [{ mesh: 'pwa_scars', visibleSubmeshes: [1], materialsByTone: { '01_ca_pale': ['scar0', 'scar1', null, null] } }] },
            },
          },
        },
      },
      genitals_switcher: {
        variants: { genitals: { type: 'switcher', options: { '2': { parts: [{ mesh: 'pwa_penis', visibleSubmeshes: [0], materialsByTone: { '01_ca_pale': ['pen'] } }] } } } },
      },
      genitals_size: {
        variants: {
          penis_base: {
            type: 'morph',
            options: {
              '2': {
                appliesTo: [
                  { mesh: 'pwa_penis', target: 'big' },
                  { mesh: 'pwa_penis_hairstyle_01', target: 'big' },
                ],
                influence: 1,
              },
            },
          },
        },
      },
      pubic_hair_color: {
        variants: { penis_base_hairstyle_01: { type: 'appearance', options: { '0': { parts: [{ mesh: 'pwa_penis_hairstyle_01', visibleSubmeshes: [0], materials: ['bush_black'] }] } } } },
      },
    },
  },
};

describe('resolveIntimate', () => {
  it('shows nothing for the default picks', () => {
    const r = resolveIntimate(M, 'pwa', { nipples_switcher: { variant: 'nipples', i: 0 }, breast: { variant: 'breast', i: 1 } }, '01_ca_pale');
    expect(r.parts).toEqual([]);
    expect(r.morphs).toEqual({});
  });

  it('picks the material of the body tone and falls back to the first tone', () => {
    const pick = { nipples_switcher: { variant: 'nipples', i: 1 } };
    expect(resolveIntimate(M, 'pwa', pick, '06_bl_dark').parts).toEqual([{ mesh: 'pwa_nipple', submeshes: [{ index: 0, material: 'nip_dark' }] }]);
    expect(resolveIntimate(M, 'pwa', pick, 'unknown_tone').parts[0].submeshes[0].material).toBe('nip_pale');
  });

  it('uses the material of the visible submesh index (scars 02 → submesh 1)', () => {
    const r = resolveIntimate(M, 'pwa', { body_scars_switcher: { variant: 'body_scars', i: 2 } }, '01_ca_pale');
    expect(r.parts).toEqual([{ mesh: 'pwa_scars', submeshes: [{ index: 1, material: 'scar1' }] }]);
  });

  it('genitals, size morph and pubic hair colour work together', () => {
    const r = resolveIntimate(
      M,
      'pwa',
      {
        genitals_switcher: { variant: 'genitals', i: 2 },
        genitals_size: { variant: 'penis_base', i: 2 },
        pubic_hair_color: { variant: 'penis_base_hairstyle_01', i: 0 },
      },
      '01_ca_pale',
    );
    expect(r.parts.map((p) => p.mesh)).toEqual(['pwa_penis', 'pwa_penis_hairstyle_01']);
    expect(morphWeight(r, 'pwa_penis', 'big')).toBe(1);
    expect(morphWeight(r, 'pwa_penis_hairstyle_01', 'big')).toBe(1);
    expect(morphWeight(r, 'pwa_penis', 'small')).toBe(0);
  });

  it('breast morphs reach nipple and scar decals, but not the body (that comes from the catalog morph)', () => {
    const r = resolveIntimate(M, 'pwa', { breast: { variant: 'breast', i: 0 } }, '01_ca_pale');
    expect(r.morphs).toEqual({ pwa_nipple: { t0_small_breast: 1 }, pwa_scars: { t0_small_breast: 1 } });
  });

  it('a pack cannot write into Object.prototype through appliesTo keys', () => {
    const bad = JSON.parse(
      JSON.stringify({ ...M, genders: { pwa: { breast: { variants: { breast: { type: 'morph', options: { '0': { appliesTo: [{ mesh: '__proto__', target: 'x' }, { mesh: 'pwa_nipple', target: '__proto__' }, { mesh: 'constructor', target: 'y' }, { mesh: 7, target: 'z' }], influence: { evil: 1 } } } } } } } } }),
    ) as IntimateManifest;
    const r = resolveIntimate(bad, 'pwa', { breast: { variant: 'breast', i: 0 } }, '01_ca_pale');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
    expect(({} as Record<string, unknown>).y).toBeUndefined();
    expect(Object.keys(r.morphs)).toEqual([]);
  });

  it('ignores unknown variants and genders', () => {
    expect(resolveIntimate(M, 'pma', { nipples_switcher: { variant: 'nipples', i: 1 } }, '01_ca_pale').parts).toEqual([]);
    expect(resolveIntimate(M, 'pwa', { nipples_switcher: { variant: 'nope', i: 1 } }, '01_ca_pale').parts).toEqual([]);
  });
});

describe('helpers', () => {
  it('dangle bones are the penis dyng joints only', () => {
    expect(isDangleBone('dyng_penis_02')).toBe(true);
    expect(isDangleBone('dyng_hair_01')).toBe(false);
  });
  it('pubic halo fades the near-black texels', () => {
    expect(pubicHaloAlpha(0)).toBe(0);
    expect(pubicHaloAlpha(0.025)).toBeCloseTo(0.5);
    expect(pubicHaloAlpha(0.2)).toBe(1);
  });
});
