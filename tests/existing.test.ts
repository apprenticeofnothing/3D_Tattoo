import { describe, expect, it } from 'vitest';
import { makeImage, SRGB_TO_LINEAR, linearToSrgbByte, type Rgba } from '../src/existing/image';
import { extractInk } from '../src/existing/inkExtract';
import { applyHomography, limbFrame, rectifyQuad, squareToQuad, unwrapLimb } from '../src/existing/unwrap';

/** Deterministic noise in -1..1. */
function rand(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return (s / 0xffffffff) * 2 - 1; };
}

const SKIN = [225, 180, 160].map((v) => SRGB_TO_LINEAR[v]);

/** Skin with lighting from 60% (left) to 100% (right), noise, and ink given by a transmission function. */
function photo(W: number, H: number, ink: (x: number, y: number) => [number, number, number] | null, seed = 1): Rgba {
  const img = makeImage(W, H);
  const n = rand(seed);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const light = 0.6 + 0.4 * (x / (W - 1));
    const t = ink(x, y) ?? [1, 1, 1];
    const tex = 1 + 0.03 * n();
    const o = (y * W + x) * 4;
    for (let c = 0; c < 3; c++) img.data[o + c] = linearToSrgbByte(SKIN[c] * light * tex * t[c]);
    img.data[o + 3] = 255;
  }
  return img;
}

const alphaAt = (img: Rgba, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3] / 255;
const rgbAt = (img: Rgba, x: number, y: number) => [0, 1, 2].map((c) => SRGB_TO_LINEAR[img.data[(y * img.width + x) * 4 + c]]);

describe('ink extraction', () => {
  const BLACK: [number, number, number] = [0.12, 0.12, 0.13];
  const RED: [number, number, number] = [0.8, 0.12, 0.12];
  const W = 320, H = 220;
  const inkAt = (x: number, y: number): [number, number, number] | null => {
    if (Math.abs(y - 40) < 2.5 && x > 20 && x < 300) return BLACK; // thin line across the lighting gradient
    if (Math.abs(x - 40) < 2.5 && y > 20 && y < 200) return BLACK;
    if (Math.hypot(x - 120, y - 130) < 30) return RED;
    if (x > 200 && x < 270 && y > 90 && y < 170) return BLACK; // solid blackwork block
    return null;
  };
  const res = extractInk(photo(W, H, inkAt));

  it('keeps thin black lines, solid fills and coloured ink at their strength', () => {
    for (const [x, y] of [[60, 40], [160, 40], [280, 40], [40, 120], [235, 130], [210, 100]]) {
      expect(alphaAt(res.image, x, y)).toBeGreaterThan(0.75);
      // Rendered over the bare skin, the ink reproduces the photo's darkening.
      const a = alphaAt(res.image, x, y), c = rgbAt(res.image, x, y);
      for (let ch = 0; ch < 3; ch++) expect(Math.abs(1 - a * (1 - c[ch]) - BLACK[ch])).toBeLessThan(0.1);
    }
    const a = alphaAt(res.image, 120, 130), c = rgbAt(res.image, 120, 130);
    expect(a).toBeGreaterThan(0.7);
    expect(c[0]).toBeGreaterThan(3 * c[1]); // still red
    for (let ch = 0; ch < 3; ch++) expect(Math.abs(1 - a * (1 - c[ch]) - RED[ch])).toBeLessThan(0.1);
  });

  it('removes bare skin, even where the lighting is 40% darker', () => {
    let skin = 0, clean = 0;
    for (let y = 0; y < H; y += 2) for (let x = 0; x < W; x += 2) {
      // Skip pixels next to ink (edges are legitimately partial).
      let near = false;
      for (let dy = -4; dy <= 4 && !near; dy += 2) for (let dx = -4; dx <= 4 && !near; dx += 2) if (inkAt(x + dx, y + dy)) near = true;
      if (near) continue;
      skin++;
      if (alphaAt(res.image, x, y) < 0.05) clean++;
    }
    expect(clean / skin).toBeGreaterThan(0.99);
    expect(res.bbox).not.toBeNull();
    expect(res.bbox!.x0).toBeLessThanOrEqual(23);
    expect(res.bbox!.x1).toBeGreaterThanOrEqual(297);
  });
});

