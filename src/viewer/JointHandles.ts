// Draggable joint handles for arm posing: a ring at each wrist and elbow,
// plus faint bone lines from shoulder to elbow to wrist.

import { BufferAttribute, BufferGeometry, CanvasTexture, Group, LineBasicMaterial, LineSegments, Sprite, SpriteMaterial, Vector3 } from 'three';

export type JointId = 'wrist' | 'elbow';
export type ArmSide = 'left' | 'right';

function ringTexture(fill: string): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.beginPath(); ctx.arc(32, 32, 24, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.globalAlpha = 0.9; ctx.fill();
  ctx.globalAlpha = 1; ctx.lineWidth = 5; ctx.strokeStyle = '#0b1220'; ctx.stroke();
  ctx.beginPath(); ctx.arc(32, 32, 8, 0, Math.PI * 2); ctx.fillStyle = '#0b1220'; ctx.fill();
  const t = new CanvasTexture(c);
  t.colorSpace = 'srgb';
  return t;
}

export class JointHandles {
  readonly group = new Group();
  private sprites = new Map<string, Sprite>();
  private bones: LineSegments;

  constructor() {
    const mats: Record<JointId, SpriteMaterial> = {
      wrist: new SpriteMaterial({ map: ringTexture('#7ee0a1'), depthTest: false, sizeAttenuation: false, transparent: true }),
      elbow: new SpriteMaterial({ map: ringTexture('#ffd166'), depthTest: false, sizeAttenuation: false, transparent: true }),
    };
    for (const side of ['left', 'right'] as ArmSide[]) {
      for (const j of ['wrist', 'elbow'] as JointId[]) {
        const s = new Sprite(mats[j]);
        s.scale.setScalar(j === 'wrist' ? 0.042 : 0.036);
        s.renderOrder = 40;
        this.sprites.set(`${side}.${j}`, s);
        this.group.add(s);
      }
    }
    this.bones = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false }));
    this.bones.renderOrder = 39;
    this.bones.frustumCulled = false;
    this.group.add(this.bones);
    this.group.visible = false;
  }

  /** Place the handles at the given joint positions (shoulder, elbow, wrist per side). */
  update(joints: Record<ArmSide, { shoulder: Vector3; elbow: Vector3; wrist: Vector3 }>): void {
    const seg: number[] = [];
    for (const side of ['left', 'right'] as ArmSide[]) {
      const j = joints[side];
      this.sprites.get(`${side}.wrist`)!.position.copy(j.wrist);
      this.sprites.get(`${side}.elbow`)!.position.copy(j.elbow);
      seg.push(...j.shoulder.toArray(), ...j.elbow.toArray(), ...j.elbow.toArray(), ...j.wrist.toArray());
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(seg), 3));
    this.bones.geometry.dispose();
    this.bones.geometry = g;
  }

  setVisible(v: boolean): void { this.group.visible = v; }

  /** Keep the rings the same size on screen when the view is offset by a panel. */
  setMagnification(m: number): void {
    for (const [k, s] of this.sprites) s.scale.setScalar((k.endsWith('wrist') ? 0.042 : 0.036) / m);
  }

  /** World positions of all handles, for hit testing in screen space. */
  positions(): Array<{ side: ArmSide; joint: JointId; p: Vector3 }> {
    const out: Array<{ side: ArmSide; joint: JointId; p: Vector3 }> = [];
    for (const [k, s] of this.sprites) {
      const [side, joint] = k.split('.') as [ArmSide, JointId];
      out.push({ side, joint, p: s.position.clone() });
    }
    return out;
  }
}
