// Arm posing for the body builder: forward kinematics from MakeHuman's
// joints and dual-quaternion skinning with MakeHuman's bone weights.
// Only the arms move; everything else stays as modelled (A-pose).
//
// Angles are in degrees.
//   raise   elevation of the upper arm: 0 hanging down, 90 horizontal, 180 straight up
//   forward plane of elevation: 0 out to the side, 90 straight forward, negative behind
//   twist   upper-arm rotation about its own axis relative to rest, + = outward (external)
//   bend    elbow flexion: 0 straight, 150 fully bent
//   turn    forearm rotation relative to rest, + = palm up / forward (supination)

import { Quaternion, Vector3 } from 'three';

export interface ArmPose { raise: number; forward: number; twist: number; bend: number; turn: number }
export type Side = 'left' | 'right';
/** Missing fields mean "as modelled" (the rest pose). */
export interface Pose { left?: Partial<ArmPose>; right?: Partial<ArmPose> }

export const POSE_LIMITS: Record<keyof ArmPose, [number, number]> = {
  raise: [0, 160], forward: [-40, 130], twist: [-90, 90], bend: [0, 150], turn: [-90, 120],
};

export const POSE_PRESETS: Array<{ id: string; label: string; arm: Partial<ArmPose> | null }> = [
  { id: 'relaxed', label: 'Relaxed', arm: null },
  { id: 'down', label: 'Arms down', arm: { raise: 10, forward: 5, twist: 0, bend: 8, turn: 0 } },
  { id: 'tpose', label: 'Arms out', arm: { raise: 90, forward: 0, twist: 0, bend: 0, turn: 0 } },
  { id: 'inner', label: 'Inner arm', arm: { raise: 55, forward: 35, twist: 40, bend: 5, turn: 95 } },
  { id: 'flex', label: 'Flex', arm: { raise: 90, forward: 0, twist: 85, bend: 100, turn: 60 } },
  { id: 'up', label: 'Arm up', arm: { raise: 150, forward: 15, twist: 0, bend: 10, turn: 0 } },
];

export interface Joints { [name: string]: [number, number, number] }

const sideSuffix = (s: Side) => (s === 'left' ? 'L' : 'R');
const v3 = (p: [number, number, number]) => new Vector3(p[0], p[1], p[2]);

/** Joint positions as the mean of their vertex groups. */
export function jointPositions(coarse: Float32Array, joints: Record<string, number[]>): Joints {
  const out: Joints = {};
  for (const [name, idx] of Object.entries(joints)) {
    let x = 0, y = 0, z = 0;
    for (const i of idx) { x += coarse[i * 3]; y += coarse[i * 3 + 1]; z += coarse[i * 3 + 2]; }
    out[name] = [x / idx.length, y / idx.length, z / idx.length];
  }
  return out;
}

export interface RestArm { raise: number; forward: number; bend: number; shoulder: Vector3; elbow: Vector3; wrist: Vector3; hinge: Vector3 }

/** The modelled (rest) arm angles of one side. */
export function restArm(j: Joints, side: Side): RestArm {
  const S = sideSuffix(side);
  const shoulder = v3(j[`upperarm01.${S}____head`]), elbow = v3(j[`lowerarm01.${S}____head`]), wrist = v3(j[`wrist.${S}____head`]);
  const dU = elbow.clone().sub(shoulder).normalize();
  const dF = wrist.clone().sub(elbow).normalize();
  const lat = side === 'left' ? 1 : -1;
  const raise = (Math.acos(Math.min(1, Math.max(-1, -dU.y))) * 180) / Math.PI;
  const forward = (Math.atan2(dU.z, lat * dU.x) * 180) / Math.PI;
  const bend = (dU.angleTo(dF) * 180) / Math.PI;
  let hinge = dU.clone().cross(dF);
  if (hinge.lengthSq() < 1e-8) hinge = dU.clone().cross(new Vector3(0, 0, 1));
  return { raise, forward, bend, shoulder, elbow, wrist, hinge: hinge.normalize() };
}

