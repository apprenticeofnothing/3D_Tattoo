import { describe, expect, it } from 'vitest';
import { BuilderBody, blendCoarse, estimateBmi, presetParams, presetParamsAtHeight, targetWeights, defaultParams, type BodyParams } from '../src/body/builder';
import { surfaceFromObject } from '../src/mesh/topology';
import { checkManifold, signedVolume } from '../src/mesh/marchingCubes';
import { REGIONS, locateRegion } from '../src/body/regions';
import { barycentric, computeExpMap, normalAt } from '../src/mapping/expmap';
import { vertexStretch } from '../src/mapping/distortion';
import { designTangent } from '../src/mapping/placements';
import { circumferenceAt } from '../src/mapping/measure';
import { loadBodyDataSync } from './helpers/bodyData';

const data = loadBodyDataSync();
const H = 1.93;

function bodyFor(params: BodyParams, height = H) {
  const b = new BuilderBody(data, params);
  b.update(params, height);
  b.mesh.updateMatrixWorld(true);
  const surface = surfaceFromObject(b.mesh);
  return { b, surface };
}

/** Front-facing surface point nearest to (x, y) on the given side of the body. */
function frontPoint(surface: ReturnType<typeof surfaceFromObject>, x: number, y: number, zDir = 1) {
  const I = surface.indices, P = surface.positions, N = surface.normals;
  let best = -1, bd = Infinity;
  for (let t = 0; t < I.length / 3; t++) {
    const a = I[t * 3] * 3;
    if (N[a + 2] * zDir < 0.6) continue;
    const d = Math.hypot(P[a] - x, P[a + 1] - y);
    if (d < bd) { bd = d; best = t; }
  }
  const a = I[best * 3] * 3, b = I[best * 3 + 1] * 3, c = I[best * 3 + 2] * 3;
  return { tri: best, point: [(P[a] + P[b] + P[c]) / 3, (P[a + 1] + P[b + 1] + P[c + 1]) / 3, (P[a + 2] + P[b + 2] + P[c + 2]) / 3] as [number, number, number] };
}

describe('body builder data', () => {
  it('has the MakeHuman skin plus eyes and the six presets', () => {
    expect(data.meta.vertexCount).toBe(13524);
    expect(data.meta.quadCount).toBe(13518);
    expect(data.meta.presets.map((p) => p.id)).toEqual(['female-thin', 'female-athletic', 'female-overweight', 'male-thin', 'male-athletic', 'male-overweight']);
    expect(data.targets.size).toBeGreaterThan(100);
  });

  it('blends with weights that sum correctly (ancestry, muscle and weight are partitions of unity)', () => {
    const w = targetWeights({ ...defaultParams(), gender: 0.3, muscle: 0.8, weight: 0.2 }, data.meta.detailTargets);
    const sum = (re: RegExp) => w.filter(([n]) => re.test(n)).reduce((s, [, x]) => s + x, 0);
    expect(sum(/^macrodetails\/(african|asian|caucasian)-female/)).toBeCloseTo(0.7, 9);
    expect(sum(/^macrodetails\/(african|asian|caucasian)-male/)).toBeCloseTo(0.3, 9);
    expect(sum(/^macrodetails\/universal-female/)).toBeCloseTo(0.7, 9);
    expect(sum(/^macrodetails\/universal-male/)).toBeCloseTo(0.3, 9);
  });

  it('reproduces the generator calibration: preset BMI matches within 0.3', () => {
    for (const p of data.meta.presets) {
      const coarse = blendCoarse(data, presetParams(p));
      const { bmi } = estimateBmi(data, coarse, p.referenceHeightCm / 100);
      expect(Math.abs(bmi - p.bmiAtReferenceHeight), p.id).toBeLessThan(0.3);
    }
  });
});

