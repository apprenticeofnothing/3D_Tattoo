// First guess at the guides for a tattoo photo, so the person only nudges
// handles instead of placing them from scratch:
// - the skin region around the photo centre (or a person mask when a pose
//   model found one), with the tattoo's holes filled in,
// - the tattoo: non-skin pixels inside that region,
// - the limb's direction (long axis of the skin region) and its two
//   outline edges across the tattoo,
// - a quadrilateral around the tattoo for flat areas.

import { crop, linearToSrgbByte, makeImage, SRGB_TO_LINEAR, type Rgba } from './image';
import { extractInk } from './inkExtract';
import type { LimbGuide, Pt } from './unwrap';

export interface Guides {
  limb: LimbGuide & { from: number; to: number };
  quad: [Pt, Pt, Pt, Pt];
  /** The skin region looks like a limb crossing the photo (long and narrow). */
  limbLike: boolean;
  /** Tattoo bounding box (photo pixels), if found. */
  ink: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Where the body is (generously), covering the whole photo: outside it nothing counts as ink. */
  body?: { data: Uint8Array; width: number; height: number };
}

interface Small { w: number; h: number; s: number; lin: Float32Array }

function downscale(img: Rgba, maxSide = 720): Small {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * s)), h = Math.max(1, Math.round(img.height * s));
  const lin = new Float32Array(w * h * 3);
  const cnt = new Float32Array(w * h);
  for (let y = 0; y < img.height; y++) {
    const sy = Math.min(h - 1, Math.floor(y * s));
    for (let x = 0; x < img.width; x++) {
      const sx = Math.min(w - 1, Math.floor(x * s)), i = (y * img.width + x) * 4, o = sy * w + sx;
      lin[o * 3] += SRGB_TO_LINEAR[img.data[i]]; lin[o * 3 + 1] += SRGB_TO_LINEAR[img.data[i + 1]]; lin[o * 3 + 2] += SRGB_TO_LINEAR[img.data[i + 2]];
      cnt[o]++;
    }
  }
  for (let o = 0; o < w * h; o++) if (cnt[o]) for (let c = 0; c < 3; c++) lin[o * 3 + c] /= cnt[o];
  // Rows or columns that received no pixels copy their neighbour; then a light blur against noise.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * w + x;
    if (cnt[o]) continue;
    const k = y > 0 ? o - w : x > 0 ? o - 1 : o;
    for (let c = 0; c < 3; c++) lin[o * 3 + c] = lin[k * 3 + c];
  }
  const blur = new Float32Array(lin.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let sum = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      sum += lin[(yy * w + xx) * 3 + c]; n++;
    }
    blur[(y * w + x) * 3 + c] = sum / n;
  }
  return { w, h, s, lin: blur };
}

const lumOf = (lin: Float32Array, o: number) => 0.2126 * lin[o * 3] + 0.7152 * lin[o * 3 + 1] + 0.0722 * lin[o * 3 + 2];

/**
 * @param personMask optional per-pixel person probability (0..1) at `maskW` x `maskH`,
 *   covering the whole photo (e.g. from a pose model).
 */
