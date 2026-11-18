// Arm pose panel: quick poses and sliders for each arm (or both mirrored).

import { POSE_LIMITS, POSE_PRESETS, type ArmPose, type Pose, type Side } from '../body/pose';

export interface PosePanelState {
  available: boolean;
  pose: Pose;
  /** Modelled (relaxed) angles per side, used when a value is not set. */
  rest: Record<Side, { raise: number; forward: number; bend: number }>;
}

export interface PosePanelCallbacks {
  onPose(pose: Pose, live: boolean, preset?: string): void;
  onClose(): void;
}

type Target = 'both' | Side;

const SLIDERS: Array<{ id: keyof ArmPose; label: string; left: string; right: string }> = [
  { id: 'raise', label: 'Raise arm', left: 'Down', right: 'Up' },
  { id: 'forward', label: 'Arm forward', left: 'Behind', right: 'In front' },
  { id: 'twist', label: 'Rotate upper arm', left: 'Inward', right: 'Outward' },
  { id: 'bend', label: 'Bend elbow', left: 'Straight', right: 'Bent' },
  { id: 'turn', label: 'Turn forearm', left: 'Palm down', right: 'Palm up' },
];

export class PosePanel {
  readonly el: HTMLElement;
  private target: Target = 'both';
  private rows = new Map<keyof ArmPose, { input: HTMLInputElement; value: HTMLElement; reset: HTMLButtonElement }>();

  constructor(root: HTMLElement, private state: PosePanelState, private cb: PosePanelCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'body-panel pose-panel hidden';
    this.el.innerHTML = `
      <div class="bp-head"><span>Arm pose</span><button class="btn ghost" data-close>Done</button></div>
      <div class="bp-body">
        <p class="bp-scan-note pp-unavailable hidden">Arm posing works on the built bodies. A loaded scan keeps the pose it was captured in.</p>
        <p class="pp-tip">Drag the green hand rings or yellow elbow rings on the body to move an arm.</p>
        <h3>Quick poses</h3>
        <div class="pp-presets"></div>
        <h3>Adjust</h3>
        <div class="seg pp-side">
          <button class="btn seg-btn" data-side="both">Both arms</button>
          <button class="btn seg-btn" data-side="left">Left</button>
          <button class="btn seg-btn" data-side="right">Right</button>
        </div>
        <div class="pp-sliders"></div>
        <div class="bp-row bp-foot"><button class="btn" data-reset>Relax arms</button></div>
        <p class="muted bp-credit">Tattoos move with the skin. Size and stretch are measured on the relaxed body; use the heatmap there to judge distortion.</p>
      </div>`;
    root.appendChild(this.el);
    this.el.querySelector('[data-close]')!.addEventListener('click', () => cb.onClose());
    this.el.querySelector('[data-reset]')!.addEventListener('click', () => cb.onPose({}, false, 'relaxed'));
    const presets = this.el.querySelector('.pp-presets')!;
    for (const p of POSE_PRESETS) {
      const b = document.createElement('button');
      b.className = 'btn'; b.textContent = p.label; b.dataset.preset = p.id;
      b.addEventListener('click', () => {
        if (!p.arm) { cb.onPose(this.withTarget({}, null), false, p.id); return; }
        cb.onPose(this.withTarget(this.state.pose, p.arm), false, p.id);
      });
      presets.appendChild(b);
    }
    this.el.querySelectorAll<HTMLButtonElement>('.pp-side .seg-btn').forEach((b) => b.addEventListener('click', () => { this.target = b.dataset.side as Target; this.render(); }));
    const wrap = this.el.querySelector('.pp-sliders')!;
    for (const def of SLIDERS) {
      const [min, max] = POSE_LIMITS[def.id];
      const row = document.createElement('div');
      row.className = 'bp-slider';
      row.innerHTML = `<div class="bp-slider-head"><span>${def.label}</span><span class="bp-val"></span><button class="btn ghost bp-reset" aria-label="Reset ${def.label}">↺</button></div>
        <input type="range" min="${min}" max="${max}" step="1" />
        <div class="bp-ends"><span>${def.left}</span><span>${def.right}</span></div>`;
      const input = row.querySelector('input')!;
      const value = row.querySelector<HTMLElement>('.bp-val')!;
      const reset = row.querySelector<HTMLButtonElement>('.bp-reset')!;
      input.addEventListener('input', () => cb.onPose(this.setValue(def.id, Number(input.value)), true));
      input.addEventListener('change', () => cb.onPose(this.setValue(def.id, Number(input.value)), false));
      reset.addEventListener('click', () => cb.onPose(this.setValue(def.id, undefined), false));
      this.rows.set(def.id, { input, value, reset });
      wrap.appendChild(row);
    }
    this.render();
  }

  get open(): boolean { return !this.el.classList.contains('hidden'); }
  /** Which arms the panel edits: both mirrored, or one. */
  get side(): Target { return this.target; }
  show(): void { this.el.classList.remove('hidden'); this.render(); }
  hide(): void { this.el.classList.add('hidden'); }
  update(state: Partial<PosePanelState>): void { this.state = { ...this.state, ...state }; this.render(); }

  /** Apply an arm pose (or relax, when null) to the arms the panel targets. */
  private withTarget(pose: Pose, arm: Partial<ArmPose> | null): Pose {
    const next: Pose = { left: pose.left ? { ...pose.left } : undefined, right: pose.right ? { ...pose.right } : undefined };
    for (const s of this.sides()) next[s] = arm ? { ...arm } : undefined;
    return next;
  }

  private sides(): Side[] { return this.target === 'both' ? ['left', 'right'] : [this.target]; }

  private setValue(id: keyof ArmPose, v: number | undefined): Pose {
    const pose = this.state.pose;
    const next: Pose = { left: pose.left ? { ...pose.left } : undefined, right: pose.right ? { ...pose.right } : undefined };
    for (const s of this.sides()) next[s] = { ...(next[s] ?? {}), [id]: v };
    return next;
  }

  private shownSide(): Side { return this.target === 'right' ? 'right' : 'left'; }

  private valueOf(id: keyof ArmPose, side: Side): number {
    const a = this.state.pose[side];
    const v = a?.[id];
    if (v !== undefined) return v;
    if (id === 'raise' || id === 'forward' || id === 'bend') return Math.round(this.state.rest[side][id]);
    return 0;
  }

  private render(): void {
    this.el.querySelector('.pp-unavailable')!.classList.toggle('hidden', this.state.available);
    this.el.querySelectorAll<HTMLElement>('.pp-presets, .pp-side, .pp-sliders, [data-reset]').forEach((e) => e.classList.toggle('disabled-block', !this.state.available));
    this.el.querySelectorAll<HTMLButtonElement>('.pp-side .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.side === this.target));
    const side = this.shownSide();
    for (const [id, { input, value, reset }] of this.rows) {
      const v = this.valueOf(id, side);
      if (document.activeElement !== input) input.value = String(v);
      value.textContent = `${Math.round(v)}°`;
      reset.classList.toggle('invisible', this.state.pose[side]?.[id] === undefined);
    }
  }
}
