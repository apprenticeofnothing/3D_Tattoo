// Exact straightest geodesics on the triangle mesh, traced outward from the
// seed in many directions. Each ray is a straight line in the unfolded
// strip of triangles it crosses, so along it the stencil coordinates are
// known exactly: (r cos theta, r sin theta). Every triangle a ray crosses
// is "unrolled" into the stencil plane by a rigid motion, which gives its
// corner vertices their coordinates. This removes the noise of the
// edge-walking approximation.

import type { SurfaceMesh } from '../mesh/topology';

export interface SeedFrame {
  tri: number;
  point: [number, number, number];
  normal: [number, number, number];
  tangent: [number, number, number];
  bitangent: [number, number, number];
}

/** Edge (min,max) -> the one or two triangles using it. Cached per mesh. */
const edgeCache = new WeakMap<SurfaceMesh, Map<number, [number, number]>>();
function edgeMap(mesh: SurfaceMesh): Map<number, [number, number]> {
  let m = edgeCache.get(mesh);
  if (m) return m;
  m = new Map();
  const I = mesh.indices;
  for (let t = 0; t < I.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + ((k + 1) % 3)];
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a;
      const e = m.get(key);
      if (!e) m.set(key, [t, -1]); else if (e[1] === -1 && e[0] !== t) e[1] = t;
    }
  }
  edgeCache.set(mesh, m);
  return m;
}

export interface RayRefineResult {
  /** Fraction of patch vertices that received ray-based coordinates. */
  coverage: number;
  rays: number;
  /** 1 for every global vertex id that received ray-based coordinates. */
  covered: Uint8Array;
}

/**
 * Overwrite uvx/uvy (indexed by global vertex id) for vertices of `patchVerts`
 * reached by traced geodesics. Vertices not reached keep their values.
 */
