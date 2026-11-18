// The design panel: which design is selected, its size, rotation, flags,
// view mode, compare option, and the stretch readout.

import type { Option, PlacementData, ViewMode } from '../app/project';
import type { PlacedDesign } from '../mapping/placements';

/** How to resize besides the corner handle, for the kind of screen in use. */
const RESIZE_HINT = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches
  ? ' or pinch it with two fingers'
  : ' or hold Alt (Option on a Mac) and scroll over the design';

export interface PanelCallbacks {
  onSelect(id: string): void;
  /** Change fields of the selected placement. `commit` true = add an undo step. */
  onChange(patch: Partial<PlacementData>, commit: boolean): void;
  onDuplicate(): void;
  onRemove(): void;
  onExport(): void;
}

export class Panel {
  readonly el: HTMLElement;
  private chips: HTMLElement;
  private summary: HTMLElement;
  private width: HTMLInputElement;
  private heightLabel: HTMLElement;
  private rot: HTMLInputElement;
  private rotVal: HTMLElement;
  private opacity: HTMLInputElement;
  private readout: HTMLElement;
  private current: PlacedDesign | null = null;
  private collapsed = false;
  /** Cover-up check under the readout (filled in by the app). */
  cover!: HTMLElement;

  constructor(root: HTMLElement, private cb: PanelCallbacks) {
    this.el = document.createElement('div');
    this.el.className = 'panel hidden';
    this.el.innerHTML = `
      <div class="panel-head">
        <div class="chips" id="p-chips"></div>
        <span class="badge hidden" id="p-badge">Existing tattoo</span>
        <span class="muted" id="p-summary"></span>
        <button class="btn ghost" id="p-collapse">Hide</button>
      </div>
      <div class="row">
        <label class="field">Width
          <button class="btn step" data-step="-0.5" aria-label="Smaller">−</button>
          <input id="p-width" type="number" inputmode="decimal" min="1" max="150" step="0.5" />
          <button class="btn step" data-step="0.5" aria-label="Larger">+</button> cm</label>
        <span id="p-height" class="muted"></span>
        <label class="field">Rotate <input id="p-rot" type="range" min="-180" max="180" step="1" value="0" /><span id="p-rot-val">0°</span></label>
      </div>
      <div class="row">
        <button id="p-mirror" class="btn toggle">Mirror</button>
        <button id="p-wrap" class="btn toggle">Wrap around limb</button>
        <div class="seg" id="p-modes">
          <button class="btn seg-btn" data-mode="stencil">Stencil</button>
          <button class="btn seg-btn" data-mode="inked">Inked</button>
          <button class="btn seg-btn" data-mode="heatmap">Heatmap</button>
        </div>
        <label class="field">Opacity <input id="p-opacity" type="range" min="0.1" max="1" step="0.05" value="1" /></label>
      </div>
      <div class="row">
        <span class="muted">Compare as</span>
        <div class="seg" id="p-options">
          <button class="btn seg-btn" data-option="A">A</button>
          <button class="btn seg-btn" data-option="B">B</button>
          <button class="btn seg-btn" data-option="both">Both</button>
        </div>
        <button id="p-lock" class="btn toggle hidden">Locked</button>
        <button id="p-export" class="btn primary">Export stencil</button>
        <button id="p-hide" class="btn toggle">Hide design</button>
        <button id="p-dup" class="btn">Duplicate</button>
        <button id="p-remove" class="btn danger">Remove</button>
      </div>
      <div id="p-readout" class="readout"></div>
      <div id="p-cover" class="readout cover hidden"></div>`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(id: string) => this.el.querySelector(`#${id}`) as T;
    this.chips = q('p-chips'); this.summary = q('p-summary');
    this.width = q<HTMLInputElement>('p-width'); this.heightLabel = q('p-height');
    this.rot = q<HTMLInputElement>('p-rot'); this.rotVal = q('p-rot-val');
    this.opacity = q<HTMLInputElement>('p-opacity'); this.readout = q('p-readout');

    q('p-collapse').addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.width.addEventListener('change', () => cb.onChange({ widthCm: this.clampWidth(Number(this.width.value)) }, true));
    this.el.querySelectorAll<HTMLButtonElement>('.step').forEach((b) => b.addEventListener('click', () => {
      const w = this.clampWidth((Number(this.width.value) || 10) + Number(b.dataset.step));
      this.width.value = String(w);
      cb.onChange({ widthCm: w }, true);
    }));
    this.rot.addEventListener('input', () => { this.rotVal.textContent = `${this.rot.value}°`; cb.onChange({ rotation: (Number(this.rot.value) * Math.PI) / 180 }, false); });
    this.rot.addEventListener('change', () => cb.onChange({ rotation: (Number(this.rot.value) * Math.PI) / 180 }, true));
    q('p-mirror').addEventListener('click', () => { if (this.current) cb.onChange({ mirror: !this.current.placement.mirror }, true); });
    q('p-lock').addEventListener('click', () => { if (this.current) cb.onChange({ locked: !this.current.placement.locked }, true); });
    this.cover = q('p-cover');
    q('p-wrap').addEventListener('click', () => { if (this.current) cb.onChange({ wrap: !this.current.placement.wrap }, true); });
    this.el.querySelectorAll<HTMLButtonElement>('#p-modes .seg-btn').forEach((b) => b.addEventListener('click', () => cb.onChange({ mode: b.dataset.mode as ViewMode }, true)));
    this.el.querySelectorAll<HTMLButtonElement>('#p-options .seg-btn').forEach((b) => b.addEventListener('click', () => cb.onChange({ option: b.dataset.option as Option }, true)));
    this.opacity.addEventListener('input', () => cb.onChange({ opacity: Number(this.opacity.value) }, false));
    this.opacity.addEventListener('change', () => cb.onChange({ opacity: Number(this.opacity.value) }, true));
    q('p-hide').addEventListener('click', () => { if (this.current) cb.onChange({ hidden: !this.current.placement.hidden }, true); });
    q('p-dup').addEventListener('click', () => cb.onDuplicate());
    q('p-export').addEventListener('click', () => cb.onExport());
    q('p-remove').addEventListener('click', () => cb.onRemove());
  }

