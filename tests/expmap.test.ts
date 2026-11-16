import { describe, expect, it } from 'vitest';
import { weld, surfaceFromIndexed, type SurfaceMesh } from '../src/mesh/topology';
import { computeExpMap, type Patch } from '../src/mapping/expmap';
import { summarize, triangleStretch, vertexStretch } from '../src/mapping/distortion';
import { PatchLocator } from '../src/mapping/locate';
import { cylinderMesh, sphereMesh } from './helpers/analytic';
import { sectionLoop } from '../src/mapping/section';

function surface(m: { positions: Float32Array; indices: Uint32Array }): SurfaceMesh {
  const w = weld(m.positions, m.indices);
  return surfaceFromIndexed({ positions: w.positions, indices: w.indices });
}

/** Find the triangle whose centroid is nearest to p. */
function nearestTri(mesh: SurfaceMesh, p: [number, number, number]): number {
  const I = mesh.indices, P = mesh.positions;
  let best = -1, bd = Infinity;
  for (let t = 0; t < I.length / 3; t++) {
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; cx += P[v] / 3; cy += P[v + 1] / 3; cz += P[v + 2] / 3; }
    const d = Math.hypot(cx - p[0], cy - p[1], cz - p[2]);
    if (d < bd) { bd = d; best = t; }
  }
  return best;
}

function circlePoints(r: number, n = 720): Float32Array {
  const out = new Float32Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) { const a = (2 * Math.PI * i) / n; out[i * 2] = r * Math.cos(a); out[i * 2 + 1] = r * Math.sin(a); }
  return out;
}

function report(name: string, mesh: SurfaceMesh, patch: Patch) {
  const ts = triangleStretch(mesh, patch);
  const s = summarize(ts, mesh, patch);
  console.log(`${name}: ${patch.verts.length} verts, ${patch.tris.length} tris, worst stretch ${(s.worstStretch * 100).toFixed(2)}%, worst compression ${(s.worstCompression * 100).toFixed(2)}%, area over 5%: ${(s.areaOverThreshold * 100).toFixed(1)}%`);
  return { ts, s };
}

describe('exponential map on a cylinder (developable: zero distortion expected)', () => {
  const R = 0.05; // forearm-like, 5 cm radius
  const mesh = surface(cylinderMesh(R, 0.6, 160, 96));
  const seedPoint: [number, number, number] = [R, 0, 0];
  const tri = nearestTri(mesh, seedPoint);
  const patch = computeExpMap(mesh, { tri, point: seedPoint, normal: [1, 0, 0], tangent: [0, 1, 0] }, { radius: 0.12 });

  it('preserves lengths to within 1% over a 24 cm patch', () => {
    const { s } = report('cylinder', mesh, patch);
    expect(s.worstStretch).toBeLessThan(0.01);
    expect(s.worstCompression).toBeGreaterThan(-0.01);
    expect(s.areaOverThreshold).toBe(0);
  });

  it('matches the analytic unrolling (u along axis, v around) within 1 mm', () => {
    // On a cylinder the exp map from (R,0,0) with tangent +Y is exactly
    // u = y, v = R * angle (signed), angle measured from +X toward +Z.
    let maxErr = 0;
    for (let i = 0; i < patch.verts.length; i++) {
      const v = patch.verts[i];
      const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
      const ang = Math.atan2(z, x);
      const u = y, w = R * ang; // bitangent = n x t = (1,0,0) x (0,1,0) = (0,0,1): +v toward +Z
      maxErr = Math.max(maxErr, Math.hypot(patch.uv[i * 2] - u, patch.uv[i * 2 + 1] - w));
    }
    console.log(`cylinder uv max error ${(maxErr * 1000).toFixed(3)} mm`);
    expect(maxErr).toBeLessThan(0.001);
  });

  it('a 6 cm circle and a 10 cm grid line keep their lengths on the skin', () => {
    const loc = new PatchLocator(mesh, patch);
    const circ = loc.curveLength(circlePoints(0.03))!;
    const line = loc.curveLength(new Float32Array([-0.05, 0.02, 0.05, 0.02]))!;
    console.log(`cylinder: circle ${(circ * 100).toFixed(3)} cm (design ${(Math.PI * 6).toFixed(3)}), line ${(line * 100).toFixed(3)} cm (design 10)`);
    expect(Math.abs(circ / (Math.PI * 0.06) - 1)).toBeLessThan(0.005);
    expect(Math.abs(line / 0.10 - 1)).toBeLessThan(0.005);
  });
});

