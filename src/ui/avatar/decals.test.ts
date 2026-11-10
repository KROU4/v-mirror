import { describe, expect, it } from 'vitest';
import type { DecalManifest, FaceLayerComponent } from './assets';
import { fillApp, resolveFaceLayer, transferHeadAttrs } from './decals';

const comp = (mesh: string, app = 'default'): FaceLayerComponent[] => [{ mesh, app, chunks: [0] }];

describe('fillApp', () => {
  it('подставляет пол, код тела и тон кожи', () => {
    expect(fillApp('{g}__{tone}', 'pwa', '01_ca_pale')).toBe('w__01_ca_pale');
    expect(fillApp('hx_000_{code}__cyberware_03__{tone}', 'pma', '05_af_dark')).toBe('hx_000_pma__cyberware_03__05_af_dark');
    expect(fillApp('hx_000_pma__makeup_eyes__01_black', 'pwa', 't')).toBe('hx_000_pma__makeup_eyes__01_black');
  });
});

describe('resolveFaceLayer', () => {
  const apps: DecalManifest['apps'] = {
    hx_000__tattoo_01: {
      m__01_ca_pale: comp('m_pale'),
      m__05_af_dark: comp('m_dark'),
      w__01_ca_pale: comp('w_pale'),
      w__05_af_dark: comp('w_dark'),
    },
    i1_000__earring_01: {
      i0_000_pwa__earring__01_silver: comp('w_silver'),
      i0_000_pma__earring__01_silver: comp('m_silver'),
      i0_000_pma__earring__02_gold: comp('m_gold'),
    },
    hx_000__empty: {},
  };

  it('точное имя appearance', () => {
    expect(resolveFaceLayer(apps, { slot: 'facial_tattoo_switcher', base: 'hx_000__tattoo_01', app: '{g}__{tone}' }, 'pwa', '05_af_dark')[0].mesh).toBe('w_dark');
  });

  it('тот же цвет у другого пола в имени app', () => {
    const pick = { slot: 'piercings', base: 'i1_000__earring_01', app: 'i0_000_pwa__earring__02_gold' };
    expect(resolveFaceLayer(apps, pick, 'pma', 't')[0].mesh).toBe('m_gold');
  });

  it('нет такого тона — первая appearance своего пола, лучше того же тона', () => {
    const pick = { slot: 'facial_tattoo_switcher', base: 'hx_000__tattoo_01', app: '{g}__{tone}' };
    expect(resolveFaceLayer(apps, pick, 'pma', '09_xx_unknown')[0].mesh).toBe('m_pale');
    expect(resolveFaceLayer(apps, { ...pick, app: null }, 'pwa', '05_af_dark')[0].mesh).toBe('w_dark');
  });

  it('цвет «нет» (app = null) — первая appearance своего пола', () => {
    expect(resolveFaceLayer(apps, { slot: 'piercings', base: 'i1_000__earring_01', app: null }, 'pma', 't')[0].mesh).toBe('m_silver');
  });

  it('неизвестная или пустая база — слоя нет', () => {
    expect(resolveFaceLayer(apps, { slot: 'x', base: 'nope', app: null }, 'pma', 't')).toEqual([]);
    expect(resolveFaceLayer(apps, { slot: 'x', base: 'hx_000__empty', app: null }, 'pma', 't')).toEqual([]);
  });
});

describe('transferHeadAttrs', () => {
  // кожа: три вершины на 1 см друг от друга со своими UV и касательными
  const head = [
    {
      pos: [0, 0, 0, 0.01, 0, 0, 0, 0.01, 0],
      uv: [0.1, 0.1, 0.2, 0.1, 0.1, 0.2],
      tangent: [1, 0, 0, 1, 1, 0, 0, -1, 0, 1, 0, 1],
    },
  ];

  it('берёт UV и касательную ближайшей вершины головы (слой сдвинут на доли мм по нормали)', () => {
    const t = transferHeadAttrs([0.0101, 0, 0.0004, 0, 0.0098, 0.0003], head);
    expect([...t.uv]).toEqual([expect.closeTo(0.2), expect.closeTo(0.1), expect.closeTo(0.1), expect.closeTo(0.2)]);
    expect([...t.tangent!]).toEqual([1, 0, 0, -1, 0, 1, 0, 1]);
    expect(t.misses).toBe(0);
  });

  it('вершины дальше maxDist считаются промахами, вне соседних ячеек — UV (0, 0)', () => {
    const t = transferHeadAttrs([0.005, 0.005, 0, 1, 1, 1], head, 0.003);
    expect(t.misses).toBe(2);
    expect(t.uv[2]).toBe(0);
    expect(t.uv[3]).toBe(0);
  });

  it('без касательных у головы касательных нет', () => {
    expect(transferHeadAttrs([0, 0, 0], [{ pos: head[0].pos, uv: head[0].uv }]).tangent).toBeNull();
  });

  it('несколько частей головы (submesh) ищутся вместе', () => {
    const t = transferHeadAttrs([0.05, 0, 0], [head[0], { pos: [0.05, 0, 0.0002], uv: [0.9, 0.8], tangent: [0, 0, 1, 1] }]);
    expect([...t.uv]).toEqual([expect.closeTo(0.9), expect.closeTo(0.8)]);
  });
});
