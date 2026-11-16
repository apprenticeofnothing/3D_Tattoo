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

/**
 * Find a region on a body given its world-space vertex positions (Y up,
 * feet at 0) and total height. Returns null when no vertices match.
 */
export function locateRegion(def: RegionDef, positions: Float32Array, height: number): RegionPose | null {
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
