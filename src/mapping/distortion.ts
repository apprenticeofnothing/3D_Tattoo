// Per-triangle stretch of the design-to-skin map. The map sends design
// plane coordinates (metres) to the 3D surface; its Jacobian's singular
// values are the principal length ratios. 1.0 means lengths preserved,
// 1.05 means 5% stretch (stencil would tear), 0.95 means 5% compression
// (stencil would wrinkle).

import type { SurfaceMesh } from '../mesh/topology';
import type { Patch } from './expmap';

export interface TriangleStretch {
  /** Larger principal stretch (>= smaller). */
  sMax: Float32Array;
  /** Smaller principal stretch. */
  sMin: Float32Array;
  /** Area ratio surface/design per triangle. */
  area: Float32Array;
}

/** Principal stretches for each triangle of the patch (same order as patch.tris). */
export function triangleStretch(mesh: SurfaceMesh, patch: Patch): TriangleStretch {
  const { positions: P, indices: I } = mesh;
  const n = patch.tris.length;
  const sMax = new Float32Array(n), sMin = new Float32Array(n), area = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = patch.tris[i];
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const la = patch.local[a], lb = patch.local[b], lc = patch.local[c];
    // 2D edges
    const u1 = patch.uv[lb * 2] - patch.uv[la * 2], v1 = patch.uv[lb * 2 + 1] - patch.uv[la * 2 + 1];
    const u2 = patch.uv[lc * 2] - patch.uv[la * 2], v2 = patch.uv[lc * 2 + 1] - patch.uv[la * 2 + 1];
    // 3D edges
    const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    // Jacobian J (3x2) with J * [u1 u2; v1 v2] = [e1 e2]  =>  J = E * inv(U)
    const det = u1 * v2 - u2 * v1;
    if (Math.abs(det) < 1e-18) { sMax[i] = sMin[i] = area[i] = NaN; continue; }
    const iu = [v2 / det, -u2 / det, -v1 / det, u1 / det]; // inv(U) = [[v2,-u2],[-v1,u1]]/det
    // J columns: J1 = e1*iu[0] + e2*iu[2], J2 = e1*iu[1] + e2*iu[3]
    const J1 = [e1[0] * iu[0] + e2[0] * iu[2], e1[1] * iu[0] + e2[1] * iu[2], e1[2] * iu[0] + e2[2] * iu[2]];
    const J2 = [e1[0] * iu[1] + e2[0] * iu[3], e1[1] * iu[1] + e2[1] * iu[3], e1[2] * iu[1] + e2[2] * iu[3]];
    // Singular values of J from the 2x2 metric G = J^T J.
    const g11 = J1[0] * J1[0] + J1[1] * J1[1] + J1[2] * J1[2];
    const g22 = J2[0] * J2[0] + J2[1] * J2[1] + J2[2] * J2[2];
    const g12 = J1[0] * J2[0] + J1[1] * J2[1] + J1[2] * J2[2];
    const tr = g11 + g22, dt = g11 * g22 - g12 * g12;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - dt));
    const l1 = tr / 2 + disc, l2 = Math.max(0, tr / 2 - disc);
    sMax[i] = Math.sqrt(l1); sMin[i] = Math.sqrt(l2);
    area[i] = Math.sqrt(Math.max(0, dt));
  }
  return { sMax, sMin, area };
}

export interface StretchSummary {
  /** Worst stretch (max of sMax - 1) and worst compression (min of sMin - 1), as fractions. */
  worstStretch: number;
  worstCompression: number;
  /** Fraction of design area where |stretch| exceeds the threshold. */
  areaOverThreshold: number;
  triangles: number;
}

export function summarize(ts: TriangleStretch, mesh: SurfaceMesh, patch: Patch, threshold = 0.05, vs?: VertexStretch): StretchSummary {
  let worstStretch = 0, worstCompression = 0, bad = 0, total = 0;
  const { positions: P, indices: I } = mesh;
  for (let i = 0; i < patch.tris.length; i++) {
    const t = patch.tris[i];
    let sMaxT = ts.sMax[i], sMinT = ts.sMin[i];
    if (vs) {
      // Ring-averaged values are the physical ones; single triangles jitter.
      let a = 0, b = 0, n = 0;
      for (let k = 0; k < 3; k++) {
        const l = patch.local[I[t * 3 + k]];
        if (l >= 0 && Number.isFinite(vs.sMax[l])) { a += vs.sMax[l]; b += vs.sMin[l]; n++; }
      }
      if (n) { sMaxT = a / n; sMinT = b / n; }
    }
    if (!Number.isFinite(sMaxT)) continue;
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const e1x = P[b] - P[a], e1y = P[b + 1] - P[a + 1], e1z = P[b + 2] - P[a + 2];
    const e2x = P[c] - P[a], e2y = P[c + 1] - P[a + 1], e2z = P[c + 2] - P[a + 2];
    const ar = 0.5 * Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    total += ar;
    worstStretch = Math.max(worstStretch, sMaxT - 1);
    worstCompression = Math.min(worstCompression, sMinT - 1);
    if (sMaxT - 1 > threshold || 1 - sMinT > threshold) bad += ar;
  }
  return { worstStretch, worstCompression, areaOverThreshold: total > 0 ? bad / total : 0, triangles: patch.tris.length };
}

