// Separate tattoo ink from skin in a (flattened) photo.
//
// Ink acts like a filter in the skin: what the camera sees is roughly the
// bare skin colour times the ink's transmission. So we estimate the bare
// skin (including uneven lighting) everywhere, divide it out, and turn the
// remaining ratio into an ink colour with an alpha, the way "colour to
// alpha" works with white. The result is a design whose "inked skin"
// render (multiply) reproduces the photo's ink on any skin tone.
//
// The skin estimate comes from a coarse grid of the brighter pixels in
// each cell; cells that are mostly ink (solid blackwork) are filled in
// from their neighbours. Everything is computed in linear light.

import { linearToSrgbByte, makeImage, SRGB_TO_LINEAR, type Rgba } from './image';

export interface InkOptions {
  /** Grid cell size in pixels (default: about 1/20 of the shorter side). */
  cell?: number;
  /**
   * Ink below this strength (0..1) is treated as skin texture and removed.
   * Default: estimated from the image noise.
   */
  floor?: number;
}

export interface InkResult {
  /** Ink colour (sRGB) with alpha = ink strength; transparent where there is no ink. */
  image: Rgba;
  /** Noise floor that was used. */
  floor: number;
  /** Bounding box of clear ink (alpha > 0.25), or null if none. */
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Fraction of valid pixels with clear ink. */
  inkFraction: number;
}

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Bare-skin colour (linear RGB, 3 floats per pixel) under the photo's
 * lighting. Pixels with alpha 0 are outside the usable area and ignored.
 */
export function estimateSkin(img: Rgba, cellSize?: number): Float32Array {
  const { width: W, height: H, data: d } = img;
  const cs = Math.max(6, Math.round(cellSize ?? Math.min(W, H) / 20));
  const gw = Math.max(1, Math.ceil(W / cs)), gh = Math.max(1, Math.ceil(H / cs));
  const cellRgb = new Float32Array(gw * gh * 3);
  const cellL = new Float32Array(gw * gh);
  const known = new Uint8Array(gw * gh);
  const L: number[] = [], idx: number[] = [];
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    L.length = 0; idx.length = 0;
    for (let y = gy * cs; y < Math.min(H, (gy + 1) * cs); y++) for (let x = gx * cs; x < Math.min(W, (gx + 1) * cs); x++) {
      const i = (y * W + x) * 4;
      if (d[i + 3] < 128) continue;
      L.push(lum(SRGB_TO_LINEAR[d[i]], SRGB_TO_LINEAR[d[i + 1]], SRGB_TO_LINEAR[d[i + 2]]));
      idx.push(i);
    }
    const c = gy * gw + gx;
    if (L.length < 4) continue;
    // Mean colour of the pixels between the 70th and 92nd brightness
    // percentiles: skin, not ink, and not specular highlights.
    const order = L.map((_, k) => k).sort((a, b) => L[a] - L[b]);
    const lo = Math.floor(order.length * 0.7), hi = Math.max(lo + 1, Math.floor(order.length * 0.92));
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = lo; k < hi; k++) {
      const i = idx[order[k]];
      r += SRGB_TO_LINEAR[d[i]]; g += SRGB_TO_LINEAR[d[i + 1]]; b += SRGB_TO_LINEAR[d[i + 2]]; n++;
    }
    cellRgb[c * 3] = r / n; cellRgb[c * 3 + 1] = g / n; cellRgb[c * 3 + 2] = b / n;
    cellL[c] = lum(r / n, g / n, b / n);
    known[c] = 1;
  }
  // Cells that are mostly ink are much darker than the skin around them (or
  // than the brightest skin overall): forget them and fill them in.
  const knownL = [...cellL].filter((_, c) => known[c]).sort((a, b) => a - b);
  if (!knownL.length) return new Float32Array(W * H * 3).fill(1);
  const bright = knownL[Math.floor(knownL.length * 0.9)];
  const flagged = new Uint8Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    const c = gy * gw + gx;
    if (!known[c]) continue;
    const near: number[] = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = gx + dx, y = gy + dy;
      if (x < 0 || y < 0 || x >= gw || y >= gh || !known[y * gw + x]) continue;
      near.push(cellL[y * gw + x]);
    }
    near.sort((a, b) => a - b);
    const med = near[Math.floor(near.length / 2)];
    if (cellL[c] < 0.72 * med || cellL[c] < 0.45 * bright) flagged[c] = 1;
  }
  for (let c = 0; c < gw * gh; c++) if (flagged[c]) known[c] = 0;
  // Fill unknown cells from known neighbours, growing outwards.
  for (let pass = 0; pass < gw + gh; pass++) {
    let missing = 0;
    const next = known.slice();
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const c = gy * gw + gx;
      if (known[c]) continue;
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const k = y * gw + x;
        if (!known[k]) continue;
        r += cellRgb[k * 3]; g += cellRgb[k * 3 + 1]; b += cellRgb[k * 3 + 2]; n++;
      }
      if (n) { cellRgb[c * 3] = r / n; cellRgb[c * 3 + 1] = g / n; cellRgb[c * 3 + 2] = b / n; next[c] = 1; } else missing++;
    }
    known.set(next);
    if (!missing) break;
  }
  // Light smoothing of the grid, then bilinear interpolation between cell centres.
  const sm = new Float32Array(cellRgb.length);
  for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
    for (let ch = 0; ch < 3; ch++) {
      let s = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const x = gx + dx, y = gy + dy;
        if (x < 0 || y < 0 || x >= gw || y >= gh) continue;
        const w = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
        s += cellRgb[(y * gw + x) * 3 + ch] * w; n += w;
      }
      sm[(gy * gw + gx) * 3 + ch] = s / n;
    }
  }
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const fy = Math.max(0, Math.min(gh - 1, (y + 0.5) / cs - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < W; x++) {
      const fx = Math.max(0, Math.min(gw - 1, (x + 0.5) / cs - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      for (let ch = 0; ch < 3; ch++) {
        const a = sm[(y0 * gw + x0) * 3 + ch] * (1 - tx) + sm[(y0 * gw + x1) * 3 + ch] * tx;
        const b = sm[(y1 * gw + x0) * 3 + ch] * (1 - tx) + sm[(y1 * gw + x1) * 3 + ch] * tx;
        out[(y * W + x) * 3 + ch] = a * (1 - ty) + b * ty;
      }
    }
  }
  return out;
}

/** Ink strength (0..1) per pixel before any clean-up, plus its colour. */
function rawInk(img: Rgba, skin: Float32Array): { alpha: Float32Array; rgb: Float32Array } {
  const { width: W, height: H, data: d } = img;
  const alpha = new Float32Array(W * H), rgb = new Float32Array(W * H * 3).fill(1);
  for (let p = 0; p < W * H; p++) {
    if (d[p * 4 + 3] < 128) continue;
    let mn = 1;
    const r = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const s = Math.max(1e-4, skin[p * 3 + c]);
      r[c] = Math.min(1, SRGB_TO_LINEAR[d[p * 4 + c]] / s);
      mn = Math.min(mn, r[c]);
    }
    const a = 1 - mn;
    alpha[p] = a;
    if (a > 1e-3) for (let c = 0; c < 3; c++) rgb[p * 3 + c] = Math.max(0, Math.min(1, 1 - (1 - r[c]) / a));
  }
  return { alpha, rgb };
}

