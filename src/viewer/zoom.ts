// Zoom towards a point: the camera and its orbit target are scaled about
// the anchor, so the anchor stays at the same place on screen (the skin
// under the cursor stays under the cursor).

import { Vector3 } from 'three';

export interface ZoomResult { camera: Vector3; target: Vector3; factor: number }

/**
 * Move `camera` and `target` towards `anchor` by `factor` (< 1 zooms in),
 * clamped so the camera ends between `minDist` and `maxDist` from the anchor.
 */
export function zoomTowards(camera: Vector3, target: Vector3, anchor: Vector3, factor: number, minDist: number, maxDist: number): ZoomResult {
  const d = camera.distanceTo(anchor);
  const f = d > 0 ? Math.min(maxDist / d, Math.max(minDist / d, factor)) : 1;
  return {
    camera: anchor.clone().add(camera.clone().sub(anchor).multiplyScalar(f)),
    target: anchor.clone().add(target.clone().sub(anchor).multiplyScalar(f)),
    factor: f,
  };
}

/** Zoom factor for a wheel event: mouse notches, trackpad scrolls and trackpad pinches (ctrlKey). */
export function wheelFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  // deltaMode 1 = lines, 2 = pages; normalise to pixels.
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  const k = ctrlKey ? 0.01 : 0.0015; // pinch deltas are small and frequent
  return Math.exp(Math.max(-0.6, Math.min(0.6, px * k)));
}
