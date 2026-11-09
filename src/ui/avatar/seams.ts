// Сшивка швов кожи. Голова, торс, руки и ноги V — отдельные меши; вершины на их краях
// совпадают лишь приблизительно и весят по-разному, поэтому в позе между кусками
// проступают щели (сквозь них виден фон). Игра закрывает их своим скиннингом, мы —
// подтягиваем краевые вершины к соседнему куску: позиция, нормаль и веса костей.
import * as THREE from 'three';

/** Индексы вершин на открытых краях меша (рёбра, принадлежащие одному треугольнику). */
export function boundaryVertices(g: THREE.BufferGeometry): number[] {
  const pos = g.getAttribute('position');
  const idx = g.index;
  const tris = idx ? idx.count : pos.count;
  // Вершины, разрезанные по UV, сводим к одной по позиции — иначе UV-швы сочтутся краями
  const canon = new Int32Array(pos.count);
  const byKey = new Map<string, number>();
  for (let v = 0; v < pos.count; v++) {
    const key = `${Math.round(pos.getX(v) * 1e5)},${Math.round(pos.getY(v) * 1e5)},${Math.round(pos.getZ(v) * 1e5)}`;
    const c = byKey.get(key);
    if (c === undefined) {
      byKey.set(key, v);
      canon[v] = v;
    } else canon[v] = c;
  }
  const edges = new Map<string, number>();
  const at = (i: number) => canon[idx ? idx.getX(i) : i];
  for (let t = 0; t + 2 < tris; t += 3) {
    const a = at(t), b = at(t + 1), c = at(t + 2);
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      if (p === q) continue;
      const key = p < q ? `${p}_${q}` : `${q}_${p}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  const open = new Set<number>();
  for (const [key, n] of edges) {
    if (n !== 1) continue;
    const [p, q] = key.split('_').map(Number);
    open.add(p);
    open.add(q);
  }
  const out: number[] = [];
  for (let v = 0; v < pos.count; v++) if (open.has(canon[v])) out.push(v);
  return out;
}

export interface WeldStats {
  welded: number;
  maxGap: number;
}

/**
 * Сшить края кусков. Порядок важен: первый меш — «главный», края следующих подтягиваются
 * к уже учтённым. Вершины ближе tol (м) считаются одним швом. Дельты морфов у
 * подтянутых вершин обнуляются, если у главного куска их нет: шов не расходится,
 * когда лицо меняет форму.
 */
export function weldSeams(meshes: THREE.SkinnedMesh[], tol = 0.003): WeldStats {
  const CELL = tol * 2;
  interface Rep {
    mesh: THREE.SkinnedMesh;
    v: number;
    x: number;
    y: number;
    z: number;
  }
  const grid = new Map<string, Rep[]>();
  const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)},${Math.floor(z / CELL)}`;
  const stats: WeldStats = { welded: 0, maxGap: 0 };
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const nrm = g.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const si = g.getAttribute('skinIndex') as THREE.BufferAttribute | undefined;
    const sw = g.getAttribute('skinWeight') as THREE.BufferAttribute | undefined;
    const boneIndex = new Map<THREE.Bone, number>();
    mesh.skeleton?.bones.forEach((b, i) => boneIndex.set(b, i));
    const own: Rep[] = [];
    for (const v of boundaryVertices(g)) {
      const x = pos.getX(v), y = pos.getY(v), z = pos.getZ(v);
      const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL), cz = Math.floor(z / CELL);
      let best: Rep | null = null;
      let bd = tol * tol;
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++)
          for (let k = -1; k <= 1; k++)
            for (const r of grid.get(`${cx + i},${cy + j},${cz + k}`) ?? []) {
              if (r.mesh === mesh) continue;
              const d = (r.x - x) ** 2 + (r.y - y) ** 2 + (r.z - z) ** 2;
              if (d <= bd) (bd = d), (best = r);
            }
      if (!best) {
        own.push({ mesh, v, x, y, z });
        continue;
      }
      stats.welded++;
      stats.maxGap = Math.max(stats.maxGap, Math.sqrt(bd));
      const rg = best.mesh.geometry;
      pos.setXYZ(v, best.x, best.y, best.z);
      const rn = rg.getAttribute('normal');
      if (nrm && rn) nrm.setXYZ(v, rn.getX(best.v), rn.getY(best.v), rn.getZ(best.v));
      // Веса (до 8 костей): кости главного куска переводим в индексы своего скелета
      const rBones = best.mesh.skeleton?.bones;
      const sets = (geo: THREE.BufferGeometry) =>
        [
          [geo.getAttribute('skinIndex'), geo.getAttribute('skinWeight')],
          [geo.getAttribute('skinIndex1'), geo.getAttribute('skinWeight1')],
        ].filter(([i, w]) => i && w) as [THREE.BufferAttribute, THREE.BufferAttribute][];
      const mineSets = sets(g);
      const repSets = sets(rg);
      if (si && sw && rBones && mineSets.length === repSets.length) {
        const plan: [THREE.BufferAttribute, THREE.BufferAttribute, number, number, number][] = [];
        let ok = true;
        repSets.forEach(([ri, rw], s) => {
          for (let c = 0; c < 4; c++) {
            const wt = rw.getComponent(best.v, c);
            const b = rBones[ri.getComponent(best.v, c)];
            const mine = b ? boneIndex.get(b) : undefined;
            if (wt > 0 && mine === undefined) ok = false;
            plan.push([mineSets[s][0], mineSets[s][1], c, mine ?? 0, wt]);
          }
        });
        if (ok)
          for (const [ia, wa, c, i, w] of plan) {
            ia.setComponent(v, c, i);
            wa.setComponent(v, c, w);
          }
      }
      // Морфы: у одноимённой цели главного куска берём его дельту, иначе дельта 0
      const morphs = g.morphAttributes.position;
      if (morphs?.length) {
        const rv = best.v;
        const rDict = best.mesh.morphTargetDictionary ?? {};
        const rMorphs = rg.morphAttributes.position ?? [];
        const names = Object.entries(mesh.morphTargetDictionary ?? {});
        morphs.forEach((a, i) => {
          const n = names.find(([, k]) => k === i)?.[0];
          const ri = n === undefined ? undefined : rDict[n];
          const ra = ri === undefined ? undefined : rMorphs[ri];
          if (ra) a.setXYZ(v, ra.getX(rv), ra.getY(rv), ra.getZ(rv));
          else a.setXYZ(v, 0, 0, 0);
        });
      }
    }
    for (const r of own) {
      const key = cellKey(r.x, r.y, r.z);
      const cell = grid.get(key);
      if (cell) cell.push(r);
      else grid.set(key, [r]);
    }
    for (const name of ['position', 'normal', 'skinIndex', 'skinWeight', 'skinIndex1', 'skinWeight1']) {
      const a = g.getAttribute(name);
      if (a) a.needsUpdate = true;
    }
    for (const a of g.morphAttributes.position ?? []) a.needsUpdate = true;
  }
  return stats;
}
