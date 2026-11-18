// Where on the body was this photo of a tattoo taken? From the person's
// pose landmarks (MediaPipe numbering) and the tattoo's position in the
// photo: which body segment it sits on, how far along it, and from which
// direction the camera saw it, in the body's own frame (x = the person's
// left, y = up, z = front), which is the frame of the 3D bodies here.

export interface Landmark { x: number; y: number; z: number; visibility?: number }

export type PartName = 'upperarm' | 'forearm' | 'hand' | 'thigh' | 'shin' | 'foot' | 'torso' | 'neck' | 'head';
export type BodySide = 'left' | 'right' | 'center';

export interface PoseHint {
  part: PartName;
  side: BodySide;
  /** Fraction along the segment from the joint nearer the trunk (limbs), or down the torso (0 shoulders, 1 hips). */
  t: number;
  /** Torso only: fraction across from the person's right shoulder (0) to their left (1). */
  u?: number;
  /** Offset across the limb in the photo, as a fraction of its half-width (-1..1, sign follows `across`). */
  lateral: number;
  /** Direction from the body towards the camera, in the body frame (x left, y up, z front). */
  view: [number, number, number];
  /** Direction from the limb's axis to the tattoo (the view turned by the lateral offset), body frame. */
  surfaceDir: [number, number, number];
  /** Pixels per metre of body height, from body proportions in the photo (rough). */
  pxPerHeight?: number;
  /** Segment ends in photo pixels (trunk end first), and half-width estimate in pixels. */
  segment?: { a: { x: number; y: number }; b: { x: number; y: number }; halfWidth: number };
  /** Up the body in the photo (unit vector, photo pixels: y down). */
  upInPhoto: { x: number; y: number };
}

export const LM = {
  nose: 0, lShoulder: 11, rShoulder: 12, lElbow: 13, rElbow: 14, lWrist: 15, rWrist: 16,
  lPinky: 17, rPinky: 18, lIndex: 19, rIndex: 20, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26,
  lAnkle: 27, rAnkle: 28, lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
} as const;

/** Typical half-width of each segment as a fraction of its length (used when there is no person mask). */
export const HALF_WIDTH: Record<string, number> = { upperarm: 0.2, forearm: 0.19, hand: 0.4, thigh: 0.24, shin: 0.17, foot: 0.3 };

type P2 = { x: number; y: number };

export interface SuggestInput {
  landmarks: Landmark[];
  world?: Landmark[];
  width: number;
  height: number;
  /** Tattoo centre in photo pixels. */
  at: P2;
  /** Photo taken in a mirror. */
  mirrored?: boolean;
  /** Person mask (probability) covering the photo, to measure limb widths. */
  mask?: { data: Float32Array; width: number; height: number };
}

/** Swap the person's left and right landmarks (what a mirror does to the apparent person). */
function swapSides<T>(l: T[]): T[] {
  const out = l.slice();
  for (let i = 1; i < 33; i++) {
    const n = mirrorIndex(i);
    if (n !== i) out[i] = l[n];
  }
  return out;
}
function mirrorIndex(i: number): number {
  // 1..10 face points come in left/right pairs too; 11.. body pairs alternate L, R.
  if (i >= 11) return i % 2 === 1 ? i + 1 : i - 1;
  const pairs: Record<number, number> = { 1: 4, 2: 5, 3: 6, 4: 1, 5: 2, 6: 3, 7: 8, 8: 7, 9: 10, 10: 9 };
  return pairs[i] ?? i;
}

const vis = (l: Landmark | undefined) => !!l && (l.visibility ?? 1) > 0.35;

/** The two places where the person mask ends, walking across a limb from `c` (photo pixels), or null. */
export function maskEdges(mask: SuggestInput['mask'], W: number, H: number, c: P2, across: P2): [P2, P2] | null {
  if (!mask) return null;
  const sx = mask.width / W, sy = mask.height / H;
  const inside = (p: P2) => {
    const x = Math.floor(p.x * sx), y = Math.floor(p.y * sy);
    return x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.data[y * mask.width + x] > 0.5;
  };
  if (!inside(c)) return null;
  const reach = (sgn: number) => {
    let t = 0;
    for (; t < Math.max(W, H); t += 1) if (!inside({ x: c.x + across.x * t * sgn, y: c.y + across.y * t * sgn })) break;
    return { x: c.x + across.x * t * sgn, y: c.y + across.y * t * sgn };
  };
  return [reach(-1), reach(1)];
}