/** Rigid transform x' = q x + t. */
interface Rigid { q: Quaternion; t: Vector3 }
const ident = (): Rigid => ({ q: new Quaternion(), t: new Vector3() });
const about = (c: Vector3, q: Quaternion): Rigid => ({ q: q.clone(), t: c.clone().sub(c.clone().applyQuaternion(q)) });
const compose = (a: Rigid, b: Rigid): Rigid => ({ q: a.q.clone().multiply(b.q), t: b.t.clone().applyQuaternion(a.q).add(a.t) });
const apply = (r: Rigid, p: Vector3) => p.clone().applyQuaternion(r.q).add(r.t);
const axisAngle = (axis: Vector3, deg: number) => new Quaternion().setFromAxisAngle(axis.clone().normalize(), (deg * Math.PI) / 180);
const rad = (d: number) => (d * Math.PI) / 180;

/** Fill in missing pose fields with the rest values. */
export function fullArm(rest: RestArm, p: Partial<ArmPose> | undefined): ArmPose {
  return {
    raise: p?.raise ?? rest.raise, forward: p?.forward ?? rest.forward, twist: p?.twist ?? 0,
    bend: p?.bend ?? rest.bend, turn: p?.turn ?? 0,
  };
}

/** Everything the forward model computes for one arm. */
interface ArmChain {
  C: Rigid; sh: Vector3; dT: Vector3; swing: Quaternion; tw: number;
  shoulder01: Rigid; upper01: Rigid; U: Rigid; elbow: Vector3; hingeNoTwist: Vector3;
  F0: Rigid; axis: Vector3; g: number; fore: (f: number) => Rigid;
}

function armChain(j: Joints, side: Side, rest: RestArm, arm: ArmPose): ArmChain {
  const S = sideSuffix(side), lat = side === 'left' ? 1 : -1;
  const clavHead = v3(j[`clavicle.${S}____head`]);
  // Shoulder girdle: the collarbone elevates only above about 60 degrees of
  // arm elevation and by roughly 15 degrees at 150 (measured clavicle
  // kinematics), pivoting at its breastbone end. The shoulder joint's own
  // rotation does the rest.
  const girdle = (raise: number) => Math.max(0, raise - 60) / 6;
  const h = new Vector3(lat * Math.cos(rad(arm.forward)), 0, Math.sin(rad(arm.forward)));
  const girdleAxis = new Vector3(0, -1, 0).cross(h).normalize();
  const C = about(clavHead, axisAngle(girdleAxis, girdle(arm.raise) - girdle(rest.raise)));
  const sh = apply(C, rest.shoulder);
  const dRest = rest.elbow.clone().sub(rest.shoulder).normalize().applyQuaternion(C.q);
  const dT = new Vector3(0, -Math.cos(rad(arm.raise)), 0).add(h.clone().multiplyScalar(Math.sin(rad(arm.raise)))).normalize();
  const swing = new Quaternion().setFromUnitVectors(dRest, dT);
  const tw = -lat * arm.twist; // + twist = external rotation
  const upper = (twistFrac: number, swingFrac = 1) => {
    const qs = new Quaternion().slerp(swing, swingFrac);
    return compose(about(sh, axisAngle(dT, tw * twistFrac).multiply(qs)), C);
  };
  // The shoulder bone (top of the shoulder, trapezius) moves with the girdle
  // and takes a quarter of the arm's own swing, which softens the deltoid.
  const shoulder01 = upper(0, 0.25);
  const upper01 = upper(0.4);
  const U = upper(1);
  const elbow = apply(U, rest.elbow);
  const hingeNoTwist = rest.hinge.clone().applyQuaternion(swing.clone().multiply(C.q));
  const hinge = rest.hinge.clone().applyQuaternion(U.q);
  const E = about(elbow, axisAngle(hinge, arm.bend - rest.bend));
  const F0 = compose(E, U);
  const axis = apply(F0, rest.wrist).sub(elbow).normalize();
  const g = -lat * arm.turn; // + turn = supination
  const fore = (f: number) => compose(about(elbow, axisAngle(axis, g * f)), F0);
  return { C, sh, dT, swing, tw, shoulder01, upper01, U, elbow, hingeNoTwist, F0, axis, g, fore };
}

