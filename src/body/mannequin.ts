// Procedural placeholder body. Built from smooth-unioned capsules and
// ellipsoids, polygonised with marching cubes, so it is one closed,
// manifold surface with real double curvature at the joints.
//
// Coordinates: metres, Y up, feet on y=0, facing +Z. The subject's left
// side is at +X (as if you stand behind the model looking along +Z).
// Proportions follow a classic 8-head figure scaled to the given height.

import { marchingCubes, sampleField, type GridSpec, type IndexedMesh } from '../mesh/marchingCubes';
import { capsule, ellipsoid, sdUnion, type Primitive, type Vec3 } from '../mesh/sdf';

export interface MannequinOptions {
  /** Total height in metres (default 1.93). */
  height?: number;
  /** Grid cell size in metres (default 0.01). Smaller is finer and slower. */
  cell?: number;
}

/** Primitive list for a unit-height body (height = 1). */
export function mannequinPrimitives(): Primitive[] {
  const headTop = 1.0, chin = 0.875, shoulder = 0.82;
  const chest = 0.74, waist = 0.62, hip = 0.52, crotch = 0.47;
  const knee = 0.28, ankle = 0.045;
  const elbow = 0.63, wrist = 0.47;
  const shoulderX = 0.105; // half biacromial width
  const legX = 0.055;
  const k = 0.02; // default blend radius

  const prims: Primitive[] = [];
  // Head and neck
  prims.push(ellipsoid([0, (headTop + chin) / 2 + 0.003, 0.004], [0.044, 0.064, 0.053], k));
  prims.push(capsule([0, chin - 0.01, -0.005], [0, shoulder, -0.005], 0.03, 0.035, 0.03));
  // Torso: shoulders, chest, waist, pelvis, back
  prims.push(capsule([-shoulderX + 0.025, shoulder - 0.01, 0], [shoulderX - 0.025, shoulder - 0.01, 0], 0.04, 0.04, 0.04));
  prims.push(ellipsoid([0, chest, 0.0], [0.100, 0.100, 0.062], 0.05));
  prims.push(ellipsoid([0, waist + 0.02, -0.005], [0.085, 0.100, 0.058], 0.05));
  prims.push(ellipsoid([0, hip, 0.0], [0.092, 0.075, 0.062], 0.05));
  prims.push(ellipsoid([0, chest + 0.02, -0.03], [0.095, 0.085, 0.045], 0.04));
  // Arms, slight A-pose (hanging about 15 degrees out) so they clear the torso.
  for (const s of [-1, 1]) {
    const sh: Vec3 = [s * (shoulderX + 0.012), shoulder - 0.012, 0];
    const el: Vec3 = [s * (shoulderX + 0.055), elbow, -0.01];
    const wr: Vec3 = [s * (shoulderX + 0.09), wrist, 0.0];
    const hand: Vec3 = [s * (shoulderX + 0.10), wrist - 0.055, 0.0];
    prims.push(ellipsoid(sh, [0.033, 0.036, 0.034], 0.03)); // deltoid
    prims.push(capsule(sh, el, 0.029, 0.024, k));
    prims.push(capsule(el, wr, 0.025, 0.016, 0.015));
    prims.push(ellipsoid(hand, [0.026, 0.056, 0.014], 0.015));
  }
  // Legs
  for (const s of [-1, 1]) {
    const hp: Vec3 = [s * legX, crotch + 0.04, 0];
    const kn: Vec3 = [s * legX, knee, 0];
    const an: Vec3 = [s * legX, ankle, -0.01];
    prims.push(capsule(hp, kn, 0.048, 0.033, 0.03));
    prims.push(capsule(kn, an, 0.032, 0.020, k));
    prims.push(ellipsoid([s * legX, (knee + ankle) / 2 + 0.01, -0.012], [0.030, 0.06, 0.034], k)); // calf
    prims.push(capsule([s * legX, 0.022, -0.03], [s * legX, 0.02, 0.09], 0.022, 0.02, 0.012)); // foot
  }
  return prims;
}

/** Scale a unit-height primitive list to a real height in metres. */
export function scalePrimitives(prims: readonly Primitive[], h: number): Primitive[] {
  return prims.map((p) =>
    p.kind === 'ellipsoid'
      ? { ...p, cx: p.cx * h, cy: p.cy * h, cz: p.cz * h, rx: p.rx * h, ry: p.ry * h, rz: p.rz * h, k: p.k * h }
      : { ...p, ax: p.ax * h, ay: p.ay * h, az: p.az * h, bx: p.bx * h, by: p.by * h, bz: p.bz * h, ra: p.ra * h, rb: p.rb * h, k: p.k * h },
  );
}

/** Build the mannequin mesh at the requested height. */
export function buildMannequin(opts: MannequinOptions = {}): IndexedMesh {
  const height = opts.height ?? 1.93;
  const cell = opts.cell ?? 0.01;
  const prims = scalePrimitives(mannequinPrimitives(), height);
  const halfW = 0.26 * height, halfD = 0.16 * height;
  const c = cell;
  const grid: GridSpec = {
    nx: Math.ceil((2 * halfW) / c) + 3,
    ny: Math.ceil((height + 0.04) / c) + 3,
    nz: Math.ceil((2 * halfD) / c) + 3,
    origin: [-halfW - c, -0.02 - c, -halfD - c],
    cell: [c, c, c],
  };
  const field = sampleField(grid, (x, y, z) => sdUnion(x, y, z, prims));
  return marchingCubes(grid, field, 0);
}