describe('limb unwrap', () => {
  // A vertical limb of radius 80 px seen from the side (orthographic), with
  // a stripe every 20 px of length along the skin.
  const W = 300, H = 300, CX = 150, R = 80, PERIOD = 20;
  // Anti-aliased like a real camera: each pixel averages 16 samples across it.
  const img = photo(W, H, (x) => {
    let cover = 0;
    for (let k = 0; k < 16; k++) {
      const dx = x + (k + 0.5) / 16 - CX;
      if (Math.abs(dx) >= R) continue;
      const s = R * Math.asin(dx / R) + 1000 * PERIOD;
      if (s % PERIOD < 4) cover++;
    }
    const t = 1 - 0.9 * (cover / 16);
    return cover ? [t, t, t] : null;
  });
  // Outside the limb: dark background.
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.abs(x + 0.5 - CX) >= R) { const o = (y * W + x) * 4; img.data[o] = img.data[o + 1] = img.data[o + 2] = 20; }

  it('finds the axis and radius from the two edges, also when tapered', () => {
    const f = limbFrame({ p0: { x: 70, y: 20 }, p1: { x: 70, y: 280 }, q0: { x: 230, y: 20 }, q1: { x: 230, y: 280 } });
    expect(f.u.x).toBeCloseTo(0, 6); expect(f.u.y).toBeCloseTo(1, 6);
    expect(f.at(100).r).toBeCloseTo(80, 6);
    expect(f.at(100).c.x).toBeCloseTo(150, 6);
    const tapered = limbFrame({ p0: { x: 60, y: 0 }, p1: { x: 80, y: 200 }, q0: { x: 240, y: 0 }, q1: { x: 220, y: 200 } });
    expect(tapered.at(0).r).toBeCloseTo(90, 1);
    expect(tapered.at(tapered.length).r).toBeCloseTo(70, 1);
  });

  it('turns stripes squeezed towards the edges back into even spacing', () => {
    const res = unwrapLimb(img, { p0: { x: CX - R, y: 20 }, p1: { x: CX - R, y: 280 }, q0: { x: CX + R, y: 20 }, q1: { x: CX + R, y: 280 } }, { maxAngleDeg: 70 });
    expect(res.radiusPx).toBeCloseTo(80, 6);
    const ink = extractInk(res.image, { floor: 0.3 });
    const y = Math.floor(ink.image.height / 2);
    // Stripe centres along the middle row.
    // Alpha-weighted centroid of each stripe (sub-pixel).
    const centres: number[] = [];
    let sw = 0, sx = 0;
    for (let x = 0; x <= ink.image.width; x++) {
      const a = x < ink.image.width ? alphaAt(ink.image, x, y) : 0;
      if (a > 0.05) { sw += a; sx += a * (x + 0.5); }
      else if (sw > 0) { if (sw > 1) centres.push(sx / sw); sw = 0; sx = 0; }
    }
    const mid = ink.image.width / 2;
    const within = centres.filter((c) => Math.abs(c - mid) / R < (60 * Math.PI) / 180);
    expect(within.length).toBeGreaterThan(6);
    const gaps = within.slice(1).map((c, i) => c - within[i]);
    for (const g of gaps) expect(Math.abs(g - PERIOD) / PERIOD).toBeLessThan(0.03);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    expect(Math.abs(mean - PERIOD) / PERIOD).toBeLessThan(0.02);
  });
});