export function refineWithRays(
  mesh: SurfaceMesh, seed: SeedFrame, patchVerts: ArrayLike<number>, inPatch: Uint8Array,
  uvx: Float64Array, uvy: Float64Array, radius: number, rayCount?: number,
  onSegment?: (ray: number, tri: number, from: [number, number, number], to: [number, number, number], r0: number, r1: number) => void,
): RayRefineResult {
  const P = mesh.positions, I = mesh.indices;
  const edges = edgeMap(mesh);
  const nV = P.length / 3;

  // Ray count from the median edge length so that every rim triangle is crossed several times.
  let medianEdge = 0.005;
  {
    const lens: number[] = [];
    for (let i = 0; i < patchVerts.length && lens.length < 400; i += Math.max(1, Math.floor(patchVerts.length / 400))) {
      const v = patchVerts[i];
      const k = mesh.adjOffset[v];
      if (k < mesh.adjOffset[v + 1]) {
        const w = mesh.adj[k];
        lens.push(Math.hypot(P[v * 3] - P[w * 3], P[v * 3 + 1] - P[w * 3 + 1], P[v * 3 + 2] - P[w * 3 + 2]));
      }
    }
    lens.sort((a, b) => a - b);
    if (lens.length) medianEdge = lens[lens.length >> 1];
  }
  const M = rayCount ?? Math.min(4096, Math.max(256, Math.ceil((2 * Math.PI * radius) / (0.35 * medianEdge))));

  // Per vertex, up to K clusters of ray contributions. Rays that reach a
  // vertex from different sides of a limb (around the cut locus) land in
  // different clusters; the exponential map takes the shorter side.
  const K = 3;
  const cX = new Float64Array(nV * K), cY = new Float64Array(nV * K), cW = new Float64Array(nV * K);
  const [sx, sy, sz] = seed.point;
  const [tx, ty, tz] = seed.tangent, [bx, by, bz] = seed.bitangent;

  // Scratch for the current triangle's 2D frame.
  let A = [0, 0, 0], e1 = [0, 0, 0], e2 = [0, 0, 0];
  const corner2 = [[0, 0], [0, 0], [0, 0]];
  const cornerId = [0, 0, 0];
  function setTriangle(t: number) {
    const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
    cornerId[0] = a; cornerId[1] = b; cornerId[2] = c;
    A = [P[a * 3], P[a * 3 + 1], P[a * 3 + 2]];
    const ab = [P[b * 3] - A[0], P[b * 3 + 1] - A[1], P[b * 3 + 2] - A[2]];
    const ac = [P[c * 3] - A[0], P[c * 3 + 1] - A[1], P[c * 3 + 2] - A[2]];
    const l1 = Math.hypot(ab[0], ab[1], ab[2]) || 1;
    e1 = [ab[0] / l1, ab[1] / l1, ab[2] / l1];
    let n = [ab[1] * ac[2] - ab[2] * ac[1], ab[2] * ac[0] - ab[0] * ac[2], ab[0] * ac[1] - ab[1] * ac[0]];
    const ln = Math.hypot(n[0], n[1], n[2]) || 1;
    n = [n[0] / ln, n[1] / ln, n[2] / ln];
    // Keep orientation consistent with the smooth normals (handles flipped winding).
    const na = mesh.normals;
    const dot = n[0] * (na[a * 3] + na[b * 3] + na[c * 3]) + n[1] * (na[a * 3 + 1] + na[b * 3 + 1] + na[c * 3 + 1]) + n[2] * (na[a * 3 + 2] + na[b * 3 + 2] + na[c * 3 + 2]);
    if (dot < 0) n = [-n[0], -n[1], -n[2]];
    e2 = [n[1] * e1[2] - n[2] * e1[1], n[2] * e1[0] - n[0] * e1[2], n[0] * e1[1] - n[1] * e1[0]];
    corner2[0][0] = 0; corner2[0][1] = 0;
    corner2[1][0] = ab[0] * e1[0] + ab[1] * e1[1] + ab[2] * e1[2]; corner2[1][1] = ab[0] * e2[0] + ab[1] * e2[1] + ab[2] * e2[2];
    corner2[2][0] = ac[0] * e1[0] + ac[1] * e1[1] + ac[2] * e1[2]; corner2[2][1] = ac[0] * e2[0] + ac[1] * e2[1] + ac[2] * e2[2];
  }
  const to2 = (x: number, y: number, z: number): [number, number] => {
    const dx = x - A[0], dy = y - A[1], dz = z - A[2];
    return [dx * e1[0] + dy * e1[1] + dz * e1[2], dx * e2[0] + dy * e2[1] + dz * e2[2]];
  };
  const to3 = (u: number, v: number): [number, number, number] => [A[0] + u * e1[0] + v * e2[0], A[1] + u * e1[1] + v * e2[1], A[2] + u * e1[2] + v * e2[2]];

  // Contributions farther apart than this belong to different clusters.
  const accept = Math.max(4 * medianEdge, 0.02 * radius);

  /** Record the segment x->e inside the current triangle with stencil radii r0->r1 along direction theta. */
  function record(x2: [number, number], e2d: [number, number], r0: number, r1: number, cosT: number, sinT: number) {
    const dx = e2d[0] - x2[0], dy = e2d[1] - x2[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-7) return;
    // Rigid motion: local 2D -> stencil plane. Rotation aligns the segment direction with (cosT, sinT).
    const ang = Math.atan2(sinT, cosT) - Math.atan2(dy, dx);
    const c = Math.cos(ang), s = Math.sin(ang);
    const ux = r0 * cosT, uy = r0 * sinT; // stencil coords of x
    const w = len;
    for (let k = 0; k < 3; k++) {
      const vid = cornerId[k];
      if (!inPatch[vid]) continue;
      const px = corner2[k][0] - x2[0], py = corner2[k][1] - x2[1];
      const gx = ux + c * px - s * py, gy = uy + s * px + c * py;
      const base = vid * K;
      let j = -1;
      for (let q = 0; q < K; q++) {
        if (cW[base + q] <= 0) continue;
        if (Math.hypot(gx - cX[base + q] / cW[base + q], gy - cY[base + q] / cW[base + q]) <= accept) { j = q; break; }
      }
      if (j < 0) for (let q = 0; q < K; q++) if (cW[base + q] <= 0) { j = q; break; }
      if (j < 0) continue; // more than K sides: ignore
      cX[base + j] += w * gx; cY[base + j] += w * gy; cW[base + j] += w;
    }
  }

  const maxSteps = 100000;
  for (let m = 0; m < M; m++) {
    const theta = (2 * Math.PI * m) / M + 1e-4; // small offset avoids rays exactly along mesh symmetry lines
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    // 3D direction in the seed frame.
    let d3: [number, number, number] = [cosT * tx + sinT * bx, cosT * ty + sinT * by, cosT * tz + sinT * bz];
    let tri = seed.tri;
    let x3: [number, number, number] = [sx, sy, sz];
    let r = 0;
    let entryEdge = -1; // local edge index we came through (k means edge corner k -> k+1)
    for (let step = 0; step < maxSteps; step++) {
      setTriangle(tri);
      // Project the direction into this triangle's plane and normalise.
      let du = d3[0] * e1[0] + d3[1] * e1[1] + d3[2] * e1[2];
      let dv = d3[0] * e2[0] + d3[1] * e2[1] + d3[2] * e2[2];
      const dl = Math.hypot(du, dv);
      if (dl < 1e-12) break;
      du /= dl; dv /= dl;
      const x2 = to2(x3[0], x3[1], x3[2]);
      // Find the exit edge: smallest positive s where x2 + s*d hits edge k.
      let bestS = Infinity, bestK = -1, bestT = 0;
      for (let k = 0; k < 3; k++) {
        if (k === entryEdge) continue;
        const p0 = corner2[k], p1 = corner2[(k + 1) % 3];
        const ex = p1[0] - p0[0], ey = p1[1] - p0[1];
        const den = du * ey - dv * ex;
        if (Math.abs(den) < 1e-14) continue;
        const wx = p0[0] - x2[0], wy = p0[1] - x2[1];
        const s = (wx * ey - wy * ex) / den;
        const tt = (wx * dv - wy * du) / den;
        if (s > -1e-9 && tt >= -1e-6 && tt <= 1 + 1e-6 && s < bestS) { bestS = s; bestK = k; bestT = tt; }
      }
      if (bestK < 0) break;
      bestS = Math.max(0, bestS);
      // Nudge away from vertices so we do not land on a cone point.
      const tcl = Math.min(1 - 1e-4, Math.max(1e-4, bestT));
      const p0 = corner2[bestK], p1 = corner2[(bestK + 1) % 3];
      let exit2: [number, number] = [p0[0] + (p1[0] - p0[0]) * tcl, p0[1] + (p1[1] - p0[1]) * tcl];
      let segLen = Math.hypot(exit2[0] - x2[0], exit2[1] - x2[1]);
      let r1 = r + segLen;
      let finished = false;
      if (r1 >= radius) { // clip
        const f = (radius - r) / (segLen || 1);
        exit2 = [x2[0] + (exit2[0] - x2[0]) * f, x2[1] + (exit2[1] - x2[1]) * f];
        r1 = radius; finished = true;
      }
      record(x2, exit2, r, r1, cosT, sinT);
      if (onSegment) onSegment(m, tri, x3, to3(exit2[0], exit2[1]), r, r1);
      if (finished) break;
      // Cross the edge.
      const va = cornerId[bestK], vb = cornerId[(bestK + 1) % 3];
      const key = va < vb ? va * 4294967296 + vb : vb * 4294967296 + va;
      const pair = edges.get(key);
      const next = pair ? (pair[0] === tri ? pair[1] : pair[0]) : -1;
      if (next < 0) break; // boundary
      // Direction in 3D: component along the edge stays, perpendicular flips into the next triangle.
      const ex3 = [P[vb * 3] - P[va * 3], P[vb * 3 + 1] - P[va * 3 + 1], P[vb * 3 + 2] - P[va * 3 + 2]];
      const el = Math.hypot(ex3[0], ex3[1], ex3[2]) || 1;
      const eh = [ex3[0] / el, ex3[1] / el, ex3[2] / el];
      const dirAlong = (du * (p1[0] - p0[0]) + dv * (p1[1] - p0[1])) / (Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) || 1);
      const perp = Math.sqrt(Math.max(0, 1 - dirAlong * dirAlong));
      const exit3 = to3(exit2[0], exit2[1]);
      // Next triangle's third vertex gives the inward perpendicular.
      const na = I[next * 3], nb = I[next * 3 + 1], nc = I[next * 3 + 2];
      const third = na !== va && na !== vb ? na : nb !== va && nb !== vb ? nb : nc;
      let m3 = [P[third * 3] - P[va * 3], P[third * 3 + 1] - P[va * 3 + 1], P[third * 3 + 2] - P[va * 3 + 2]];
      const md = m3[0] * eh[0] + m3[1] * eh[1] + m3[2] * eh[2];
      m3 = [m3[0] - md * eh[0], m3[1] - md * eh[1], m3[2] - md * eh[2]];
      const ml = Math.hypot(m3[0], m3[1], m3[2]) || 1;
      d3 = [dirAlong * eh[0] + perp * m3[0] / ml, dirAlong * eh[1] + perp * m3[1] / ml, dirAlong * eh[2] + perp * m3[2] / ml];
      // Entry edge index in the next triangle.
      entryEdge = -1;
      for (let k = 0; k < 3; k++) {
        const q0 = I[next * 3 + k], q1 = I[next * 3 + ((k + 1) % 3)];
        if ((q0 === va && q1 === vb) || (q0 === vb && q1 === va)) { entryEdge = k; break; }
      }
      x3 = exit3; r = r1; tri = next;
    }
  }

  let covered = 0;
  const flags = new Uint8Array(nV);
  for (let i = 0; i < patchVerts.length; i++) {
    const v = patchVerts[i];
    const base = v * K;
    let wMax = 0;
    for (let q = 0; q < K; q++) wMax = Math.max(wMax, cW[base + q]);
    if (wMax <= 0) continue;
    // Among well-supported clusters, take the one nearest the seed.
    let bestQ = -1, bestR = Infinity;
    for (let q = 0; q < K; q++) {
      const w = cW[base + q];
      if (w < 0.2 * wMax) continue;
      const r = Math.hypot(cX[base + q] / w, cY[base + q] / w);
      if (r < bestR) { bestR = r; bestQ = q; }
    }
    const w = cW[base + bestQ];
    uvx[v] = cX[base + bestQ] / w; uvy[v] = cY[base + bestQ] / w;
    covered++; flags[v] = 1;
  }
  return { coverage: patchVerts.length ? covered / patchVerts.length : 0, rays: M, covered: flags };
}