export function autoGuides(img: Rgba, personMask?: { data: Float32Array; width: number; height: number }, focus?: Pt): Guides {
  // A tap on a small tattoo in a wide photo: look closely in a window around it.
  const win = Math.round(Math.max(320, 0.4 * Math.max(img.width, img.height)));
  if (focus && win < Math.max(img.width, img.height) * 0.9) {
    const x0 = Math.round(Math.max(0, Math.min(img.width - win, focus.x - win / 2)));
    const y0 = Math.round(Math.max(0, Math.min(img.height - win, focus.y - win / 2)));
    const cw = Math.min(win, img.width), ch = Math.min(win, img.height);
    const sub = crop(img, x0, y0, cw, ch);
    let subMask: typeof personMask;
    if (personMask) {
      const sx = personMask.width / img.width, sy = personMask.height / img.height;
      const mw = Math.max(1, Math.round(cw * sx)), mh = Math.max(1, Math.round(ch * sy));
      const d = new Float32Array(mw * mh);
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
        const mx = Math.min(personMask.width - 1, Math.floor(x0 * sx) + x), my = Math.min(personMask.height - 1, Math.floor(y0 * sy) + y);
        d[y * mw + x] = personMask.data[my * personMask.width + mx];
      }
      subMask = { data: d, width: mw, height: mh };
    }
    const g = guidesIn(sub, subMask, { x: focus.x - x0, y: focus.y - y0 });
    const mv = (p: Pt): Pt => ({ x: p.x + x0, y: p.y + y0 });
    // The body mask only covers the window: outside it, keep everything.
    let body: Guides['body'];
    if (g.body) {
      const bw = Math.min(1024, img.width), bh = Math.max(1, Math.round((img.height * bw) / img.width));
      const d = new Uint8Array(bw * bh).fill(1);
      for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
        const px = ((x + 0.5) / bw) * img.width - x0, py = ((y + 0.5) / bh) * img.height - y0;
        if (px < 0 || py < 0 || px >= cw || py >= ch) continue;
        d[y * bw + x] = g.body.data[Math.min(g.body.height - 1, Math.floor((py / ch) * g.body.height)) * g.body.width + Math.min(g.body.width - 1, Math.floor((px / cw) * g.body.width))];
      }
      body = { data: d, width: bw, height: bh };
    }
    return {
      limb: { p0: mv(g.limb.p0), p1: mv(g.limb.p1), q0: mv(g.limb.q0), q1: mv(g.limb.q1), from: g.limb.from, to: g.limb.to },
      quad: g.quad.map(mv) as [Pt, Pt, Pt, Pt],
      limbLike: g.limbLike,
      ink: g.ink ? { x0: g.ink.x0 + x0, y0: g.ink.y0 + y0, x1: g.ink.x1 + x0, y1: g.ink.y1 + y0 } : null,
      body,
    };
  }
  return guidesIn(img, personMask, focus);
}

