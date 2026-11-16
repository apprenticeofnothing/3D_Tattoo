// A placed design: anchor on the skin, orientation, physical size, mode.
// Recomputes its patch, stretch report and decal geometry on demand.

import { Vector3 } from 'three';
import type { SurfaceMesh } from '../mesh/topology';
import { barycentric, computeExpMap, normalAt, rotateTangent, tangentFrom, type Patch } from './expmap';
import { summarize, triangleStretch, vertexStretch, type StretchSummary } from './distortion';
import { sectionLoop } from './section';
import { DecalObject, type DecalMode } from './decal';
import type { DesignImage } from '../design/raster';

export interface Placement {
  id: string;
  design: DesignImage;
  tri: number;
  point: [number, number, number];
  /** Rotation of the design about the skin normal, radians. 0 = design up along the body's up. */
  rotation: number;
  widthCm: number;
  mirror: boolean;
  wrap: boolean;
  opacity: number;
}

export interface PlacementResult {
  patch: Patch;
  summary: StretchSummary;
  circumferenceM: number | null;
  heightCm: number;
  computeMs: number;
}

/** Design frame: tangent = +u (design right), bitangent = +v (design up). */
export function designTangent(normal: [number, number, number], rotation: number): [number, number, number] {
  const up = tangentFrom(normal, [0, 1, 0]);
  const b = rotateTangent(up, normal, rotation); // design up
  // t = b x n
  return [b[1] * normal[2] - b[2] * normal[1], b[2] * normal[0] - b[0] * normal[2], b[0] * normal[1] - b[1] * normal[0]];
}

export class PlacedDesign {
  readonly decal: DecalObject;
  result: PlacementResult | null = null;
  mode: DecalMode = 'stencil';

  constructor(public placement: Placement) {
    this.decal = new DecalObject(placement.design.texture);
  }

  setMode(m: DecalMode) { this.mode = m; this.decal.setMode(m); }

  /** Recompute everything for the current placement on the given surface. */
  update(surface: SurfaceMesh): PlacementResult {
    const t0 = performance.now();
    const p = this.placement;
    const bary = barycentric(surface, p.tri, p.point);
    const normal = normalAt(surface, p.tri, bary);
    const tangent = designTangent(normal, p.rotation);
    const widthM = p.widthCm / 100;
    const heightM = widthM / p.design.aspect;
    let circumference: number | null = null;
    let radius = Math.hypot(widthM / 2, heightM / 2) * 1.1 + 0.01;
    if (p.wrap) {
      // Limb axis = design up direction; measure the loop around it.
      const b = new Vector3().crossVectors(new Vector3(...normal), new Vector3(...tangent)); // n x t = bitangent = design up
      const sec = sectionLoop(surface, p.tri, p.point, [b.x, b.y, b.z]);
      circumference = sec.closed ? sec.length : null;
      const C = circumference ?? widthM;
      radius = Math.hypot(C / 2, heightM / 2) * 1.05 + 0.01;
    }
    const patch = computeExpMap(surface, { tri: p.tri, point: p.point, normal, tangent }, { radius });
    const vs = vertexStretch(surface, patch, 2);
    const summary = summarize(triangleStretch(surface, patch), surface, patchClippedToDesign(patch, surface, widthM, heightM, p.wrap, circumference), 0.05, vs);
    this.decal.setOpacity(p.opacity);
    this.decal.build(surface, patch, { width: widthM, height: heightM, mirror: p.mirror, wrap: p.wrap, circumference: circumference ?? 0 }, vs);
    this.result = { patch, summary, circumferenceM: circumference, heightCm: heightM * 100, computeMs: performance.now() - t0 };
    return this.result;
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
