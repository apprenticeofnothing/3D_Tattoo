// Flatten a photo of a tattoo.
//
// Around a limb: the limb is treated as a (possibly tapered) cylinder seen
// from the side. Its two outline edges in the photo give the axis and the
// radius; a point at angle θ from the line facing the camera appears at
// R·sin θ from the axis, while along the skin it lies R·θ away. Unwrapping
// inverts that, so the output's horizontal axis is length along the skin.
// The far sides (beyond about ±70°) are too foreshortened to use.
// This assumes the camera is far enough away that perspective across the
// limb is small (a 4 cm radius seen from 40 cm: well under 1%).
//
// Flat area: four corners of a quadrilateral are mapped to a rectangle
// (a homography), which removes perspective and rotation.

import { makeImage, sampleBilinear, type Rgba } from './image';

export type Pt = { x: number; y: number };

/** The limb's two outline edges; p0/q0 are at the end nearer the body (top of the result). */
export interface LimbGuide {
  p0: Pt; p1: Pt; // one edge
  q0: Pt; q1: Pt; // the other edge
}

export interface LimbFrame {
  /** Unit vector along the limb, from the body end to the far end. */
  u: Pt;
  /** Unit vector across the limb, to the right when u points down. */
  v: Pt;
  /** Centre line point and radius (px) at axial position t (px along u from the body-end centre). */
  at(t: number): { c: Pt; r: number };
  /** Axial length between the body-end and far-end handles (px). */
  length: number;
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);

/** Where the line through a with direction d meets the line through b with direction e (parameter on the first line). */
function meet(a: Pt, d: Pt, b: Pt, e: Pt): number | null {
  const den = d.x * e.y - d.y * e.x;
  if (Math.abs(den) < 1e-9) return null;
  const w = sub(b, a);
  return (w.x * e.y - w.y * e.x) / den;
}

export function limbFrame(g: LimbGuide): LimbFrame {
  const dp = sub(g.p1, g.p0), dq = sub(g.q1, g.q0);
  let u = add(mul(dp, 1 / (len(dp) || 1)), mul(dq, 1 / (len(dq) || 1)));
  if (len(u) < 1e-6) u = { x: 0, y: 1 };
  u = mul(u, 1 / len(u));
  const v = { x: u.y, y: -u.x }; // right of u when u points down the image
  // Origin: middle of the body-end handles; axial position measured along u.
  const o = mul(add(g.p0, g.q0), 0.5);
  const edgeAt = (t: number) => {
    const base = add(o, mul(u, t));
    const sp = meet(base, v, g.p0, dp), sq = meet(base, v, g.q0, dq);
    const a = sp === null ? base : add(base, mul(v, sp));
    const b = sq === null ? base : add(base, mul(v, sq));
    return { a, b };
  };
  const end = mul(add(g.p1, g.q1), 0.5);
  return {
    u, v,
    length: dot(sub(end, o), u),
    at(t: number) {
      const { a, b } = edgeAt(t);
      return { c: mul(add(a, b), 0.5), r: Math.abs(dot(sub(b, a), v)) / 2 };
    },
  };
}

export interface UnwrapResult {
  image: Rgba;
  /** Limb radius in photo pixels at the front of the limb, middle of the band (the scale of the output). */
  radiusPx: number;
  /** Output pixels per photo pixel (both axes). */
  scale: number;
}

/**
 * Unwrap the limb between axial fractions `from`..`to` (0 = body-end handles,
 * 1 = far-end handles) up to `maxAngleDeg` either side of the line facing
 * the camera. Output pixels are skin length in units of the photo's pixel
 * size at the front of the limb, times `scale`.
 *
 * With `fPx` (the camera's focal length in photo pixels) perspective is
 * taken into account: a close camera sees the limb's outline from nearer
 * the side, so the outline looks narrower than the front of the limb. For
 * a cylinder of radius R whose axis is D away, a point at angle θ appears
 * at f·R·sin θ / (D − R·cos θ) from the axis, and the outline at the angle
 * where the line of sight grazes it (sin α = R/D, half-width f·tan α).
 * So the apparent half-width alone gives D/R. Without `fPx` the camera is
 * taken to be far away (orthographic).
 */