  private clampWidth(w: number): number { return Math.round(Math.min(150, Math.max(1, w || 10)) * 10) / 10; }

  setCollapsed(c: boolean): void {
    this.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    (this.el.querySelector('#p-collapse') as HTMLElement).textContent = c ? 'Show' : 'Hide';
  }

  /** Refresh the chip list. */
  setDesigns(list: PlacedDesign[], selectedId: string | null): void {
    this.chips.innerHTML = '';
    list.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = 'chip' + (d.placement.id === selectedId ? ' active' : '') + (d.placement.existing ? ' existing' : '');
      const name = d.placement.design.name.replace(/\.[a-z0-9]+$/i, '');
      b.textContent = `${i + 1} ${d.placement.existing ? 'Old: ' : ''}${name.length > 14 ? name.slice(0, 13) + '…' : name}`;
      b.title = d.placement.design.name;
      b.addEventListener('click', () => this.cb.onSelect(d.placement.id));
      this.chips.appendChild(b);
    });
  }

  /** Show the panel for a design (or hide it). */
  show(d: PlacedDesign | null): void {
    this.current = d;
    if (!d) { this.el.classList.add('hidden'); return; }
    this.el.classList.remove('hidden');
    const p = d.placement;
    if (document.activeElement !== this.width) this.width.value = String(p.widthCm);
    this.rot.value = String(Math.round((p.rotation * 180) / Math.PI));
    this.rotVal.textContent = `${this.rot.value}°`;
    this.el.querySelector('#p-mirror')!.classList.toggle('active', p.mirror);
    this.el.querySelector('#p-wrap')!.classList.toggle('active', p.wrap);
    this.el.querySelector('#p-hide')!.classList.toggle('active', !!p.hidden);
    const lock = this.el.querySelector('#p-lock')!;
    lock.classList.toggle('hidden', !p.existing);
    lock.classList.toggle('active', !!p.locked);
    lock.textContent = p.locked ? 'Locked' : 'Lock in place';
    this.el.querySelector('#p-badge')!.classList.toggle('hidden', !p.existing);
    this.el.querySelector('#p-export')!.textContent = p.existing ? 'Export (reference)' : 'Export stencil';
    this.el.querySelector('#p-hide')!.textContent = p.existing ? 'Hide tattoo' : 'Hide design';
    this.opacity.value = String(p.opacity);
    this.el.querySelectorAll<HTMLButtonElement>('#p-modes .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === p.mode));
    this.el.querySelectorAll<HTMLButtonElement>('#p-options .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.option === p.option));
    this.renderReadout(d);
  }

  renderReadout(d: PlacedDesign): void {
    const r = d.result;
    const p = d.placement;
    if (!r) { this.readout.textContent = 'Computing…'; return; }
    this.heightLabel.textContent = `× ${r.heightCm.toFixed(1)} cm (${(p.widthCm / 2.54).toFixed(1)} × ${(r.heightCm / 2.54).toFixed(1)} in)`;
    const s = r.summary;
    const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
    const worst = Math.max(s.worstStretch, -s.worstCompression);
    const cls = worst > 0.05 ? 'warn' : 'ok';
    const parts = [
      p.existing
        ? `<b>Existing tattoo</b> ${p.widthCm} × ${r.heightCm.toFixed(1)} cm on the skin. ${p.locked ? 'Locked: tap "Locked" to move or resize it.' : `Drag it to where it really is and resize it to match${RESIZE_HINT}; then lock it.`}`
        : `<b>${p.design.name}</b> ${p.widthCm} × ${r.heightCm.toFixed(1)} cm on the skin. Resize with the yellow corner handle${RESIZE_HINT}.`,
      `<span class="${cls}">Stretch up to ${pct(s.worstStretch)}, compression up to ${pct(-s.worstCompression)}; ${pct(s.areaOverThreshold)} of the design beyond 5%</span>`,
    ];
    if (worst > 0.05) parts.push(`<span class="warn">A paper stencil would ${s.worstCompression < -0.05 ? 'wrinkle' : 'tear'} there. Consider a smaller design or a flatter spot.</span>`);
    if (r.circumferenceM !== null) parts.push(`Circumference here: <b>${(r.circumferenceM * 100).toFixed(1)} cm</b> (set width to this, or a fraction of it, for a seamless band)`);
    if (p.mode === 'heatmap') parts.push(`<span class="legend"><i style="background:#1a59f2"></i> compression (wrinkle) <i style="background:#ededed"></i> under 2% <i style="background:#d9261a"></i> stretch (tear); strong colour above 5%</span>`);
    parts.push(`<span class="muted">${r.patch.tris.length} triangles, ${r.exact ? `${(r.patch.exactCoverage * 100).toFixed(0)}% exact` : 'quick preview while dragging'}, ${r.computeMs.toFixed(0)} ms</span>`);
    this.readout.innerHTML = parts.join('<br>');
    this.summary.innerHTML = `${p.widthCm} × ${r.heightCm.toFixed(1)} cm · <span class="${cls}">max ${pct(worst)}</span>`;
  }
}
