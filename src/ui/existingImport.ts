// Full-screen editor that turns a photo of an existing tattoo into a flat
// design: drag the guides around the tattoo (the limb's two edges, or four
// corners on a flat area), check the preview, say where it is, place it.

import type { RegionDef } from '../body/regions';
import { autoGuides, maskOutside, type Guides } from '../existing/autoGuide';
import { flattenTattoo, type Flattened, type SurfaceKind } from '../existing/flatten';
import type { Rgba } from '../existing/image';
import { limbFrame, type LimbGuide, type Pt } from '../existing/unwrap';
import { DEFAULT_FOCAL_35, focal35FromJpeg, focalPx } from '../existing/exif';

/** What a pose model (or other analysis) could tell about the photo. */
export interface ImportAnalysis {
  kind?: SurfaceKind;
  limb?: LimbGuide & { from: number; to: number };
  quad?: [Pt, Pt, Pt, Pt];
  regionId?: string;
  /** Plain-language description of the suggested spot. */
  hint?: string;
  /** Opaque data the app uses to anchor precisely (part, fraction, direction). */
  place?: unknown;
  /** Rough width estimate in cm. */
  widthCm?: number;
  /** Rotation of the design on the body (radians, + anticlockwise). */
  rotation?: number;
  mirrored?: boolean;
  personMask?: { data: Float32Array; width: number; height: number };
  /** Photo pixels per cm of skin, roughly (from body proportions). */
  pxPerCm?: number;
  /** The photo shows much of the body: good for where, too small for the design itself. */
  wide?: boolean;
  /** Redo the suggestion when the person says the photo was taken in a mirror. */
  refine?(mirrored: boolean): { hint?: string; regionId?: string } | null;
}

export interface ImportResult {
  canvas: HTMLCanvasElement;
  name: string;
  kind: SurfaceKind;
  flattened: Flattened;
  /** Width the person typed, if any. */
  widthCm: number | null;
  /** Rough width estimated from the photo, if any. */
  estimateCm: number | null;
  regionId: string;
  /** The region the analysis suggested (if the person picked another, the suggestion is ignored). */
  suggestedRegionId?: string;
  mirrored: boolean;
  place?: unknown;
  rotation: number;
}

export interface ImportHooks {
  regions: RegionDef[];
  initialRegionId(): string;
  /** `focus`: a point on the tattoo the person tapped (photo pixels). */
  analyse?(photo: Rgba, focus?: Pt): Promise<ImportAnalysis | null>;
  /** Place the result; resolve with an error message, or null when done. */
  place(r: ImportResult): Promise<string | null>;
}

type Handle = { kind: 'p0' | 'p1' | 'q0' | 'q1' | 'from' | 'to' | 'c0' | 'c1' | 'c2' | 'c3' | 'body' };

const HANDLE_R = 12, GRAB_R = 30;

export function rgbaToCanvas(img: Rgba): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return c;
}

export async function loadPhoto(file: Blob, maxSide = 2400): Promise<Rgba> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const s = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  bmp.close();
  const d = ctx.getImageData(0, 0, w, h);
  return { width: w, height: h, data: d.data };
}

function downscaleRgba(img: Rgba, maxSide: number): { img: Rgba; s: number } {
  const s = Math.min(1, maxSide / Math.max(img.width, img.height));
  if (s >= 1) return { img, s: 1 };
  const src = rgbaToCanvas(img);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * s); c.height = Math.round(img.height * s);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return { img: { width: c.width, height: c.height, data: ctx.getImageData(0, 0, c.width, c.height).data }, s };
}