/**
 * Rigid transforms for the 17 pose bones: 0 static, then per side
 * clavicle, shoulder01, upperarm01, upperarm02, lowerarm01, lowerarm02, wrist, hand.
 */
export function boneTransforms(j: Joints, pose: Pose, poseBones: string[]): Rigid[] {
  const out: Rigid[] = [ident()];
  for (const side of ['left', 'right'] as Side[]) {
    const rest = restArm(j, side);
    const isRest = !pose[side] || Object.values(pose[side]!).every((v) => v === undefined);
    if (isRest) { for (let k = 0; k < poseBones.length; k++) out.push(ident()); continue; }
    const c = armChain(j, side, rest, fullArm(rest, pose[side]));
    const bySide: Record<string, Rigid> = {
      clavicle: c.C, shoulder01: c.shoulder01, upperarm01: c.upper01, upperarm02: c.U,
      lowerarm01: c.fore(0.2), lowerarm02: c.fore(0.7), wrist: c.fore(1), hand: c.fore(1),
    };
    for (const b of poseBones) out.push(bySide[b] ?? ident());
  }
  return out;
}

const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));
const deg = (r: number) => (r * 180) / Math.PI;

/** Raise and forward angles that point the upper arm along `d`. */
function anglesFor(d: Vector3, lat: number): { raise: number; forward: number } {
  const raise = deg(Math.acos(Math.min(1, Math.max(-1, -d.y))));
  const horiz = Math.hypot(d.x, d.z);
  const forward = horiz < 1e-6 ? 0 : deg(Math.atan2(d.z, lat * d.x));
  return { raise, forward };
}

/** Smallest signed difference of two angles in degrees. */
const angleDiff = (x: number, y: number) => ((((x - y) % 360) + 540) % 360) - 180;
const smooth01 = (lo: number, hi: number, x: number) => { const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo))); return t * t * (3 - 2 * t); };

/**
 * Inverse kinematics for one arm. `joint` is the joint being dragged:
 *  - 'wrist': the wrist goes to the target and the arm moves as little as
 *    it can from `start` (the arm when the drag began): the elbow stays
 *    where it was if the hand can get there by bending and turning the
 *    arm, and the upper arm's rotation stays while the arm is nearly
 *    straight (there it would only spin the arm without moving the hand).
 *    The result depends only on the target, so a hand dragged out and back
 *    returns the arm exactly as it was. Within the joint limits.
 *  - 'elbow': the upper arm swings to the target; bend, rotation and turn
 *    stay, so the forearm and hand come along.
 * Positions are in the same frame as `j`. Returns the new pose of that arm.
 */