describe.each(data.meta.presets.map((p) => [p.id, p] as const))('preset %s', (_id, preset) => {
  const { b, surface } = bodyFor(presetParams(preset));

  it('is a closed, consistently oriented surface at the requested height', () => {
    const rep = checkManifold({ positions: surface.positions, indices: surface.indices });
    expect(rep.boundaryEdges).toBe(0);
    expect(rep.nonManifoldEdges).toBe(0);
    expect(rep.inconsistentEdges).toBe(0);
    expect(signedVolume({ positions: surface.positions, indices: surface.indices })).toBeGreaterThan(0);
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < surface.positions.length; i += 3) { minY = Math.min(minY, surface.positions[i]); maxY = Math.max(maxY, surface.positions[i]); }
    expect(maxY - minY).toBeCloseTo(H, 4);
    expect(Math.abs(minY)).toBeLessThan(1e-4);
    expect(surface.labels).toBeDefined();
  });

  it('finds every body region on the correct side', () => {
    const lab = { labels: surface.labels!, names: surface.partNames! };
    for (const r of REGIONS) {
      const pose = locateRegion(r, surface.positions, H, lab);
      expect(pose, r.id).not.toBeNull();
      if (r.side === 'left') expect(pose!.target.x, r.id).toBeGreaterThan(0.02);
      if (r.side === 'right') expect(pose!.target.x, r.id).toBeLessThan(-0.02);
      if (r.view === 'front' || r.view === 'back') {
        // Front and back of the same area: front must be nearer the viewer (the neck sits behind the body's centre).
        const twin = REGIONS.find((o) => o.view === (r.view === 'front' ? 'back' : 'front') && o.side === r.side && o.part === r.part && o.yMin === r.yMin);
        if (twin) {
          const other = locateRegion(twin, surface.positions, H, lab)!;
          const front = r.view === 'front' ? pose! : other, back = r.view === 'front' ? other : pose!;
          expect(front.target.z - back.target.z, r.id).toBeGreaterThan(0.03);
        }
      }
      expect(pose!.position.distanceTo(pose!.target), r.id).toBeGreaterThan(0.4);
    }
  });

  it('maps a 10 cm design on the outer left forearm with low distortion', () => {
    const lab = { labels: surface.labels!, names: surface.partNames! };
    const pose = locateRegion(REGIONS.find((r) => r.id === 'forearm-outer-left')!, surface.positions, H, lab)!;
    // Anchor: the forearm vertex nearest the region target.
    const fa = surface.partNames!.indexOf('forearm.L');
    let best = -1, bd = Infinity;
    for (let v = 0; v < surface.labels!.length; v++) {
      if (surface.labels![v] !== fa) continue;
      const d = Math.hypot(surface.positions[v * 3] - pose.target.x, surface.positions[v * 3 + 1] - pose.target.y, surface.positions[v * 3 + 2] - pose.target.z);
      if (d < bd) { bd = d; best = v; }
    }
    const tri = surface.vertTris[surface.triOffset[best]];
    const I = surface.indices, P = surface.positions;
    const point: [number, number, number] = [0, 1, 2].map((k) => (P[I[tri * 3] * 3 + k] + P[I[tri * 3 + 1] * 3 + k] + P[I[tri * 3 + 2] * 3 + k]) / 3) as [number, number, number];
    const normal = normalAt(surface, tri, barycentric(surface, tri, point));
    const patch = computeExpMap(surface, { tri, point, normal, tangent: designTangent(normal, 0) }, { radius: 0.08 });
    const vs = vertexStretch(surface, patch, 2);
    let worst = 0;
    for (let i = 0; i < patch.verts.length; i++) if (patch.dist[i] < 0.04 && Number.isFinite(vs.sMax[i])) worst = Math.max(worst, Math.abs(vs.sMax[i] - 1), Math.abs(vs.sMin[i] - 1));
    expect(patch.exactCoverage).toBeGreaterThan(0.95);
    expect(worst).toBeLessThan(0.05);
  });

  it('reports a BMI that fits the build at the reference height', () => {
    b.update(presetParams(preset), preset.referenceHeightCm / 100);
    const { bmi } = b.bmi();
    const range = { thin: [17.5, 20.5], athletic: [21.5, 26.5], overweight: [26.5, 30.5] }[preset.build];
    expect(bmi).toBeGreaterThan(range[0]);
    expect(bmi).toBeLessThan(range[1]);
  });
});

