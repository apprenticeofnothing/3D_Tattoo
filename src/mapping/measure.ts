// Tape measure on the skin: geodesic distance between two points (via the
// exponential map from the first point) and the circumference of a limb
// through a point (plane section perpendicular to the local limb axis).

import type { SurfaceMesh } from '../mesh/topology';
import { barycentric, computeExpMap, normalAt, tangentFrom } from './expmap';
import { PatchLocator } from './locate';
import { sectionLoop } from './section';

export interface SurfacePoint { tri: number; point: [number, number, number] }

export interface DistanceResult {
  /** Along the skin, metres. */
  geodesic: number;
  /** Straight line through the air, metres. */
  straight: number;
  /** Polyline of the shortest path on the skin (world metres). */
  path: Array<[number, number, number]>;
}

/** Shortest distance along the skin from a to b, or null if b is beyond the mapped patch. */
export function distanceOnSkin(surface: SurfaceMesh, a: SurfacePoint, b: SurfacePoint, display?: Float32Array): DistanceResult | null {
  const straight = Math.hypot(b.point[0] - a.point[0], b.point[1] - a.point[1], b.point[2] - a.point[2]);
  const normal = normalAt(surface, a.tri, barycentric(surface, a.tri, a.point));
  const tangent = tangentFrom(normal, [0, 1, 0]);
  // The skin path can be a good deal longer than the straight line around a limb.
  const radius = Math.min(2.5, straight * 1.8 + 0.05);
  const patch = computeExpMap(surface, { tri: a.tri, point: a.point, normal, tangent }, { radius });
  const I = surface.indices;
  const l = [patch.local[I[b.tri * 3]], patch.local[I[b.tri * 3 + 1]], patch.local[I[b.tri * 3 + 2]]];
  if (l.some((x) => x < 0)) return null;
  const w = barycentric(surface, b.tri, b.point);
  const u = w[0] * patch.uv[l[0] * 2] + w[1] * patch.uv[l[1] * 2] + w[2] * patch.uv[l[2] * 2];
  const v = w[0] * patch.uv[l[0] * 2 + 1] + w[1] * patch.uv[l[1] * 2 + 1] + w[2] * patch.uv[l[2] * 2 + 1];
  const geodesic = Math.hypot(u, v);
  // Sample the straight design-plane segment back onto the surface.
  const loc = new PatchLocator(surface, patch);
  const n = Math.max(2, Math.ceil(geodesic / 0.004));
  const path: Array<[number, number, number]> = [];
  const D = display ?? surface.positions;
  for (let i = 0; i <= n; i++) {
    const h = loc.locateTri((u * i) / n, (v * i) / n);
    if (!h) continue;
    const t = h.tri * 3, w = h.bary;
    const ia = surface.indices[t] * 3, ib = surface.indices[t + 1] * 3, ic = surface.indices[t + 2] * 3;
    path.push([w[0] * D[ia] + w[1] * D[ib] + w[2] * D[ic], w[0] * D[ia + 1] + w[1] * D[ib + 1] + w[2] * D[ic + 1], w[0] * D[ia + 2] + w[1] * D[ib + 2] + w[2] * D[ic + 2]]);
  }
  if (path.length && !display) { path[0] = a.point; path[path.length - 1] = b.point; }
  return { geodesic, straight, path };
}

export interface CircumferenceResult {
  length: number;
  points: Float32Array;
  /** Unit limb axis used for the cut. */
  axis: [number, number, number];
  /** True if the axis came from the local shape, false if world up was used. */
  fromShape: boolean;
}

/**
 * Circumference of the body part through `p`. The cutting plane is
 * perpendicular to the local limb axis, estimated from the spread of the
 * skin around the point (principal direction of a tube is its axis). For
 * flat areas such as the torso the vertical axis is used.
 */
export function circumferenceAt(surface: SurfaceMesh, p: SurfacePoint, display?: Float32Array): CircumferenceResult | null {
  const normal = normalAt(surface, p.tri, barycentric(surface, p.tri, p.point));
  const tangent = tangentFrom(normal, [0, 1, 0]);
  const patch = computeExpMap(surface, { tri: p.tri, point: p.point, normal, tangent }, { radius: 0.12, exact: false, smoothPasses: 0 });
  const P = surface.positions;
  // PCA of patch vertex positions.
  let cx = 0, cy = 0, cz = 0;
  for (const v of patch.verts) { cx += P[v * 3]; cy += P[v * 3 + 1]; cz += P[v * 3 + 2]; }
  const n = patch.verts.length || 1; cx /= n; cy /= n; cz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const v of patch.verts) {
    const dx = P[v * 3] - cx, dy = P[v * 3 + 1] - cy, dz = P[v * 3 + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  // Power iteration for the dominant eigenvector.
  let ax = 0.3, ay = 1, az = 0.2;
  for (let it = 0; it < 50; it++) {
    const nx = xx * ax + xy * ay + xz * az, ny = xy * ax + yy * ay + yz * az, nz = xz * ax + yz * ay + zz * az;
    const l = Math.hypot(nx, ny, nz) || 1; ax = nx / l; ay = ny / l; az = nz / l;
  }
  const lambda1 = xx * ax * ax + yy * ay * ay + zz * az * az + 2 * (xy * ax * ay + xz * ax * az + yz * ay * az);
  const trace = xx + yy + zz;
  // A tube has one dominant direction; a flat patch spreads over two.
  const fromShape = lambda1 > 0.6 * trace;
  let axis: [number, number, number] = fromShape ? [ax, ay, az] : [0, 1, 0];
  if (axis[1] < 0) axis = [-axis[0], -axis[1], -axis[2]];
  const sec = sectionLoop(surface, p.tri, p.point, axis, 200000, display);
  if (!sec.closed) return null;
  return { length: sec.length, points: sec.points, axis, fromShape };
}
