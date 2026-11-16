import { describe, expect, it } from 'vitest';
import { weld, surfaceFromIndexed } from '../src/mesh/topology';
import { cylinderMesh } from './helpers/analytic';
import { PlacedDesign, designTangent } from '../src/mapping/placements';
import type { Placement } from '../src/mapping/placements';
import type { DesignImage } from '../src/design/raster';

// A fake design image: only aspect and a texture stand-in are needed here.
const fakeDesign = (aspect: number): DesignImage => ({ name: 'fake.svg', texture: {} as never, aspect, width: 100, height: 100 / aspect, kind: 'svg' });

describe('placement geometry on a cylinder', () => {
  const R = 0.05;
  const m = cylinderMesh(R, 0.6, 160, 96);
  const w = weld(m.positions, m.indices);
  const surface = surfaceFromIndexed({ positions: w.positions, indices: w.indices });
  const I = surface.indices, P = surface.positions;
  let tri = -1, bd = Infinity;
  for (let t = 0; t < I.length / 3; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; cx += P[v] / 3; cy += P[v + 1] / 3; cz += P[v + 2] / 3; }
    const d = Math.hypot(cx - R, cy, cz); if (d < bd) { bd = d; tri = t; }
  }
  const make = (rotation: number, widthCm = 8, aspect = 2): PlacedDesign => {
    const placement: Placement = { id: 'p', designId: 'd', design: fakeDesign(aspect), tri, point: [R, 0, 0], normal: [1, 0, 0], rotation, widthCm, mirror: false, wrap: false, opacity: 1, mode: 'stencil', option: 'both' };
    const d = new PlacedDesign(placement);
    // Build without a real texture/material: patch the decal build to a no-op.
    (d.decal as unknown as { build: () => void }).build = () => {};
    d.update(surface, true);
    return d;
  };

  it('design up points along world up at rotation 0, and uvAt inverts surfacePoint', () => {
    const d = make(0);
    const top = d.surfacePoint(surface, 0, 0.02)!; // 2 cm up the design
    expect(top[1]).toBeCloseTo(0.02, 3); // along +Y on the cylinder
    const right = d.surfacePoint(surface, 0.02, 0)!; // 2 cm to the design's right
    expect(Math.abs(right[1])).toBeLessThan(1e-3);
    // Round trip through uvAt
    for (const [u, v] of [[0.01, 0.02], [-0.03, 0.01], [0.025, -0.015]]) {
      const hit = (d as unknown as { getLocator: (s: typeof surface) => { locateTri: (u: number, v: number) => { tri: number; point: [number, number, number] } } }).getLocator(surface).locateTri(u, v);
      const back = d.uvAt(surface, hit.tri, hit.point)!;
      expect(back[0]).toBeCloseTo(u, 4);
      expect(back[1]).toBeCloseTo(v, 4);
    }
  });

  it('rotate-handle rule: rotation -= atan2(u, v) brings the up axis onto the finger', () => {
    const d = make(0.3);
    // Pick a surface point 3 cm from the anchor in some direction and compute phi.
    const target = d.surfacePoint(surface, 0.02, 0.022)!;
    const loc = (d as unknown as { getLocator: (s: typeof surface) => { locateTri: (u: number, v: number) => { tri: number } } }).getLocator(surface).locateTri(0.02, 0.022);
    const uv = d.uvAt(surface, loc.tri, target)!;
    const phi = Math.atan2(uv[0], uv[1]);
    d.placement.rotation -= phi;
    d.update(surface, true);
    const uv2 = d.uvAt(surface, loc.tri, target)!;
    expect(Math.abs(uv2[0])).toBeLessThan(1e-3); // now straight up the design's v axis
    expect(uv2[1]).toBeGreaterThan(0.025);
  });

  it('scale-handle rule: widthForCornerRadius inverts the corner radius', () => {
    const d = make(0, 8, 2);
    const W = 0.08, H = 0.04;
    expect(d.widthForCornerRadius(Math.hypot(W / 2, H / 2))).toBeCloseTo(8, 6);
  });

  it('designTangent is perpendicular to the normal and right-handed', () => {
    const n: [number, number, number] = [0.3, 0.2, 0.93];
    const l = Math.hypot(...n); const nn: [number, number, number] = [n[0] / l, n[1] / l, n[2] / l];
    const t = designTangent(nn, 0.7);
    expect(Math.abs(t[0] * nn[0] + t[1] * nn[1] + t[2] * nn[2])).toBeLessThan(1e-9);
    expect(Math.hypot(...t)).toBeCloseTo(1, 9);
  });
});
