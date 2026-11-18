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
}

export interface Flattened {
  /** Ink with alpha, cropped to the tattoo. */
  image: Rgba;
  /** Size of `image` in photo pixels (lengths along the skin). */
  widthPhotoPx: number;
  heightPhotoPx: number;
  /** Limb radius in photo pixels (limb mode), for sizing from the body's circumference. */
  radiusPx: number | null;
  floor: number;
  /** Nothing that looks like ink was found. */
  empty: boolean;
}

export function flattenTattoo(photo: Rgba, p: FlattenParams): Flattened {
  const flat = p.kind === 'limb'
    ? unwrapLimb(photo, p.limb, { from: p.limb.from, to: p.limb.to, maxSide: p.maxSide ?? 2048, scale: 2 })
    : rectifyQuad(photo, p.quad, { maxSide: p.maxSide ?? 2048, scale: 2 });
  const ink = extractInk(flat.image, { floor: p.floor });
  let img = ink.image;
  let w = img.width, h = img.height;
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
