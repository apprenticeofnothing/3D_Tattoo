// Photo -> flat ink image, ready to place on the body.

import { crop, flipX, type Rgba } from './image';
import { extractInk } from './inkExtract';
import { rectifyQuad, unwrapLimb, type LimbGuide, type Pt } from './unwrap';

export type SurfaceKind = 'limb' | 'flat';

export interface FlattenParams {
  kind: SurfaceKind;
  limb: LimbGuide & { from: number; to: number };
  quad: [Pt, Pt, Pt, Pt];
  /** Photo taken in a mirror: the result is flipped back. */
  mirrored: boolean;
  /** Ink strength treated as skin texture (0..1); undefined = automatic. */
  floor?: number;
  maxSide?: number;
  /** Camera focal length in photo pixels (perspective of close-ups); undefined = far away. */
  fPx?: number;
}

export interface Flattened {
  /** Ink with alpha, cropped to the tattoo. */
  image: Rgba;
  /** Size of `image` in photo pixels (lengths along the skin). */
  widthPhotoPx: number;
  heightPhotoPx: number;
  /** Width of the ink itself (without the margin around it), photo pixels. */
  inkWidthPhotoPx: number;
  /** Limb radius in photo pixels (limb mode), for sizing from the body's circumference. */
  radiusPx: number | null;
  floor: number;
  /** Nothing that looks like ink was found. */
  empty: boolean;
}

export function flattenTattoo(photo: Rgba, p: FlattenParams): Flattened {
  const flat = p.kind === 'limb'
    ? unwrapLimb(photo, p.limb, { from: p.limb.from, to: p.limb.to, maxSide: p.maxSide ?? 2048, scale: 2, fPx: p.fPx })
    : rectifyQuad(photo, p.quad, { maxSide: p.maxSide ?? 2048, scale: 2 });
  const ink = extractInk(flat.image, { floor: p.floor });
  keepCentralInk(ink);
  let img = ink.image;
  let w = img.width, h = img.height;
  const inkW = ink.bbox ? ink.bbox.x1 - ink.bbox.x0 : w;
  if (ink.bbox) {
    // Trim to the ink with a small margin.
    const m = Math.round(Math.max(ink.bbox.x1 - ink.bbox.x0, ink.bbox.y1 - ink.bbox.y0) * 0.03) + 2;
    const x0 = Math.max(0, ink.bbox.x0 - m), y0 = Math.max(0, ink.bbox.y0 - m);
    w = Math.min(img.width, ink.bbox.x1 + m) - x0; h = Math.min(img.height, ink.bbox.y1 + m) - y0;
    img = crop(img, x0, y0, w, h);
  }
  if (p.mirrored) img = flipX(img);
  return {
    image: img,
    widthPhotoPx: w / flat.scale,
    heightPhotoPx: h / flat.scale,
    inkWidthPhotoPx: inkW / flat.scale,
    radiusPx: p.kind === 'limb' ? flat.radiusPx : null,
    floor: ink.floor,
    empty: !ink.bbox,
  };
}

/** Width in cm from the limb's real circumference at the spot (cylinder of equal circumference). */
export function widthFromCircumference(f: Flattened, circumferenceCm: number): number | null {
  if (!f.radiusPx) return null;
  const cmPerPx = circumferenceCm / (2 * Math.PI) / f.radiusPx;
  return f.widthPhotoPx * cmPerPx;
}

/**
 * Width in cm from how wide the limb is as seen in the photo: the limb's
 * real width across (from the body model, seen from the same side) over
 * its width in the photo. Better than the circumference for limbs that are
 * not round (a forearm is flatter one way than the other).
 */
export function widthFromVisibleWidth(f: Flattened, visibleWidthCm: number): number | null {
  if (!f.radiusPx) return null;
  return f.widthPhotoPx * (visibleWidthCm / 2 / f.radiusPx);
}

/**
 * Keep the tattoo, drop stray marks: the guides are put around the tattoo,
 * so its strokes gather near the middle, while shadows where a limb meets
 * the body or the background show up as streaks along the edges. Strokes
 * are grouped (joining small gaps); the biggest group near the middle and
 * the groups close to it stay, the rest is cleared. Updates the bounding box.
 */
export function keepCentralInk(ink: ReturnType<typeof extractInk>): void {
  const img = ink.image, W = img.width, H = img.height;
  const on = (o: number) => img.data[o * 4 + 3] > 64;
  const R = Math.max(2, Math.round(Math.max(W, H) / 120));
  const lab = new Int32Array(W * H).fill(-1);
  const groups: { n: number; cx: number; cy: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let o0 = 0; o0 < W * H; o0++) {
    if (!on(o0) || lab[o0] >= 0) continue;
    const id = groups.length, st = [o0];
    lab[o0] = id;
    let n = 0, sx = 0, sy = 0, x0 = W, y0 = H, x1 = -1, y1 = -1;
    while (st.length) {
      const o = st.pop()!, x = o % W, y = (o - x) / W;
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const k = yy * W + xx;
        if (lab[k] < 0 && on(k)) { lab[k] = id; st.push(k); }
      }
    }
    groups.push({ n, cx: sx / n, cy: sy / n, x0, y0, x1, y1 });
  }
  if (groups.length < 2) return;
  const diag = Math.hypot(W, H);
  const score = (g: (typeof groups)[number]) => g.n * Math.exp(-((Math.hypot(g.cx - W / 2, g.cy - H / 2) / (0.3 * diag)) ** 2));
  const first = groups.reduce((a, b) => (score(b) > score(a) ? b : a));
  const keep = new Set([first]);
  // One pass around the main group (no chain reaction): groups of some size
  // whose middle lies close to it. Pieces touching the band's sides (the
  // limb's outline, creases against the body) only stay if they are big.
  const box = { x0: first.x0, y0: first.y0, x1: first.x1, y1: first.y1 };
  const mx = (box.x1 - box.x0) * 0.15 + R * 2, my = (box.y1 - box.y0) * 0.15 + R * 2;
  for (const g of groups) {
    if (keep.has(g) || g.n < first.n * 0.02) continue;
    if (g.cx < box.x0 - mx || g.cx > box.x1 + mx || g.cy < box.y0 - my || g.cy > box.y1 + my) continue;
    const touchesSide = g.x0 <= 2 || g.x1 >= W - 3;
    if (touchesSide && g.n < first.n * 0.2) continue;
    keep.add(g);
  }
  const ids = new Set([...keep].map((g) => groups.indexOf(g)));
  for (let o = 0; o < W * H; o++) if (lab[o] >= 0 && !ids.has(lab[o])) img.data[o * 4 + 3] = 0;
  // Faint pixels not in any group stay; recompute the box of clear ink.
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (img.data[(y * W + x) * 4 + 3] > 64) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  ink.bbox = x1 >= 0 ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null;
}
