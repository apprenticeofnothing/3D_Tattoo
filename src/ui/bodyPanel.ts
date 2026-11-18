// Body panel: start from a preset, then shape the body with sliders.
// Also height, skin tone, and switching to the user's own scan.

import { Color } from 'three';
import { SKIN_TONES, SLIDERS, blendCoarse, presetParams, type Appearance, type BodyData, type BodyParams, type PresetMeta, type SliderDef } from '../body/builder';

export interface BodyPanelState {
  source: 'builder' | 'scan' | 'mannequin';
  params: BodyParams;
  appearance: Appearance;
  presetId: string | null;
  /** Parameters the preset started from (reset arrows compare against these). */
  base: BodyParams | null;
  heightCm: number;
  bmi: { bmi: number; massKg: number } | null;
}

export interface BodyPanelCallbacks {
  onParams(params: BodyParams, live: boolean): void;
  onPreset(preset: PresetMeta): void;
  onAppearance(a: Appearance): void;
  onHeight(cm: number): void;
  onUseBuilder(): void;
  onLoadScan(): void;
  onClose(): void;
}

const GROUPS: SliderDef['group'][] = ['Basics', 'Torso', 'Arms', 'Legs', 'Ancestry'];

export class BodyPanel {
  readonly el: HTMLElement;
  private state: BodyPanelState;
  private thumbs = new Map<string, HTMLCanvasElement>();
  private thumbsDrawn = false;
  private inputs = new Map<string, { input: HTMLInputElement; value: HTMLElement; reset: HTMLButtonElement; def: SliderDef }>();

  constructor(root: HTMLElement, private data: BodyData | null, initial: BodyPanelState, private cb: BodyPanelCallbacks) {
    this.state = initial;
    this.el = document.createElement('div');
    this.el.className = 'body-panel hidden';
    this.el.innerHTML = `
      <div class="bp-head"><span>Body</span><button class="btn ghost" data-close>Done</button></div>
      <div class="bp-body">
        <div class="bp-scan-note hidden"><span>Showing your own scan.</span> <button class="btn" data-builder>Use the body builder</button></div>
        <h3>Start from</h3>
        <div class="bp-presets"></div>
        <div class="bp-row">
          <label class="field">Height
            <button class="btn step" data-h="-1" aria-label="Shorter">−</button>
            <input type="number" inputmode="numeric" min="120" max="230" step="1" data-height />
            <button class="btn step" data-h="1" aria-label="Taller">+</button> cm</label>
        </div>
        <div class="bp-bmi muted"></div>
        <h3>Skin tone</h3>
        <div class="bp-tones"></div>
        <div class="bp-groups"></div>
        <div class="bp-row bp-foot">
          <button class="btn" data-reset>Reset sliders</button>
          <button class="btn" data-scan>Load my scan…</button>
        </div>
        <p class="muted bp-credit">Bodies are built from MakeHuman data (CC0, makehumancommunity.org). BMI is estimated from the body's volume and is only a guide.</p>
      </div>`;
    root.appendChild(this.el);
    this.el.querySelector('[data-close]')!.addEventListener('click', () => cb.onClose());
    this.el.querySelector('[data-builder]')!.addEventListener('click', () => cb.onUseBuilder());
    this.el.querySelector('[data-scan]')!.addEventListener('click', () => cb.onLoadScan());
    this.el.querySelector('[data-reset]')!.addEventListener('click', () => {
      const p = this.data?.meta.presets.find((x) => x.id === this.state.presetId);
      if (p) cb.onPreset(p);
      else cb.onParams({ ...this.state.params, details: {} }, false);
    });
    const h = this.el.querySelector<HTMLInputElement>('[data-height]')!;
    h.addEventListener('change', () => cb.onHeight(Number(h.value) || this.state.heightCm));
    this.el.querySelectorAll<HTMLButtonElement>('[data-h]').forEach((b) => b.addEventListener('click', () => cb.onHeight(this.state.heightCm + Number(b.dataset.h))));
    this.buildPresets();
    this.buildTones();
    this.buildSliders();
    this.render();
  }

  get open(): boolean { return !this.el.classList.contains('hidden'); }

  show(): void {
    this.el.classList.remove('hidden');
    if (!this.thumbsDrawn) { this.thumbsDrawn = true; setTimeout(() => this.drawThumbs(), 30); }
  }
  hide(): void { this.el.classList.add('hidden'); }