describe('exponential map on a sphere (known theoretical stretch)', () => {
  const R = 0.10;
  const mesh = surface(sphereMesh(R, 256, 128));
  const seedPoint: [number, number, number] = [R, 0, 0]; // on the equator, away from the poles
  const tri = nearestTri(mesh, seedPoint);
  const patch = computeExpMap(mesh, { tri, point: seedPoint, normal: [1, 0, 0], tangent: [0, 1, 0] }, { radius: 0.07 });

  it('keeps radial distances equal to the true geodesic distance within 1%', () => {
    let maxRel = 0;
    for (let i = 0; i < patch.verts.length; i++) {
      const v = patch.verts[i];
      const x = mesh.positions[v * 3], y = mesh.positions[v * 3 + 1], z = mesh.positions[v * 3 + 2];
      const geo = R * Math.acos(Math.max(-1, Math.min(1, x / R))); // angle from seed direction
      if (geo < 0.01) continue;
      maxRel = Math.max(maxRel, Math.abs(patch.dist[i] / geo - 1));
    }
    console.log(`sphere radial distance max rel error ${(maxRel * 100).toFixed(2)}%`);
    expect(maxRel).toBeLessThan(0.01);
  });

  it('compresses tangentially by sin(r/R)/(r/R): ring-averaged stretch matches theory within 1 point', () => {
    report('sphere', mesh, patch);
    const vs = vertexStretch(mesh, patch, 2);
    let maxDiff = 0, n = 0; const diffs: number[] = [];
    for (let i = 0; i < patch.verts.length; i++) {
      const r = patch.dist[i];
      if (r < 0.01 || r > 0.06) continue; // skip the seed cap and the outer rim where rings are truncated
      const rho = r / R;
      const theory = Math.sin(rho) / rho;
      const d = Math.max(Math.abs(vs.sMin[i] - theory), Math.abs(vs.sMax[i] - 1));
      diffs.push(d); maxDiff = Math.max(maxDiff, d); n++;
    }
    diffs.sort((a, b) => a - b);
    const p95 = diffs[Math.floor(diffs.length * 0.95)];
    console.log(`sphere ring-averaged stretch vs theory over ${n} vertices: p95 ${(p95 * 100).toFixed(2)} points, max ${(maxDiff * 100).toFixed(2)} points`);
    expect(n).toBeGreaterThan(500);
    expect(p95).toBeLessThan(0.01);
    expect(maxDiff).toBeLessThan(0.02);
  });

  it('per-triangle stretch is unbiased around the theory', () => {
    const ts = triangleStretch(mesh, patch);
    let sum = 0, n = 0;
    for (let i = 0; i < patch.tris.length; i++) {
      const t = patch.tris[i];
      let r = 0;
      for (let k = 0; k < 3; k++) r += patch.dist[patch.local[mesh.indices[t * 3 + k]]] / 3;
      if (r < 0.015) continue;
      sum += ts.sMin[i] - Math.sin(r / R) / (r / R); n++;
    }
    console.log(`sphere per-triangle bias ${(sum / n * 100).toFixed(3)} points over ${n} triangles`);
    expect(Math.abs(sum / n)).toBeLessThan(0.002);
  });

  it('a circle of design radius 5 cm has the spherical circumference', () => {
    const loc = new PatchLocator(mesh, patch);
    const r = 0.05;
    const circ = loc.curveLength(circlePoints(r))!;
    const theory = 2 * Math.PI * R * Math.sin(r / R);
    console.log(`sphere: circle ${(circ * 100).toFixed(3)} cm, theory ${(theory * 100).toFixed(3)} cm, flat ${(2 * Math.PI * r * 100).toFixed(3)} cm`);
    expect(Math.abs(circ / theory - 1)).toBeLessThan(0.005);
  });
});

describe('wrap mode around a cylinder', () => {
  const R = 0.05;
  const mesh = surface(cylinderMesh(R, 0.6, 160, 96));
  const seedPoint: [number, number, number] = [R, 0, 0];
  const tri = nearestTri(mesh, seedPoint);
  const C = 2 * Math.PI * R;
  // Patch large enough to go all the way round: radius > C/2.
  const patch = computeExpMap(mesh, { tri, point: seedPoint, normal: [1, 0, 0], tangent: [0, 1, 0] }, { radius: C / 2 + 0.03 });

  it('covers the whole circumference with exact coordinates and a single seam', () => {
    const { s } = report('cylinder wrap', mesh, patch);
    console.log(`cylinder wrap: coverage ${(patch.exactCoverage * 100).toFixed(1)}%, seam tris ${patch.seamTris.length}`);
    expect(patch.exactCoverage).toBeGreaterThan(0.97);
    expect(s.worstStretch).toBeLessThan(0.01);
    expect(s.worstCompression).toBeGreaterThan(-0.01);
    // v (around) reaches +-C/2 on both sides
    let maxV = -Infinity, minV = Infinity;
    for (let i = 0; i < patch.verts.length; i++) { maxV = Math.max(maxV, patch.uv[i * 2 + 1]); minV = Math.min(minV, patch.uv[i * 2 + 1]); }
    expect(maxV).toBeGreaterThan(C / 2 - 0.004);
    expect(minV).toBeLessThan(-C / 2 + 0.004);
    expect(patch.seamTris.length).toBeGreaterThan(10);
    expect(patch.seamTris.length).toBeLessThan(400);
  });
});

describe('section loop', () => {
  it('measures the cylinder circumference within 0.1%', () => {
    const R = 0.05;
    const mesh = surface(cylinderMesh(R, 0.6, 160, 96));
    const tri = nearestTri(mesh, [R, 0.01, 0]);
    const sec = sectionLoop(mesh, tri, [R, 0.01, 0], [0, 1, 0]);
    expect(sec.closed).toBe(true);
    // Polygon inscribed in the circle: slightly shorter than 2*pi*R
    expect(Math.abs(sec.length / (2 * Math.PI * R) - 1)).toBeLessThan(0.001);
  });
});
