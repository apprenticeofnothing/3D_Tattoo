// A placed design: anchor on the skin, orientation, physical size, mode.
// Recomputes its patch, stretch report and decal geometry on demand, and
// answers geometric questions the interaction layer needs (where is the
// outline, where are the handles, what design coordinate is under a point).

import { Vector3 } from 'three';
import type { SurfaceMesh } from '../mesh/topology';
import { barycentric, computeExpMap, normalAt, rotateTangent, tangentFrom, type Patch } from './expmap';
import { summarize, triangleStretch, vertexStretch, type StretchSummary } from './distortion';
import { sectionLoop } from './section';
import { PatchLocator } from './locate';
import { DecalObject } from './decal';
import type { DesignImage } from '../design/raster';
import type { PlacementData } from '../app/project';

export interface Placement extends PlacementData {
  design: DesignImage;
}

export interface PlacementResult {
  patch: Patch;
  summary: StretchSummary;
  circumferenceM: number | null;
  heightCm: number;
  computeMs: number;
  exact: boolean;
  /** Rotation the patch was computed with (the frame rotates with it). */
  rotation: number;
}

/** Design frame: tangent = +u (design right), bitangent = +v (design up). */
export function designTangent(normal: [number, number, number], rotation: number): [number, number, number] {
  const up = tangentFrom(normal, [0, 1, 0]);
  const b = rotateTangent(up, normal, rotation); // design up
  // t = b x n
  return [b[1] * normal[2] - b[2] * normal[1], b[2] * normal[0] - b[0] * normal[2], b[0] * normal[1] - b[1] * normal[0]];
}

/** Handle offset beyond the top edge, metres. */
export const ROTATE_HANDLE_GAP = 0.02;

export class PlacedDesign {
  readonly decal: DecalObject;
  result: PlacementResult | null = null;
  private locator: PatchLocator | null = null;

  constructor(public placement: Placement) {
    this.decal = new DecalObject(placement.design.texture);
    this.decal.setMode(placement.mode);
  }

  get widthM(): number { return this.placement.widthCm / 100; }
  get heightM(): number { return this.widthM / this.placement.design.aspect; }

  /** Recompute everything for the current placement on the given surface. */
  update(surface: SurfaceMesh, exact = true): PlacementResult {
    const t0 = performance.now();
    const p = this.placement;
    const bary = barycentric(surface, p.tri, p.point);
    const normal = normalAt(surface, p.tri, bary);
    p.normal = normal;
    const tangent = designTangent(normal, p.rotation);
    const widthM = this.widthM, heightM = this.heightM;
    let circumference: number | null = null;
    // Patch must also reach the rotate handle above the design.
    let radius = Math.hypot(widthM / 2, heightM / 2 + ROTATE_HANDLE_GAP) * 1.1 + 0.015;
    if (p.wrap) {
      const b = new Vector3().crossVectors(new Vector3(...normal), new Vector3(...tangent)); // design up = limb axis
      const sec = sectionLoop(surface, p.tri, p.point, [b.x, b.y, b.z]);
      circumference = sec.closed ? sec.length : null;
      const C = circumference ?? widthM;
      radius = Math.hypot(C / 2, heightM / 2 + ROTATE_HANDLE_GAP) * 1.05 + 0.015;
    }
    const patch = computeExpMap(surface, { tri: p.tri, point: p.point, normal, tangent }, { radius, exact, smoothPasses: exact ? 3 : 2 });
    const vs = vertexStretch(surface, patch, 2);
    const summary = summarize(triangleStretch(surface, patch), surface, patchClippedToDesign(patch, surface, widthM, heightM, p.wrap, circumference), 0.05, vs);
    this.decal.setOpacity(p.opacity);
    this.decal.setMode(p.mode);
    this.decal.build(surface, patch, { width: widthM, height: heightM, mirror: p.mirror, wrap: p.wrap, circumference: circumference ?? 0 }, vs);
    this.locator = null;
    this.result = { patch, summary, circumferenceM: circumference, heightCm: heightM * 100, computeMs: performance.now() - t0, exact, rotation: p.rotation };
    return this.result;
  }

  private getLocator(surface: SurfaceMesh): PatchLocator | null {
    if (!this.result) return null;
    if (!this.locator) this.locator = new PatchLocator(surface, this.result.patch);
    return this.locator;
  }

  /** Surface point for a design-plane coordinate (metres), if inside the patch. */
  surfacePoint(surface: SurfaceMesh, u: number, v: number, lift = 0): [number, number, number] | null {
    const hit = this.getLocator(surface)?.locateTri(u, v);
    if (!hit) return null;
    if (lift === 0) return hit.point;
    const I = surface.indices, N = surface.normals;
    const a = I[hit.tri * 3] * 3, b = I[hit.tri * 3 + 1] * 3, c = I[hit.tri * 3 + 2] * 3;
    const nx = N[a] + N[b] + N[c], ny = N[a + 1] + N[b + 1] + N[c + 1], nz = N[a + 2] + N[b + 2] + N[c + 2];
    const l = Math.hypot(nx, ny, nz) || 1;
    return [hit.point[0] + (nx / l) * lift, hit.point[1] + (ny / l) * lift, hit.point[2] + (nz / l) * lift];
  }