  update(state: Partial<BodyPanelState>): void { this.state = { ...this.state, ...state }; this.render(); }

  private buildPresets(): void {
    const wrap = this.el.querySelector('.bp-presets')!;
    if (!this.data) { wrap.innerHTML = '<p class="muted">Body builder data could not be loaded.</p>'; return; }
    for (const p of this.data.meta.presets) {
      const b = document.createElement('button');
      b.className = 'bp-card';
      b.dataset.id = p.id;
      const c = document.createElement('canvas');
      c.width = 96; c.height = 150;
      this.thumbs.set(p.id, c);
      const [sex, ...rest] = p.name.split(' · ');
      b.append(c);
      const label = document.createElement('span');
      label.innerHTML = `<b>${sex}</b><small>${rest.join(' ')}</small>`;
      b.append(label);
      b.addEventListener('click', () => this.cb.onPreset(p));
      wrap.appendChild(b);
    }
  }

  private buildTones(): void {
    const wrap = this.el.querySelector('.bp-tones')!;
    for (const t of SKIN_TONES) {
      const b = document.createElement('button');
      b.className = 'bp-tone'; b.style.background = t; b.dataset.tone = t; b.setAttribute('aria-label', `Skin tone ${t}`);
      b.addEventListener('click', () => this.cb.onAppearance({ ...this.state.appearance, skinTone: t }));
      wrap.appendChild(b);
    }
    const custom = document.createElement('input');
    custom.type = 'color'; custom.className = 'bp-tone-custom'; custom.title = 'Any colour';
    custom.value = this.state.appearance.skinTone;
    custom.addEventListener('input', () => this.cb.onAppearance({ ...this.state.appearance, skinTone: custom.value }));
    wrap.appendChild(custom);
  }

  private buildSliders(): void {
    const wrap = this.el.querySelector('.bp-groups')!;
    for (const g of GROUPS) {
      const det = document.createElement('details');
      det.className = 'bp-group';
      if (g === 'Basics') det.open = true;
      det.innerHTML = `<summary>${g === 'Ancestry' ? 'Ancestry (face and build)' : g}</summary>`;
      for (const def of SLIDERS.filter((s) => s.group === g)) {
        const row = document.createElement('div');
        row.className = 'bp-slider';
        row.innerHTML = `<div class="bp-slider-head"><span>${def.label}</span><span class="bp-val"></span><button class="btn ghost bp-reset" aria-label="Reset ${def.label}">↺</button></div>
          <input type="range" min="${def.min}" max="${def.max}" step="${def.step}" />
          ${def.left ? `<div class="bp-ends"><span>${def.left}</span><span>${def.right}</span></div>` : ''}`;
        const input = row.querySelector('input')!;
        const value = row.querySelector<HTMLElement>('.bp-val')!;
        const reset = row.querySelector<HTMLButtonElement>('.bp-reset')!;
        input.addEventListener('input', () => this.cb.onParams(this.withValue(def, Number(input.value)), true));
        input.addEventListener('change', () => this.cb.onParams(this.withValue(def, Number(input.value)), false));
        reset.addEventListener('click', () => this.cb.onParams(this.withValue(def, this.neutral(def)), false));
        this.inputs.set(def.id, { input, value, reset, def });
        det.appendChild(row);
      }
      wrap.appendChild(det);
    }
  }

  /** Neutral value of a slider: the preset's value for macro sliders, 0 for details. */
  private neutral(def: SliderDef): number {
    if (def.detail) return 0;
    const b = this.state.base;
    if (b) return b[def.id as keyof BodyParams] as number;
    if (def.group === 'Ancestry') return 1 / 3;
    return 0.5;
  }

  private valueOf(def: SliderDef): number {
    const p = this.state.params;
    return def.detail ? (p.details[def.id as keyof BodyParams['details']] ?? 0) : (p[def.id as keyof BodyParams] as number);
  }

  private withValue(def: SliderDef, v: number): BodyParams {
    const p = this.state.params;
    if (def.detail) return { ...p, details: { ...p.details, [def.id]: v } };
    return { ...p, [def.id]: v };
  }