/** Half-width of the person mask across a segment at a point (pixels), or null. */
function maskHalfWidth(mask: SuggestInput['mask'], W: number, H: number, c: P2, across: P2): number | null {
  if (!mask) return null;
  const sx = mask.width / W, sy = mask.height / H;
  const inside = (p: P2) => {
    const x = Math.floor(p.x * sx), y = Math.floor(p.y * sy);
    return x >= 0 && y >= 0 && x < mask.width && y < mask.height && mask.data[y * mask.width + x] > 0.5;
  };
  if (!inside(c)) return null;
  const reach = (sgn: number) => {
    let t = 0;
    for (; t < Math.max(W, H); t += 1) if (!inside({ x: c.x + across.x * t * sgn, y: c.y + across.y * t * sgn })) break;
    return t;
  };
  const a = reach(1), b = reach(-1);
  return (a + b) / 2;
}

/** Body frame from world landmarks (x left, y up, z front) in camera axes (x right, y up, z towards the camera). */
function bodyFrame(world: Landmark[] | undefined, lm: Landmark[]): { left: number[]; up: number[]; front: number[] } | null {
  const w = world;
  const pick = (i: number) => (w && w[i] ? [w[i].x, -w[i].y, -w[i].z] : null);
  const ls = pick(LM.lShoulder), rs = pick(LM.rShoulder), lh = pick(LM.lHip), rh = pick(LM.rHip);
  if (!ls || !rs || !lh || !rh || !vis(lm[LM.lShoulder]) || !vis(lm[LM.rShoulder])) return null;
  const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
  const addv = (a: number[], b: number[]) => a.map((v, i) => v + b[i]);
  const norm = (a: number[]) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return a.map((v) => v / l); };
  const dotv = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const left = norm(addv(sub(ls, rs), sub(lh, rh)));
  let up = sub(addv(ls, rs), addv(lh, rh));
  up = norm(sub(up, left.map((v) => v * dotv(up, left))));
  const front = cross(left, up);
  return { left, up, front };
}