describe('flat rectification', () => {
  it('maps the unit square to the quad corners', () => {
    const q: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [{ x: 10, y: 20 }, { x: 200, y: 35 }, { x: 180, y: 160 }, { x: 25, y: 140 }];
    const m = squareToQuad(q);
    const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([s, t]) => applyHomography(m, s, t));
    corners.forEach((c, i) => { expect(c.x).toBeCloseTo(q[i].x, 6); expect(c.y).toBeCloseTo(q[i].y, 6); });
  });

  it('undoes perspective: a grid photographed at an angle comes back even', () => {
    // A 10 x 10 grid of 1-unit squares, seen through a perspective map.
    const q: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [{ x: 40, y: 30 }, { x: 260, y: 50 }, { x: 240, y: 250 }, { x: 60, y: 220 }];
    const m = squareToQuad(q);
    // Invert numerically by rendering: for each photo pixel find (s, t) by Newton steps.
    const W = 300, H = 280;
    const img = photo(W, H, (x, y) => {
      let s = 0.5, t = 0.5;
      for (let k = 0; k < 20; k++) {
        const p = applyHomography(m, s, t), ps = applyHomography(m, s + 1e-4, t), pt = applyHomography(m, s, t + 1e-4);
        const a = (ps.x - p.x) / 1e-4, b = (pt.x - p.x) / 1e-4, c = (ps.y - p.y) / 1e-4, d = (pt.y - p.y) / 1e-4;
        const ex = x + 0.5 - p.x, ey = y + 0.5 - p.y, det = a * d - b * c;
        s += (d * ex - b * ey) / det; t += (-c * ex + a * ey) / det;
      }
      if (s < 0 || s > 1 || t < 0 || t > 1) return null;
      const gx = (s * 10) % 1, gy = (t * 10) % 1;
      return gx < 0.12 || gy < 0.12 ? [0.1, 0.1, 0.1] : null;
    });
    const res = rectifyQuad(img, q);
    const ink = extractInk(res.image, { floor: 0.3 });
    const Wr = ink.image.width, row = Math.floor(ink.image.height * 0.55);
    const lines: number[] = [];
    let start = -1;
    for (let x = 0; x <= Wr; x++) {
      const on = x < Wr && alphaAt(ink.image, x, row) > 0.5;
      if (on && start < 0) start = x;
      if (!on && start >= 0) { lines.push((start + x) / 2 / Wr); start = -1; }
    }
    // Line starts at multiples of 0.1 of the width (thickness 0.012).
    const inner = lines.filter((l) => l > 0.05 && l < 0.95);
    expect(inner.length).toBeGreaterThanOrEqual(8);
    for (const l of inner) {
      const k = Math.round((l - 0.006) * 10) / 10;
      expect(Math.abs(l - 0.006 - k)).toBeLessThan(0.012);
    }
  });
});

describe('automatic guides', () => {
  it('finds a tilted limb, its edges and the tattoo on it', async () => {
    const { autoGuides } = await import('../src/existing/autoGuide');
    // A limb of radius 70 px tilted 30 degrees from vertical across a dark background,
    // shaded like a cylinder, with a dark square tattoo in the middle.
    const W = 640, H = 480, R = 70, ang = (30 * Math.PI) / 180;
    const ax = { x: Math.sin(ang), y: Math.cos(ang) }, perp = { x: ax.y, y: -ax.x };
    const img = makeImage(W, H);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dx = x + 0.5 - W / 2, dy = y + 0.5 - H / 2;
      const across = dx * perp.x + dy * perp.y, along = dx * ax.x + dy * ax.y;
      const o = (y * W + x) * 4;
      img.data[o + 3] = 255;
      if (Math.abs(across) >= R) { img.data[o] = 28; img.data[o + 1] = 30; img.data[o + 2] = 36; continue; }
      const shade = 0.55 + 0.45 * Math.sqrt(1 - (across / R) ** 2);
      const ink = Math.abs(across) < 40 && Math.abs(along) < 40 && (Math.abs(across) > 30 || Math.abs(along) > 30 || (Math.abs(across) < 8 && Math.abs(along) < 25)) ? 0.12 : 1;
      for (let c = 0; c < 3; c++) img.data[o + c] = linearToSrgbByte(SKIN[c] * shade * ink);
    }
    const g = autoGuides(img);
    expect(g.limbLike).toBe(true);
    // Axis direction within 5 degrees of the truth (either way round).
    const f = limbFrame(g.limb);
    const cosA = Math.abs(f.u.x * ax.x + f.u.y * ax.y);
    expect(Math.acos(Math.min(1, cosA)) * 180 / Math.PI).toBeLessThan(5);
    // Width between the edges within 8% of the true diameter.
    const mid = f.at(f.length / 2);
    expect(Math.abs(mid.r - R) / R).toBeLessThan(0.08);
    // The tattoo (an 80 px square rotated with the limb) is inside the found box.
    expect(g.ink).not.toBeNull();
    const cx = (g.ink!.x0 + g.ink!.x1) / 2, cy = (g.ink!.y0 + g.ink!.y1) / 2;
    expect(Math.hypot(cx - W / 2, cy - H / 2)).toBeLessThan(10);
  });
});

