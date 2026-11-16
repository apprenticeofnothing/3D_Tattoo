// Fit any loaded body mesh into the app's world: Y up, feet on y=0,
// centred on x/z, scaled so the bounding-box height equals the real height.

import { Box3, Group, Object3D, Vector3 } from 'three';

export interface FitInfo {
  /** Uniform scale that was applied. */
  scale: number;
  /** True if the model looked Z-up and was rotated to Y-up. */
  rotatedToYUp: boolean;
  /** Size in metres after fitting. */
  size: Vector3;
}

/**
 * Wrap `object` in a group transformed so the body stands on the floor with
 * the requested height. The original object is not modified.
 */
export function fitToHeight(object: Object3D, heightM: number, options: { autoUpright?: boolean } = {}): { group: Group; info: FitInfo } {
  const group = new Group();
  group.add(object);
  object.updateMatrixWorld(true);

  let box = new Box3().setFromObject(object);
  let size = box.getSize(new Vector3());
  let rotated = false;
  // Photogrammetry exports are often Z-up. If the model is clearly taller
  // along Z than along Y, rotate it upright.
  if (options.autoUpright !== false && size.z > size.y * 1.3 && size.z >= size.x) {
    object.rotation.x = -Math.PI / 2;
    object.updateMatrixWorld(true);
    box = new Box3().setFromObject(object);
    size = box.getSize(new Vector3());
    rotated = true;
  }
  const scale = size.y > 0 ? heightM / size.y : 1;
  group.scale.setScalar(scale);
  const center = box.getCenter(new Vector3());
  group.position.set(-center.x * scale, -box.min.y * scale, -center.z * scale);
  group.updateMatrixWorld(true);
  const fitted = new Box3().setFromObject(group).getSize(new Vector3());
  return { group, info: { scale, rotatedToYUp: rotated, size: fitted } };
}
