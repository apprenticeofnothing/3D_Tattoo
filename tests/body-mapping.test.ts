import { describe, expect, it } from 'vitest';
import { buildMannequin } from '../src/body/mannequin';
import { surfaceFromIndexed } from '../src/mesh/topology';
import { computeExpMap, normalAt, barycentric } from '../src/mapping/expmap';
import { summarize, triangleStretch, vertexStretch } from '../src/mapping/distortion';
import { sectionLoop } from '../src/mapping/section';
import { designTangent } from '../src/mapping/placements';

describe('mapping on the placeholder body', () => {
  const H = 1.93;
  const surface = surfaceFromIndexed(buildMannequin({ height: H, cell: 0.01 }));
  const I = surface.indices, P = surface.positions;

  /** Triangle whose centroid is nearest to p and faces direction d. */
  function pick(p: [number, number, number], d: [number, number, number]): { tri: number; point: [number, number, number] } {
    let best = -1, bd = Infinity;
    for (let t = 0; t < I.length / 3; t++) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; cx += P[v] / 3; cy += P[v + 1] / 3; cz += P[v + 2] / 3; }
      const n = surface.normals;
      const v0 = I[t * 3] * 3;
      if (n[v0] * d[0] + n[v0 + 1] * d[1] + n[v0 + 2] * d[2] < 0.5) continue;
      const dist = Math.hypot(cx - p[0], cy - p[1], cz - p[2]);
      if (dist < bd) { bd = dist; best = t; }
    }
    let cx = 0, cy = 0, cz = 0;
    for (let k = 0; k < 3; k++) { const v = I[best * 3 + k] * 3; cx += P[v] / 3; cy += P[v + 1] / 3; cz += P[v + 2] / 3; }
    return { tri: best, point: [cx, cy, cz] };
  }

  it('maps a 10 cm design on the outer left forearm with low distortion and full coverage', () => {
    // Left forearm: x ~ +0.3 m, y ~ 0.56 H.
    const { tri, point } = pick([0.33, 0.56 * H, 0], [1, 0, 0]);
    const bary = barycentric(surface, tri, point);
    const normal = normalAt(surface, tri, bary);
    const tangent = designTangent(normal, 0);
    const t0 = performance.now();
    const patch = computeExpMap(surface, { tri, point, normal, tangent }, { radius: 0.09 });
    const ms = performance.now() - t0;
    const s = summarize(triangleStretch(surface, patch), surface, patch);
    const vs = vertexStretch(surface, patch, 2);
    let worst = 0;
    for (let i = 0; i < patch.verts.length; i++) if (patch.dist[i] < 0.05) worst = Math.max(worst, Math.abs(vs.sMax[i] - 1), Math.abs(vs.sMin[i] - 1));
    console.log(`forearm: ${patch.verts.length} verts, ${patch.tris.length} tris, exact coverage ${(patch.exactCoverage * 100).toFixed(1)}%, ring stretch within 5 cm worst ${(worst * 100).toFixed(2)}%, area over 5%: ${(s.areaOverThreshold * 100).toFixed(1)}%, ${ms.toFixed(0)} ms`);
    expect(patch.exactCoverage).toBeGreaterThan(0.97);
    expect(patch.verts.length).toBeGreaterThan(200);
    expect(worst).toBeLessThan(0.05); // forearm is nearly developable
    expect(ms).toBeLessThan(2000);
  });

  it('measures a plausible forearm circumference', () => {
    const { tri, point } = pick([0.33, 0.56 * H, 0], [1, 0, 0]);
    const bary = barycentric(surface, tri, point);
    const normal = normalAt(surface, tri, bary);
    const tangent = designTangent(normal, 0);
    const n = normal, t = tangent;
    const up: [number, number, number] = [n[1] * t[2] - n[2] * t[1], n[2] * t[0] - n[0] * t[2], n[0] * t[1] - n[1] * t[0]];
    const sec = sectionLoop(surface, tri, point, up);
    console.log(`forearm circumference ${(sec.length * 100).toFixed(1)} cm, closed ${sec.closed}, ${sec.points.length / 3} points`);
    expect(sec.closed).toBe(true);
    expect(sec.length).toBeGreaterThan(0.10);
    expect(sec.length).toBeLessThan(0.35);
  });

  it('flags real stretch on the shoulder cap for a large design', () => {
    const { tri, point } = pick([0.23, 0.81 * H, 0.02], [0.7, 0.6, 0.2]);
    const bary = barycentric(surface, tri, point);
    const normal = normalAt(surface, tri, bary);
    const tangent = designTangent(normal, 0);
    const patch = computeExpMap(surface, { tri, point, normal, tangent }, { radius: 0.10 });
    const s = summarize(triangleStretch(surface, patch), surface, patch);
    console.log(`shoulder: worst compression ${(s.worstCompression * 100).toFixed(1)}%, area over 5%: ${(s.areaOverThreshold * 100).toFixed(1)}%`);
    expect(s.worstCompression).toBeLessThan(-0.05);
  });
});

