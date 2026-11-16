// Discrete exponential map (Schmidt, Grimm, Wyvill 2006) around a seed
// point on a triangle mesh. Gives each nearby vertex a 2D coordinate in
// metres: distance along the surface and direction, as if a sheet were
// pressed down from the seed outwards. Radial lengths are preserved; on
// doubly curved skin the tangential direction compresses or stretches,
// which is exactly what a paper stencil does.

import type { SurfaceMesh } from '../mesh/topology';
import { refineWithRays } from './geodesicRays';

export interface Seed {
  /** Global triangle index. */
  tri: number;
  /** Point on the triangle (world metres). */
  point: [number, number, number];
  /** Unit surface normal at the point. */
  normal: [number, number, number];
  /** Unit tangent: the direction of the design's +u axis. Must be perpendicular to normal. */
  tangent: [number, number, number];
}

export interface Patch {
  seed: Seed;
  /** Global vertex ids in the patch. */
  verts: Uint32Array;
  /** 2D coordinate per patch vertex (u, v) in metres. */
  uv: Float32Array;
  /** Estimated geodesic distance per patch vertex (metres). */
  dist: Float32Array;
  /** Patch-local index per global vertex, or -1. */
  local: Int32Array;
  /** Global triangle ids with all three corners in the patch. */
  tris: Uint32Array;
  /** Triangles whose uv edges are far longer than their 3D edges (the wrap seam). */
  seamTris: Uint32Array;
  /** The frame actually used (face normal of the seed triangle, re-projected tangent). */
  frame: { normal: [number, number, number]; tangent: [number, number, number]; bitangent: [number, number, number] };
  /** Fraction of vertices with exact (ray traced) coordinates; 0 when exact is off. */
  exactCoverage: number;
}

export interface ExpMapOptions {
  /** Stop expanding beyond this geodesic radius (metres). */
  radius: number;
  /** Jacobi smoothing passes after the initial expansion (default 3). */
  smoothPasses?: number;
  /** Refine with exact geodesic ray tracing (default true). */
  exact?: boolean;
  /** Override the number of traced rays. */
  rays?: number;
}

/** Binary min-heap over (key, value) pairs. */
class Heap {
  keys: number[] = []; vals: number[] = [];
  get size() { return this.keys.length; }
  push(k: number, v: number) {
    const keys = this.keys, vals = this.vals;
    keys.push(k); vals.push(v);
    let i = keys.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (keys[p] <= keys[i]) break; [keys[p], keys[i]] = [keys[i], keys[p]]; [vals[p], vals[i]] = [vals[i], vals[p]]; i = p; }
  }
  pop(): [number, number] {
    const keys = this.keys, vals = this.vals;
    const k = keys[0], v = vals[0];
    const lk = keys.pop()!, lv = vals.pop()!;
    if (keys.length) {
      keys[0] = lk; vals[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < keys.length && keys[l] < keys[m]) m = l;
        if (r < keys.length && keys[r] < keys[m]) m = r;
        if (m === i) break;
        [keys[m], keys[i]] = [keys[i], keys[m]]; [vals[m], vals[i]] = [vals[i], vals[m]]; i = m;
      }
    }
    return [k, v];
  }
}

/** Rotate v by the minimal rotation taking unit normal a onto unit normal b. */
function rotateBetween(vx: number, vy: number, vz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
  let kx = ay * bz - az * by, ky = az * bx - ax * bz, kz = ax * by - ay * bx;
  const s = Math.sqrt(kx * kx + ky * ky + kz * kz);
  const c = ax * bx + ay * by + az * bz;
  if (s < 1e-12) return [vx, vy, vz]; // parallel normals (edges never flip a normal fully)
  kx /= s; ky /= s; kz /= s;
  const dot = kx * vx + ky * vy + kz * vz;
  const crx = ky * vz - kz * vy, cry = kz * vx - kx * vz, crz = kx * vy - ky * vx;
  return [vx * c + crx * s + kx * dot * (1 - c), vy * c + cry * s + ky * dot * (1 - c), vz * c + crz * s + kz * dot * (1 - c)];
}