export function solveArmIK(j: Joints, pose: Pose, side: Side, joint: 'wrist' | 'elbow', target: Vector3, start?: Partial<ArmPose>): ArmPose {
  const rest = restArm(j, side);
  const lat = side === 'left' ? 1 : -1;
  const arm = fullArm(rest, pose[side]);
  if (joint === 'elbow') {
    for (let iter = 0; iter < 3; iter++) {
      const d = target.clone().sub(armChain(j, side, rest, arm).sh);
      if (d.lengthSq() < 1e-10) break;
      const ang = anglesFor(d.normalize(), lat);
      arm.raise = clamp(ang.raise, POSE_LIMITS.raise);
      arm.forward = clamp(ang.forward, POSE_LIMITS.forward);
    }
    return arm;
  }
  const ref = fullArm(rest, start ?? pose[side]);
  const refElbow = armChain(j, side, rest, ref).elbow;
  const a = rest.elbow.distanceTo(rest.shoulder), b = rest.wrist.distanceTo(rest.elbow);
  const maxBend = POSE_LIMITS.bend[1];
  const dMin = Math.sqrt(a * a + b * b - 2 * a * b * Math.cos(rad(180 - maxBend)));
  let best = { ...arm };
  for (let iter = 0; iter < 2; iter++) {
    // The shoulder itself rises with the collarbone for raised arms.
    const sh = armChain(j, side, rest, best).sh;
    const v = target.clone().sub(sh);
    const dist0 = v.length();
    if (dist0 < 1e-6) break;
    const dir = v.clone().divideScalar(dist0);
    const d = Math.min(a + b - 1e-6, Math.max(dMin + 1e-6, dist0));
    const cosA = Math.min(1, Math.max(-1, (a * a + d * d - b * b) / (2 * a * d)));
    const sinA = Math.sqrt(1 - cosA * cosA);
    const centre = sh.clone().add(dir.clone().multiplyScalar(a * cosA));
    // The elbow is on a circle around the shoulder-to-target line. Swivel
    // angle 0 is the point nearest the elbow the drag started with.
    const perp = (x: Vector3) => x.clone().sub(dir.clone().multiplyScalar(x.dot(dir)));
    let u = perp(refElbow.clone().sub(sh));
    if (u.lengthSq() < 1e-10) u = perp(new Vector3(lat * 0.35, -1, -0.35));
    if (u.lengthSq() < 1e-10) u = perp(new Vector3(0, 0, -1));
    u.normalize();
    const w = dir.clone().cross(u);
    // Elbow bend from the triangle; the upper arm's rotation only moves the
    // hand once the elbow is bent, so near straight it is kept as it was.
    const bendGeom = 180 - deg(Math.acos(Math.min(1, Math.max(-1, (a * a + b * b - d * d) / (2 * a * b)))));
    const twistWeight = 0.03 + 1.5 * (1 - smooth01(5, 45, bendGeom));
    const evaluate = (psi: number) => {
      const e = centre.clone().add(u.clone().multiplyScalar(a * sinA * Math.cos(psi))).add(w.clone().multiplyScalar(a * sinA * Math.sin(psi)));
      const ang = anglesFor(e.sub(sh).normalize(), lat);
      const raise = clamp(ang.raise, POSE_LIMITS.raise);
      const cand: ArmPose = { ...arm, raise, forward: clamp(ang.forward, forwardRange(raise)), twist: ref.twist };
      // With raise and forward fixed (possibly clamped), aim the forearm at the target.
      const fixed = armChain(j, side, rest, { ...cand, twist: 0 });
      const upperDir = fixed.dT;
      const elbowPos = fixed.sh.clone().add(upperDir.clone().multiplyScalar(a));
      const f = target.clone().sub(elbowPos);
      if (f.lengthSq() > 1e-12) {
        f.normalize();
        cand.bend = clamp(deg(upperDir.angleTo(f)), POSE_LIMITS.bend);
        const kStar = upperDir.clone().cross(f);
        if (kStar.lengthSq() > 1e-10) {
          kStar.normalize();
          const k0 = fixed.hingeNoTwist.clone().sub(upperDir.clone().multiplyScalar(fixed.hingeNoTwist.dot(upperDir))).normalize();
          const twRad = Math.atan2(upperDir.dot(k0.clone().cross(kStar)), k0.dot(kStar));
          cand.twist = clamp(-lat * deg(twRad), POSE_LIMITS.twist);
        }
      }
      const c = armChain(j, side, rest, cand);
      const wrist = apply(c.F0, rest.wrist);
      const cost = 60 * wrist.distanceToSquared(target) / (a * a)
        + c.elbow.distanceToSquared(refElbow) / (a * a)
        + twistWeight * (angleDiff(cand.twist, ref.twist) / 180) ** 2;
      return { cand, cost };
    };
    // Follow the cost downhill from the current swivel, so the arm moves
    // continuously and never flips to a far-off elbow position. A straight
    // arm has no swivel yet: there the best point on the circle is taken.
    const N = 72, step = (2 * Math.PI) / N;
    const costs = Array.from({ length: N }, (_, k) => evaluate(k * step).cost);
    const cur = armChain(j, side, rest, arm);
    const ce = perp(cur.elbow.clone().sub(centre));
    let bi = 0;
    if (arm.bend > 3 && sinA > 0.05 && ce.length() > 0.2 * a * sinA) {
      bi = ((Math.round(Math.atan2(ce.dot(w), ce.dot(u)) / step) % N) + N) % N;
      for (let guard = 0; guard < N; guard++) {
        const l = (bi + N - 1) % N, r = (bi + 1) % N;
        const nb = costs[l] < costs[r] ? l : r;
        if (costs[nb] >= costs[bi]) break;
        bi = nb;
      }
    } else {
      for (let k = 1; k < N; k++) if (costs[k] < costs[bi]) bi = k;
    }
    let lo = step * (bi - 1), hi = step * (bi + 1);
    const g = (Math.sqrt(5) - 1) / 2;
    let x1 = hi - g * (hi - lo), x2 = lo + g * (hi - lo), f1 = evaluate(x1).cost, f2 = evaluate(x2).cost;
    for (let k = 0; k < 16; k++) {
      if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - g * (hi - lo); f1 = evaluate(x1).cost; }
      else { lo = x1; x1 = x2; f1 = f2; x2 = lo + g * (hi - lo); f2 = evaluate(x2).cost; }
    }
    best = evaluate((lo + hi) / 2).cand;
  }
  return best;
}