export class ExistingImport {
  readonly el: HTMLElement;
  private stage: HTMLCanvasElement;
  private preview: HTMLCanvasElement;
  private status: HTMLElement;
  private regionSel: HTMLSelectElement;
  private widthIn: HTMLInputElement;
  private cleanIn: HTMLInputElement;
  private mirrorIn: HTMLInputElement;
  private hintEl: HTMLElement;
  private photo: Rgba | null = null;
  private photoCanvas: HTMLCanvasElement | null = null;
  private small: { img: Rgba; s: number } | null = null;
  private name = 'tattoo';
  private kind: SurfaceKind = 'limb';
  private limb: LimbGuide & { from: number; to: number } = { p0: { x: 0, y: 0 }, p1: { x: 0, y: 1 }, q0: { x: 1, y: 0 }, q1: { x: 1, y: 1 }, from: 0, to: 1 };
  private quad: [Pt, Pt, Pt, Pt] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  private floor: number | undefined;
  private analysis: ImportAnalysis | null = null;
  private touched = false;
  private drag: { h: Handle; last: Pt; pointer: Pt; start: Pt; moved: boolean } | null = null;
  private focus: Pt | undefined;
  /** Camera focal length in pixels of `photo`, and where it came from. */
  private fPx = 0;
  private lens = '';
  private view = { s: 1, ox: 0, oy: 0 };
  private previewTimer = 0;
  private lastFlat: Flattened | null = null;
  /** Photo (and preview copy) with the background made transparent, from the latest guides. */
  private masked: { full: Rgba; small: Rgba } | null = null;

  constructor(root: HTMLElement, private hooks: ImportHooks) {
    this.el = document.createElement('div');
    this.el.className = 'ex-editor hidden';
    this.el.innerHTML = `
      <div class="ex-head">
        <b>Existing tattoo</b>
        <span class="muted ex-status"></span>
        <button class="btn ghost" data-close>Close</button>
      </div>
      <div class="ex-body">
        <div class="ex-stage"><canvas></canvas></div>
        <div class="ex-side">
          <p class="ex-tip">Drag the round handles so the blue lines follow the edges of the arm or leg and the orange bars sit just past the tattoo. Drag inside to move everything.</p>
          <div class="seg ex-kind">
            <button class="btn seg-btn" data-kind="limb">Around an arm or leg</button>
            <button class="btn seg-btn" data-kind="flat">Flat area</button>
          </div>
          <div class="row">
            <button class="btn" data-swap>Swap ends</button>
            <label class="check"><input type="checkbox" data-mirror> Taken in a mirror</label>
          </div>
          <div class="ex-closeup hidden">
            <p class="muted">This photo shows where the tattoo is, but it is small in it. For a sharp copy of the design, add a close-up too.</p>
            <button class="btn" data-closeup>Add a close-up for the design</button>
            <input type="file" accept="image/*" class="hidden" data-closeup-file>
          </div>
          <div class="ex-preview"><canvas></canvas></div>
          <label class="field ex-clean">Remove skin texture <input type="range" min="0" max="100" value="30" data-clean></label>
          <label class="field">Where on the body <select data-region></select></label>
          <p class="muted ex-hint"></p>
          <label class="field">Tattoo width, left to right in the preview <input type="number" inputmode="decimal" min="0.5" max="150" step="0.1" placeholder="estimate" data-width> cm</label>
          <p class="muted ex-width-tip"></p>
          <button class="btn primary ex-go" data-go>Place on body</button>
        </div>
      </div>`;
    root.appendChild(this.el);
    const q = <T extends HTMLElement>(sel: string) => this.el.querySelector(sel) as T;
    this.stage = q<HTMLCanvasElement>('.ex-stage canvas');
    this.preview = q<HTMLCanvasElement>('.ex-preview canvas');
    this.status = q('.ex-status');
    this.regionSel = q<HTMLSelectElement>('[data-region]');
    this.widthIn = q<HTMLInputElement>('[data-width]');
    this.cleanIn = q<HTMLInputElement>('[data-clean]');
    this.mirrorIn = q<HTMLInputElement>('[data-mirror]');
    this.hintEl = q('.ex-hint');
    // Regions grouped like the body part picker.
    const groups = new Map<string, RegionDef[]>();
    for (const r of hooks.regions) { if (!groups.has(r.group)) groups.set(r.group, []); groups.get(r.group)!.push(r); }
    for (const [g, list] of groups) {
      const og = document.createElement('optgroup'); og.label = g;
      for (const r of list) { const o = document.createElement('option'); o.value = r.id; o.textContent = r.label; og.appendChild(o); }
      this.regionSel.appendChild(og);
    }
    q('[data-close]').addEventListener('click', () => this.close());
    this.el.querySelectorAll<HTMLButtonElement>('.ex-kind .seg-btn').forEach((b) => b.addEventListener('click', () => { this.setKind(b.dataset.kind as SurfaceKind); this.touched = true; }));
    q('[data-swap]').addEventListener('click', () => {
      const l = this.limb;
      this.limb = { p0: l.p1, p1: l.p0, q0: l.q1, q1: l.q0, from: 1 - l.to, to: 1 - l.from };
      this.touched = true; this.draw(); this.schedulePreview(0);
    });
    this.mirrorIn.addEventListener('change', () => {
      const r = this.analysis?.refine?.(this.mirrorIn.checked);
      if (r && this.analysis) {
        if (r.regionId) { this.analysis.regionId = r.regionId; this.regionSel.value = r.regionId; }
        this.hintEl.textContent = r.hint ? `Suggested: ${r.hint}. You can fine-tune it on the body.` : '';
      }
      this.schedulePreview(0);
    });
    this.cleanIn.addEventListener('input', () => { this.floor = 0.03 + (Number(this.cleanIn.value) / 100) * 0.42; this.schedulePreview(120); });
    q('[data-go]').addEventListener('click', () => void this.go());
    const closeFile = q<HTMLInputElement>('[data-closeup-file]');
    q('[data-closeup]').addEventListener('click', () => closeFile.click());
    closeFile.addEventListener('change', () => { const f = closeFile.files?.[0]; closeFile.value = ''; if (f) void this.useCloseUp(f); });
    this.stage.addEventListener('pointerdown', (e) => this.onDown(e));
    this.stage.addEventListener('pointermove', (e) => this.onMove(e));
    this.stage.addEventListener('pointerup', (e) => this.onUp(e));
    this.stage.addEventListener('pointercancel', (e) => this.onUp(e));
    window.addEventListener('resize', () => { if (!this.el.classList.contains('hidden')) this.layout(); });
  }

