// A ring on the floor around the body. Dragging it turns the body (yaw)
// and tilts it (pitch); see Viewer.spin. A small marker shows the front.

import { DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, Shape, ShapeGeometry, Vector3 } from 'three';

export class TurntableRing {
  readonly group = new Group();
  private ringMat = new MeshBasicMaterial({ color: 0x6ea8fe, transparent: true, opacity: 0.45, side: DoubleSide, depthWrite: false });
  private markMat = new MeshBasicMaterial({ color: 0x6ea8fe, transparent: true, opacity: 0.8, side: DoubleSide, depthWrite: false });
  private radius = 0.55;
  private ring: Mesh;
  private marker: Mesh;

  constructor() {
    this.ring = new Mesh(new RingGeometry(1 - 0.022, 1 + 0.022, 128), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.renderOrder = 1;
    const tri = new Shape();
    tri.moveTo(0, 0.07); tri.lineTo(-0.06, -0.02); tri.lineTo(0.06, -0.02); tri.closePath();
    this.marker = new Mesh(new ShapeGeometry(tri), this.markMat);
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.renderOrder = 1;
    this.group.add(this.ring, this.marker);
    this.group.position.y = 0.004;
    this.setRadius(0.55);
  }

  /** Ring radius in metres (scaled with body height). */
  setRadius(r: number): void {
    this.radius = r;
    this.ring.scale.setScalar(r);
    // The front marker sits just outside the ring, pointing away from the body (+z).
    this.marker.position.set(0, 0, r + 0.06 * (r / 0.55) + 0.02);
    this.marker.scale.setScalar(r / 0.55);
    this.marker.rotation.z = Math.PI; // triangle points towards +z after the x rotation
  }

  setHighlight(on: boolean): void {
    this.ringMat.opacity = on ? 0.85 : 0.45;
    this.markMat.opacity = on ? 1 : 0.8;
  }

  /** Points around the ring in world space, for hit testing in screen space. */
  samples(n = 72): Vector3[] {
    const out: Vector3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      out.push(new Vector3(Math.sin(a) * this.radius, this.group.position.y, Math.cos(a) * this.radius));
    }
    return out;
  }
}