describe('limb unwrap with perspective', () => {
  // A vertical cylinder (radius 1) 6 radii from a pinhole camera with an
  // 800 px focal length, stripes every 0.2 radii of skin. A close phone
  // photo of a forearm is like this (4 cm radius seen from 24 cm).
  const W = 400, H = 200, F = 800, D = 6, Rc = 1, cx = 200;
  const img = makeImage(W, H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let cover = 0, hit = 0;
    for (let k = 0; k < 8; k++) {
      const a = (x + (k + 0.5) / 8 - cx) / F; // ray x = a z
      const A = a * a + 1, disc = D * D - A * (D * D - Rc * Rc);
      if (disc < 0) continue;
      hit++;
      const z = (D - Math.sqrt(disc)) / A;
      const th = Math.atan2(a * z, D - z);
      if (((Rc * th) / 0.2 + 1000) % 1 < 0.2) cover++;
    }
    const o = (y * W + x) * 4;
    img.data[o + 3] = 255;
    if (!hit) { img.data[o] = img.data[o + 1] = img.data[o + 2] = 25; continue; }
    const t = 1 - 0.88 * (cover / 8);
    for (let c = 0; c < 3; c++) img.data[o + c] = linearToSrgbByte(SKIN[c] * t);
  }
  const hw = F * Math.tan(Math.asin(Rc / D)); // apparent half-width of the outline
  const guide = { p0: { x: cx - hw, y: 10 }, p1: { x: cx - hw, y: 190 }, q0: { x: cx + hw, y: 10 }, q1: { x: cx + hw, y: 190 } };
  const stripes = (res: ReturnType<typeof unwrapLimb>) => {
    const ink = extractInk(res.image, { floor: 0.3 });
    const y = Math.floor(ink.image.height / 2), out: number[] = [];
    let sw = 0, sx = 0;
    for (let x = 0; x <= ink.image.width; x++) {
      const a = x < ink.image.width ? alphaAt(ink.image, x, y) : 0;
      if (a > 0.05) { sw += a; sx += a * (x + 0.5); } else if (sw > 0) { if (sw > 1) out.push(sx / sw); sw = 0; sx = 0; }
    }
    const mid = ink.image.width / 2;
    return out.filter((c) => Math.abs(c - mid) < 0.75 * mid).slice(1, -1);
  };

  it('spaces the stripes evenly and sizes them by the front of the limb', () => {
    const res = unwrapLimb(img, guide, { fPx: F, scale: 1 });
    expect(res.radiusPx).toBeCloseTo(F / (D / Rc - 1), 3); // 160 px
    const c = stripes(res);
    expect(c.length).toBeGreaterThan(5);
    const gaps = c.slice(1).map((v, i) => v - c[i]);
    const expected = 0.2 * res.radiusPx; // 0.2 radii in front pixels
    for (const g of gaps) expect(Math.abs(g - expected) / expected).toBeLessThan(0.04);
  });

  it('would be about 15% off without perspective (why the focal length matters)', () => {
    const res = unwrapLimb(img, guide, { scale: 1 });
    const c = stripes(res);
    const gaps = c.slice(1).map((v, i) => v - c[i]);
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    // Read with the outline as the scale, the stripes come out too far apart in real units.
    const apparent = (mean / res.radiusPx) * Rc; // radii per stripe as the orthographic model reads it
    expect(apparent / 0.2).toBeGreaterThan(1.1);
  });
});

describe('EXIF focal length', () => {
  it('reads FocalLengthIn35mmFilm from a minimal JPEG', async () => {
    const { focal35FromJpeg, focalPx } = await import('../src/existing/exif');
    // SOI, APP1 "Exif\\0\\0", little-endian TIFF: IFD0 with an Exif pointer, Exif IFD with 0xA405 = 26.
    const tiff: number[] = [];
    const u16 = (v: number) => tiff.push(v & 255, v >> 8), u32 = (v: number) => { u16(v & 0xffff); u16(v >>> 16); };
    tiff.push(0x49, 0x49); u16(42); u32(8);
    u16(1); u16(0x8769); u16(4); u32(1); u32(26); u32(0); // IFD0 at 8: one entry, next IFD 0 -> Exif IFD at 26
    u16(1); u16(0xa405); u16(3); u32(1); u16(26); u16(0); u32(0);
    const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
    const bytes = [0xff, 0xd8, 0xff, 0xe1, (app1.length + 2) >> 8, (app1.length + 2) & 255, ...app1, 0xff, 0xda, 0, 2];
    expect(focal35FromJpeg(new Uint8Array(bytes).buffer)).toBe(26);
    expect(focalPx(26, 4032, 3024)).toBeCloseTo((26 / 43.27) * 5040, 0);
  });
});
