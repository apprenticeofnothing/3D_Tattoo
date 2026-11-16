// Marching cubes over a scalar field sampled on a regular, non-cubic grid.
// Produces an indexed triangle mesh (shared vertices), so it is suitable for
// downstream mesh processing (geodesics, flattening), not only for display.
//
// Convention: the surface is where field == 0; field < 0 is inside.
// Triangles are wound so that normals point outward (toward positive field).

import { edgeTable, triTable } from './mcTables';

export interface GridSpec {
  /** Number of samples along x, y, z (not cells). */
  nx: number;
  ny: number;
  nz: number;
  /** World position of sample (0,0,0). */
  origin: [number, number, number];
  /** Spacing between samples along each axis (metres). */
  cell: [number, number, number];
}

export interface IndexedMesh {
  positions: Float32Array; // xyz per vertex
  indices: Uint32Array; // 3 per triangle
}

/** Sample a scalar function onto a grid. */
export function sampleField(grid: GridSpec, f: (x: number, y: number, z: number) => number): Float32Array {
  const { nx, ny, nz, origin, cell } = grid;
  const field = new Float32Array(nx * ny * nz);
  let i = 0;
  for (let k = 0; k < nz; k++) {
    const z = origin[2] + k * cell[2];
    for (let j = 0; j < ny; j++) {
      const y = origin[1] + j * cell[1];
      for (let ii = 0; ii < nx; ii++) {
        field[i++] = f(origin[0] + ii * cell[0], y, z);
      }
    }
  }
  return field;
}

// Edge table from the standard marching cubes convention (Bourke):
// cube corners 0..7, edge e connects cornerA[e] -> cornerB[e].
const cornerOffset: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
  [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
];
const edgeCorners: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 0],
  [4, 5], [5, 6], [6, 7], [7, 4],
  [0, 4], [1, 5], [2, 6], [3, 7],
];
// For vertex sharing: each edge is identified by the sample at its lower
// corner and the axis it runs along (0=x, 1=y, 2=z).
const edgeAxis = [0, 1, 0, 1, 0, 1, 0, 1, 2, 2, 2, 2];
const edgeBase: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [0, 0, 1],
  [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
];

/** Polygonise a sampled field at iso-level 0. */
export function marchingCubes(grid: GridSpec, field: Float32Array, iso = 0): IndexedMesh {
  const { nx, ny, nz, origin, cell } = grid;
  if (field.length !== nx * ny * nz) throw new Error('field size does not match grid');
  const n = nx * ny * nz;
  // Vertex index per (sample, axis); -1 = not yet created.
  const edgeVert = new Int32Array(n * 3).fill(-1);
  const positions: number[] = [];
  const indices: number[] = [];
  const sIdx = (i: number, j: number, k: number) => i + nx * (j + ny * k);
  const cornerVal = new Float64Array(8);
  const vertOfEdge = new Int32Array(12);

  const vertexOnEdge = (i: number, j: number, k: number, e: number): number => {
    const b = edgeBase[e];
    const bi = i + b[0], bj = j + b[1], bk = k + b[2];
    const key = sIdx(bi, bj, bk) * 3 + edgeAxis[e];
    let v = edgeVert[key];
    if (v >= 0) return v;
    const [ca, cb] = edgeCorners[e];
    const va = cornerVal[ca], vb = cornerVal[cb];
    let t = (iso - va) / (vb - va);
    if (!Number.isFinite(t)) t = 0.5;
    t = Math.min(1, Math.max(0, t));
    const oa = cornerOffset[ca], ob = cornerOffset[cb];
    const x = origin[0] + (i + oa[0] + (ob[0] - oa[0]) * t) * cell[0];
    const y = origin[1] + (j + oa[1] + (ob[1] - oa[1]) * t) * cell[1];
    const z = origin[2] + (k + oa[2] + (ob[2] - oa[2]) * t) * cell[2];
    v = positions.length / 3;
    positions.push(x, y, z);
    edgeVert[key] = v;
    return v;
  };

  for (let k = 0; k < nz - 1; k++) {
    for (let j = 0; j < ny - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        let cubeIndex = 0;
        for (let c = 0; c < 8; c++) {
          const o = cornerOffset[c];
          const v = field[sIdx(i + o[0], j + o[1], k + o[2])];
          cornerVal[c] = v;
          if (v < iso) cubeIndex |= 1 << c;
        }
        const bits = edgeTable[cubeIndex];
        if (bits === 0) continue;
        for (let e = 0; e < 12; e++) {
          if (bits & (1 << e)) vertOfEdge[e] = vertexOnEdge(i, j, k, e);
        }
        const base = cubeIndex * 16;
        for (let t = 0; triTable[base + t] !== -1; t += 3) {
          const a = vertOfEdge[triTable[base + t]];
          const b = vertOfEdge[triTable[base + t + 1]];
          const c = vertOfEdge[triTable[base + t + 2]];
          if (a === b || b === c || a === c) continue; // degenerate
          indices.push(a, c, b); // swapped so normals point toward positive field
        }
      }
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) };
}

/** Per-vertex area-weighted normals. */
export function computeNormals(mesh: IndexedMesh): Float32Array {
  const { positions: p, indices: idx } = mesh;
  const nrm = new Float32Array(p.length);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const v of [a, b, c]) { nrm[v] += nx; nrm[v + 1] += ny; nrm[v + 2] += nz; }
  }
  for (let v = 0; v < nrm.length; v += 3) {
    const l = Math.hypot(nrm[v], nrm[v + 1], nrm[v + 2]) || 1;
    nrm[v] /= l; nrm[v + 1] /= l; nrm[v + 2] /= l;
  }
  return nrm;
}

/** Total surface area in m^2. */
export function surfaceArea(mesh: IndexedMesh): number {
  const { positions: p, indices: idx } = mesh;
  let area = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    area += 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
  }
  return area;
}

/** Signed volume via divergence theorem; positive for outward-wound closed meshes. */
export function signedVolume(mesh: IndexedMesh): number {
  const { positions: p, indices: idx } = mesh;
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    vol += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return vol;
}

export interface ManifoldReport {
  edges: number;
  boundaryEdges: number; // edges used by exactly one triangle
  nonManifoldEdges: number; // edges used by three or more triangles
  inconsistentEdges: number; // edges used twice in the same direction (flipped triangle)
}

/** Check edge manifoldness and consistent winding. */
export function checkManifold(mesh: IndexedMesh): ManifoldReport {
  const { indices: idx } = mesh;
  const count = new Map<number, number>(); // undirected edge -> uses
  const dir = new Map<number, number>(); // directed edge -> uses
  const key = (a: number, b: number) => a * 4294967296 + b; // safe below 2^21 verts
  for (let t = 0; t < idx.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = idx[t + e], b = idx[t + ((e + 1) % 3)];
      const u = a < b ? key(a, b) : key(b, a);
      count.set(u, (count.get(u) ?? 0) + 1);
      const d = key(a, b);
      dir.set(d, (dir.get(d) ?? 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0;
  for (const c of count.values()) {
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
  }
  let inconsistent = 0;
  for (const c of dir.values()) if (c > 1) inconsistent++;
  return { edges: count.size, boundaryEdges: boundary, nonManifoldEdges: nonManifold, inconsistentEdges: inconsistent };
}