export function suggestFromPose(input: SuggestInput): PoseHint | null {
  const W = input.width, H = input.height;
  // Work in the un-mirrored photo: flip x and swap the person's sides.
  let lm = input.landmarks.map((l) => ({ ...l, x: l.x * W, y: l.y * H }));
  let world = input.world;
  let at = input.at;
  let mask = input.mask;
  if (input.mirrored) {
    lm = swapSides(lm.map((l) => ({ ...l, x: W - l.x })));
    world = world ? swapSides(world.map((l) => ({ ...l, x: -l.x }))) : undefined;
    at = { x: W - at.x, y: at.y };
    if (mask) {
      const m = mask, d = new Float32Array(m.data.length);
      for (let y = 0; y < m.height; y++) for (let x = 0; x < m.width; x++) d[y * m.width + x] = m.data[y * m.width + (m.width - 1 - x)];
      mask = { data: d, width: m.width, height: m.height };
    }
  }
  if (lm.length < 33) return null;
  const P = (i: number): P2 => ({ x: lm[i].x, y: lm[i].y });
  const mid = (a: P2, b: P2): P2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

  // Candidate limb segments, trunk end first.
  const segs: Array<{ part: PartName; side: BodySide; a: number | P2; b: number | P2 }> = [];
  for (const [side, s] of [['left', 0], ['right', 1]] as const) {
    const L = (l: number, r: number) => (s === 0 ? l : r);
    segs.push({ part: 'upperarm', side, a: L(LM.lShoulder, LM.rShoulder), b: L(LM.lElbow, LM.rElbow) });
    segs.push({ part: 'forearm', side, a: L(LM.lElbow, LM.rElbow), b: L(LM.lWrist, LM.rWrist) });
    segs.push({ part: 'hand', side, a: L(LM.lWrist, LM.rWrist), b: mid(P(L(LM.lIndex, LM.rIndex)), P(L(LM.lPinky, LM.rPinky))) });
    segs.push({ part: 'thigh', side, a: L(LM.lHip, LM.rHip), b: L(LM.lKnee, LM.rKnee) });
    segs.push({ part: 'shin', side, a: L(LM.lKnee, LM.rKnee), b: L(LM.lAnkle, LM.rAnkle) });
    segs.push({ part: 'foot', side, a: L(LM.lAnkle, LM.rAnkle), b: L(LM.lFoot, LM.rFoot) });
  }
  let best: { score: number; hint: Omit<PoseHint, 'view' | 'upInPhoto' | 'surfaceDir'>; across?: P2 } | null = null;
  for (const s of segs) {
    if (typeof s.a === 'number' && !vis(lm[s.a])) continue;
    if (typeof s.b === 'number' && !vis(lm[s.b])) continue;
    const a = typeof s.a === 'number' ? P(s.a) : s.a, b = typeof s.b === 'number' ? P(s.b) : s.b;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 4) continue;
    const u = { x: dx / len, y: dy / len }, across = { x: u.y, y: -u.x };
    const t = ((at.x - a.x) * u.x + (at.y - a.y) * u.y) / len;
    const d = (at.x - a.x) * across.x + (at.y - a.y) * across.y;
    if (t < -0.15 || t > 1.15) continue;
    const c = { x: a.x + u.x * t * len, y: a.y + u.y * t * len };
    const hw = maskHalfWidth(mask, W, H, c, across) ?? HALF_WIDTH[s.part] * len;
    if (Math.abs(d) > hw * 1.3) continue;
    const score = Math.abs(d) / hw + Math.max(0, -t, t - 1) * 3;
    if (!best || score < best.score) best = { score, across, hint: { part: s.part, side: s.side, t: Math.max(0, Math.min(1, t)), lateral: Math.max(-1, Math.min(1, d / hw)), segment: { a, b, halfWidth: hw } } };
  }
  // Torso: inside the shoulders-hips quadrilateral.
  if (vis(lm[LM.lShoulder]) && vis(lm[LM.rShoulder]) && vis(lm[LM.lHip]) && vis(lm[LM.rHip])) {
    const ls = P(LM.lShoulder), rs = P(LM.rShoulder), lh = P(LM.lHip), rh = P(LM.rHip);
    const top = mid(ls, rs), bot = mid(lh, rh);
    const vlen = Math.hypot(bot.x - top.x, bot.y - top.y) || 1;
    const down = { x: (bot.x - top.x) / vlen, y: (bot.y - top.y) / vlen };
    const v = ((at.x - top.x) * down.x + (at.y - top.y) * down.y) / vlen;
    // Across: from the right shoulder/hip line to the left one at this height.
    const r = { x: rs.x + (rh.x - rs.x) * v, y: rs.y + (rh.y - rs.y) * v }, l = { x: ls.x + (lh.x - ls.x) * v, y: ls.y + (lh.y - ls.y) * v };
    const span = Math.hypot(l.x - r.x, l.y - r.y) || 1;
    const u = ((at.x - r.x) * (l.x - r.x) + (at.y - r.y) * (l.y - r.y)) / (span * span);
    // A side view squeezes the torso: allow a little outside the shoulder line.
    if (v >= -0.25 && v <= 1.1 && u >= -0.2 && u <= 1.2) {
      const score = 0.9;
      if (!best || score < best.score) {
        const part: PartName = v < -0.05 ? 'neck' : 'torso';
        best = { score, hint: { part, side: 'center', t: Math.max(0, Math.min(1, v)), u: Math.max(0, Math.min(1, u)), lateral: 0 } };
      }
    }
  }
  if (!best) return null;
  // Body frame in camera axes (x right, y up, z towards the camera).
  let frame = bodyFrame(world, lm);
  if (!frame) {
    // Without 3D: the person's left shoulder on the photo's right means they face the camera.
    const ls = lm[LM.lShoulder], rs = lm[LM.rShoulder];
    const facing = !ls || !rs || ls.x > rs.x;
    frame = facing ? { left: [1, 0, 0], up: [0, 1, 0], front: [0, 0, 1] } : { left: [-1, 0, 0], up: [0, 1, 0], front: [0, 0, -1] };
  }
  const toBody = (c: number[]): [number, number, number] => {
    const v: [number, number, number] = [
      c[0] * frame!.left[0] + c[1] * frame!.left[1] + c[2] * frame!.left[2],
      c[0] * frame!.up[0] + c[1] * frame!.up[1] + c[2] * frame!.up[2],
      c[0] * frame!.front[0] + c[1] * frame!.front[1] + c[2] * frame!.front[2],
    ];
    const l = Math.hypot(...v) || 1;
    return v.map((x) => x / l) as [number, number, number];
  };
  const view = toBody([0, 0, 1]);
  // On a limb the tattoo sits off the line facing the camera by asin(lateral).
  let surfaceDir = view;
  if (best.across && best.hint.part !== 'torso') {
    const th = Math.asin(Math.max(-0.95, Math.min(0.95, best.hint.lateral)));
    const acrossBody = toBody([best.across.x, -best.across.y, 0]);
    surfaceDir = view.map((v, i) => Math.cos(th) * v + Math.sin(th) * acrossBody[i]) as [number, number, number];
    const l = Math.hypot(...surfaceDir) || 1;
    surfaceDir = surfaceDir.map((v) => v / l) as [number, number, number];
  }
  // Up the body in the photo.
  let upInPhoto = { x: 0, y: -1 };
  if (vis(lm[LM.lShoulder]) && vis(lm[LM.rShoulder]) && vis(lm[LM.lHip]) && vis(lm[LM.rHip])) {
    const top = mid(P(LM.lShoulder), P(LM.rShoulder)), bot = mid(P(LM.lHip), P(LM.rHip));
    const l = Math.hypot(top.x - bot.x, top.y - bot.y);
    if (l > 4) upInPhoto = { x: (top.x - bot.x) / l, y: (top.y - bot.y) / l };
  }
  // Scale from body proportions: shoulders-to-hip-joints is about 0.29 of
  // standing height, shoulders-to-ankles about 0.77 (rough, adult averages).
  let pxPerHeight: number | undefined;
  {
    const sh = vis(lm[LM.lShoulder]) && vis(lm[LM.rShoulder]) ? mid(P(LM.lShoulder), P(LM.rShoulder)) : null;
    const hp = vis(lm[LM.lHip]) && vis(lm[LM.rHip]) ? mid(P(LM.lHip), P(LM.rHip)) : null;
    const an = vis(lm[LM.lAnkle]) && vis(lm[LM.rAnkle]) ? mid(P(LM.lAnkle), P(LM.rAnkle)) : null;
    if (sh && an) pxPerHeight = Math.hypot(sh.x - an.x, sh.y - an.y) / 0.77;
    else if (sh && hp) pxPerHeight = Math.hypot(sh.x - hp.x, sh.y - hp.y) / 0.29;
  }
  // Back in the photo's own frame for anything drawn on it.
  const hint: PoseHint = { ...best.hint, view, surfaceDir, upInPhoto, pxPerHeight };
  if (input.mirrored) {
    if (hint.segment) hint.segment = { ...hint.segment, a: { x: W - hint.segment.a.x, y: hint.segment.a.y }, b: { x: W - hint.segment.b.x, y: hint.segment.b.y } };
    hint.upInPhoto = { x: -hint.upInPhoto.x, y: hint.upInPhoto.y };
    hint.lateral = -hint.lateral;
  }
  return hint;
}

