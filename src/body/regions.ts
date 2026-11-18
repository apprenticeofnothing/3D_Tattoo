// Named body regions and a heuristic to find them on any standing body mesh.
// Heights are fractions of total height; "left" means the subject's left,
// which is +X when the body faces +Z.

import { Vector3 } from 'three';

export type Side = 'left' | 'right' | 'center';
export type Part = 'head' | 'torso' | 'arm' | 'leg';
export type View = 'front' | 'back' | 'outer' | 'inner' | 'top';

export interface RegionDef {
  id: string;
  label: string;
  group: string;
  yMin: number;
  yMax: number;
  side: Side;
  part: Part;
  view: View;
}

const R = (id: string, label: string, group: string, yMin: number, yMax: number, side: Side, part: Part, view: View): RegionDef =>
  ({ id, label, group, yMin, yMax, side, part, view });

function mirrored(idBase: string, label: string, group: string, yMin: number, yMax: number, part: Part, view: View): RegionDef[] {
  return [
    R(`${idBase}-left`, `Left ${label}`, group, yMin, yMax, 'left', part, view),
    R(`${idBase}-right`, `Right ${label}`, group, yMin, yMax, 'right', part, view),
  ];
}

export const REGIONS: RegionDef[] = [
  R('head-front', 'Face', 'Head and neck', 0.88, 1.0, 'center', 'head', 'front'),
  R('head-back', 'Back of head', 'Head and neck', 0.88, 1.0, 'center', 'head', 'back'),
  R('neck-front', 'Throat', 'Head and neck', 0.81, 0.88, 'center', 'torso', 'front'),
  R('neck-back', 'Nape', 'Head and neck', 0.81, 0.88, 'center', 'torso', 'back'),
  R('chest', 'Chest', 'Torso', 0.68, 0.81, 'center', 'torso', 'front'),
  R('stomach', 'Stomach', 'Torso', 0.54, 0.68, 'center', 'torso', 'front'),
  ...mirrored('ribs', 'ribs', 'Torso', 0.58, 0.72, 'torso', 'outer'),
  R('upper-back', 'Upper back', 'Torso', 0.66, 0.82, 'center', 'torso', 'back'),
  R('lower-back', 'Lower back', 'Torso', 0.50, 0.66, 'center', 'torso', 'back'),
  ...mirrored('hip', 'hip', 'Torso', 0.46, 0.56, 'torso', 'outer'),
  ...mirrored('shoulder', 'shoulder', 'Arms', 0.78, 0.86, 'arm', 'outer'),
  ...mirrored('upper-arm-outer', 'upper arm (outer)', 'Arms', 0.66, 0.79, 'arm', 'outer'),
  ...mirrored('upper-arm-inner', 'upper arm (inner)', 'Arms', 0.66, 0.79, 'arm', 'inner'),
  ...mirrored('forearm-outer', 'forearm (outer)', 'Arms', 0.50, 0.63, 'arm', 'outer'),
  ...mirrored('forearm-inner', 'forearm (inner)', 'Arms', 0.50, 0.63, 'arm', 'inner'),
  ...mirrored('hand', 'hand', 'Arms', 0.39, 0.49, 'arm', 'outer'),
  ...mirrored('thigh-front', 'thigh (front)', 'Legs', 0.32, 0.47, 'leg', 'front'),
  ...mirrored('thigh-back', 'thigh (back)', 'Legs', 0.32, 0.47, 'leg', 'back'),
  ...mirrored('thigh-outer', 'thigh (outer)', 'Legs', 0.32, 0.47, 'leg', 'outer'),
  ...mirrored('knee', 'knee', 'Legs', 0.25, 0.32, 'leg', 'front'),
  ...mirrored('shin', 'shin', 'Legs', 0.08, 0.25, 'leg', 'front'),
  ...mirrored('calf', 'calf', 'Legs', 0.08, 0.25, 'leg', 'back'),
  ...mirrored('foot', 'foot (top)', 'Legs', 0.0, 0.08, 'leg', 'top'),
];

export interface RegionPose {
  /** Point on the skin the camera should look at (world metres). */
  target: Vector3;
  /** Camera position (world metres). */
  position: Vector3;
}

export interface PartLabels { labels: Uint8Array; names: string[] }

/** Labelled parts used for each region (bodies with a skeleton). Fractions run from the joint nearer the trunk. */
const LABELLED: Record<string, { parts: string[]; from?: number; to?: number; also?: { parts: string[]; from?: number; to?: number } }> = {
  'head-front': { parts: ['head'] }, 'head-back': { parts: ['head'] },
  'neck-front': { parts: ['neck'] }, 'neck-back': { parts: ['neck'] },
  shoulder: { parts: ['upperarm', 'shoulder'], from: 0, to: 0.3 },
  'upper-arm-outer': { parts: ['upperarm'], from: 0.25, to: 1 }, 'upper-arm-inner': { parts: ['upperarm'], from: 0.25, to: 1 },
  'forearm-outer': { parts: ['forearm'] }, 'forearm-inner': { parts: ['forearm'] },
  hand: { parts: ['hand'] },
  'thigh-front': { parts: ['thigh'], from: 0.1, to: 0.9 }, 'thigh-back': { parts: ['thigh'], from: 0.1, to: 0.9 }, 'thigh-outer': { parts: ['thigh'], from: 0.1, to: 0.9 },
  knee: { parts: ['thigh'], from: 0.85, to: 1, also: { parts: ['shin'], from: 0, to: 0.12 } },
  shin: { parts: ['shin'], from: 0.1, to: 0.9 }, calf: { parts: ['shin'], from: 0.1, to: 0.9 },
  foot: { parts: ['foot'] },
};