  /** Design-plane coordinate (metres) of a surface point in triangle `tri`, or null if outside the patch. */
  uvAt(surface: SurfaceMesh, tri: number, point: [number, number, number]): [number, number] | null {
    const patch = this.result?.patch;
    if (!patch) return null;
    const I = surface.indices;
    const l = [patch.local[I[tri * 3]], patch.local[I[tri * 3 + 1]], patch.local[I[tri * 3 + 2]]];
    if (l.some((x) => x < 0)) return null;
    const b = barycentric(surface, tri, point);
    return [
      b[0] * patch.uv[l[0] * 2] + b[1] * patch.uv[l[1] * 2] + b[2] * patch.uv[l[2] * 2],
      b[0] * patch.uv[l[0] * 2 + 1] + b[1] * patch.uv[l[1] * 2 + 1] + b[2] * patch.uv[l[2] * 2 + 1],
    ];
  }

  /** Outline of the design rectangle on the skin, as a closed 3D polyline (may have gaps as nulls). */
  outline(surface: SurfaceMesh, step = 0.004): Array<[number, number, number] | null> {
    const W = this.widthM, H = this.heightM;
    const wrap = this.placement.wrap;
    const pts: Array<[number, number, number] | null> = [];
    const w2 = wrap ? Math.min(W, (this.result?.circumferenceM ?? W)) / 2 : W / 2;
    const corners: [number, number][] = [[-w2, -H / 2], [w2, -H / 2], [w2, H / 2], [-w2, H / 2]];
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let k = 0; k < n; k++) {
        const t = k / n;
        pts.push(this.surfacePoint(surface, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, 0.0015));
      }
    }
    pts.push(pts[0]);
    return pts;
  }

  /** 3D positions of the rotate handle (above the top edge) and the scale handle (bottom-right corner). */
  handles(surface: SurfaceMesh): { rotate: [number, number, number] | null; scale: [number, number, number] | null; center: [number, number, number] | null } {
    const W = this.widthM, H = this.heightM;
    const sx = this.placement.mirror ? -1 : 1;
    return {
      rotate: this.surfacePoint(surface, 0, H / 2 + ROTATE_HANDLE_GAP, 0.003),
      scale: this.surfacePoint(surface, sx * W / 2, -H / 2, 0.003),
      center: this.surfacePoint(surface, 0, 0, 0.003),
    };
  }

  /** Width that puts the scale handle corner at design-plane radius r. */
  widthForCornerRadius(r: number): number {
    const k = Math.hypot(1, 1 / this.placement.design.aspect) / 2; // corner radius per unit width
    return Math.max(0.01, r / k) * 100;
  }

  toData(): PlacementData {
    const { design: _d, ...data } = this.placement;
    void _d;
    return JSON.parse(JSON.stringify(data));
  }

  dispose() { this.decal.dispose(); }
}

/** A view of the patch limited to triangles under the design rectangle, for the summary. */
function patchClippedToDesign(patch: Patch, surface: SurfaceMesh, W: number, H: number, wrap: boolean, C: number | null): Patch {
  const I = surface.indices;
  const tris: number[] = [];
  for (let i = 0; i < patch.tris.length; i++) {
    const t = patch.tris[i];
    let inside = true;
    for (let k = 0; k < 3 && inside; k++) {
      const l = patch.local[I[t * 3 + k]];
      const u = patch.uv[l * 2], v = patch.uv[l * 2 + 1];
      if (Math.abs(v) > H / 2) inside = false;
      if (!wrap && Math.abs(u) > W / 2) inside = false;
      if (wrap && C !== null && Math.abs(u) > C / 2) inside = false;
    }
    if (inside) tris.push(t);
  }
  return { ...patch, tris: new Uint32Array(tris) };
}

/** Nearest triangle to a point (brute force; used when restoring a saved placement onto a mesh). */
export function nearestTriangle(surface: SurfaceMesh, p: [number, number, number]): { tri: number; dist: number } {
  const I = surface.indices, P = surface.positions;
  let best = -1, bd = Infinity;
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const cx = (P[a] + P[b] + P[c]) / 3, cy = (P[a + 1] + P[b + 1] + P[c + 1]) / 3, cz = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
    const d = (cx - p[0]) ** 2 + (cy - p[1]) ** 2 + (cz - p[2]) ** 2;
    if (d < bd) { bd = d; best = t; }
  }
  return { tri: best, dist: Math.sqrt(bd) };
}
