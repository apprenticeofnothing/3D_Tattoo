// Cover-up check: how much of an old tattoo a new design hides.
//
// The old tattoo's ink is sampled on a grid, every sample is carried over
// the skin into the new design's flat coordinates (the app does that with
// the stencil mapping), and a sample counts as covered when the new design
// has ink at least as dark there: in a cover-up, old ink shows through
// lighter or open parts of the new design. Dark old ink weighs more.

import { SRGB_TO_LINEAR, type Rgba } from './image';

/** How dark the ink is at a pixel (0 = bare skin, 1 = black): strength times darkness of its colour. */
export function inkDarkness(img: Rgba, fx: number, fy: number): number {
  const x = Math.min(img.width - 1, Math.max(0, Math.floor(fx * img.width)));
  const y = Math.min(img.height - 1, Math.max(0, Math.floor(fy * img.height)));
  const i = (y * img.width + x) * 4, d = img.data;
  const a = d[i + 3] / 255;
  if (a <= 0) return 0;
  const L = 0.2126 * SRGB_TO_LINEAR[d[i]] + 0.7152 * SRGB_TO_LINEAR[d[i + 1]] + 0.0722 * SRGB_TO_LINEAR[d[i + 2]];
  return a * (1 - L);
}

export interface InkSample {
  /** Position in the design's own flat coordinates (metres, x right, y up, centre 0). */
  u: number;
  v: number;
  /** How dark the old ink is there (0..1). */
  dark: number;
}

/** Ink samples of a design every `step` metres (only where there is ink). */
export function sampleInk(img: Rgba, widthM: number, heightM: number, mirror: boolean, step: number, minDark = 0.12): InkSample[] {
  const out: InkSample[] = [];
  const nx = Math.max(1, Math.round(widthM / step)), ny = Math.max(1, Math.round(heightM / step));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const fx = (i + 0.5) / nx, fy = (j + 0.5) / ny;
    const dark = inkDarkness(img, fx, fy);
    if (dark < minDark) continue;
    const u = (fx - 0.5) * widthM * (mirror ? -1 : 1), v = (0.5 - fy) * heightM;
    out.push({ u, v, dark });
  }
  return out;
}

export interface CoverResult {
  /** Share of the old ink (weighted by darkness) under ink at least as dark. */
  covered: number;
  /** Per sample: hidden or not. */
  hidden: boolean[];
}

/**
 * Coverage for samples already in the NEW design's flat coordinates, with
 * the new design `widthM` wide (its height follows its aspect).
 */
export function coverage(samples: InkSample[], newImg: Rgba, widthM: number, aspect: number, mirror: boolean, minDark = 0.3): CoverResult {
  const heightM = widthM / aspect;
  let total = 0, got = 0;
  const hidden = samples.map((s) => {
    total += s.dark;
    const fx = (mirror ? -s.u : s.u) / widthM + 0.5, fy = 0.5 - s.v / heightM;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return false;
    const ok = inkDarkness(newImg, fx, fy) >= Math.max(minDark, s.dark * 0.95);
    if (ok) got += s.dark;
    return ok;
  });
  return { covered: total > 0 ? got / total : 1, hidden };
}

/**
 * Smallest width (from `fromM`, growing in 2% steps up to `toM`) at which the
 * new design hides at least `target` of the old ink, or the best found.
 */
export function sizeToCover(samples: InkSample[], newImg: Rgba, aspect: number, mirror: boolean, fromM: number, toM: number, target = 0.95): { widthM: number; covered: number; reached: boolean } {
  let best = { widthM: fromM, covered: -1 };
  for (let w = fromM; w <= toM * 1.0001; w *= 1.02) {
    const c = coverage(samples, newImg, w, aspect, mirror).covered;
    if (c >= target) return { widthM: w, covered: c, reached: true };
    if (c > best.covered + 1e-6) best = { widthM: w, covered: c };
  }
  return { ...best, reached: false };
}
