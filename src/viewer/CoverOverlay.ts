// Red dots where an old tattoo would still show through a new design.

import { BufferAttribute, BufferGeometry, Points, PointsMaterial } from 'three';

export class CoverOverlay {
  readonly points: Points;

  constructor() {
    this.points = new Points(new BufferGeometry(), new PointsMaterial({ color: 0xff2d55, size: 5, sizeAttenuation: false, transparent: true, opacity: 0.95 }));
    this.points.renderOrder = 20;
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  set(positions: number[]): void {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    this.points.geometry.dispose();
    this.points.geometry = g;
    this.points.visible = positions.length > 0;
  }

  clear(): void { this.points.visible = false; }
}
