import { describe, expect, it } from 'vitest';
import { weld, surfaceFromIndexed } from '../src/mesh/topology';
import { cylinderMesh } from './helpers/analytic';
import { circumferenceAt, distanceOnSkin } from '../src/mapping/measure';
import { buildMannequin } from '../src/body/mannequin';

function nearest(surface: ReturnType<typeof surfaceFromIndexed>, p: [number, number, number]) {
  const I = surface.indices, P = surface.positions;
  let best = -1, bd = Infinity;
  for (let t = 0; t < I.length / 3; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; cx += P[v] / 3; cy += P[v + 1] / 3; cz += P[v + 2] / 3; }
    const d = Math.hypot(cx - p[0], cy - p[1], cz - p[2]); if (d < bd) { bd = d; best = t; }
  }
  let cx = 0, cy = 0, cz = 0;
  for (let k = 0; k < 3; k++) { const v = I[best * 3 + k] * 3; cx += P[v] / 3; cy += P[v + 1] / 3; cz += P[v + 2] / 3; }
  return { tri: best, point: [cx, cy, cz] as [number, number, number] };
}

describe('tape measure', () => {
  const R = 0.05;
  const m = cylinderMesh(R, 0.6, 160, 96);
  const w = weld(m.positions, m.indices);
  const cyl = surfaceFromIndexed({ positions: w.positions, indices: w.indices });

  it('measures a helix on a cylinder: sqrt((R dphi)^2 + dz^2)', () => {
    const a = nearest(cyl, [R, 0.02, 0]);
    const phi = 2.0, dz = 0.12;
    const b = nearest(cyl, [R * Math.cos(phi), 0.02 + dz, R * Math.sin(phi)]);
    const r = distanceOnSkin(cyl, a, b)!;
    const theory = Math.hypot(R * phi, dz);
    // The picked points are triangle centroids, so allow a couple of millimetres.
    expect(Math.abs(r.geodesic - theory)).toBeLessThan(0.003);
    expect(r.straight).toBeLessThan(r.geodesic);
    expect(r.path.length).toBeGreaterThan(10);
  });

  it('finds the cylinder axis from the shape and returns 2 pi R', () => {
    const c = circumferenceAt(cyl, nearest(cyl, [R, 0.1, 0]))!;
    expect(c.fromShape).toBe(true);
    expect(Math.abs(c.axis[1])).toBeGreaterThan(0.99);
    expect(Math.abs(c.length / (2 * Math.PI * R) - 1)).toBeLessThan(0.002);
  });

  it('on the placeholder forearm the cut follows the slanted arm', () => {
    const H = 1.93;
    const body = surfaceFromIndexed(buildMannequin({ height: H, cell: 0.01 }));
    const c = circumferenceAt(body, nearest(body, [0.33, 0.56 * H, 0.0]))!;
    expect(c.fromShape).toBe(true);
    // Forearm hangs about 15 degrees outward in the A-pose: axis tilted in x.
    expect(Math.abs(c.axis[0])).toBeGreaterThan(0.1);
    expect(c.length).toBeGreaterThan(0.2);
    expect(c.length).toBeLessThan(0.3);
  });
});
