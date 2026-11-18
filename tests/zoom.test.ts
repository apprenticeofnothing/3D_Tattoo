import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { wheelFactor, zoomTowards } from '../src/viewer/zoom';

function project(cam: PerspectiveCamera, p: Vector3) { return p.clone().project(cam); }

describe('zoom towards a point', () => {
  it('keeps the anchor at the same place on screen', () => {
    const cam = new PerspectiveCamera(38, 1.5, 0.02, 80);
    cam.position.set(0.4, 1.2, 2.5);
    const target = new Vector3(0, 1, 0);
    cam.lookAt(target); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    const anchor = new Vector3(0.25, 1.15, 0.1);
    const before = project(cam, anchor);
    const r = zoomTowards(cam.position, target, anchor, 0.5, 0.07, 20);
    cam.position.copy(r.camera); cam.lookAt(r.target); cam.updateMatrixWorld();
    const after = project(cam, anchor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    expect(cam.position.distanceTo(anchor)).toBeCloseTo(new Vector3(0.4, 1.2, 2.5).distanceTo(anchor) * 0.5, 6);
  });

  it('stops at the near and far limits', () => {
    const anchor = new Vector3(0, 1, 0);
    const near = zoomTowards(new Vector3(0, 1, 0.1), new Vector3(0, 1, -0.5), anchor, 0.01, 0.07, 20);
    expect(near.camera.distanceTo(anchor)).toBeCloseTo(0.07, 9);
    const far = zoomTowards(new Vector3(0, 1, 5), new Vector3(0, 1, 0), anchor, 100, 0.07, 20);
    expect(far.camera.distanceTo(anchor)).toBeCloseTo(20, 9);
  });

  it('turns wheel and pinch deltas into gentle factors', () => {
    expect(wheelFactor(-100, 0, false)).toBeLessThan(1); // scroll up zooms in
    expect(wheelFactor(100, 0, false)).toBeGreaterThan(1);
    expect(wheelFactor(-100, 0, false)).toBeGreaterThan(0.8); // one mouse notch: under 20%
    expect(wheelFactor(-3, 1, false)).toBeCloseTo(wheelFactor(-48, 0, false), 9); // lines -> pixels
    expect(wheelFactor(-5, 0, true)).toBeLessThan(wheelFactor(-5, 0, false)); // pinch is more responsive per delta
    expect(wheelFactor(-100000, 0, false)).toBeGreaterThan(0.5); // clamped
  });
});
