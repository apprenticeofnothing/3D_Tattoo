import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { BuilderBody, presetParams } from '../src/body/builder';
import { POSE_PRESETS, jointPositions, posedJoints, type Pose } from '../src/body/pose';
import { checkManifold, signedVolume } from '../src/mesh/marchingCubes';
import { loadBodyDataSync } from './helpers/bodyData';

const data = loadBodyDataSync();
const H = 1.93;
const male = presetParams(data.meta.presets.find((p) => p.id === 'male-athletic')!);
const female = presetParams(data.meta.presets.find((p) => p.id === 'female-overweight')!);

function body(params = male) {
  const b = new BuilderBody(data, params);
  b.update(params, H);
  return b;
}
const both = (arm: Pose['left']): Pose => ({ left: arm, right: arm });
function joints(b: BuilderBody, pose: Pose) {
  const rest = jointPositions((b as unknown as { coarse: Float32Array }).coarse, data.meta.joints);
  return posedJoints(rest, pose, data.meta.poseBones);
}
const J = (j: Record<string, [number, number, number]>, n: string) => new Vector3(...j[n]);
const deg = (a: Vector3, b: Vector3) => (a.angleTo(b) * 180) / Math.PI;

describe('arm posing', () => {
  const b = body();

  it('leaves the body exactly as modelled in the relaxed pose', () => {
    b.setPose({});
    const d = b.displayPositions();
    for (let i = 0; i < d.length; i++) expect(d[i]).toBe(b.restFine[i]);
  });

  it('puts the joints where an arm has them', () => {
    const j = b.worldJoints();
    const sh = J(j, 'upperarm01.L____head'), el = J(j, 'lowerarm01.L____head'), wr = J(j, 'wrist.L____head');
    expect(sh.x).toBeGreaterThan(0.1);
    expect(el.y).toBeLessThan(sh.y);
    expect(wr.y).toBeLessThan(el.y);
    const upper = sh.distanceTo(el), fore = el.distanceTo(wr);
    // Upper arm and forearm of a 193 cm adult: roughly 28-38 cm and 23-32 cm.
    expect(upper).toBeGreaterThan(0.28); expect(upper).toBeLessThan(0.38);
    expect(fore).toBeGreaterThan(0.23); expect(fore).toBeLessThan(0.32);
    // Mirror symmetry.
    expect(J(j, 'wrist.R____head').x).toBeCloseTo(-wr.x, 2);
  });

  it('arms out (T-pose): upper arm horizontal and straight elbow', () => {
    const j = joints(b, both({ raise: 90, forward: 0, twist: 0, bend: 0, turn: 0 }));
    const up = J(j, 'lowerarm01.L____head').sub(J(j, 'upperarm01.L____head')).normalize();
    const fo = J(j, 'wrist.L____head').sub(J(j, 'lowerarm01.L____head')).normalize();
    expect(Math.abs(up.y)).toBeLessThan(0.01);
    expect(up.x).toBeGreaterThan(0.99);
    expect(deg(up, fo)).toBeLessThan(1);
  });

  it('bends the elbow by the requested angle and raises the arm overhead', () => {
    for (const bend of [30, 90, 140]) {
      const j = joints(b, both({ raise: 40, forward: 20, bend }));
      const up = J(j, 'lowerarm01.L____head').sub(J(j, 'upperarm01.L____head'));
      const fo = J(j, 'wrist.L____head').sub(J(j, 'lowerarm01.L____head'));
      expect(Math.abs(deg(up, fo) - bend)).toBeLessThan(1);
    }
    const j = joints(b, both({ raise: 165, forward: 10 }));
    const up = J(j, 'lowerarm01.L____head').sub(J(j, 'upperarm01.L____head')).normalize();
    expect(up.y).toBeGreaterThan(0.9);
  });

  it('turns the palm up with + turn and swings a bent forearm outward with + twist', () => {
    const down = { raise: 10, forward: 0, bend: 0 };
    const j0 = joints(b, both({ ...down, turn: 0 })), j1 = joints(b, both({ ...down, turn: 90 }));
    // Supination moves the thumb outward (+x on the left arm, -x on the right).
    expect(J(j1, 'finger1-1.L____head').x - J(j0, 'finger1-1.L____head').x).toBeGreaterThan(0.01);
    expect(J(j1, 'finger1-1.R____head').x - J(j0, 'finger1-1.R____head').x).toBeLessThan(-0.01);
    const bent = { raise: 10, forward: 0, bend: 90 };
    const k0 = joints(b, both({ ...bent, twist: 0 })), k1 = joints(b, both({ ...bent, twist: 60 }));
    expect(J(k1, 'wrist.L____head').x - J(k0, 'wrist.L____head').x).toBeGreaterThan(0.05);
  });

  it('moves the hand rigidly and leaves head, torso centre and legs untouched', () => {
    b.setPose(both({ raise: 120, forward: 40, twist: 30, bend: 110, turn: 70 }));
    const d = b.displayPositions(), r = b.restFine;
    const names = data.meta.parts;
    const lab = b.fineLabels;
    const handL = names.indexOf('hand.L');
    const hand: number[] = [];
    for (let i = 0; i < lab.length; i++) if (lab[i] === handL) hand.push(i);
    let worst = 0;
    for (let k = 0; k < 200; k++) {
      const a = hand[(k * 37) % hand.length], c = hand[(k * 91 + 13) % hand.length];
      const dr = Math.hypot(r[a * 3] - r[c * 3], r[a * 3 + 1] - r[c * 3 + 1], r[a * 3 + 2] - r[c * 3 + 2]);
      const dp = Math.hypot(d[a * 3] - d[c * 3], d[a * 3 + 1] - d[c * 3 + 1], d[a * 3 + 2] - d[c * 3 + 2]);
      worst = Math.max(worst, Math.abs(dr - dp));
    }
    expect(worst).toBeLessThan(0.003); // fingers are subdivided with their neighbours; near-rigid
    for (const part of ['head', 'thigh.L', 'thigh.R', 'shin.L', 'foot.R']) {
      const id = names.indexOf(part);
      let moved = 0;
      for (let i = 0; i < lab.length; i++) if (lab[i] === id) moved = Math.max(moved, Math.hypot(d[i * 3] - r[i * 3], d[i * 3 + 1] - r[i * 3 + 1], d[i * 3 + 2] - r[i * 3 + 2]));
      expect(moved, part).toBeLessThan(0.001); // under a millimetre (tiny collarbone weights reach the jaw line)
    }
  });

  it('keeps the surface closed and the volume within 5% in every preset pose', () => {
    // Raised arms stretch the armpit into a web that encloses a little extra space, as real skin does.
    for (const params of [male, female]) {
      const bb = body(params);
      const v0 = signedVolume({ positions: bb.restFine, indices: bb.tris });
      for (const p of POSE_PRESETS) {
        bb.setPose(p.arm ? both(p.arm) : {});
        const d = bb.displayPositions();
        expect(d.every((x) => Number.isFinite(x))).toBe(true);
        const v = signedVolume({ positions: d, indices: bb.tris });
        expect(Math.abs(v / v0 - 1), p.id).toBeLessThan(0.05);
      }
      const rep = checkManifold({ positions: bb.displayPositions(), indices: bb.tris });
      expect(rep.nonManifoldEdges + rep.boundaryEdges + rep.inconsistentEdges).toBe(0);
    }
  });

  it('leaves the side of the chest in place when the arms go out (no flank bulge)', () => {
    b.setPose(both({ raise: 90, forward: 0, twist: 0, bend: 0, turn: 0 }));
    const d = b.displayPositions(), r = b.restFine, lab = b.fineLabels;
    const torso = data.meta.parts.indexOf('torso');
    const wj = b.worldJoints();
    const shL = wj['upperarm01.L____head'], shR = wj['upperarm01.R____head'];
    let worst = 0;
    for (let i = 0; i < lab.length; i++) {
      if (lab[i] !== torso) continue;
      const sh = r[i * 3] >= 0 ? shL : shR;
      const dist = Math.hypot(r[i * 3] - sh[0], r[i * 3 + 1] - sh[1], r[i * 3 + 2] - sh[2]);
      if (dist < 0.15) continue; // the armpit hollow (up to ~12 cm below the joint) stretches with the arm
      worst = Math.max(worst, Math.hypot(d[i * 3] - r[i * 3], d[i * 3 + 1] - r[i * 3 + 1], d[i * 3 + 2] - r[i * 3 + 2]));
    }
    // The collarbone lifts with the arm, so the upper chest moves a little; the flank must not swing out.
    expect(worst).toBeLessThan(0.03);
  });

  it('keeps the biceps when the elbow bends: no caving in, a slight bulge', () => {
    // Arm out to the side; measure each front-of-upper-arm vertex's distance
    // from the posed upper-arm axis, straight and bent.
    const labels = b.fineLabels, upper = data.meta.parts.indexOf('upperarm.L');
    const measure = (bend: number) => {
      b.setPose({ left: { raise: 80, forward: 0, twist: 0, bend, turn: 0 } });
      const sh = b.posedWorldJoint('left', 'shoulder'), el = b.posedWorldJoint('left', 'elbow');
      const ax = el.clone().sub(sh); const L = ax.length(); ax.normalize();
      const P = b.displayPositions();
      const out = new Map<number, { t: number; r: number; dir: Vector3 }>();
      for (let v = 0; v < labels.length; v++) {
        if (labels[v] !== upper) continue;
        const p = new Vector3(P[v * 3], P[v * 3 + 1], P[v * 3 + 2]).sub(sh);
        const t = p.dot(ax) / L;
        const rad = p.clone().sub(ax.clone().multiplyScalar(p.dot(ax)));
        out.set(v, { t, r: rad.length(), dir: rad.normalize() });
      }
      return out;
    };
    const straight = measure(0);
    // The front: where the forearm folds to (the forearm's direction at 90 degrees).
    b.setPose({ left: { raise: 80, forward: 0, twist: 0, bend: 90, turn: 0 } });
    const front = b.posedWorldJoint('left', 'wrist').sub(b.posedWorldJoint('left', 'elbow')).normalize();
    for (const bend of [90, 140]) {
      const bent = measure(bend);
      let worst = 0, sum = 0, n = 0;
      for (const [v, s] of straight) {
        if (s.t < 0.35 || s.t > 0.8 || s.dir.dot(front) < 0.7) continue;
        const dr = bent.get(v)!.r - s.r;
        worst = Math.min(worst, dr); sum += dr; n++;
      }
      console.log(`bend ${bend}: biceps ${n} points, mean ${(sum / n * 1000).toFixed(1)} mm, lowest ${(worst * 1000).toFixed(1)} mm`);
      expect(n).toBeGreaterThan(20);
      expect(worst).toBeGreaterThan(-0.001); // nothing sinks by more than 1 mm (it was 16 mm at 90, 24 mm at 140)
      expect(sum / n).toBeGreaterThan(0.0005); // the belly thickens a little
      expect(sum / n).toBeLessThan(0.006);
    }
  });

  it('poses fast enough for a live slider', () => {
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) b.setPose(both({ raise: 40 + i * 10, bend: i * 12, turn: i * 9 }));
    const ms = (performance.now() - t0) / 10;
    console.log(`pose update: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(60);
  });
});

describe('dragging joints (inverse kinematics)', () => {
  const b = body();
  const W = (side: 'left' | 'right', joint: 'wrist' | 'elbow') => b.posedWorldJoint(side, joint);

  it('brings the wrist to a reachable target within a few millimetres', () => {
    b.setPose({});
    const targets = [
      W('left', 'wrist').add(new Vector3(0.05, 0.15, 0.12)), // up and forward
      W('left', 'wrist').add(new Vector3(-0.15, 0.25, 0.2)), // across the body
      W('left', 'wrist').add(new Vector3(0.1, 0.35, -0.05)), // out to the side
    ];
    for (const t of targets) {
      b.setPose({});
      const arm = b.solveIK('left', 'wrist', t);
      b.setPose({ left: arm });
      const err = W('left', 'wrist').distanceTo(t);
      expect(err).toBeLessThan(0.005);
      expect(arm.bend).toBeGreaterThanOrEqual(0); expect(arm.bend).toBeLessThanOrEqual(150);
      expect(Math.abs(arm.twist)).toBeLessThanOrEqual(90);
    }
  });

  it('stretches straight towards a target out of reach', () => {
    b.setPose({});
    const sh = b.posedWorldJoint('left', 'shoulder');
    const far = sh.clone().add(new Vector3(1.5, 0.2, 0.3));
    const arm = b.solveIK('left', 'wrist', far);
    b.setPose({ left: arm });
    expect(arm.bend).toBeLessThan(3);
    const toWrist = W('left', 'wrist').sub(b.posedWorldJoint('left', 'shoulder')).normalize();
    const toTarget = far.clone().sub(b.posedWorldJoint('left', 'shoulder')).normalize();
    expect(toWrist.angleTo(toTarget)).toBeLessThan(0.08);
  });

  it('drags the elbow: the upper arm follows and the forearm keeps its bend', () => {
    b.setPose({ left: { raise: 40, forward: 20, twist: 10, bend: 70, turn: 30 } });
    const before = { bend: 70, twist: 10, turn: 30 };
    const sh = b.posedWorldJoint('left', 'shoulder');
    const target = sh.clone().add(new Vector3(0.25, 0.1, 0.15));
    const arm = b.solveIK('left', 'elbow', target);
    b.setPose({ left: arm });
    const dir = W('left', 'elbow').sub(b.posedWorldJoint('left', 'shoulder')).normalize();
    expect(dir.angleTo(target.clone().sub(b.posedWorldJoint('left', 'shoulder')).normalize())).toBeLessThan(0.03);
    expect(arm.bend).toBe(before.bend); expect(arm.twist).toBe(before.twist); expect(arm.turn).toBe(before.turn);
  });

  it('moves smoothly: small drags give small changes (no elbow flips)', () => {
    b.setPose({});
    let prev = b.solveIK('left', 'wrist', W('left', 'wrist'));
    b.setPose({ left: prev });
    const start = W('left', 'wrist');
    for (let i = 1; i <= 40; i++) {
      const t = start.clone().add(new Vector3(0.006 * i, 0.012 * i, 0.004 * i));
      const arm = b.solveIK('left', 'wrist', t);
      for (const k of ['raise', 'forward', 'twist', 'bend'] as const) expect(Math.abs(arm[k] - prev[k]), `${k} step ${i}`).toBeLessThan(k === 'bend' ? 12 : 6); // the bend changes fast only as the arm straightens near full reach
      b.setPose({ left: arm });
      prev = arm;
    }
  });

  it('a biceps curl keeps the elbow in place, and stretching back restores the arm exactly', () => {
    const start = { raise: 5, forward: 0, twist: 0, bend: 10, turn: 0 };
    b.setPose({ left: start });
    const el0 = W('left', 'elbow'), wr0 = W('left', 'wrist');
    const down = wr0.clone().sub(el0); const fl = down.length(); down.normalize();
    const fwd = new Vector3(0, 0, 1).sub(down.clone().multiplyScalar(down.z)).normalize();
    const path = [...Array(41).keys()].map((i) => (i / 40) * 120);
    let worstElbow = 0;
    for (const a of [...path, ...path.slice().reverse()]) {
      const r = (a * Math.PI) / 180;
      const t = el0.clone().add(down.clone().multiplyScalar(Math.cos(r) * fl)).add(fwd.clone().multiplyScalar(Math.sin(r) * fl));
      const arm = b.solveIK('left', 'wrist', t, start);
      b.setPose({ left: arm });
      expect(W('left', 'wrist').distanceTo(t)).toBeLessThan(0.005);
      worstElbow = Math.max(worstElbow, W('left', 'elbow').distanceTo(el0));
    }
    const end = b.pose.left!;
    expect(worstElbow).toBeLessThan(0.01);
    for (const k of ['raise', 'forward', 'twist', 'bend'] as const) expect(Math.abs(end[k]! - start[k]), k).toBeLessThan(1);
  });

  it('an arm flexed from the side and stretched again returns to how it was', () => {
    const start = { raise: 90, forward: 0, twist: 0, bend: 0, turn: 0 };
    b.setPose({ left: start });
    const el0 = W('left', 'elbow'), wr0 = W('left', 'wrist'), fl = el0.distanceTo(wr0);
    const out = wr0.clone().sub(el0).normalize();
    const path = [...Array(41).keys()].map((i) => (i / 40) * 110);
    for (const a of [...path, ...path.slice().reverse()]) {
      const r = (a * Math.PI) / 180;
      const t = el0.clone().add(out.clone().multiplyScalar(Math.cos(r) * fl)).add(new Vector3(0, Math.sin(r) * fl, 0));
      const prev = { ...(b.pose.left as Required<typeof start>) };
      const arm = b.solveIK('left', 'wrist', t, start);
      expect(Math.abs(arm.twist - prev.twist)).toBeLessThan(15); // no sudden spin (it jumped 70 degrees at once)
      b.setPose({ left: arm });
    }
    const end = b.pose.left!;
    for (const k of ['raise', 'forward', 'twist', 'bend'] as const) expect(Math.abs(end[k]! - start[k]), k).toBeLessThan(1);
    expect(W('left', 'elbow').distanceTo(el0)).toBeLessThan(0.005);
  });

  it('keeps the arm in its realistic range when the target is behind the back', () => {
    b.setPose({});
    const sh = b.posedWorldJoint('left', 'shoulder');
    const arm = b.solveIK('left', 'wrist', sh.clone().add(new Vector3(-0.3, -0.3, -0.5)));
    expect(arm.forward).toBeGreaterThanOrEqual(-40);
    expect(arm.raise).toBeGreaterThanOrEqual(0); expect(arm.raise).toBeLessThanOrEqual(160);
    expect(Math.abs(arm.twist)).toBeLessThanOrEqual(90);
  });
});
