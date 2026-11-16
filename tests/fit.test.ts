import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, Mesh, Vector3 } from 'three';
import { fitToHeight } from '../src/body/fit';

describe('fitToHeight', () => {
  it('scales a Y-up model to the height and puts its feet on the floor', () => {
    const mesh = new Mesh(new BoxGeometry(0.5, 2.0, 0.3));
    mesh.position.set(3, 10, -2);
    const { group, info } = fitToHeight(mesh, 1.93);
    const box = new Box3().setFromObject(group);
    expect(info.rotatedToYUp).toBe(false);
    expect(box.max.y - box.min.y).toBeCloseTo(1.93, 5);
    expect(box.min.y).toBeCloseTo(0, 5);
    expect((box.min.x + box.max.x) / 2).toBeCloseTo(0, 5);
    expect((box.min.z + box.max.z) / 2).toBeCloseTo(0, 5);
  });

  it('rotates a Z-up model upright', () => {
    const mesh = new Mesh(new BoxGeometry(0.5, 0.3, 2.0)); // tall along Z
    const { group, info } = fitToHeight(mesh, 1.8);
    const size = new Box3().setFromObject(group).getSize(new Vector3());
    expect(info.rotatedToYUp).toBe(true);
    expect(size.y).toBeCloseTo(1.8, 5);
    expect(size.z).toBeLessThan(size.y);
  });
});