describe('presets at other heights', () => {
  it('keep their BMI at 193 cm and 155 cm (or the nearest the weight slider allows)', () => {
    for (const h of [1.93, 1.55]) {
      for (const p of data.meta.presets) {
        const params = presetParamsAtHeight(data, p, h);
        const { bmi } = estimateBmi(data, blendCoarse(data, params), h);
        if (params.weight > 0 && params.weight < 1) expect(Math.abs(bmi - p.bmiAtReferenceHeight), `${p.id} at ${h}`).toBeLessThan(0.1);
        else if (params.weight === 0) expect(bmi, `${p.id} at ${h}`).toBeGreaterThanOrEqual(p.bmiAtReferenceHeight - 0.1);
        else expect(bmi, `${p.id} at ${h}`).toBeLessThanOrEqual(p.bmiAtReferenceHeight + 0.1);
        // Order of builds is kept within each sex.
      }
      for (const sex of ['female', 'male']) {
        const bmis = ['thin', 'athletic', 'overweight'].map((b) => {
          const p = data.meta.presets.find((x) => x.sex === sex && x.build === b)!;
          return estimateBmi(data, blendCoarse(data, presetParamsAtHeight(data, p, h)), h).bmi;
        });
        expect(bmis[0]).toBeLessThan(bmis[1]);
        expect(bmis[1]).toBeLessThan(bmis[2]);
      }
    }
  });
});

describe('sliders', () => {
  const female = data.meta.presets.find((p) => p.id === 'female-athletic')!;
  const male = data.meta.presets.find((p) => p.id === 'male-athletic')!;

  function waist(params: BodyParams) {
    const { surface } = bodyFor(params);
    // Navel height is about 0.6 of standing height in MakeHuman proportions.
    const p = frontPoint(surface, 0, 0.6 * H);
    return circumferenceAt(surface, p)!.length;
  }

  it('belly and weight make the waist larger; waist slider makes it smaller', () => {
    const base = presetParams(male);
    const w0 = waist(base);
    const wBelly = waist({ ...base, details: { belly: 1 } });
    const wHeavy = waist({ ...base, weight: 1 });
    const wSlim = waist({ ...base, details: { waist: -1 } });
    expect(wBelly).toBeGreaterThan(w0 + 0.02);
    expect(wHeavy).toBeGreaterThan(w0 + 0.02);
    expect(wSlim).toBeLessThan(w0 - 0.01);
  });

  it('forearm size changes the forearm circumference and leaves the torso alone', () => {
    const base = presetParams(female);
    const around = (params: BodyParams) => {
      const { surface } = bodyFor(params);
      const lab = { labels: surface.labels!, names: surface.partNames! };
      const pose = locateRegion(REGIONS.find((r) => r.id === 'forearm-outer-left')!, surface.positions, H, lab)!;
      let best = -1, bd = Infinity;
      for (let t = 0; t < surface.indices.length / 3; t++) {
        const a = surface.indices[t * 3] * 3;
        const d = Math.hypot(surface.positions[a] - pose.target.x, surface.positions[a + 1] - pose.target.y, surface.positions[a + 2] - pose.target.z);
        if (d < bd) { bd = d; best = t; }
      }
      const I = surface.indices, P = surface.positions;
      const point = [0, 1, 2].map((k) => (P[I[best * 3] * 3 + k] + P[I[best * 3 + 1] * 3 + k] + P[I[best * 3 + 2] * 3 + k]) / 3) as [number, number, number];
      return circumferenceAt(surface, { tri: best, point })!.length;
    };
    const c0 = around(base), c1 = around({ ...base, details: { forearmSize: 1 } });
    expect(c1).toBeGreaterThan(c0 + 0.01);
    expect(Math.abs(waist({ ...base, details: { forearmSize: 1 } }) - waist(base))).toBeLessThan(0.002);
  });

  it('updates fast enough to follow a slider live', () => {
    const b = new BuilderBody(data, presetParams(male));
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) b.update({ ...presetParams(male), weight: i / 10, details: { belly: i / 10 } }, H);
    const ms = (performance.now() - t0) / 10;
    console.log(`builder update: ${ms.toFixed(1)} ms per slider step (${b.stencil.fineCount} vertices)`);
    expect(ms).toBeLessThan(80);
  });
});
