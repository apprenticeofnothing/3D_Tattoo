// Pick up a tattoo that is already in a textured 3D scan: the scan's photo
// texture is rendered flat through the same skin-length-preserving map used
// for placing stencils, so the result has the tattoo's true size and shape.

import { makeImage, sampleBilinear, type Rgba } from './image';

export interface ScanTexture {
  /** Per surface triangle: texture coordinates of its three corners (6 floats), NaN when untextured. */
  triUv: Float32Array;
  /** Per surface triangle: which texture. */
  triTex: Uint8Array;
  textures: Array<{ img: Rgba; flipY: boolean }>;
}

/** Plane coordinates (metres) to a surface triangle and barycentric weights. */
export type Locate = (u: number, v: number) => { tri: number; bary: [number, number, number] } | null;

/**
 * The skin around the anchor as a flat image `sizeM` across with `px`
 * pixels a side, centred on plane coordinate `centre`.
 */
export function renderSkin(locate: Locate, tex: ScanTexture, sizeM: number, px: number, centre = { u: 0, v: 0 }): Rgba {
  const img = makeImage(px, px);
  const s = new Float32Array(4);
  for (let y = 0; y < px; y++) for (let x = 0; x < px; x++) {
    const u = centre.u + ((x + 0.5) / px - 0.5) * sizeM, v = centre.v + (0.5 - (y + 0.5) / px) * sizeM;
    const h = locate(u, v);
    if (!h) continue;
    const t = h.tri, b = h.bary, q = tex.triUv;
    const tu = b[0] * q[t * 6] + b[1] * q[t * 6 + 2] + b[2] * q[t * 6 + 4];
    const tv = b[0] * q[t * 6 + 1] + b[1] * q[t * 6 + 3] + b[2] * q[t * 6 + 5];
    if (!Number.isFinite(tu) || !Number.isFinite(tv)) continue;
    const T = tex.textures[tex.triTex[t]];
    if (!T) continue;
    const fu = tu - Math.floor(tu), fv = tv - Math.floor(tv);
    if (!sampleBilinear(T.img, fu * T.img.width, (T.flipY ? 1 - fv : fv) * T.img.height, s)) continue;
    const o = (y * px + x) * 4;
    img.data[o] = s[0]; img.data[o + 1] = s[1]; img.data[o + 2] = s[2]; img.data[o + 3] = 255;
  }
  return img;
}