function guidesIn(img: Rgba, personMask?: { data: Float32Array; width: number; height: number }, focus?: Pt): Guides {
  const sm = downscale(img);
  const { w, h, lin } = sm;
  // Where to look: a point the person tapped on the tattoo, or the middle of the photo.
  const fx = focus ? Math.max(0, Math.min(w - 1, focus.x * sm.s)) : w / 2, fy = focus ? Math.max(0, Math.min(h - 1, focus.y * sm.s)) : h / 2;
  const reach = focus ? 0.08 : 0.15;
  // Skin reference: brighter half of the central window (ink is darker).
  const half = focus ? 0.1 : 0.2;
  const cx0 = Math.max(0, Math.floor(fx - w * half)), cx1 = Math.min(w, Math.ceil(fx + w * half)), cy0 = Math.max(0, Math.floor(fy - h * half)), cy1 = Math.min(h, Math.ceil(fy + h * half));
  const centre: number[] = [];
  for (let y = cy0; y < cy1; y++) for (let x = cx0; x < cx1; x++) centre.push(y * w + x);
  centre.sort((a, b) => lumOf(lin, a) - lumOf(lin, b));
  const ref = [0, 0, 0];
  const top = centre.slice(Math.floor(centre.length * 0.5), Math.floor(centre.length * 0.9));
  for (const o of top) for (let c = 0; c < 3; c++) ref[c] += lin[o * 3 + c] / top.length;
  const refL = 0.2126 * ref[0] + 0.7152 * ref[1] + 0.0722 * ref[2];
  const refSum = ref[0] + ref[1] + ref[2] || 1;
  const rr = ref[0] / refSum, rg = ref[1] / refSum;
  const skinLike = (o: number) => {
    const r = lin[o * 3], g = lin[o * 3 + 1], b = lin[o * 3 + 2], sum = r + g + b;
    if (sum <= 1e-4) return false;
    const L = lumOf(lin, o) / refL;
    return Math.hypot(r / sum - rr, g / sum - rg) < 0.075 && L > 0.25 && L < 2.2;
  };
  // Region: the person mask, or the skin component containing the centre.
  const region = new Uint8Array(w * h);
  if (personMask) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const mx = Math.min(personMask.width - 1, Math.floor(((x + 0.5) / w) * personMask.width));
      const my = Math.min(personMask.height - 1, Math.floor(((y + 0.5) / h) * personMask.height));
      region[y * w + x] = personMask.data[my * personMask.width + mx] > 0.5 ? 1 : 0;
    }
  } else {
    // Skin mask, closed over small gaps (noise, pores, thin lines), then the
    // connected piece containing the skin nearest the centre.
    const skin = new Uint8Array(w * h);
    for (let o = 0; o < w * h; o++) skin[o] = skinLike(o) ? 1 : 0;
    const grown = dilate(skin, w, h, 2);
    // Connected pieces of skin; keep the one covering most of the central
    // window (not just the pixel nearest the centre, which can be skin
    // enclosed by the tattoo's own lines).
    const lab = new Int32Array(w * h).fill(-1);
    const sizes: number[] = [], central: number[] = [], near: boolean[] = [];
    const nx0 = Math.max(0, fx - w * 0.35), nx1 = Math.min(w, fx + w * 0.35), ny0 = Math.max(0, fy - h * 0.35), ny1 = Math.min(h, fy + h * 0.35);
    for (let o0 = 0; o0 < w * h; o0++) {
      if (!grown[o0] || lab[o0] >= 0) continue;
      const id = sizes.length;
      const st = [o0]; lab[o0] = id;
      let n = 0, c = 0, nr = false;
      while (st.length) {
        const o = st.pop()!, x = o % w, y = (o - x) / w;
        n++; if (x >= cx0 && x < cx1 && y >= cy0 && y < cy1) c++;
        if (x >= nx0 && x < nx1 && y >= ny0 && y < ny1) nr = true;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const k = yy * w + xx;
          if (grown[k] && lab[k] < 0) { lab[k] = id; st.push(k); }
        }
      }
      sizes.push(n); central.push(c); near.push(nr);
    }
    // Take every sizeable piece of skin reaching into the middle of the
    // photo; after filling holes, the piece under the focus is the body
    // part (skin enclosed by the tattoo's own outline becomes part of it).
    const conn = new Uint8Array(w * h);
    let any = false;
    for (let i = 0; i < sizes.length; i++) if (near[i] && (sizes[i] > w * h * 0.004 || central[i] > 0)) any = true;
    if (any) {
      for (let o = 0; o < w * h; o++) { const i = lab[o]; if (i >= 0 && near[i] && (sizes[i] > w * h * 0.004 || central[i] > 0)) conn[o] = 1; }
      region.set(erode(conn, w, h, 2));
    } else region.fill(1);
  }
  // Fill holes (the tattoo itself): anything not reachable from the border
  // through non-region pixels. Close the region first, so a tattoo that
  // reaches the limb's outline at a corner still counts as enclosed.
  const closeR = Math.max(2, Math.round(Math.max(w, h) * 0.01));
  const sealed = erode(dilate(region, w, h, closeR), w, h, closeR);
  for (let o = 0; o < w * h; o++) if (region[o]) sealed[o] = 1;
  region.set(sealed);
  const outside = new Uint8Array(w * h);
  const stack: number[] = [];
  for (let x = 0; x < w; x++) { stack.push(x, (h - 1) * w + x); }
  for (let y = 0; y < h; y++) { stack.push(y * w, y * w + w - 1); }
  while (stack.length) {
    const o = stack.pop()!;
    if (outside[o] || region[o]) continue;
    outside[o] = 1;
    const x = o % w, y = (o - x) / w;
    if (x > 0) stack.push(o - 1); if (x < w - 1) stack.push(o + 1);
    if (y > 0) stack.push(o - w); if (y < h - 1) stack.push(o + w);
  }
  const all = new Uint8Array(w * h);
  for (let o = 0; o < w * h; o++) if (!outside[o]) all[o] = 1;
  // Keep the piece under the focus (or the nearest one).
  let start = -1, bd = Infinity;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    if (!all[y * w + x]) continue;
    const d = Math.hypot(x - fx, y - fy);
    if (d < bd) { bd = d; start = y * w + x; }
  }
  const filled = new Uint8Array(w * h);
  let nFilled = 0;
  if (start >= 0) {
    const st = [start]; filled[start] = 1;
    while (st.length) {
      const o = st.pop()!, x = o % w, y = (o - x) / w; nFilled++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (all[k] && !filled[k]) { filled[k] = 1; st.push(k); }
      }
    }
  }
  if (nFilled < w * h * 0.02) filled.fill(1);
  for (let o = 0; o < w * h; o++) if (!filled[o]) region[o] = 0;
  // Ink: measured against the local skin colour and lighting (as in the
  // final extraction), inside the region but away from its rim.
  const regionImg = makeImage(w, h);
  for (let o = 0; o < w * h; o++) {
    for (let c = 0; c < 3; c++) regionImg.data[o * 4 + c] = linearToSrgbByte(lin[o * 3 + c]);
    regionImg.data[o * 4 + 3] = filled[o] ? 255 : 0;
  }
  const inkImg = extractInk(regionImg).image;
  const inkMask = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = y * w + x;
    if (inkImg.data[o * 4 + 3] < 115) continue; // clear ink only (shading leaves faint residue)
    let rim = false;
    for (let d = 1; d <= 3 && !rim; d++) for (const [dx, dy] of [[d, 0], [-d, 0], [0, d], [0, -d]]) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h || !filled[yy * w + xx]) { rim = true; break; }
    }
    if (!rim) inkMask[o] = 1;
  }
  // Group strokes into blobs (joining gaps of a few pixels) and keep the
  // biggest blob near the middle of the photo: that is the tattoo.
  const R = Math.max(2, Math.round(Math.max(w, h) / 240)), comp = new Int32Array(w * h).fill(-1);
  const blobs: { n: number; cx: number; cy: number; x0: number; y0: number; x1: number; y1: number }[] = [];
  for (let o0 = 0; o0 < w * h; o0++) {
    if (!inkMask[o0] || comp[o0] >= 0) continue;
    const id = blobs.length;
    const st = [o0]; comp[o0] = id;
    let n = 0, sx = 0, sy = 0, x0 = w, y0 = h, x1 = -1, y1 = -1;
    while (st.length) {
      const o = st.pop()!, x = o % w, y = (o - x) / w;
      n++; sx += x; sy += y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        const k = yy * w + xx;
        if (inkMask[k] && comp[k] < 0) { comp[k] = id; st.push(k); }
      }
    }
    blobs.push({ n, cx: sx / n, cy: sy / n, x0, y0, x1, y1 });
  }
  // Photos of a tattoo are aimed at it: start from the biggest blob near
  // the centre, then take in blobs whose middle lies close to it (the other
  // strokes of the same tattoo), growing until nothing more joins.
  const centreScore = (b: (typeof blobs)[number]) => b.n * Math.exp(-((Math.hypot(b.cx - fx, b.cy - fy) / (reach * Math.hypot(w, h))) ** 2));
  let best = { x0: 0, y0: 0, x1: -1, y1: -1, n: 0 };
  const first = blobs.reduce<(typeof blobs)[number] | null>((a, b) => (!a || centreScore(b) > centreScore(a) ? b : a), null);
  if (first && first.n > 3) {
    best = { x0: first.x0, y0: first.y0, x1: first.x1, y1: first.y1, n: first.n };
    const used = new Set([first]);
    // One pass (no chain reaction), only blobs of some substance.
    const mx = (best.x1 - best.x0) * 0.2 + 4, my = (best.y1 - best.y0) * 0.2 + 4;
    const box = { ...best };
    for (const b of blobs) {
      if (used.has(b) || b.n < Math.max(3, first.n * 0.01)) continue;
      if (b.cx < box.x0 - mx || b.cx > box.x1 + mx || b.cy < box.y0 - my || b.cy > box.y1 + my) continue;
      used.add(b);
      best = { x0: Math.min(best.x0, b.x0), y0: Math.min(best.y0, b.y0), x1: Math.max(best.x1, b.x1), y1: Math.max(best.y1, b.y1), n: best.n + b.n };
    }
  }
  const hasInk = best.n > 6;
  const ix0 = best.x0, iy0 = best.y0, ix1 = best.x1, iy1 = best.y1;
  const ic = hasInk ? { x: (ix0 + ix1) / 2, y: (iy0 + iy1) / 2 } : { x: fx, y: fy };
  // Limb direction near the tattoo: a limb's outlines and its shading both
  // run along it, so the dominant direction of brightness changes (outside
  // the ink) points across the limb. Structure tensor of log-brightness.
  const logL = new Float32Array(w * h);
  for (let o = 0; o < w * h; o++) logL[o] = Math.log(Math.max(1e-4, lumOf(lin, o)));
  const inkNear = dilate(inkMask, w, h, 2);
  const win = hasInk ? Math.hypot(ix1 - ix0, iy1 - iy0) * 0.9 + 12 : Math.min(w, h) * 0.45;
  let jxx = 0, jxy = 0, jyy = 0, edgeN = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const o = y * w + x;
    if (inkNear[o] || Math.hypot(x - ic.x, y - ic.y) > win) continue;
    const gx = logL[o + 1] - logL[o - 1], gy = logL[o + w] - logL[o - w];
    jxx += gx * gx; jxy += gx * gy; jyy += gy * gy; edgeN++;
  }
  let ax: { x: number; y: number };
  if (edgeN > 8 && jxx + jyy > 1e-6) {
    const tr2 = jxx + jyy, det2 = jxx * jyy - jxy * jxy, big = tr2 / 2 + Math.sqrt(Math.max(0, (tr2 * tr2) / 4 - det2));
    const across = Math.abs(jxy) > 1e-12 ? { x: big - jyy, y: jxy } : jxx >= jyy ? { x: 1, y: 0 } : { x: 0, y: 1 };
    ax = { x: -across.y, y: across.x };
  } else ax = { x: 0, y: 1 };
  const al = Math.hypot(ax.x, ax.y) || 1; ax = { x: ax.x / al, y: ax.y / al };
  // Point the axis "down" the photo (or right if horizontal): body end first by default.
  if (ax.y < -1e-6 || (Math.abs(ax.y) < 1e-6 && ax.x < 0)) ax = { x: -ax.x, y: -ax.y };
  const perp = { x: ax.y, y: -ax.x };
  // Tattoo extent along the axis.
  let a0 = Infinity, a1 = -Infinity;
  const corners = hasInk ? [[ix0, iy0], [ix1, iy0], [ix1, iy1], [ix0, iy1]] : [[w * 0.3, h * 0.3], [w * 0.7, h * 0.3], [w * 0.7, h * 0.7], [w * 0.3, h * 0.7]];
  for (const [x, y] of corners) {
    const a = (x - ic.x) * ax.x + (y - ic.y) * ax.y;
    a0 = Math.min(a0, a); a1 = Math.max(a1, a);
  }
  const padA = (a1 - a0) * 0.12 + 3;
  a0 -= padA; a1 += padA;
  // Limb edges: walk across the region at the two ends of the tattoo.
  let borderHits = 0;
  // Cross-sections must start on the limb: step towards the tattoo's middle until they do.
  const onLimb = (a: number) => {
    const x = Math.round(ic.x + ax.x * a), y = Math.round(ic.y + ax.y * a);
    return x >= 0 && y >= 0 && x < w && y < h && !!filled[y * w + x];
  };
  for (let k = 0; k < 400 && a0 < 0 && !onLimb(a0); k++) a0 = Math.min(0, a0 + 1);
  for (let k = 0; k < 400 && a1 > 0 && !onLimb(a1); k++) a1 = Math.max(0, a1 - 1);
  const edgeAt = (a: number): [Pt, Pt] => {
    const base = { x: ic.x + ax.x * a, y: ic.y + ax.y * a };
    const walk = (sgn: number): Pt => {
      let last = base;
      const at = (t: number) => {
        const xi = Math.round(base.x + perp.x * t * sgn), yi = Math.round(base.y + perp.y * t * sgn);
        return xi < 0 || yi < 0 || xi >= w || yi >= h ? -1 : yi * w + xi;
      };
      for (let t = 0; t < Math.max(w, h); t += 1) {
        const o = at(t);
        const p = { x: base.x + perp.x * t * sgn, y: base.y + perp.y * t * sgn };
        if (o < 0) { borderHits++; return last; }
        if (!filled[o]) return last;
        // A sharp brightness step outside the ink: the limb's outline against
        // whatever is behind it (even other skin in shadow).
        const o2 = at(t + 2), o0 = at(t - 1);
        if (t > 3 && o2 >= 0 && o0 >= 0 && !inkNear[o] && !inkNear[o2] && !inkNear[o0] && Math.abs(logL[o2] - logL[o0]) > 0.16) return p;
        last = p;
      }
      return last;
    };
    return [walk(-1), walk(1)];
  };
  const [e0a, e0b] = edgeAt(a0), [e1a, e1b] = edgeAt(a1);
  // Flat (back, chest) when skin runs off the photo on most sides; a limb otherwise.
  const limbLike = borderHits <= 1 && Math.hypot(e0b.x - e0a.x, e0b.y - e0a.y) > 4;
  const k = 1 / sm.s;
  const P = (p: Pt): Pt => ({ x: p.x * k, y: p.y * k });
  return {
    limb: { p0: P(e0a), p1: P(e1a), q0: P(e0b), q1: P(e1b), from: 0, to: 1 },
    // Flat areas: an upright box around the tattoo (the photo's top is the design's top).
    quad: flatQuad(hasInk ? { x0: ix0 * k, y0: iy0 * k, x1: (ix1 + 1) * k, y1: (iy1 + 1) * k } : { x0: img.width * 0.3, y0: img.height * 0.3, x1: img.width * 0.7, y1: img.height * 0.7 }, img),
    limbLike,
    ink: hasInk ? { x0: ix0 * k, y0: iy0 * k, x1: (ix1 + 1) * k, y1: (iy1 + 1) * k } : null,
    body: { data: dilate(filled, w, h, Math.max(3, Math.round(Math.max(w, h) * 0.03))), width: w, height: h },
  };
}

