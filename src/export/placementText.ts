// Plain-language description of where a design sits, for the artist.

import type { SurfaceMesh } from '../mesh/topology';
import { barycentric, normalAt } from '../mapping/expmap';

const PART_NAMES: Record<string, string> = {
  head: 'head', neck: 'neck', torso: 'torso', 'shoulder.L': 'left shoulder', 'shoulder.R': 'right shoulder',
  'upperarm.L': 'left upper arm', 'upperarm.R': 'right upper arm', 'forearm.L': 'left forearm', 'forearm.R': 'right forearm',
  'hand.L': 'left hand', 'hand.R': 'right hand', 'thigh.L': 'left thigh', 'thigh.R': 'right thigh',
  'shin.L': 'left lower leg', 'shin.R': 'right lower leg', 'foot.L': 'left foot', 'foot.R': 'right foot',
};

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Left forearm, inner side", "Upper back", "Chest, left of centre" … */
export function describeArea(surface: SurfaceMesh, tri: number, point: [number, number, number], heightM: number): string {
  const n = normalAt(surface, tri, barycentric(surface, tri, point));
  const [x, y] = point;
  const f = y / heightM;
  let part = 'torso';
  if (surface.labels && surface.partNames) {
    const counts = new Map<number, number>();
    for (let k = 0; k < 3; k++) { const l = surface.labels[surface.indices[tri * 3 + k]]; counts.set(l, (counts.get(l) ?? 0) + 1); }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    part = surface.partNames[best] ?? 'torso';
  }
  const lateral = Math.sign(x) || 1; // +1 on the body's left
  const facing = (): string => {
    const dirs: Array<[string, number]> = [['front', n[2]], ['back', -n[2]], ['outer side', n[0] * lateral], ['inner side', -n[0] * lateral]];
    return dirs.sort((a, b) => b[1] - a[1])[0][0];
  };
  if (part === 'torso' || part === 'neck') {
    const front = n[2] >= 0;
    const side = Math.abs(n[0]) > 0.75 ? (x > 0 ? 'left' : 'right') : null;
    let zone: string;
    if (part === 'neck' || f > 0.81) zone = front ? 'throat' : 'back of the neck';
    else if (side && f > 0.56) zone = `${side} ribs`;
    else if (side) zone = `${side} hip`;
    else if (f > 0.68) zone = front ? 'chest' : 'upper back';
    else if (f > 0.54) zone = front ? 'stomach' : 'lower back';
    else zone = front ? 'lower stomach' : 'lower back';
    const off = !side && Math.abs(x) > 0.04 ? `, ${x > 0 ? 'left' : 'right'} of centre` : '';
    return cap(zone) + off;
  }
  const name = PART_NAMES[part] ?? part;
  if (part.startsWith('head')) return cap(name);
  return `${cap(name)}, ${facing()}`;
}

/** Rotation of the design for the artist: 0 means its top points along the body towards the head. */
export function describeRotation(rotationRad: number): string {
  const d = Math.round((rotationRad * 180) / Math.PI);
  if (Math.abs(d) < 1) return 'Upright (top of the design towards the head, along the body)';
  return `${Math.abs(d)}° ${d > 0 ? 'anticlockwise' : 'clockwise'} from upright, seen facing the skin`;
}