const PART_LABEL: Record<PartName, string> = { upperarm: 'upper arm', forearm: 'forearm', hand: 'hand', thigh: 'thigh', shin: 'lower leg', foot: 'foot', torso: 'torso', neck: 'neck', head: 'head' };
const ENDS: Partial<Record<PartName, [string, string]>> = {
  upperarm: ['shoulder', 'elbow'], forearm: ['elbow', 'wrist'], hand: ['wrist', 'knuckles'], thigh: ['hip', 'knee'], shin: ['knee', 'ankle'], foot: ['ankle', 'toes'],
};

/** Plain words for a hint, e.g. "left forearm, 40% of the way from elbow to wrist, seen from the back". */
export function describeHint(h: PoseHint): string {
  const facing = (() => {
    const [x, , z] = h.view;
    if (Math.abs(z) >= Math.abs(x)) return z > 0 ? 'front' : 'back';
    const leftward = x > 0; // camera on the person's left
    if (h.side === 'center') return leftward ? 'left side' : 'right side';
    return (leftward === (h.side === 'left')) ? 'outer side' : 'inner side';
  })();
  const name = `${h.side === 'center' ? '' : `${h.side} `}${PART_LABEL[h.part]}`;
  const ends = ENDS[h.part];
  if (ends) return `${name}, ${Math.round(h.t * 100)}% of the way from ${ends[0]} to ${ends[1]}, seen from the ${facing}`;
  return `${name}, seen from the ${facing}`;
}