function baseId(def: RegionDef): string { return def.id.replace(/-(left|right)$/, ''); }

/** Vertex ids carrying any of the given part names on the region's side, limited to a fraction along the limb. */
function labelledVertices(positions: Float32Array, lab: PartLabels, parts: string[], side: Side, from = 0, to = 1): number[] {
  const suffix = side === 'left' ? '.L' : side === 'right' ? '.R' : '';
  const ids = new Set<number>();
  parts.forEach((p) => {
    const i1 = lab.names.indexOf(p + suffix), i2 = lab.names.indexOf(p);
    if (i1 >= 0) ids.add(i1);
    if (i2 >= 0 && !suffix) ids.add(i2);
  });
  const sel: number[] = [];
  for (let v = 0; v < lab.labels.length; v++) if (ids.has(lab.labels[v])) sel.push(v);
  if (sel.length === 0 || (from <= 0 && to >= 1)) return sel;
  // Principal axis of the selection; the proximal end is the one nearer the body's centre line.
  const ax = limbAxis(positions, sel);
  const proj = sel.map((v) => (positions[v * 3] - ax.c[0]) * ax.d[0] + (positions[v * 3 + 1] - ax.c[1]) * ax.d[1] + (positions[v * 3 + 2] - ax.c[2]) * ax.d[2]);
  let lo = Infinity, hi = -Infinity;
  for (const t of proj) { lo = Math.min(lo, t); hi = Math.max(hi, t); }
  // Which end is proximal: farther from the centre line x = 0 is distal for arms; higher is proximal for legs.
  const endA = [ax.c[0] + ax.d[0] * lo, ax.c[1] + ax.d[1] * lo, ax.c[2] + ax.d[2] * lo];
  const endB = [ax.c[0] + ax.d[0] * hi, ax.c[1] + ax.d[1] * hi, ax.c[2] + ax.d[2] * hi];
  const proxIsLo = Math.abs(endA[0]) - endA[1] * 0.5 < Math.abs(endB[0]) - endB[1] * 0.5;
  const out: number[] = [];
  sel.forEach((v, i) => {
    let f = (proj[i] - lo) / (hi - lo || 1);
    if (!proxIsLo) f = 1 - f;
    if (f >= from && f <= to) out.push(v);
  });
  return out;
}

function limbAxis(positions: Float32Array, sel: number[]): { c: [number, number, number]; d: [number, number, number] } {
  let cx = 0, cy = 0, cz = 0;
  for (const v of sel) { cx += positions[v * 3]; cy += positions[v * 3 + 1]; cz += positions[v * 3 + 2]; }
  cx /= sel.length; cy /= sel.length; cz /= sel.length;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (const v of sel) {
    const dx = positions[v * 3] - cx, dy = positions[v * 3 + 1] - cy, dz = positions[v * 3 + 2] - cz;
    xx += dx * dx; xy += dx * dy; xz += dx * dz; yy += dy * dy; yz += dy * dz; zz += dz * dz;
  }
  let ax = 0.3, ay = 1, az = 0.2;
  for (let it = 0; it < 60; it++) {
    const nx = xx * ax + xy * ay + xz * az, ny = xy * ax + yy * ay + yz * az, nz = xz * ax + yz * ay + zz * az;
    const l = Math.hypot(nx, ny, nz) || 1; ax = nx / l; ay = ny / l; az = nz / l;
  }
  return { c: [cx, cy, cz], d: [ax, ay, az] };
}