export interface VertexStretch {
  /** Per patch vertex: larger and smaller principal stretch of the ring-averaged metric. */
  sMax: Float32Array;
  sMin: Float32Array;
}

/**
 * Per-vertex principal stretches from the area-weighted average of the
 * metric tensor over the triangles within `rings` of each patch vertex.
 * Single triangles are noisy (the map is unbiased but its discretisation
 * jitters); averaging over a few millimetres gives the physical answer.
 */
export function vertexStretch(mesh: SurfaceMesh, patch: Patch, rings = 2): VertexStretch {
  const { positions: P, indices: I } = mesh;
  const nT = patch.tris.length, nV = patch.verts.length;
  // Metric per triangle in uv basis, area weighted.
  const g11 = new Float64Array(nT), g12 = new Float64Array(nT), g22 = new Float64Array(nT), w = new Float64Array(nT);
  const triLocal = new Int32Array(I.length / 3).fill(-1);
  for (let i = 0; i < nT; i++) {
    const t = patch.tris[i];
    triLocal[t] = i;
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    const la = patch.local[a], lb = patch.local[b], lc = patch.local[c];
    const u1 = patch.uv[lb * 2] - patch.uv[la * 2], v1 = patch.uv[lb * 2 + 1] - patch.uv[la * 2 + 1];
    const u2 = patch.uv[lc * 2] - patch.uv[la * 2], v2 = patch.uv[lc * 2 + 1] - patch.uv[la * 2 + 1];
    const e1 = [P[b * 3] - P[a * 3], P[b * 3 + 1] - P[a * 3 + 1], P[b * 3 + 2] - P[a * 3 + 2]];
    const e2 = [P[c * 3] - P[a * 3], P[c * 3 + 1] - P[a * 3 + 1], P[c * 3 + 2] - P[a * 3 + 2]];
    const det = u1 * v2 - u2 * v1;
    if (Math.abs(det) < 1e-18) continue;
    const iu = [v2 / det, -u2 / det, -v1 / det, u1 / det];
    const J1 = [e1[0] * iu[0] + e2[0] * iu[2], e1[1] * iu[0] + e2[1] * iu[2], e1[2] * iu[0] + e2[2] * iu[2]];
    const J2 = [e1[0] * iu[1] + e2[0] * iu[3], e1[1] * iu[1] + e2[1] * iu[3], e1[2] * iu[1] + e2[2] * iu[3]];
    const area = 0.5 * Math.abs(det);
    g11[i] = (J1[0] * J1[0] + J1[1] * J1[1] + J1[2] * J1[2]);
    g22[i] = (J2[0] * J2[0] + J2[1] * J2[1] + J2[2] * J2[2]);
    g12[i] = (J1[0] * J2[0] + J1[1] * J2[1] + J1[2] * J2[2]);
    w[i] = area;
  }
  const sMax = new Float32Array(nV), sMin = new Float32Array(nV);
  const mark = new Int32Array(mesh.positions.length / 3).fill(-1);
  let frontier: number[] = [], next: number[] = [];
  for (let i = 0; i < nV; i++) {
    const v0 = patch.verts[i];
    // Collect vertices within `rings` hops (inside the patch).
    frontier = [v0]; mark[v0] = i;
    const ring: number[] = [v0];
    for (let r = 0; r < rings; r++) {
      next = [];
      for (const v of frontier) {
        for (let k = mesh.adjOffset[v]; k < mesh.adjOffset[v + 1]; k++) {
          const n = mesh.adj[k];
          if (mark[n] === i || patch.local[n] < 0) continue;
          mark[n] = i; next.push(n); ring.push(n);
        }
      }
      frontier = next;
    }
    // Average metric over triangles touching the ring vertices.
    let a11 = 0, a12 = 0, a22 = 0, aw = 0;
    const seen = new Set<number>();
    for (const v of ring) {
      for (let k = mesh.triOffset[v]; k < mesh.triOffset[v + 1]; k++) {
        const t = mesh.vertTris[k];
        const li = triLocal[t];
        if (li < 0 || seen.has(li)) continue;
        seen.add(li);
        a11 += g11[li] * w[li]; a12 += g12[li] * w[li]; a22 += g22[li] * w[li]; aw += w[li];
      }
    }
    if (aw === 0) { sMax[i] = sMin[i] = NaN; continue; }
    a11 /= aw; a12 /= aw; a22 /= aw;
    const tr = a11 + a22, dt = a11 * a22 - a12 * a12;
    const disc = Math.sqrt(Math.max(0, tr * tr / 4 - dt));
    sMax[i] = Math.sqrt(tr / 2 + disc); sMin[i] = Math.sqrt(Math.max(0, tr / 2 - disc));
  }
  return { sMax, sMin };
}
