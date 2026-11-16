// Lines on the skin for the tape measure, plus small dots at the ends.

import { BufferAttribute, BufferGeometry, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, SphereGeometry } from 'three';

export class MeasureOverlay {
  readonly group = new Group();
  private line: LineSegments;
  private dots: Mesh[] = [];
  private dotGeo = new SphereGeometry(0.004, 12, 8);
  private dotMat = new MeshBasicMaterial({ color: 0xffd166, depthTest: false });

  constructor() {
    this.line = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true, opacity: 0.95 }));
    this.line.renderOrder = 25; this.line.frustumCulled = false;
    this.group.add(this.line);
    this.group.visible = false;
  }

  /** Show a polyline (closed if `closed`) and dots at the given points. */
  set(points: ArrayLike<number> | Array<[number, number, number]>, dots: Array<[number, number, number]>, closed = false): void {
    const flat: number[] = Array.isArray(points) && Array.isArray(points[0]) ? (points as Array<[number, number, number]>).flat() : Array.from(points as ArrayLike<number>);
    const segs: number[] = [];
    const n = flat.length / 3;
    for (let i = 0; i + 1 < n; i++) segs.push(flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2], flat[i * 3 + 3], flat[i * 3 + 4], flat[i * 3 + 5]);
    if (closed && n > 2) segs.push(flat[(n - 1) * 3], flat[(n - 1) * 3 + 1], flat[(n - 1) * 3 + 2], flat[0], flat[1], flat[2]);
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(segs), 3));
    this.line.geometry.dispose(); this.line.geometry = g;
    for (const d of this.dots) this.group.remove(d);
    this.dots = dots.map((p) => { const m = new Mesh(this.dotGeo, this.dotMat); m.position.set(...p); m.renderOrder = 26; this.group.add(m); return m; });
    this.group.visible = true;
  }

  clear(): void { this.group.visible = false; }
}