function poseFrom(positions: Float32Array, sel: number[], dir: Vector3, def: RegionDef, height: number): RegionPose | null {
  if (sel.length === 0) return null;
  const c = new Vector3();
  for (const i of sel) c.add(new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
  c.multiplyScalar(1 / sel.length);
  const facing = sel.filter((i) => (positions[i * 3] - c.x) * dir.x + (positions[i * 3 + 1] - c.y) * dir.y + (positions[i * 3 + 2] - c.z) * dir.z > 0);
  const use = facing.length > 10 ? facing : sel;
  // Keep the half most toward the viewer so the target sits on the skin.
  const scored = use.map((i) => ({ i, s: positions[i * 3] * dir.x + positions[i * 3 + 1] * dir.y + positions[i * 3 + 2] * dir.z })).sort((a, b) => b.s - a.s);
  const top = scored.slice(0, Math.max(5, Math.ceil(scored.length * 0.5)));
  const target = new Vector3();
  for (const { i } of top) target.add(new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
  target.multiplyScalar(1 / top.length);
  const dist = def.part === 'torso' ? 1.3 : def.part === 'head' ? 0.9 : def.part === 'arm' ? 0.95 : 1.1;
  return { target, position: target.clone().addScaledVector(dir, dist * (height / 1.8)) };
}

function locateLabelled(def: RegionDef, positions: Float32Array, height: number, lab: PartLabels): RegionPose | null {
  const spec = LABELLED[baseId(def)];
  let dir = viewDirection(def);
  if (!spec) {
    // Torso regions: torso label within the height band.
    const torso = labelledVertices(positions, lab, ['torso'], 'center');
    const yMin = def.yMin * height, yMax = def.yMax * height;
    const sel = torso.filter((v) => {
      const x = positions[v * 3], y = positions[v * 3 + 1];
      if (y < yMin || y > yMax) return false;
      if (def.side === 'left' && x <= 0) return false;
      if (def.side === 'right' && x >= 0) return false;
      return true;
    });
    return poseFrom(positions, sel, dir, def, height);
  }
  let sel = labelledVertices(positions, lab, spec.parts, def.side, spec.from, spec.to);
  if (spec.also) sel = sel.concat(labelledVertices(positions, lab, spec.also.parts, def.side, spec.also.from, spec.also.to));
  if (sel.length === 0) return null;
  if (def.part === 'arm' || def.part === 'leg') {
    // View perpendicular to the limb so "outer"/"front" mean the same on a raised or hanging limb.
    const { d } = limbAxis(positions, sel);
    const a = new Vector3(...d);
    const perp = dir.clone().addScaledVector(a, -dir.dot(a));
    if (perp.lengthSq() > 1e-6) dir = perp.normalize();
  }
  return poseFrom(positions, sel, dir, def, height);
}

/**
 * Find a region on a body given its world-space vertex positions (Y up,
 * feet at 0) and total height. Uses body-part labels when the body has
 * them (body builder), otherwise a height-band heuristic. Returns null
 * when no vertices match.
 */
export function locateRegion(def: RegionDef, positions: Float32Array, height: number, labels?: PartLabels): RegionPose | null {
  if (labels) return locateLabelled(def, positions, height, labels);
  const yMin = def.yMin * height, yMax = def.yMax * height;
  // Pass 1: band extents.
  let maxAbsX = 0, count = 0;
  for (let i = 0; i < positions.length; i += 3) {
    const y = positions[i + 1];
    if (y < yMin || y > yMax) continue;
    count++;
    maxAbsX = Math.max(maxAbsX, Math.abs(positions[i]));
  }
  if (count === 0) return null;

  // Pass 2: select vertices for the part and side.
  const sel: number[] = [];
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1];
    if (y < yMin || y > yMax) continue;
    const ax = Math.abs(x);
    if (def.part === 'arm' && ax < 0.62 * maxAbsX) continue; // arms are the outermost
    if (def.part === 'leg' && ax > 0.12 * height) continue; // ignore hands hanging beside the thighs
    if (def.part === 'torso' && def.side === 'center' && ax > 0.55 * maxAbsX) continue;
    if (def.part === 'torso' && def.side !== 'center' && ax > 0.6 * maxAbsX) continue;
    if (def.side === 'left' && x <= 0) continue;
    if (def.side === 'right' && x >= 0) continue;
    sel.push(i);
  }
  if (sel.length === 0) return null;

  // Centroid of the selection, then keep only the half facing the camera so
  // the target lands near the skin instead of inside the limb.
  const c = new Vector3();
  for (const i of sel) c.add(new Vector3(positions[i], positions[i + 1], positions[i + 2]));
  c.multiplyScalar(1 / sel.length);
  const dir = viewDirection(def);
  const facing = sel.filter((i) => (positions[i] - c.x) * dir.x + (positions[i + 1] - c.y) * dir.y + (positions[i + 2] - c.z) * dir.z > 0);
  const target = new Vector3();
  const use = facing.length > 10 ? facing : sel;
  for (const i of use) target.add(new Vector3(positions[i], positions[i + 1], positions[i + 2]));
  target.multiplyScalar(1 / use.length);

  const dist = def.part === 'torso' ? 1.3 : def.part === 'head' ? 0.9 : def.part === 'arm' ? 0.95 : 1.1;
  const position = target.clone().addScaledVector(dir, dist * (height / 1.8));
  return { target, position };
}

/** Unit direction from the skin toward the camera for a region. */
export function viewDirection(def: RegionDef): Vector3 {
  const sideSign = def.side === 'left' ? 1 : def.side === 'right' ? -1 : 0;
  switch (def.view) {
    case 'front': return new Vector3(0.15 * sideSign, 0.05, 1).normalize();
    case 'back': return new Vector3(0.15 * sideSign, 0.05, -1).normalize();
    case 'outer': return new Vector3(sideSign || 1, 0.05, 0.25).normalize();
    case 'inner': return new Vector3(-(sideSign || 1), -0.1, 0.6).normalize();
    case 'top': return new Vector3(0, 1, 0.7).normalize();
  }
}