  get isOpen(): boolean { return !this.el.classList.contains('hidden'); }

  async open(file: File): Promise<void> {
    this.el.classList.remove('hidden');
    this.setStatus('Reading the photo…');
    this.name = file.name.replace(/\.[a-z0-9]+$/i, '') || 'tattoo';
    try {
      this.photo = await loadPhoto(file);
    } catch {
      this.setStatus('Could not read that photo. Try a JPEG or PNG (on a Mac, export HEIC photos as JPEG).');
      return;
    }
    this.setLens(await file.arrayBuffer().then(focal35FromJpeg).catch(() => null), this.photo);
    await this.start();
  }

  /** Open with an image already decoded (tests, other sources). */
  async openImage(img: Rgba, name: string, fPx?: number): Promise<void> {
    this.el.classList.remove('hidden');
    this.name = name;
    this.photo = img;
    this.setLens(null, img);
    if (fPx) { this.fPx = fPx; this.lens = 'given'; }
    await this.start();
  }

  /** Focal length for perspective correction: from the photo's EXIF, else a phone's main camera. */
  private setLens(focal35: number | null, img: Rgba) {
    this.fPx = focalPx(focal35 ?? DEFAULT_FOCAL_35, img.width, img.height);
    this.lens = focal35 ? `${focal35} mm lens (from the photo)` : `${DEFAULT_FOCAL_35} mm lens assumed (a phone's main camera)`;
  }

