import { describe, expect, it } from 'vitest';
import { applyStencil, buildCatmullClark, quadsToTriangles } from '../src/mesh/subdivide';
import { checkManifold, signedVolume } from '../src/mesh/marchingCubes';

// Unit cube, outward-facing quads.
const cubeV = [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1];
const cubeQ = [0, 3, 2, 1, 4, 5, 6, 7, 0, 1, 5, 4, 2, 3, 7, 6, 1, 2, 6, 5, 0, 4, 7, 3];

describe('Catmull–Clark stencil', () => {
  it('subdivides a cube into 24 quads and 26 vertices with textbook positions', () => {
    const st = buildCatmullClark(cubeQ, 8);
    expect(st.fineCount).toBe(26);
    expect(st.quads.length / 4).toBe(24);
    const p = applyStencil(st, cubeV, 3);
    // Corner vertex of a cube after one step: (F + 2R + (n-3)P)/n with n = 3
    // F = mean of 3 face centres = (1/3,1/3,1/3)*(-1) ... known result: 5/9 of the corner.
    expect(p[0]).toBeCloseTo(-5 / 9, 6);
    expect(p[1]).toBeCloseTo(-5 / 9, 6);
    expect(p[2]).toBeCloseTo(-5 / 9, 6);
    // Each row of weights sums to 1 (affine invariance).
    for (let i = 0; i < st.fineCount; i++) {
      let s = 0;
      for (let k = st.offsets[i]; k < st.offsets[i + 1]; k++) s += st.weights[k];
      expect(s).toBeCloseTo(1, 6);
    }
  });

  it('keeps a closed mesh closed and consistently oriented, shrinking towards a sphere', () => {
    let q: ArrayLike<number> = cubeQ, v: ArrayLike<number> = cubeV, n = 8;
    let prevVol = 8;
    for (let level = 0; level < 3; level++) {
      const st = buildCatmullClark(q, n);
      v = applyStencil(st, v, 3); q = st.quads; n = st.fineCount;
      const tris = quadsToTriangles(q);
      const rep = checkManifold({ positions: Float32Array.from(v), indices: tris });
      expect(rep.boundaryEdges).toBe(0);
      expect(rep.nonManifoldEdges).toBe(0);
      expect(rep.inconsistentEdges).toBe(0);
      const vol = signedVolume({ positions: Float32Array.from(v), indices: tris });
      expect(vol).toBeGreaterThan(0);
      expect(vol).toBeLessThan(prevVol);
      prevVol = vol;
    }
    // Converges: later steps change the volume less and less.
    const st4 = buildCatmullClark(q, n);
    const v4 = applyStencil(st4, v, 3);
    const vol4 = signedVolume({ positions: v4, indices: quadsToTriangles(st4.quads) });
    expect(prevVol - vol4).toBeGreaterThan(0);
    expect(prevVol - vol4).toBeLessThan(0.05 * prevVol);
  });

  it('gives the bicubic B-spline weights at a regular interior vertex', () => {
    const N = 4, q: number[] = [];
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i; q.push(a, a + 1, a + N + 2, a + N + 1); }
    const st = buildCatmullClark(q, (N + 1) * (N + 1));
    const c = 2 * (N + 1) + 2; // centre vertex of the 5x5 grid
    const w = new Map<number, number>();
    for (let k = st.offsets[c]; k < st.offsets[c + 1]; k++) w.set(st.indices[k], st.weights[k]);
    expect(w.get(c)).toBeCloseTo(9 / 16, 6);
    for (const d of [-1, 1, -(N + 1), N + 1]) expect(w.get(c + d)).toBeCloseTo(3 / 32, 6);
    for (const d of [-(N + 2), -N, N, N + 2]) expect(w.get(c + d)).toBeCloseTo(1 / 64, 6);
  });

  it('keeps a flat grid flat (with boundary rules)', () => {
    const N = 4, v: number[] = [], q: number[] = [];
    for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) v.push(i, j, 0);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) { const a = j * (N + 1) + i; q.push(a, a + 1, a + N + 2, a + N + 1); }
    const st = buildCatmullClark(q, (N + 1) * (N + 1));
    const p = applyStencil(st, v, 3);
    for (let i = 0; i < st.fineCount; i++) expect(Math.abs(p[i * 3 + 2])).toBeLessThan(1e-9);
    const rep = checkManifold({ positions: p, indices: quadsToTriangles(st.quads) });
    expect(rep.nonManifoldEdges).toBe(0);
    expect(rep.inconsistentEdges).toBe(0);
  });
});
