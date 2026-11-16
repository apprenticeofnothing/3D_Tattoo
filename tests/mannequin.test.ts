import { describe, expect, it } from 'vitest';
import { buildMannequin } from '../src/body/mannequin';
import { checkManifold, signedVolume, surfaceArea } from '../src/mesh/marchingCubes';

describe('mannequin', () => {
  const t0 = performance.now();
  const mesh = buildMannequin({ height: 1.93, cell: 0.01 });
  const ms = performance.now() - t0;

  it('is a single closed manifold surface', () => {
    const rep = checkManifold(mesh);
    expect(rep.boundaryEdges).toBe(0);
    expect(rep.nonManifoldEdges).toBe(0);
    expect(rep.inconsistentEdges).toBe(0);
  });

  it('has the requested height and plausible size', () => {
    const p = mesh.positions;
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < p.length; i += 3) {
      minY = Math.min(minY, p[i + 1]); maxY = Math.max(maxY, p[i + 1]);
      minX = Math.min(minX, p[i]); maxX = Math.max(maxX, p[i]);
    }
    expect(maxY - minY).toBeCloseTo(1.93, 1);
    expect(Math.abs(minY)).toBeLessThan(0.03);
    expect(maxX - minX).toBeGreaterThan(0.4);
    expect(maxX - minX).toBeLessThan(0.9);
    const area = surfaceArea(mesh);
    const vol = signedVolume(mesh);
    // A 193 cm adult: roughly 2.0-2.6 m^2 skin, 0.07-0.11 m^3 volume.
    expect(area).toBeGreaterThan(1.6);
    expect(area).toBeLessThan(3.0);
    expect(vol).toBeGreaterThan(0.05);
    expect(vol).toBeLessThan(0.14);
    console.log(`mannequin: ${mesh.indices.length / 3} tris, ${mesh.positions.length / 3} verts, area ${area.toFixed(2)} m2, vol ${vol.toFixed(3)} m3, ${ms.toFixed(0)} ms`);
  });
});