/**
 * Plane-of-elevation range for an upper arm raised by `raise` degrees. A
 * hanging arm can point anywhere around (the angle hardly means anything
 * there); a raised one cannot go far behind the body.
 */
function forwardRange(raise: number): [number, number] {
  const s = smooth01(25, 60, raise);
  return [POSE_LIMITS.forward[0] - 80 * (1 - s), POSE_LIMITS.forward[1] + 50 * (1 - s)];
}

/**
 * Biceps bulge for elbow flexion, as a pose corrective on the rest shape.
 * A bending elbow shortens the biceps, and a muscle keeps its volume, so
 * its belly thickens. Skinning alone cannot do that. Front-of-arm vertices
 * between 30% and 92% of the way from shoulder to elbow move outward, most
 * at 62% (the belly) and straight at the front, by `BICEPS_BULGE_M` at
 * full bend. This is an approximation of a relaxed arm: a tensed biceps
 * bulges more.
 */
export const BICEPS_BULGE_M = 0.005;

export interface Bulge { index: Uint32Array; dir: Float32Array }

/** Per-vertex bulge direction times profile (native units per metre of bulge). */
export function bicepsBulge(coarse: Float32Array, labels: Uint8Array, parts: string[], j: Joints, side: Side, metresPerUnit: number): Bulge {
  const S = sideSuffix(side);
  const rest = restArm(j, side);
  const upperPart = parts.indexOf(`upperarm.${S}`);
  const dU = rest.elbow.clone().sub(rest.shoulder);
  const L = dU.length(); dU.normalize();
  const dF = rest.wrist.clone().sub(rest.elbow).normalize();
  const front = dF.clone().sub(dU.clone().multiplyScalar(dF.dot(dU))).normalize();
  const idx: number[] = [], dir: number[] = [];
  const p = new Vector3();
  for (let v = 0; v < labels.length; v++) {
    if (labels[v] !== upperPart) continue;
    p.set(coarse[v * 3], coarse[v * 3 + 1], coarse[v * 3 + 2]).sub(rest.shoulder);
    const t = p.dot(dU) / L;
    if (t <= 0.3 || t >= 0.92) continue;
    const radial = p.clone().sub(dU.clone().multiplyScalar(p.dot(dU)));
    const r = radial.length();
    if (r < 1e-9) continue;
    radial.divideScalar(r);
    const c = radial.dot(front);
    if (c <= 0) continue;
    const along = Math.sin((Math.PI * (t - 0.3)) / 0.62) ** 2;
    const k = (along * c * c) / metresPerUnit;
    idx.push(v); dir.push(radial.x * k, radial.y * k, radial.z * k);
  }
  return { index: Uint32Array.from(idx), dir: Float32Array.from(dir) };
}