/** Project v onto the plane with unit normal n and normalise. */
function tangentialise(vx: number, vy: number, vz: number, nx: number, ny: number, nz: number): [number, number, number] {
  const d = vx * nx + vy * ny + vz * nz;
  let x = vx - d * nx, y = vy - d * ny, z = vz - d * nz;
  const l = Math.hypot(x, y, z);
  if (l < 1e-12) { // pick any tangent
    const alt = Math.abs(nx) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    return tangentialise(alt[0], alt[1], alt[2], nx, ny, nz);
  }
  return [x / l, y / l, z / l];
}

export function computeExpMap(mesh: SurfaceMesh, seed: Seed, opts: ExpMapOptions): Patch {
  const { positions: P, normals: N, indices: I, adjOffset, adj } = mesh;
  const nV = P.length / 3;
  const radius = opts.radius;
  // Pull the seed point into the triangle's plane and strictly inside it
  // (a hit exactly on an edge or vertex would make the ray start ambiguous).
  {
    const b = barycentric(mesh, seed.tri, seed.point);
    const eps = 1e-3;
    let b0 = Math.max(eps, b[0]), b1 = Math.max(eps, b[1]), b2 = Math.max(eps, b[2]);
    const sum = b0 + b1 + b2; b0 /= sum; b1 /= sum; b2 /= sum;
    const ia = I[seed.tri * 3] * 3, ib = I[seed.tri * 3 + 1] * 3, ic = I[seed.tri * 3 + 2] * 3;
    seed = { ...seed, point: [
      b0 * P[ia] + b1 * P[ib] + b2 * P[ic],
      b0 * P[ia + 1] + b1 * P[ib + 1] + b2 * P[ic + 1],
      b0 * P[ia + 2] + b1 * P[ib + 2] + b2 * P[ic + 2],
    ] };
  }
  const [px, py, pz] = seed.point;
  // Use the seed triangle's face normal (oriented like the given normal) so
  // the edge-walking and the exact ray tracing share one frame.
  const fa = I[seed.tri * 3] * 3, fb = I[seed.tri * 3 + 1] * 3, fc = I[seed.tri * 3 + 2] * 3;
  const abx = P[fb] - P[fa], aby = P[fb + 1] - P[fa + 1], abz = P[fb + 2] - P[fa + 2];
  const acx = P[fc] - P[fa], acy = P[fc + 1] - P[fa + 1], acz = P[fc + 2] - P[fa + 2];
  let nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
  if (nx * seed.normal[0] + ny * seed.normal[1] + nz * seed.normal[2] < 0) { nx = -nx; ny = -ny; nz = -nz; }
  let [tx, ty, tz] = seed.tangent;
  const td = tx * nx + ty * ny + tz * nz; tx -= td * nx; ty -= td * ny; tz -= td * nz;
  const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; ty /= tl; tz /= tl;
  const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;

  const uvx = new Float64Array(nV), uvy = new Float64Array(nV);
  const sumW = new Float64Array(nV), sumX = new Float64Array(nV), sumY = new Float64Array(nV);
  // Transported design frame per vertex (the seed's +u direction carried along
  // the surface edge by edge). Carrying it step by step keeps the rotation
  // small and well defined even on the far side of a limb, where a direct
  // rotation from the seed normal would be ambiguous.
  const fx = new Float64Array(nV), fy = new Float64Array(nV), fz = new Float64Array(nV);
  const sfx = new Float64Array(nV), sfy = new Float64Array(nV), sfz = new Float64Array(nV);
  const dist = new Float64Array(nV).fill(Infinity);
  const state = new Uint8Array(nV); // 0 untouched, 1 reached, 2 done
  const heap = new Heap();
  const order: number[] = [];

  /** 2D offset of edge vector e measured in the frame carried at vertex q. */
  const offsetInFrame = (ex: number, ey: number, ez: number, q: number): [number, number] => {
    const nqx = N[q * 3], nqy = N[q * 3 + 1], nqz = N[q * 3 + 2];
    const tx1 = fx[q], ty1 = fy[q], tz1 = fz[q];
    const bx1 = nqy * tz1 - nqz * ty1, by1 = nqz * tx1 - nqx * tz1, bz1 = nqx * ty1 - nqy * tx1;
    return [ex * tx1 + ey * ty1 + ez * tz1, ex * bx1 + ey * by1 + ez * bz1];
  };

  // Seed triangle corners: direct projection (they are within one edge of the seed).
  for (let k = 0; k < 3; k++) {
    const v = I[seed.tri * 3 + k];
    const ex = P[v * 3] - px, ey = P[v * 3 + 1] - py, ez = P[v * 3 + 2] - pz;
    const u = ex * tx + ey * ty + ez * tz, w = ex * bx + ey * by + ez * bz;
    uvx[v] = u; uvy[v] = w; dist[v] = Math.hypot(u, w);
    sumW[v] = 1; sumX[v] = u; sumY[v] = w; // anchored
    const fr = rotateBetween(tx, ty, tz, nx, ny, nz, N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
    const ft = tangentialise(fr[0], fr[1], fr[2], N[v * 3], N[v * 3 + 1], N[v * 3 + 2]);
    fx[v] = ft[0]; fy[v] = ft[1]; fz[v] = ft[2];
    sfx[v] = ft[0]; sfy[v] = ft[1]; sfz[v] = ft[2];
    state[v] = 1; heap.push(dist[v], v);
  }

  while (heap.size) {
    const [d, q] = heap.pop();
    if (state[q] === 2 || d > dist[q]) continue;
    if (d > radius) break;
    state[q] = 2; order.push(q);
    const qx = P[q * 3], qy = P[q * 3 + 1], qz = P[q * 3 + 2];
    const nqx = N[q * 3], nqy = N[q * 3 + 1], nqz = N[q * 3 + 2];
    for (let k = adjOffset[q]; k < adjOffset[q + 1]; k++) {
      const r = adj[k];
      if (state[r] === 2) continue;
      const ex = P[r * 3] - qx, ey = P[r * 3 + 1] - qy, ez = P[r * 3 + 2] - qz;
      const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
      if (len === 0) continue;
      const [du, dv] = offsetInFrame(ex, ey, ez, q);
      const cu = uvx[q] + du, cv = uvy[q] + dv;
      // Frame carried from q to r.
      const nrx = N[r * 3], nry = N[r * 3 + 1], nrz = N[r * 3 + 2];
      const fr = rotateBetween(fx[q], fy[q], fz[q], nqx, nqy, nqz, nrx, nry, nrz);
      // Upwind averaging: every finalised neighbour contributes, weighted by 1/edge length.
      // Around a limb the two fronts meet at the back; a candidate far from the
      // current estimate comes from the other side. Keep whichever side is
      // closer to the seed instead of averaging them into nonsense.
      const w = 1 / len;
      if (sumW[r] > 0 && Math.hypot(cu - uvx[r], cv - uvy[r]) > 3 * len + 1e-6) {
        if (Math.hypot(cu, cv) < dist[r] - 1e-9) { sumW[r] = w; sumX[r] = w * cu; sumY[r] = w * cv; sfx[r] = w * fr[0]; sfy[r] = w * fr[1]; sfz[r] = w * fr[2]; }
        else continue;
      } else {
        sumW[r] += w; sumX[r] += w * cu; sumY[r] += w * cv; sfx[r] += w * fr[0]; sfy[r] += w * fr[1]; sfz[r] += w * fr[2];
      }
      uvx[r] = sumX[r] / sumW[r]; uvy[r] = sumY[r] / sumW[r];
      const ft = tangentialise(sfx[r], sfy[r], sfz[r], nrx, nry, nrz);
      fx[r] = ft[0]; fy[r] = ft[1]; fz[r] = ft[2];
      const nd = Math.hypot(uvx[r], uvy[r]);
      if (nd < dist[r]) { dist[r] = nd; state[r] = 1; heap.push(nd, r); }
      else if (state[r] === 1) { dist[r] = nd; heap.push(nd, r); }
    }
  }

  // Optional Jacobi smoothing over all patch neighbours: removes the
  // zig-zag noise of edge paths while keeping the seed corners fixed.
  const inPatch = new Uint8Array(nV);
  for (const v of order) inPatch[v] = 1;
  const anchored = new Uint8Array(nV);
  for (let k = 0; k < 3; k++) anchored[I[seed.tri * 3 + k]] = 1;
  const passes = opts.smoothPasses ?? 3;
  if (passes > 0) {
    const nxu = new Float64Array(nV), nyu = new Float64Array(nV);
    for (let pass = 0; pass < passes; pass++) {
      for (const r of order) {
        if (anchored[r]) { nxu[r] = uvx[r]; nyu[r] = uvy[r]; continue; }
        let sw = 0, sx = 0, sy = 0;
        const rx = P[r * 3], ry = P[r * 3 + 1], rz = P[r * 3 + 2];
        for (let k = adjOffset[r]; k < adjOffset[r + 1]; k++) {
          const q = adj[k];
          if (!inPatch[q]) continue;
          const ex = rx - P[q * 3], ey = ry - P[q * 3 + 1], ez = rz - P[q * 3 + 2];
          const len = Math.sqrt(ex * ex + ey * ey + ez * ez);
          const [du, dv] = offsetInFrame(ex, ey, ez, q);
          const cu = uvx[q] + du, cv = uvy[q] + dv;
          // Skip neighbours across the wrap seam (uv far apart compared to 3D).
          if (Math.hypot(cu - uvx[r], cv - uvy[r]) > 3 * len + 1e-6) continue;
          const w = 1 / len;
          sw += w; sx += w * cu; sy += w * cv;
        }
        if (sw > 0) { nxu[r] = sx / sw; nyu[r] = sy / sw; } else { nxu[r] = uvx[r]; nyu[r] = uvy[r]; }
      }
      for (const r of order) { uvx[r] = nxu[r]; uvy[r] = nyu[r]; }
    }
  }

  // Exact refinement by geodesic ray tracing.
  let exactCoverage = 0;
  if (opts.exact !== false) {
    const res = refineWithRays(mesh, { tri: seed.tri, point: seed.point, normal: [nx, ny, nz], tangent: [tx, ty, tz], bitangent: [bx, by, bz] }, order, inPatch, uvx, uvy, radius, opts.rays);
    exactCoverage = res.coverage;
    // The edge walk is least reliable at the rim and where fronts meet behind a
    // limb. Vertices there that no ray reached are dropped rather than kept
    // with a guessed coordinate.
    if (res.coverage > 0.5) {
      const keep: number[] = [];
      for (const v of order) {
        if (res.covered[v] || anchored[v] || Math.hypot(uvx[v], uvy[v]) < 0.8 * radius) keep.push(v); else inPatch[v] = 0;
      }
      order.length = 0; order.push(...keep);
    }
  }

  // Pack the patch.
  const verts = new Uint32Array(order);
  const local = new Int32Array(nV).fill(-1);
  for (let i = 0; i < verts.length; i++) local[verts[i]] = i;
  const uv = new Float32Array(verts.length * 2);
  const dOut = new Float32Array(verts.length);
  for (let i = 0; i < verts.length; i++) {
    const v = verts[i];
    uv[i * 2] = uvx[v]; uv[i * 2 + 1] = uvy[v];
    dOut[i] = Math.hypot(uvx[v], uvy[v]);
  }
  // Triangles fully inside, split into regular and seam triangles.
  const tris: number[] = [], seam: number[] = [];
  const seenTri = new Uint8Array(I.length / 3);
  for (const v of order) {
    for (let k = mesh.triOffset[v]; k < mesh.triOffset[v + 1]; k++) {
      const t = mesh.vertTris[k];
      if (seenTri[t]) continue;
      seenTri[t] = 1;
      const a = I[t * 3], b = I[t * 3 + 1], c = I[t * 3 + 2];
      if (!inPatch[a] || !inPatch[b] || !inPatch[c]) continue;
      if (isSeam(a, b) || isSeam(b, c) || isSeam(c, a) || isCollapsed(a, b, c)) seam.push(t); else tris.push(t);
    }
  }
  /** uv area wildly different from 3D area: the corners came from different sides of a seam. */
  function isCollapsed(a: number, b: number, c: number): boolean {
    const u1 = uvx[b] - uvx[a], v1 = uvy[b] - uvy[a], u2 = uvx[c] - uvx[a], v2 = uvy[c] - uvy[a];
    const a2 = Math.abs(u1 * v2 - u2 * v1);
    const e1x = P[b * 3] - P[a * 3], e1y = P[b * 3 + 1] - P[a * 3 + 1], e1z = P[b * 3 + 2] - P[a * 3 + 2];
    const e2x = P[c * 3] - P[a * 3], e2y = P[c * 3 + 1] - P[a * 3 + 1], e2z = P[c * 3 + 2] - P[a * 3 + 2];
    const a3 = Math.hypot(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
    return a3 > 0 && (a2 < a3 / 9 || a2 > a3 * 9);
  }
  function isSeam(a: number, b: number): boolean {
    const l3 = Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]);
    const l2 = Math.hypot(uvx[a] - uvx[b], uvy[a] - uvy[b]);
    // More than 2x stretch or 2x compression along an edge is never a real
    // stencil result; the corners came from different sides of a seam.
    return l2 > 2 * l3 + 1e-6 || l2 < 0.5 * l3 - 1e-6;
  }
  return { seed, verts, uv, dist: dOut, local, tris: new Uint32Array(tris), seamTris: new Uint32Array(seam), frame: { normal: [nx, ny, nz], tangent: [tx, ty, tz], bitangent: [bx, by, bz] }, exactCoverage };
}

