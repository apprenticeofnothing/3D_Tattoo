import { describe, expect, it } from 'vitest';
import { makeImage, type Rgba } from '../src/existing/image';
import { coverage, inkDarkness, sampleInk, sizeToCover } from '../src/existing/coverage';

/** A square image with black ink where `inside(fx, fy)` (fractions 0..1). */
function image(n: number, inside: (fx: number, fy: number) => boolean, rgb = [10, 10, 10]): Rgba {
  const img = makeImage(n, n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!inside((x + 0.5) / n, (y + 0.5) / n)) continue;
    const o = (y * n + x) * 4;
    img.data[o] = rgb[0]; img.data[o + 1] = rgb[1]; img.data[o + 2] = rgb[2]; img.data[o + 3] = 255;
  }
  return img;
}
const disk = image(200, (x, y) => Math.hypot(x - 0.5, y - 0.5) < 0.5);
const ring = image(200, (x, y) => { const r = Math.hypot(x - 0.5, y - 0.5); return r < 0.5 && r > 0.3; });

describe('cover-up coverage', () => {
  // The old tattoo: a solid disk 4 cm across, centred on the new design.
  const old = sampleInk(disk, 0.04, 0.04, false, 0.001);

  it('reads ink darkness from colour and strength', () => {
    expect(inkDarkness(disk, 0.5, 0.5)).toBeGreaterThan(0.99);
    expect(inkDarkness(disk, 0.01, 0.01)).toBe(0);
    const red = image(10, () => true, [200, 20, 20]);
    expect(inkDarkness(red, 0.5, 0.5)).toBeLessThan(0.9); // red ink is lighter than black
  });

  it('a bigger solid design hides all of it, a smaller one only the middle', () => {
    expect(coverage(old, disk, 0.05, 1, false).covered).toBeGreaterThan(0.99);
    const c3 = coverage(old, disk, 0.03, 1, false).covered;
    expect(c3).toBeGreaterThan(0.56 - 0.04); // (3/4)^2 of a uniform disk
    expect(c3).toBeLessThan(0.56 + 0.04);
  });

  it('a ring leaves the middle showing', () => {
    const c = coverage(old, ring, 0.05, 1, false);
    // Inside radius 0.3 * 5 cm = 1.5 cm of a 2 cm disk: (1.5/2)^2 = 56% shows.
    expect(c.covered).toBeGreaterThan(0.44 - 0.04);
    expect(c.covered).toBeLessThan(0.44 + 0.04);
    expect(c.hidden.some((h) => !h)).toBe(true);
  });

  it('light ink does not hide dark ink', () => {
    const grey = image(200, (x, y) => Math.hypot(x - 0.5, y - 0.5) < 0.5, [190, 190, 190]);
    expect(coverage(old, grey, 0.06, 1, false).covered).toBeLessThan(0.05);
  });

  it('finds the size that covers', () => {
    const s = sizeToCover(old, disk, 1, false, 0.02, 0.2);
    expect(s.reached).toBe(true);
    expect(s.widthM).toBeGreaterThan(0.038);
    expect(s.widthM).toBeLessThan(0.042);
    // A ring can never hide a solid disk at its centre (its hole is over the middle):
    // not reached, and it reports the best width it found.
    const r = sizeToCover(old, ring, 1, false, 0.02, 0.2);
    expect(r.reached).toBe(false);
    expect(r.covered).toBeGreaterThan(0.5);
  });
});