describe('wrap mode on the placeholder forearm', () => {
  const H = 1.93;
  const surface = surfaceFromIndexed(buildMannequin({ height: H, cell: 0.01 }));
  const I = surface.indices, P = surface.positions;
  it('wraps a band all the way round with near-zero distortion', () => {
    let best = -1, bd = Infinity;
    for (let t = 0; t < I.length / 3; t++) {
      let cx = 0, cy = 0, cz = 0;
      for (let k = 0; k < 3; k++) { const v = I[t * 3 + k] * 3; cx += P[v] / 3; cy += P[v + 1] / 3; cz += P[v + 2] / 3; }
      if (surface.normals[I[t * 3] * 3] < 0.5) continue;
      const d = Math.hypot(cx - 0.33, cy - 0.56 * H, cz); if (d < bd) { bd = d; best = t; }
    }
    let cx = 0, cy = 0, cz = 0; for (let k = 0; k < 3; k++) { const v = I[best * 3 + k] * 3; cx += P[v] / 3; cy += P[v + 1] / 3; cz += P[v + 2] / 3; }
    const point: [number, number, number] = [cx, cy, cz];
    const normal = normalAt(surface, best, barycentric(surface, best, point));
    const tangent = designTangent(normal, 0);
    const patch = computeExpMap(surface, { tri: best, point, normal, tangent }, { radius: 0.15 });
    const vs = vertexStretch(surface, patch, 2);
    // Within a 4 cm tall band around the limb (|v| < 2 cm), excluding seam triangles.
    let worst = 0, n = 0;
    for (let i = 0; i < patch.verts.length; i++) {
      if (Math.abs(patch.uv[i * 2 + 1]) > 0.02) continue;
      if (!Number.isFinite(vs.sMax[i])) continue;
      worst = Math.max(worst, Math.abs(vs.sMax[i] - 1), Math.abs(vs.sMin[i] - 1)); n++;
    }
    let maxU = -Infinity, minU = Infinity;
    for (let i = 0; i < patch.verts.length; i++) { maxU = Math.max(maxU, patch.uv[i * 2]); minU = Math.min(minU, patch.uv[i * 2]); }
    console.log(`forearm wrap: coverage ${(patch.exactCoverage * 100).toFixed(1)}%, band verts ${n}, worst ring stretch ${(worst * 100).toFixed(2)}%, u range ${(minU * 100).toFixed(1)}..${(maxU * 100).toFixed(1)} cm, seam tris ${patch.seamTris.length}`);
    expect(patch.exactCoverage).toBeGreaterThan(0.95);
    expect(maxU).toBeGreaterThan(0.11); // reaches the back on both sides (circumference ~25.6 cm)
    expect(minU).toBeLessThan(-0.11);
    expect(worst).toBeLessThan(0.05);
  });
});
