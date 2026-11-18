// A plain RGBA image (8 bits per channel) that works in the browser and in
// unit tests, plus colour-space helpers and bilinear sampling.

export interface Rgba {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export function makeImage(width: number, height: number): Rgba {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

/** sRGB byte -> linear light (0..1). */
export const SRGB_TO_LINEAR = (() => {
  const t = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return t;
})();

/** Linear light (0..1) -> sRGB byte. */
export function linearToSrgbByte(v: number): number {
  const c = v <= 0 ? 0 : v >= 1 ? 1 : v;
  const s = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Bilinear sample at pixel coordinates (pixel centres at i + 0.5). Writes
 * straight (non-premultiplied) RGBA bytes into `out`; returns false when the
 * point is outside the image.
 */
export function sampleBilinear(img: Rgba, x: number, y: number, out: Float32Array): boolean {
  const fx = x - 0.5, fy = y - 0.5;
  if (fx < -0.5 || fy < -0.5 || fx > img.width - 0.5 || fy > img.height - 0.5) return false;
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(fy)));
  const x1 = Math.min(img.width - 1, x0 + 1), y1 = Math.min(img.height - 1, y0 + 1);
  const tx = Math.max(0, Math.min(1, fx - x0)), ty = Math.max(0, Math.min(1, fy - y0));
  const d = img.data, W = img.width;
  const i00 = (y0 * W + x0) * 4, i10 = (y0 * W + x1) * 4, i01 = (y1 * W + x0) * 4, i11 = (y1 * W + x1) * 4;
  // Weight colour by alpha so transparent pixels do not bleed in.
  const w00 = (1 - tx) * (1 - ty) * d[i00 + 3], w10 = tx * (1 - ty) * d[i10 + 3], w01 = (1 - tx) * ty * d[i01 + 3], w11 = tx * ty * d[i11 + 3];
  const wa = w00 + w10 + w01 + w11;
  out[3] = wa; // 0..255: the bilinear weights sum to 1
  if (wa <= 0) { out[0] = out[1] = out[2] = 0; out[3] = 0; return true; }
  for (let c = 0; c < 3; c++) out[c] = (d[i00 + c] * w00 + d[i10 + c] * w10 + d[i01 + c] * w01 + d[i11 + c] * w11) / wa;
  return true;
}

/** Copy of a rectangle of an image. */
export function crop(img: Rgba, x0: number, y0: number, w: number, h: number): Rgba {
  const out = makeImage(w, h);
  for (let y = 0; y < h; y++) {
    const sy = y + y0;
    if (sy < 0 || sy >= img.height) continue;
    for (let x = 0; x < w; x++) {
      const sx = x + x0;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4, di = (y * w + x) * 4;
      out.data[di] = img.data[si]; out.data[di + 1] = img.data[si + 1]; out.data[di + 2] = img.data[si + 2]; out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

/** Mirror left-right. */
export function flipX(img: Rgba): Rgba {
  const out = makeImage(img.width, img.height);
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    const si = (y * img.width + x) * 4, di = (y * img.width + (img.width - 1 - x)) * 4;
    for (let c = 0; c < 4; c++) out.data[di + c] = img.data[si + c];
  }
  return out;
}
