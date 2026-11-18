// Outline of the selected design on the skin plus two handles: rotate
// (above the top edge) and scale (bottom-right corner). Handles are
// screen-sized sprites; hit testing is done in screen space by the
// gesture layer, so touch targets can be generous.

import {
  BufferAttribute, BufferGeometry, CanvasTexture, Group, LineBasicMaterial, LineSegments, Sprite, SpriteMaterial, Vector3,
} from 'three';

function handleTexture(kind: 'rotate' | 'scale'): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.clearRect(0, 0, 64, 64);
  ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2);
  ctx.fillStyle = kind === 'rotate' ? '#6ea8fe' : '#ffd166'; ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = '#0b1220'; ctx.stroke();
  ctx.strokeStyle = '#0b1220'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  if (kind === 'rotate') {
    ctx.beginPath(); ctx.arc(32, 32, 13, -Math.PI * 0.9, Math.PI * 0.6); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(40, 14); ctx.lineTo(45, 24); ctx.lineTo(34, 25); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(20, 44); ctx.lineTo(44, 20); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(44, 20); ctx.lineTo(32, 20); ctx.moveTo(44, 20); ctx.lineTo(44, 32); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(20, 44); ctx.lineTo(32, 44); ctx.moveTo(20, 44); ctx.lineTo(20, 32); ctx.stroke();
  }
  const t = new CanvasTexture(c);
  t.colorSpace = 'srgb';
  return t;
}

export class SelectionGizmo {
  readonly group = new Group();
  readonly rotateHandle: Sprite;
  readonly scaleHandle: Sprite;
  private readonly outline: LineSegments;

  constructor() {
    this.outline = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0x6ea8fe, depthTest: true, transparent: true, opacity: 0.95 }));
    this.outline.renderOrder = 20;
    this.outline.frustumCulled = false;
    (this.outline.material as LineBasicMaterial).polygonOffset = true;
    const mk = (kind: 'rotate' | 'scale') => {
      const s = new Sprite(new SpriteMaterial({ map: handleTexture(kind), depthTest: false, sizeAttenuation: false, transparent: true }));
      s.scale.setScalar(0.045); // fraction of the viewport height
      s.renderOrder = 30;
      return s;
    };
    this.rotateHandle = mk('rotate');
    this.scaleHandle = mk('scale');
    this.group.add(this.outline, this.rotateHandle, this.scaleHandle);
    this.group.visible = false;
  }

  /** Update from a polyline (nulls break the line) and handle positions. Pass null to hide. */
  set(points: Array<[number, number, number] | null> | null, handles: { rotate: [number, number, number] | null; scale: [number, number, number] | null } | null): void {
    if (!points || !handles) { this.group.visible = false; return; }
    const segs: number[] = [];
    for (let i = 0; i + 1 < points.length; i++) {
      const a = points[i], b = points[i + 1];
      if (!a || !b) continue;
      segs.push(a[0], a[1], a[2], b[0], b[1], b[2]);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(segs), 3));
    this.outline.geometry.dispose();
    this.outline.geometry = g;
    this.rotateHandle.visible = !!handles.rotate;
    this.scaleHandle.visible = !!handles.scale;
    if (handles.rotate) this.rotateHandle.position.set(...handles.rotate);
    if (handles.scale) this.scaleHandle.position.set(...handles.scale);
    this.group.visible = true;
  }

  /** Keep the handles the same size on screen when the view is offset by a panel. */
  setMagnification(m: number): void {
    this.rotateHandle.scale.setScalar(0.045 / m);
    this.scaleHandle.scale.setScalar(0.045 / m);
  }

  /** Handles lifted slightly toward the camera so they are not buried in the skin. */
  liftToward(cameraPos: Vector3): void {
    for (const s of [this.rotateHandle, this.scaleHandle]) {
      if (!s.visible) continue;
      const d = new Vector3().subVectors(cameraPos, s.position).normalize().multiplyScalar(0.004);
      s.position.add(d);
    }
  }
}