/** Bulge amount (metres) for an arm pose: none up to the modelled bend, full at 150 degrees. */
export function bulgeAmount(rest: RestArm, arm: Partial<ArmPose> | undefined): number {
  const bend = arm?.bend ?? rest.bend;
  const span = POSE_LIMITS.bend[1] - rest.bend;
  return span > 0 ? BICEPS_BULGE_M * Math.min(1, Math.max(0, (bend - rest.bend) / span)) : 0;
}

/** Posed joint positions (for tests and the camera). */
export function posedJoints(j: Joints, pose: Pose, poseBones: string[]): Joints {
  const T = boneTransforms(j, pose, poseBones);
  const out: Joints = {};
  for (const [name, p] of Object.entries(j)) {
    const m = /^(.+)\.(L|R)____(head|tail)$/.exec(name);
    if (!m) { out[name] = p; continue; }
    const side = m[2] === 'L' ? 0 : 1;
    // A joint moves with the bone it starts (its head) or ends (its tail).
    let bone = m[1].startsWith('finger') ? 'hand' : m[1];
    if (m[3] === 'tail') bone = ({ clavicle: 'clavicle', shoulder01: 'shoulder01', upperarm01: 'upperarm01', upperarm02: 'upperarm02', lowerarm01: 'lowerarm01', lowerarm02: 'lowerarm02', wrist: 'hand' } as Record<string, string>)[bone] ?? bone;
    if (m[3] === 'head') bone = ({ clavicle: 'static', shoulder01: 'clavicle', upperarm01: 'clavicle', upperarm02: 'upperarm01', lowerarm01: 'upperarm02', lowerarm02: 'lowerarm01', wrist: 'lowerarm02' } as Record<string, string>)[bone] ?? bone;
    const k = bone === 'static' ? 0 : 1 + side * poseBones.length + poseBones.indexOf(bone);
    const r = T[k] ?? T[0];
    const q = apply(r, v3(p));
    out[name] = [q.x, q.y, q.z];
  }
  return out;
}

/**
 * Dual-quaternion skinning of `rest` into `out` (both xyz per vertex, same
 * length). Only vertices with non-static weights move; the rest are copied.
 */
