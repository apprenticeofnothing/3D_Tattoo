// Inverse of the patch map: design plane (u, v) in metres -> point on the
// surface. Used to measure how long a design curve is on the skin.

import type { SurfaceMesh } from '../mesh/topology';
import type { Patch } from './expmap';

export class PatchLocator {
  private cell: number;
  private minU: number; private minV: number; private nx: number; private ny: number;
  private buckets: Int32Array[]; // triangle indices (into patch.tris) per cell

  constructor(private mesh: SurfaceMesh, private patch: Patch, cells = 64) {
    let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity;
    for (let i = 0; i < patch.uv.length; i += 2) {
      minU = Math.min(minU, patch.uv[i]); maxU = Math.max(maxU, patch.uv[i]);
      minV = Math.min(minV, patch.uv[i + 1]); maxV = Math.max(maxV, patch.uv[i + 1]);
    }
    this.cell = Math.max(maxU - minU, maxV - minV) / cells || 1;
    this.minU = minU; this.minV = minV;
    this.nx = Math.ceil((maxU - minU) / this.cell) + 1; this.ny = Math.ceil((maxV - minV) / this.cell) + 1;
    const lists: number[][] = Array.from({ length: this.nx * this.ny }, () => []);
    const I = mesh.indices;
    for (let i = 0; i < patch.tris.length; i++) {
      const t = patch.tris[i];
      let lo = Infinity, hi = -Infinity, lov = Infinity, hiv = -Infinity;
      for (let k = 0; k < 3; k++) {
        const l = patch.local[I[t * 3 + k]];
        lo = Math.min(lo, patch.uv[l * 2]); hi = Math.max(hi, patch.uv[l * 2]);
        lov = Math.min(lov, patch.uv[l * 2 + 1]); hiv = Math.max(hiv, patch.uv[l * 2 + 1]);
      }
      const x0 = this.ix(lo), x1 = this.ix(hi), y0 = this.iy(lov), y1 = this.iy(hiv);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) lists[y * this.nx + x].push(i);
    }
    this.buckets = lists.map((l) => Int32Array.from(l));
  }
  private ix(u: number) { return Math.min(this.nx - 1, Math.max(0, Math.floor((u - this.minU) / this.cell))); }
  private iy(v: number) { return Math.min(this.ny - 1, Math.max(0, Math.floor((v - this.minV) / this.cell))); }

  /** 3D point for a design-plane coordinate, or null if outside the patch. */
  locate(u: number, v: number): [number, number, number] | null {
    return this.locateTri(u, v)?.point ?? null;
  }

  /** 3D point and the triangle it lies in, or null if outside the patch. */
  locateTri(u: number, v: number): { point: [number, number, number]; tri: number; bary: [number, number, number] } | null {
    const list = this.buckets[this.iy(v) * this.nx + this.ix(u)];
    const I = this.mesh.indices, P = this.mesh.positions, uv = this.patch.uv, local = this.patch.local;
    for (let n = 0; n < list.length; n++) {
      const t = this.patch.tris[list[n]];
      const a = local[I[t * 3]], b = local[I[t * 3 + 1]], c = local[I[t * 3 + 2]];
      const ax = uv[a * 2], ay = uv[a * 2 + 1], bx = uv[b * 2], by = uv[b * 2 + 1], cx = uv[c * 2], cy = uv[c * 2 + 1];
      const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(det) < 1e-20) continue;
      const l1 = ((bx - u) * (cy - v) - (cx - u) * (by - v)) / det;
      const l2 = ((cx - u) * (ay - v) - (ax - u) * (cy - v)) / det;
      const l3 = 1 - l1 - l2;
      const eps = -1e-6;
      if (l1 < eps || l2 < eps || l3 < eps) continue;
      const ga = I[t * 3] * 3, gb = I[t * 3 + 1] * 3, gc = I[t * 3 + 2] * 3;
      return { tri: t, bary: [l1, l2, l3], point: [
        l1 * P[ga] + l2 * P[gb] + l3 * P[gc],
        l1 * P[ga + 1] + l2 * P[gb + 1] + l3 * P[gc + 1],
        l1 * P[ga + 2] + l2 * P[gb + 2] + l3 * P[gc + 2],
      ] };
    }
    return null;
  }

  /** Length on the surface of a design-plane polyline (metres). Null if any point is outside. */
  curveLength(points: ArrayLike<number>): number | null {
    let prev: [number, number, number] | null = null, len = 0;
    for (let i = 0; i < points.length; i += 2) {
      const p = this.locate(points[i], points[i + 1]);
      if (!p) return null;
      if (prev) len += Math.hypot(p[0] - prev[0], p[1] - prev[1], p[2] - prev[2]);
      prev = p;
    }
    return len;
  }
}