function flatQuad(b: { x0: number; y0: number; x1: number; y1: number }, img: Rgba): [Pt, Pt, Pt, Pt] {
  const px = (b.x1 - b.x0) * 0.12 + 4, py = (b.y1 - b.y0) * 0.12 + 4;
  const x0 = Math.max(0, b.x0 - px), y0 = Math.max(0, b.y0 - py), x1 = Math.min(img.width, b.x1 + px), y1 = Math.min(img.height, b.y1 + py);
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
}

function dilate(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!m[y * w + x]) continue;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < w && yy < h) out[yy * w + xx] = 1;
    }
  }
  return out;
}

function erode(m: Uint8Array, w: number, h: number, r: number): Uint8Array {
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = m[i] ? 0 : 1;
  const d = dilate(inv, w, h, r);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i] ? 0 : 1;
  // Pixels at the image border stay as they were (no outside neighbours to erode from).
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) out[y * w + x] = m[y * w + x] && out[y * w + x];
  return out;
}

/** A copy of the photo with everything outside the body made transparent (so it never counts as ink). */
export function maskOutside(img: Rgba, body: NonNullable<Guides['body']>): Rgba {
  const out = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let y = 0; y < img.height; y++) {
    const my = Math.min(body.height - 1, Math.floor(((y + 0.5) / img.height) * body.height));
    for (let x = 0; x < img.width; x++) {
      const mx = Math.min(body.width - 1, Math.floor(((x + 0.5) / img.width) * body.width));
      if (!body.data[my * body.width + mx]) out.data[(y * img.width + x) * 4 + 3] = 0;
    }
  }
  return out;
}