/** Smooth normal at a barycentric point of a triangle. */
export function normalAt(mesh: SurfaceMesh, tri: number, bary: [number, number, number]): [number, number, number] {
  const I = mesh.indices, N = mesh.normals;
  let x = 0, y = 0, z = 0;
  for (let k = 0; k < 3; k++) {
    const v = I[tri * 3 + k];
    x += N[v * 3] * bary[k]; y += N[v * 3 + 1] * bary[k]; z += N[v * 3 + 2] * bary[k];
  }
  const l = Math.hypot(x, y, z) || 1;
  return [x / l, y / l, z / l];
}

/** Barycentric coordinates of point p in triangle tri (projected onto its plane). */
export function barycentric(mesh: SurfaceMesh, tri: number, p: [number, number, number]): [number, number, number] {
  const I = mesh.indices, P = mesh.positions;
  const a = I[tri * 3] * 3, b = I[tri * 3 + 1] * 3, c = I[tri * 3 + 2] * 3;
  const v0x = P[b] - P[a], v0y = P[b + 1] - P[a + 1], v0z = P[b + 2] - P[a + 2];
  const v1x = P[c] - P[a], v1y = P[c + 1] - P[a + 1], v1z = P[c + 2] - P[a + 2];
  const v2x = p[0] - P[a], v2y = p[1] - P[a + 1], v2z = p[2] - P[a + 2];
  const d00 = v0x * v0x + v0y * v0y + v0z * v0z, d01 = v0x * v1x + v0y * v1y + v0z * v1z, d11 = v1x * v1x + v1y * v1y + v1z * v1z;
  const d20 = v2x * v0x + v2y * v0y + v2z * v0z, d21 = v2x * v1x + v2y * v1y + v2z * v1z;
  const den = d00 * d11 - d01 * d01 || 1e-30;
  const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den;
  return [1 - v - w, v, w];
}

/** A unit tangent perpendicular to n, as close as possible to `prefer` (default world up). */
export function tangentFrom(n: [number, number, number], prefer: [number, number, number] = [0, 1, 0]): [number, number, number] {
  let [x, y, z] = prefer;
  const d = x * n[0] + y * n[1] + z * n[2];
  x -= d * n[0]; y -= d * n[1]; z -= d * n[2];
  let l = Math.hypot(x, y, z);
  if (l < 1e-6) { // prefer is parallel to the normal; pick another axis
    const alt: [number, number, number] = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    return tangentFrom(n, alt);
  }
  return [x / l, y / l, z / l];
}

/** Rotate a tangent about the normal by angle (radians). */
export function rotateTangent(t: [number, number, number], n: [number, number, number], angle: number): [number, number, number] {
  const b: [number, number, number] = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
  const c = Math.cos(angle), s = Math.sin(angle);
  return [t[0] * c + b[0] * s, t[1] * c + b[1] * s, t[2] * c + b[2] * s];
}
