import { describe, expect, it } from 'vitest';
import { checkManifold, marchingCubes, sampleField, signedVolume, surfaceArea, type GridSpec } from '../src/mesh/marchingCubes';
import { sdSphere } from '../src/mesh/sdf';

describe('marching cubes', () => {
  const r = 0.1;
  const c = 0.005;
  const n = Math.ceil((2 * r) / c) + 5;
  const grid: GridSpec = { nx: n, ny: n, nz: n, origin: [-r - 2 * c, -r - 2 * c, -r - 2 * c], cell: [c, c, c] };
  const field = sampleField(grid, (x, y, z) => sdSphere(x, y, z, [0, 0, 0], r));
  const mesh = marchingCubes(grid, field);

  it('produces a closed manifold surface for a sphere', () => {
    const rep = checkManifold(mesh);
    expect(mesh.indices.length).toBeGreaterThan(1000);
    expect(rep.boundaryEdges).toBe(0);
    expect(rep.nonManifoldEdges).toBe(0);
    expect(rep.inconsistentEdges).toBe(0);
  });

  it('matches the analytic area and volume of the sphere within 1%', () => {
    const area = surfaceArea(mesh);
    const vol = signedVolume(mesh);
    expect(Math.abs(area / (4 * Math.PI * r * r) - 1)).toBeLessThan(0.01);
    expect(Math.abs(vol / ((4 / 3) * Math.PI * r ** 3) - 1)).toBeLessThan(0.01);
    expect(vol).toBeGreaterThan(0); // outward winding
  });

  it('keeps every vertex on the sphere', () => {
    const p = mesh.positions;
    let maxErr = 0;
    for (let i = 0; i < p.length; i += 3) maxErr = Math.max(maxErr, Math.abs(Math.hypot(p[i], p[i + 1], p[i + 2]) - r));
    expect(maxErr).toBeLessThan(c * 0.05);
  });
});