export function unwrapLimb(img: Rgba, g: LimbGuide, opts: { from?: number; to?: number; maxAngleDeg?: number; scale?: number; maxSide?: number; fPx?: number } = {}): UnwrapResult {
  const f = limbFrame(g);
  const from = opts.from ?? 0, to = opts.to ?? 1;
  const t0 = Math.min(from, to) * f.length, t1 = Math.max(from, to) * f.length;
  const thMax = ((opts.maxAngleDeg ?? 70) * Math.PI) / 180;
  const fPx = opts.fPx;
  // Per row: radius of the front in photo pixels, D/R, and the usable angle.
  const rowModel = (hw: number) => {
    if (!fPx || hw <= 0) return { rFront: hw, k: Infinity, th: thMax };
    const k = 1 / Math.sin(Math.atan(hw / fPx));
    return { rFront: fPx / (k - 1), k, th: Math.min(thMax, Math.acos(1 / k) * 0.97) };
  };
  const m0 = rowModel(f.at(t0).r), m1 = rowModel(f.at(t1).r);
  const halfW = Math.max(m0.rFront * m0.th, m1.rFront * m1.th, 1);
  let scale = opts.scale ?? 1;
  const maxSide = opts.maxSide ?? 2400;
  scale = Math.min(scale, maxSide / Math.max(2 * halfW, t1 - t0, 1));
  const W = Math.max(1, Math.round(2 * halfW * scale)), H = Math.max(1, Math.round((t1 - t0) * scale));
  const out = makeImage(W, H);
  const px = new Float32Array(4);
  for (let y = 0; y < H; y++) {
    const t = t0 + (y + 0.5) / scale;
    const { c, r } = f.at(t);
    if (r < 0.5) continue;
    const m = rowModel(r);
    for (let x = 0; x < W; x++) {
      const s = (x + 0.5) / scale - halfW; // length along the skin from the centre line (front pixels)
      const a = s / m.rFront;
      if (Math.abs(a) > m.th) continue;
      const off = m.k === Infinity ? r * Math.sin(a) : (fPx! * Math.sin(a)) / (m.k - Math.cos(a));
      const q = add(c, mul(f.v, off));
      if (!sampleBilinear(img, q.x, q.y, px)) continue;
      const o = (y * W + x) * 4;
      out.data[o] = px[0]; out.data[o + 1] = px[1]; out.data[o + 2] = px[2]; out.data[o + 3] = px[3];
    }
  }
  return { image: out, radiusPx: rowModel(f.at((t0 + t1) / 2).r).rFront, scale };
}

/** 3x3 homography (row-major) mapping the unit square to a quad (q0 top-left, q1 top-right, q2 bottom-right, q3 bottom-left). */
export function squareToQuad(q: [Pt, Pt, Pt, Pt]): number[] {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-12 || Math.abs(dy3) > 1e-12) {
    const den = dx1 * dy2 - dx2 * dy1;
    g = (dx3 * dy2 - dx2 * dy3) / den;
    h = (dx1 * dy3 - dx3 * dy1) / den;
  }
  // Maps (s, t) -> ((a s + b t + c) / (g s + h t + 1), (d s + e t + f) / (...)).
  return [
    p1.x - p0.x + g * p1.x, p3.x - p0.x + h * p3.x, p0.x,
    p1.y - p0.y + g * p1.y, p3.y - p0.y + h * p3.y, p0.y,
    g, h, 1,
  ];
}

export function applyHomography(m: number[], s: number, t: number): Pt {
  const w = m[6] * s + m[7] * t + m[8];
  return { x: (m[0] * s + m[1] * t + m[2]) / w, y: (m[3] * s + m[4] * t + m[5]) / w };
}

/**
 * Map a quadrilateral of the photo to a rectangle whose sides have the
 * quad's average side lengths (photo pixels times `scale`).
 */
export function rectifyQuad(img: Rgba, q: [Pt, Pt, Pt, Pt], opts: { scale?: number; maxSide?: number } = {}): UnwrapResult {
  const wPx = (len(sub(q[1], q[0])) + len(sub(q[2], q[3]))) / 2;
  const hPx = (len(sub(q[3], q[0])) + len(sub(q[2], q[1]))) / 2;
  let scale = opts.scale ?? 1;
  scale = Math.min(scale, (opts.maxSide ?? 2400) / Math.max(wPx, hPx, 1));
  const W = Math.max(1, Math.round(wPx * scale)), H = Math.max(1, Math.round(hPx * scale));
  const m = squareToQuad(q);
  const out = makeImage(W, H);
  const px = new Float32Array(4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = applyHomography(m, (x + 0.5) / W, (y + 0.5) / H);
    if (!sampleBilinear(img, p.x, p.y, px)) continue;
    const o = (y * W + x) * 4;
    out.data[o] = px[0]; out.data[o + 1] = px[1]; out.data[o + 2] = px[2]; out.data[o + 3] = px[3];
  }
  return { image: out, radiusPx: 0, scale };
}