  private async start() {
    const photo = this.photo!;
    this.photoCanvas = rgbaToCanvas(photo);
    this.small = downscaleRgba(photo, 900);
    this.analysis = null; this.touched = false; this.floor = undefined; this.lastFlat = null; this.focus = undefined;
    this.widthIn.value = '';
    this.mirrorIn.checked = false;
    this.regionSel.value = this.hooks.initialRegionId();
    this.hintEl.textContent = '';
    const g = autoGuides(photo);
    this.limb = g.limb; this.quad = g.quad;
    this.setBody(g);
    this.setKind(g.limbLike ? 'limb' : 'flat');
    this.layout();
    this.schedulePreview(0);
    if (this.hooks.analyse) {
      this.setStatus('Looking for the body in the photo…');
      let a: ImportAnalysis | null = null;
      try { a = await this.hooks.analyse(photo, this.focus); } catch (err) { console.warn(err); }
      if (this.photo !== photo) return; // another photo was opened meanwhile
      this.applyAnalysis(a);
    } else this.setStatus('');
  }

  private applyAnalysis(a: ImportAnalysis | null) {
    this.analysis = a;
    (this.el.querySelector('.ex-closeup') as HTMLElement).classList.toggle('hidden', !a?.wide || !a.regionId);
    if (!a) { this.setStatus('Choose below where on the body it is.'); this.updateWidthTip(); return; }
    if (!this.touched) {
      if (a.personMask && this.photo) {
        const g = autoGuides(this.photo, a.personMask, this.focus);
        this.limb = g.limb; this.quad = g.quad;
        this.setBody(g);
      }
      if (a.limb) this.limb = a.limb;
      if (a.quad) this.quad = a.quad;
      if (a.kind) this.setKind(a.kind);
      if (a.mirrored !== undefined) this.mirrorIn.checked = a.mirrored;
    }
    if (a.regionId) this.regionSel.value = a.regionId;
    this.hintEl.textContent = !a.hint ? '' : a.regionId ? `Suggested: ${a.hint}. You can fine-tune it on the body.` : `${a.hint[0].toUpperCase()}${a.hint.slice(1)}.`;
    this.setStatus('');
    this.updateWidthTip();
    this.draw();
    this.schedulePreview(0);
  }

  /** Swap in a close-up of the same tattoo for the design, keeping where it is from the wide photo. */
  async useCloseUp(file: Blob, fPx?: number): Promise<void> {
    let img: Rgba;
    try { img = await loadPhoto(file); } catch { this.setStatus('Could not read that photo. Try a JPEG or PNG.'); return; }
    this.setLens(await file.arrayBuffer().then(focal35FromJpeg).catch(() => null), img);
    if (fPx) { this.fPx = fPx; this.lens = 'given'; }
    await this.swapPhoto(img);
  }

  async swapPhoto(img: Rgba): Promise<void> {
    const keep = this.analysis;
    this.photo = img;
    this.photoCanvas = rgbaToCanvas(img);
    this.small = downscaleRgba(img, 900);
    this.focus = undefined; this.touched = false; this.lastFlat = null;
    const g = autoGuides(img);
    this.limb = g.limb; this.quad = g.quad;
    this.setBody(g);
    this.analysis = keep ? { ...keep, wide: false, personMask: undefined, limb: undefined, quad: undefined, pxPerCm: undefined } : null;
    (this.el.querySelector('.ex-closeup') as HTMLElement).classList.add('hidden');
    this.setStatus('Where it is comes from the first photo, the design from this close-up.');
    this.layout();
    this.schedulePreview(0);
  }

  close() {
    this.el.classList.add('hidden');
    this.photo = null; this.photoCanvas = null; this.small = null;
  }

  private setStatus(t: string) { this.status.textContent = t; }

  /** Remember where the body is, so background inside the guides never becomes ink. */
  private setBody(g: Guides) {
    if (!this.photo || !this.small || !g.body) { this.masked = null; return; }
    this.masked = { full: maskOutside(this.photo, g.body), small: maskOutside(this.small.img, g.body) };
  }