export function skinDQS(rest: Float32Array, out: Float32Array, vertexCount: number, bones: Uint8Array, weights: Uint8Array, T: Rigid[], lbsMix = 0): void {
  out.set(rest);
  const n = T.length;
  // Dual quaternions per bone: real (x,y,z,w) and dual (x,y,z,w).
  const R = new Float64Array(n * 4), D = new Float64Array(n * 4);
  let moving = false;
  for (let b = 0; b < n; b++) {
    const q = T[b].q, t = T[b].t;
    R[b * 4] = q.x; R[b * 4 + 1] = q.y; R[b * 4 + 2] = q.z; R[b * 4 + 3] = q.w;
    D[b * 4] = 0.5 * (t.x * q.w + t.y * q.z - t.z * q.y);
    D[b * 4 + 1] = 0.5 * (-t.x * q.z + t.y * q.w + t.z * q.x);
    D[b * 4 + 2] = 0.5 * (t.x * q.y - t.y * q.x + t.z * q.w);
    D[b * 4 + 3] = -0.5 * (t.x * q.x + t.y * q.y + t.z * q.z);
    if (b > 0 && (Math.abs(q.w) < 1 - 1e-12 || t.lengthSq() > 1e-18)) moving = true;
  }
  if (!moving) return;
  for (let v = 0; v < vertexCount; v++) {
    const o = v * 4;
    if (bones[o] === 0 && weights[o] === 255) continue;
    let rx = 0, ry = 0, rz = 0, rw = 0, dx = 0, dy = 0, dz = 0, dw = 0;
    const b0 = bones[o] * 4;
    for (let k = 0; k < 4; k++) {
      const w8 = weights[o + k];
      if (!w8) continue;
      const b = bones[o + k] * 4;
      // Keep all rotations in the same hemisphere as the first.
      const dot = R[b] * R[b0] + R[b + 1] * R[b0 + 1] + R[b + 2] * R[b0 + 2] + R[b + 3] * R[b0 + 3];
      const w = (dot < 0 ? -w8 : w8) / 255;
      rx += w * R[b]; ry += w * R[b + 1]; rz += w * R[b + 2]; rw += w * R[b + 3];
      dx += w * D[b]; dy += w * D[b + 1]; dz += w * D[b + 2]; dw += w * D[b + 3];
    }
    const len = Math.hypot(rx, ry, rz, rw);
    if (len < 1e-12) continue;
    rx /= len; ry /= len; rz /= len; rw /= len; dx /= len; dy /= len; dz /= len; dw /= len;
    const px = rest[v * 3], py = rest[v * 3 + 1], pz = rest[v * 3 + 2];
    // Rotate p by r: p + 2 r.xyz x (r.xyz x p + r.w p)
    const cx = ry * pz - rz * py + rw * px, cy = rz * px - rx * pz + rw * py, cz = rx * py - ry * px + rw * pz;
    const qx = px + 2 * (ry * cz - rz * cy), qy = py + 2 * (rz * cx - rx * cz), qz = pz + 2 * (rx * cy - ry * cx);
    // Translation: 2 (r.w d.xyz - d.w r.xyz + r.xyz x d.xyz)
    const tx = 2 * (rw * dx - dw * rx + (ry * dz - rz * dy));
    const ty = 2 * (rw * dy - dw * ry + (rz * dx - rx * dz));
    const tz = 2 * (rw * dz - dw * rz + (rx * dy - ry * dx));
    let ox = qx + tx, oy = qy + ty, oz = qz + tz;
    // Where the arm blends into the static trunk, mix in linear blending:
    // dual quaternions bulge outward there, linear blending sinks inward.
    if (lbsMix > 0 && bones[o] === 0 || lbsMix > 0 && (bones[o + 1] === 0 && weights[o + 1] > 0) || lbsMix > 0 && (bones[o + 2] === 0 && weights[o + 2] > 0)) {
      let lx = 0, ly = 0, lz = 0;
      for (let k = 0; k < 4; k++) {
        const w8 = weights[o + k];
        if (!w8) continue;
        const r = T[bones[o + k]], w = w8 / 255;
        const p = new Vector3(px, py, pz).applyQuaternion(r.q).add(r.t);
        lx += w * p.x; ly += w * p.y; lz += w * p.z;
      }
      ox = (1 - lbsMix) * ox + lbsMix * lx; oy = (1 - lbsMix) * oy + lbsMix * ly; oz = (1 - lbsMix) * oz + lbsMix * lz;
    }
    out[v * 3] = ox; out[v * 3 + 1] = oy; out[v * 3 + 2] = oz;
  }
}

export function isRestPose(p: Pose | undefined): boolean {
  if (!p) return true;
  for (const s of ['left', 'right'] as Side[]) {
    const a = p[s];
    if (a && Object.values(a).some((v) => v !== undefined)) return false;
  }
  return true;
}

/** Mirror a pose so the other arm does the same (angles are already side-relative). */
export function mirrorArm(a: Partial<ArmPose> | undefined): Partial<ArmPose> | undefined {
  return a ? { ...a } : undefined;
}