/** Typical skin-texture "ink" level: median + 4 robust deviations, clamped. */
export function estimateFloor(alpha: Float32Array, valid?: (p: number) => boolean): number {
  const vals: number[] = [];
  const step = Math.max(1, Math.floor(alpha.length / 40000));
  for (let p = 0; p < alpha.length; p += step) if (!valid || valid(p)) vals.push(alpha[p]);
  if (!vals.length) return 0.08;
  vals.sort((a, b) => a - b);
  const med = vals[Math.floor(vals.length / 2)];
  const dev = vals.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[Math.floor(vals.length / 2)];
  return Math.max(0.05, Math.min(0.35, med + 4 * 1.4826 * dev + 0.02));
}

export function extractInk(img: Rgba, opts: InkOptions = {}): InkResult {
  const { width: W, height: H, data: d } = img;
  const skin = estimateSkin(img, opts.cell);
  const { alpha, rgb } = rawInk(img, skin);
  const floor = opts.floor ?? estimateFloor(alpha, (p) => d[p * 4 + 3] >= 128);
  const out = makeImage(W, H);
  // Below the floor: skin texture. Between floor and 2x floor: fade in.
  // Above: the ink's full measured strength, so dark ink stays dark.
  const a2 = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const a = alpha[p];
    a2[p] = a <= floor ? 0 : a * Math.min(1, (a - floor) / floor);
  }
  // Remove isolated specks (pores, single noisy pixels).
  let x0 = W, y0 = H, x1 = -1, y1 = -1, ink = 0, valid = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = y * W + x;
    if (d[p * 4 + 3] >= 128) valid++;
    let a = a2[p];
    if (a > 0) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && a2[yy * W + xx] > 0) n++;
      }
      if (n < 2) a = 0;
    }
    const o = p * 4;
    out.data[o] = linearToSrgbByte(rgb[p * 3]);
    out.data[o + 1] = linearToSrgbByte(rgb[p * 3 + 1]);
    out.data[o + 2] = linearToSrgbByte(rgb[p * 3 + 2]);
    out.data[o + 3] = Math.round(a * 255);
    if (a > 0.25) { ink++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { image: out, floor, bbox: x1 >= 0 ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null, inkFraction: valid ? ink / valid : 0 };
}
