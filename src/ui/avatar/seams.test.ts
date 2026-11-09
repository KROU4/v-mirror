import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { boundaryVertices, weldSeams } from './seams';
import { eightInfluences } from './skeleton';

/** Квадрат из двух треугольников; веса — одна кость на вершину. */
function quad(x0: number, x1: number, bones: THREE.Bone[], boneOf: (x: number) => number) {
  const xs = [x0, x1, x1, x0];
  const ys = [0, 0, 1, 1];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(xs.flatMap((x, i) => [x, ys[i], 0]), 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(xs.flatMap(() => [0, 0, 1]), 3));
  g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(xs.flatMap((x) => [boneOf(x), 0, 0, 0]), 4));
  g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(xs.flatMap(() => [1, 0, 0, 0]), 4));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  const m = new THREE.SkinnedMesh(g, new THREE.MeshBasicMaterial());
  m.bind(new THREE.Skeleton(bones));
  return m;
}

describe('boundaryVertices', () => {
  it('у одиночного квадрата открыты все 4 вершины', () => {
    const a = new THREE.Bone();
    expect(boundaryVertices(quad(0, 1, [a], () => 0).geometry).sort()).toEqual([0, 1, 2, 3]);
  });

  it('внутренняя вершина сетки 3×3 не считается краем, UV-разрез тоже', () => {
    const g = new THREE.BufferGeometry();
    const pts: number[] = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) pts.push(x, y, 0);
    pts.push(1, 1, 0); // дубль центра (как при разрезе по UV)
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const idx: number[] = [];
    for (let y = 0; y < 2; y++)
      for (let x = 0; x < 2; x++) {
        const a = y * 3 + x;
        const c = a === 4 ? 9 : a; // часть треугольников ссылается на дубль центра
        idx.push(c, a + 1, a + 4, c, a + 4, a + 3);
      }
    g.setIndex(idx);
    const b = boundaryVertices(g);
    expect(b).not.toContain(4);
    expect(b).not.toContain(9);
    expect(b.length).toBe(8);
  });
});

describe('weldSeams', () => {
  it('подтягивает край второго куска к первому: позиция и кость по объекту', () => {
    const A = new THREE.Bone();
    const B = new THREE.Bone();
    // первый: край x=1 весит на B (индекс 1)
    const m1 = quad(0, 1, [A, B], (x) => (x === 1 ? 1 : 0));
    // второй: порядок костей другой, край чуть смещён и весит на A — должен стать B (индекс 0)
    const m2 = quad(1.0005, 2, [B, A], () => 1);
    const st = weldSeams([m1, m2], 0.003);
    expect(st.welded).toBe(2);
    expect(st.maxGap).toBeCloseTo(0.0005, 5);
    const p = m2.geometry.getAttribute('position');
    const si = m2.geometry.getAttribute('skinIndex');
    for (const v of [0, 3]) {
      expect(p.getX(v)).toBe(1);
      expect(si.getX(v)).toBe(0);
    }
    // дальний край не тронут
    expect(p.getX(1)).toBeCloseTo(2);
    expect(si.getX(1)).toBe(1);
  });

  it('далёкие куски не сшиваются', () => {
    const A = new THREE.Bone();
    const st = weldSeams([quad(0, 1, [A], () => 0), quad(1.01, 2, [A], () => 0)], 0.003);
    expect(st.welded).toBe(0);
  });
});

describe('eightInfluences', () => {
  it('восстанавливает долю первой четвёрки после нормировки GLTFLoader', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([0, 1, 0, 0], 4));
    // исходно 0.4 + 0.4 (+ 0.2 во второй четвёрке); загрузчик нормировал к 0.5 + 0.5
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([0.5, 0.5, 0, 0], 4));
    g.setAttribute('joints_1', new THREE.Uint16BufferAttribute([3, 0, 0, 0], 4));
    g.setAttribute('weights_1', new THREE.Float32BufferAttribute([0.2, 0, 0, 0], 4));
    eightInfluences(g);
    const w0 = g.getAttribute('skinWeight');
    const w1 = g.getAttribute('skinWeight1');
    expect(w0.getX(0)).toBeCloseTo(0.4);
    expect(w0.getY(0)).toBeCloseTo(0.4);
    expect(w1.getX(0)).toBeCloseTo(0.2);
    expect(g.getAttribute('skinIndex1').getX(0)).toBe(3);
    expect(g.getAttribute('joints_1')).toBeUndefined();
  });

  it('без второй четвёрки добавляет нулевые веса и не меняет первые', () => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute([2, 0, 0, 0], 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute([1, 0, 0, 0], 4));
    eightInfluences(g);
    expect(g.getAttribute('skinWeight').getX(0)).toBe(1);
    expect(Array.from(g.getAttribute('skinWeight1').array)).toEqual([0, 0, 0, 0]);
  });
});