  private setKind(k: SurfaceKind) {
    this.kind = k;
    this.el.querySelectorAll<HTMLButtonElement>('.ex-kind .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === k));
    (this.el.querySelector('[data-swap]') as HTMLElement).classList.toggle('hidden', k !== 'limb');
    (this.el.querySelector('.ex-tip') as HTMLElement).textContent = k === 'limb'
      ? 'Tap the tattoo if the handles are not around it. Drag the round handles so the blue lines follow both edges of the arm or leg and the orange bars sit just past the ends of the tattoo. ▲ marks the end nearer the body.'
      : 'Tap the tattoo if the box is not around it. Drag the four corners around the tattoo; if it was photographed at an angle, put them on a shape you know is square. The top edge is the top of the design.';
    this.updateWidthTip();
    this.draw();
    this.schedulePreview(0);
  }

  private updateWidthTip() {
    const tip = this.el.querySelector('.ex-width-tip') as HTMLElement;
    const est = this.estimateCm();
    tip.textContent = this.kind === 'limb'
      ? `Leave empty to work it out from the width of the arm or leg on the body (perspective corrected for a ${this.lens}). A tape-measure reading along the skin is more exact.`
      : est ? `Estimated from the photo: about ${est.toFixed(1)} cm. A tape-measure reading along the skin is more exact.` : 'Measure the tattoo from its left to its right edge along the skin with a tape measure. Leave empty for 10 cm and resize it on the body.';
  }

  /** Rough width from the photo's body proportions (flat areas), using the latest preview. */
  private estimateCm(): number | undefined {
    const a = this.analysis;
    if (!a) return undefined;
    if (a.pxPerCm && this.lastFlat && !this.lastFlat.empty && this.small) return this.lastFlat.widthPhotoPx / this.small.s / a.pxPerCm;
    return a.widthCm;
  }

  // ---------- Drawing ----------

  private layout() {
    const box = this.stage.parentElement!.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.stage.width = Math.max(1, Math.round(box.width * dpr)); this.stage.height = Math.max(1, Math.round(box.height * dpr));
    this.stage.style.width = `${box.width}px`; this.stage.style.height = `${box.height}px`;
    const pbox = this.preview.parentElement!.getBoundingClientRect();
    this.preview.width = Math.max(1, Math.round(pbox.width * dpr)); this.preview.height = Math.max(1, Math.round(pbox.height * dpr));
    if (this.photo) {
      const s = Math.min(box.width / this.photo.width, box.height / this.photo.height) * 0.94;
      this.view = { s, ox: (box.width - this.photo.width * s) / 2, oy: (box.height - this.photo.height * s) / 2 };
    }
    this.draw();
    this.drawPreview();
  }

  private toScreen(p: Pt): Pt { return { x: this.view.ox + p.x * this.view.s, y: this.view.oy + p.y * this.view.s }; }
  /** Photo-pixel positions of the handles (for tests that drag them as a person would). */
  handlePositions(): Record<string, Pt> {
    return Object.fromEntries(this.handles().map(({ h, p }) => [h.kind, p]));
  }

  /** Page coordinates of a photo pixel (for tests that tap the photo). */
  photoToClient(p: Pt): Pt { const r = this.stage.getBoundingClientRect(), s = this.toScreen(p); return { x: r.left + s.x, y: r.top + s.y }; }
  private toPhoto(p: Pt): Pt { return { x: (p.x - this.view.ox) / this.view.s, y: (p.y - this.view.oy) / this.view.s }; }

  /** Handle positions in photo pixels. */
  private handles(): Array<{ h: Handle; p: Pt; color: string }> {
    if (this.kind === 'flat') return this.quad.map((p, i) => ({ h: { kind: (`c${i}`) as Handle['kind'] }, p, color: '#ffb35c' }));
    const f = limbFrame(this.limb), L = this.limb;
    const at = (t: number) => f.at(t * f.length).c;
    return [
      { h: { kind: 'p0' }, p: L.p0, color: '#7fb2ff' }, { h: { kind: 'p1' }, p: L.p1, color: '#7fb2ff' },
      { h: { kind: 'q0' }, p: L.q0, color: '#7fb2ff' }, { h: { kind: 'q1' }, p: L.q1, color: '#7fb2ff' },
      { h: { kind: 'from' }, p: at(L.from), color: '#ffb35c' }, { h: { kind: 'to' }, p: at(L.to), color: '#ffb35c' },
    ];
  }

  /** Outline of the area that will be used (photo pixels). */
  private areaPolygon(): Pt[] {
    if (this.kind === 'flat') return this.quad;
    const f = limbFrame(this.limb), pts: Pt[] = [];
    const t0 = this.limb.from * f.length, t1 = this.limb.to * f.length;
    for (const [t, side] of [[t0, -1], [t1, -1], [t1, 1], [t0, 1]] as const) {
      const { c, r } = f.at(t);
      pts.push({ x: c.x + f.v.x * r * side, y: c.y + f.v.y * r * side });
    }
    return pts;
  }

  private draw() {
    const ctx = this.stage.getContext('2d');
    if (!ctx || !this.photoCanvas || !this.photo) return;
    const dpr = this.stage.width / Math.max(1, parseFloat(this.stage.style.width) || this.stage.width);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.stage.width / dpr, H = this.stage.height / dpr;
    ctx.fillStyle = '#15171c'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.photoCanvas, this.view.ox, this.view.oy, this.photo.width * this.view.s, this.photo.height * this.view.s);
    // Dim everything outside the area that will be used.
    const poly = this.areaPolygon().map((p) => this.toScreen(p));
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, H);
    ctx.moveTo(poly[0].x, poly[0].y); for (const p of poly.slice(1)) ctx.lineTo(p.x, p.y); ctx.closePath();
    ctx.fillStyle = 'rgba(10,12,16,0.55)'; ctx.fill('evenodd');
    ctx.restore();
    ctx.lineWidth = 2;
    if (this.kind === 'limb') {
      const L = this.limb;
      const f = limbFrame(L);
      const line = (a: Pt, b: Pt, color: string, dash: number[] = []) => {
        const A = this.toScreen(a), B = this.toScreen(b);
        ctx.setLineDash(dash); ctx.strokeStyle = color; ctx.beginPath(); ctx.moveTo(A.x, A.y); ctx.lineTo(B.x, B.y); ctx.stroke(); ctx.setLineDash([]);
      };
      line(L.p0, L.p1, '#7fb2ff'); line(L.q0, L.q1, '#7fb2ff');
      line(f.at(0).c, f.at(f.length).c, 'rgba(255,255,255,0.5)', [6, 6]);
      for (const t of [L.from, L.to]) {
        const { c, r } = f.at(t * f.length);
        line({ x: c.x - f.v.x * r, y: c.y - f.v.y * r }, { x: c.x + f.v.x * r, y: c.y + f.v.y * r }, '#ffb35c');
      }
      const top = this.toScreen(f.at(0).c);
      ctx.fillStyle = '#fff'; ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'center';
      const dir = { x: -f.u.x, y: -f.u.y };
      ctx.fillText('▲ body end', top.x + dir.x * 34, top.y + dir.y * 34 + 4);
    } else {
      ctx.strokeStyle = '#ffb35c';
      ctx.beginPath(); poly.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y))); ctx.closePath(); ctx.stroke();
      const a = poly[0], b = poly[1];
      ctx.fillStyle = '#fff'; ctx.font = '600 13px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('top', (a.x + b.x) / 2, (a.y + b.y) / 2 - 8);
    }
    for (const { p, color } of this.handles()) {
      const s = this.toScreen(p);
      ctx.beginPath(); ctx.arc(s.x, s.y, HANDLE_R, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = color; ctx.stroke();
    }
    if (this.drag && this.drag.h.kind !== 'body') this.drawLoupe(ctx, W);
  }

  /** Magnified view of the photo around the dragged handle, away from the finger. */
  private drawLoupe(ctx: CanvasRenderingContext2D, W: number) {
    const d = this.drag!;
    const hp = this.handles().find((x) => x.h.kind === d.h.kind)?.p;
    if (!hp || !this.photoCanvas) return;
    const R = 62, zoom = 3.2;
    const left = d.pointer.x > W / 2;
    const cx = left ? R + 10 : W - R - 10, cy = R + 10;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.clip();
    const s = this.view.s * zoom;
    ctx.drawImage(this.photoCanvas, cx - hp.x * s, cy - hp.y * s, this.photo!.width * s, this.photo!.height * s);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - 12, cy); ctx.lineTo(cx + 12, cy); ctx.moveTo(cx, cy - 12); ctx.lineTo(cx, cy + 12); ctx.stroke();
    ctx.restore();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
  }

  // ---------- Interaction ----------

  private pointerPt(e: PointerEvent): Pt {
    const r = this.stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onDown(e: PointerEvent) {
    if (!this.photo) return;
    const sp = this.pointerPt(e);
    let best: Handle | null = null, bd = GRAB_R;
    for (const { h, p } of this.handles()) {
      const s = this.toScreen(p), d = Math.hypot(s.x - sp.x, s.y - sp.y);
      if (d < bd) { bd = d; best = h; }
    }
    // Anywhere else starts a "body" press: a drag inside the area moves it, a tap anywhere finds the tattoo there.
    if (!best) best = { kind: 'body' };
    e.preventDefault();
    this.stage.setPointerCapture(e.pointerId);
    this.drag = { h: best, last: this.toPhoto(sp), pointer: sp, start: sp, moved: false };
    this.draw();
  }

  private inside(p: Pt): boolean {
    const poly = this.areaPolygon();
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c;
    }
    return c;
  }

  private onMove(e: PointerEvent) {
    if (!this.drag || !this.photo) return;
    const sp = this.pointerPt(e);
    const p = this.toPhoto(sp);
    const clamp = (q: Pt): Pt => ({ x: Math.max(0, Math.min(this.photo!.width, q.x)), y: Math.max(0, Math.min(this.photo!.height, q.y)) });
    const k = this.drag.h.kind;
    if (!this.drag.moved && Math.hypot(sp.x - this.drag.start.x, sp.y - this.drag.start.y) < 6) return;
    if (k === 'body' && !this.drag.moved && !this.inside(this.toPhoto(this.drag.start))) return; // outside: only taps count
    this.drag.moved = true; this.touched = true;
    const dx = p.x - this.drag.last.x, dy = p.y - this.drag.last.y;
    const L = this.limb;
    if (k === 'body') {
      const mv = (q: Pt): Pt => ({ x: q.x + dx, y: q.y + dy });
      if (this.kind === 'limb') this.limb = { ...L, p0: mv(L.p0), p1: mv(L.p1), q0: mv(L.q0), q1: mv(L.q1) };
      else this.quad = this.quad.map(mv) as [Pt, Pt, Pt, Pt];
    } else if (k === 'from' || k === 'to') {
      const f = limbFrame(L);
      const o = f.at(0).c;
      const t = ((p.x - o.x) * f.u.x + (p.y - o.y) * f.u.y) / (f.length || 1);
      if (k === 'from') this.limb = { ...L, from: Math.max(-0.5, Math.min(L.to - 0.03, t)) };
      else this.limb = { ...L, to: Math.min(1.5, Math.max(L.from + 0.03, t)) };
    } else if (k.startsWith('c')) {
      const i = Number(k[1]);
      const qd = this.quad.slice() as [Pt, Pt, Pt, Pt];
      qd[i] = clamp(p);
      this.quad = qd;
    } else {
      this.limb = { ...L, [k]: clamp(p) } as typeof L;
    }
    this.drag.last = p; this.drag.pointer = sp;
    this.draw();
    this.schedulePreview(180);
  }

  private onUp(e: PointerEvent) {
    if (!this.drag) return;
    try { this.stage.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    const tap = !this.drag.moved && this.drag.h.kind === 'body' ? this.toPhoto(this.drag.start) : null;
    this.drag = null;
    this.draw();
    if (tap && e.type === 'pointerup') void this.refocus(tap);
    else this.schedulePreview(0);
  }

  /** The person tapped the tattoo: look for it there and redo the suggestion. */
  async refocus(p: Pt): Promise<void> {
    if (!this.photo) return;
    this.focus = p;
    this.touched = false;
    const photo = this.photo;
    const g = autoGuides(photo, this.analysis?.personMask, p);
    this.limb = g.limb; this.quad = g.quad;
    this.setBody(g);
    this.draw();
    this.schedulePreview(0);
    if (this.hooks.analyse && this.analysis) {
      this.setStatus('Finding where that is on the body…');
      let a: ImportAnalysis | null = null;
      try { a = await this.hooks.analyse(photo, p); } catch (err) { console.warn(err); }
      if (this.photo !== photo) return;
      this.applyAnalysis(a);
    }
  }

  // ---------- Preview and result ----------

  private params(scale = 1) {
    const sc = (p: Pt): Pt => ({ x: p.x * scale, y: p.y * scale });
    const L = this.limb;
    return {
      kind: this.kind,
      limb: { p0: sc(L.p0), p1: sc(L.p1), q0: sc(L.q0), q1: sc(L.q1), from: L.from, to: L.to },
      quad: this.quad.map(sc) as [Pt, Pt, Pt, Pt],
      mirrored: this.mirrorIn.checked,
      floor: this.floor,
      fPx: this.fPx * scale,
    };
  }

  private schedulePreview(ms: number) {
    clearTimeout(this.previewTimer);
    this.previewTimer = window.setTimeout(() => this.updatePreview(), ms);
  }

  private updatePreview() {
    if (!this.small) return;
    const flat = flattenTattoo(this.masked?.small ?? this.small.img, { ...this.params(this.small.s), maxSide: 700 });
    this.lastFlat = flat;
    if (this.floor === undefined) this.cleanIn.value = String(Math.round(((flat.floor - 0.03) / 0.42) * 100));
    this.updateWidthTip();
    this.drawPreview();
  }

  private drawPreview() {
    const ctx = this.preview.getContext('2d');
    if (!ctx) return;
    const W = this.preview.width, H = this.preview.height;
    // Light skin-coloured backdrop with a faint checker, so ink reads as on skin.
    ctx.fillStyle = '#f1dccb'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#e9d0bd';
    const c = Math.max(8, Math.round(W / 24));
    for (let y = 0; y < H; y += c) for (let x = (y / c) % 2 ? c : 0; x < W; x += 2 * c) ctx.fillRect(x, y, c, c);
    const f = this.lastFlat;
    if (!f) return;
    if (f.empty) {
      ctx.fillStyle = '#7a3b2e'; ctx.font = `${Math.round(H / 10)}px system-ui, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText('No ink found inside the guides', W / 2, H / 2);
      return;
    }
    const src = rgbaToCanvas(f.image);
    const s = Math.min(W / src.width, H / src.height) * 0.92;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(src, (W - src.width * s) / 2, (H - src.height * s) / 2, src.width * s, src.height * s);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Flatten at full resolution and hand the result over. */
  private async go(): Promise<void> {
    if (!this.photo) return;
    const btn = this.el.querySelector('[data-go]') as HTMLButtonElement;
    btn.disabled = true;
    this.setStatus('Flattening…');
    await new Promise((r) => setTimeout(r, 20));
    try {
      // 1400 px keeps fine lines (about 7 px per mm on a 20 cm tattoo) and the autosave small.
      const flat = flattenTattoo(this.masked?.full ?? this.photo, { ...this.params(1), maxSide: 1400 });
      if (flat.empty) { this.setStatus('No ink found inside the guides. Move them around the tattoo or lower "Remove skin texture".'); return; }
      const typed = Number(this.widthIn.value);
      const res: ImportResult = {
        canvas: rgbaToCanvas(flat.image),
        name: `${this.name}-existing.png`,
        kind: this.kind,
        flattened: flat,
        widthCm: typed > 0 ? typed : null,
        estimateCm: this.analysis?.pxPerCm ? flat.widthPhotoPx / this.analysis.pxPerCm : this.analysis?.widthCm ?? null,
        regionId: this.regionSel.value,
        suggestedRegionId: this.analysis?.regionId,
        mirrored: this.mirrorIn.checked,
        place: this.analysis?.place,
        rotation: this.analysis?.rotation ?? 0,
      };
      const err = await this.hooks.place(res);
      if (err) { this.setStatus(err); return; }
      this.close();
    } finally {
      btn.disabled = false;
    }
  }
}