  private render(): void {
    const s = this.state;
    this.el.classList.toggle('scan-mode', s.source !== 'builder');
    this.el.querySelector('.bp-scan-note')!.classList.toggle('hidden', s.source === 'builder');
    const h = this.el.querySelector<HTMLInputElement>('[data-height]')!;
    if (document.activeElement !== h) h.value = String(s.heightCm);
    this.el.querySelectorAll<HTMLElement>('.bp-card').forEach((c) => c.classList.toggle('active', c.dataset.id === s.presetId && s.source === 'builder'));
    this.el.querySelectorAll<HTMLElement>('.bp-tone').forEach((t) => t.classList.toggle('active', t.dataset.tone === s.appearance.skinTone));
    const custom = this.el.querySelector<HTMLInputElement>('.bp-tone-custom');
    if (custom && document.activeElement !== custom) custom.value = s.appearance.skinTone;
    const bmi = this.el.querySelector('.bp-bmi')!;
    bmi.textContent = s.bmi && s.source === 'builder' ? `Estimated BMI ${s.bmi.bmi.toFixed(1)} · about ${Math.round(s.bmi.massKg)} kg at ${s.heightCm} cm` : '';
    const sum = Math.max(1e-9, s.params.african + s.params.asian + s.params.european);
    for (const { input, value, reset, def } of this.inputs.values()) {
      const v = this.valueOf(def);
      if (document.activeElement !== input) input.value = String(v);
      if (def.detail) value.textContent = v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`;
      else if (def.group === 'Ancestry') value.textContent = `${Math.round((v / sum) * 100)}%`;
      else value.textContent = `${Math.round(v * 100)}%`;
      reset.classList.toggle('invisible', Math.abs(v - this.neutral(def)) < 1e-6);
      if (def.id === 'breastSize' || def.id === 'breastFirmness') input.closest('.bp-slider')!.classList.toggle('dim', s.params.gender > 0.85);
    }
  }

  /** Front-view thumbnails drawn on 2D canvases from the coarse mesh (no WebGL needed). */
  private drawThumbs(): void {
    if (!this.data) return;
    const data = this.data;
    const presets = [...data.meta.presets];
    const step = () => {
      const p = presets.shift();
      if (!p) return;
      drawThumbnail(this.thumbs.get(p.id)!, data, presetParams(p), this.state.appearance);
      setTimeout(step, 0);
    };
    step();
  }
}

export function drawThumbnail(canvas: HTMLCanvasElement, data: BodyData, params: BodyParams, a: Appearance): void {
  const P = blendCoarse(data, params);
  const Q = data.quads, M = data.material, mats = data.meta.materials;
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width, Hh = canvas.height;
  ctx.clearRect(0, 0, W, Hh);
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < P.length; i += 3) { minX = Math.min(minX, P[i]); maxX = Math.max(maxX, P[i]); maxY = Math.max(maxY, P[i + 1]); }
  const s = Math.min((W - 8) / (maxX - minX), (Hh - 8) / maxY);
  const ox = W / 2, oy = Hh - 4;
  const skin = new Color(a.skinTone);
  const order: Array<{ f: number; z: number }> = [];
  for (let f = 0; f < data.meta.quadCount; f++) {
    let z = 0;
    for (let k = 0; k < 4; k++) z += P[Q[f * 4 + k] * 3 + 2];
    order.push({ f, z });
  }
  order.sort((x, y) => x.z - y.z);
  for (const { f } of order) {
    const v = [0, 1, 2, 3].map((k) => Q[f * 4 + k] * 3);
    // Face normal for shading.
    const ux = P[v[2]] - P[v[0]], uy = P[v[2] + 1] - P[v[0] + 1], uz = P[v[2] + 2] - P[v[0] + 2];
    const wx = P[v[3]] - P[v[1]], wy = P[v[3] + 1] - P[v[1] + 1], wz = P[v[3] + 2] - P[v[1] + 2];
    let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
    const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    if (nz <= 0) continue;
    const shade = 0.45 + 0.55 * Math.max(0, nz * 0.8 + ny * 0.35 + nx * 0.2);
    const isEye = v.filter((i) => mats[M[i / 3]] !== 'skin').length >= 3;
    const c = (isEye ? new Color('#ece8e2') : skin).clone().multiplyScalar(shade);
    ctx.fillStyle = `#${c.getHexString()}`;
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    v.forEach((i, k) => { const x = ox + P[i] * s, y = oy - P[i + 1] * s; if (k) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}
