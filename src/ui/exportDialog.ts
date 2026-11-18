// Export dialog: stencil PDF, SVG or PNG at the size chosen on the body.

import { PAPERS, planTiles, type Paper } from '../export/stencil';

export type ExportFormat = 'pdf' | 'svg' | 'png';
export interface ExportChoice { format: ExportFormat; paper: Paper; mirror: boolean; placement: boolean }

const defaultPaper = (): Paper => (/^en-(US|CA)|^es-(MX|US)|^fil/i.test(navigator.language) ? 'letter' : 'a4');

export class ExportDialog {
  readonly el: HTMLElement;
  private backdrop: HTMLElement;
  private choice: ExportChoice;
  private size = { w: 100, h: 100, name: '' };
  private onGo: ((c: ExportChoice) => void) | null = null;

  constructor(root: HTMLElement) {
    let saved: Partial<ExportChoice> = {};
    try { saved = JSON.parse(localStorage.getItem('tattoo.export') ?? '{}'); } catch { /* ignore */ }
    this.choice = { format: 'pdf', paper: defaultPaper(), mirror: false, placement: true, ...saved };
    this.backdrop = document.createElement('div');
    this.backdrop.className = 'backdrop hidden';
    this.el = document.createElement('div');
    this.el.className = 'sheet export-sheet hidden';
    this.el.innerHTML = `
      <div class="sheet-head"><span>Export stencil</span><button class="btn ghost" data-close>Close</button></div>
      <div class="sheet-body">
        <p class="ex-size"></p>
        <h3>Format</h3>
        <div class="seg ex-format">
          <button class="btn seg-btn" data-format="pdf">Stencil PDF</button>
          <button class="btn seg-btn" data-format="svg">SVG</button>
          <button class="btn seg-btn" data-format="png">PNG 300 dpi</button>
        </div>
        <p class="muted ex-format-note"></p>
        <div class="ex-paper-row">
          <h3>Paper</h3>
          <div class="seg ex-paper">
            <button class="btn seg-btn" data-paper="a4">A4</button>
            <button class="btn seg-btn" data-paper="letter">US Letter</button>
          </div>
        </div>
        <label class="ex-check"><input type="checkbox" data-mirror /> Mirror for transfer paper <small class="muted">only if your stencil method needs a reversed print</small></label>
        <label class="ex-check ex-placement-row"><input type="checkbox" data-placement /> Add a placement page <small class="muted">picture on the body, area, rotation, stretch</small></label>
        <p class="ex-pages muted"></p>
        <button class="btn primary ex-go" data-go>Download</button>
      </div>`;
    root.append(this.backdrop, this.el);
    this.el.querySelector('[data-close]')!.addEventListener('click', () => this.close());
    this.backdrop.addEventListener('click', () => this.close());
    this.el.querySelectorAll<HTMLButtonElement>('[data-format]').forEach((b) => b.addEventListener('click', () => { this.choice.format = b.dataset.format as ExportFormat; this.render(); }));
    this.el.querySelectorAll<HTMLButtonElement>('[data-paper]').forEach((b) => b.addEventListener('click', () => { this.choice.paper = b.dataset.paper as Paper; this.render(); }));
    const mirror = this.el.querySelector<HTMLInputElement>('[data-mirror]')!;
    mirror.addEventListener('change', () => { this.choice.mirror = mirror.checked; this.render(); });
    const placement = this.el.querySelector<HTMLInputElement>('[data-placement]')!;
    placement.addEventListener('change', () => { this.choice.placement = placement.checked; this.render(); });
    this.el.querySelector('[data-go]')!.addEventListener('click', () => {
      try { localStorage.setItem('tattoo.export', JSON.stringify(this.choice)); } catch { /* ignore */ }
      this.onGo?.({ ...this.choice });
    });
  }

  open(name: string, widthMm: number, heightMm: number, onGo: (c: ExportChoice) => void): void {
    this.size = { w: widthMm, h: heightMm, name };
    this.onGo = onGo;
    this.render();
    this.el.classList.remove('hidden'); this.backdrop.classList.remove('hidden');
  }

  close(): void { this.el.classList.add('hidden'); this.backdrop.classList.add('hidden'); }

  busy(on: boolean, text = 'Preparing…'): void {
    const b = this.el.querySelector<HTMLButtonElement>('[data-go]')!;
    b.disabled = on; b.textContent = on ? text : 'Download';
  }

  private render(): void {
    const c = this.choice, { w, h, name } = this.size;
    const cm = (mm: number) => (mm / 10).toFixed(1), inch = (mm: number) => (mm / 25.4).toFixed(2);
    this.el.querySelector('.ex-size')!.innerHTML = `<b>${name}</b> at <b>${cm(w)} × ${cm(h)} cm</b> (${inch(w)} × ${inch(h)} in), the size it has on the body.`;
    this.el.querySelectorAll<HTMLElement>('[data-format]').forEach((b) => b.classList.toggle('active', b.dataset.format === c.format));
    this.el.querySelectorAll<HTMLElement>('[data-paper]').forEach((b) => b.classList.toggle('active', b.dataset.paper === c.paper));
    this.el.querySelector<HTMLInputElement>('[data-mirror]')!.checked = c.mirror;
    this.el.querySelector<HTMLInputElement>('[data-placement]')!.checked = c.placement;
    const isPdf = c.format === 'pdf';
    this.el.querySelector<HTMLElement>('.ex-paper-row')!.classList.toggle('hidden', !isPdf);
    this.el.querySelector<HTMLElement>('.ex-placement-row')!.classList.toggle('hidden', !isPdf);
    this.el.querySelector('.ex-format-note')!.textContent = isPdf
      ? 'Ready to print at 100% with a calibration ruler. Best for handing to the artist.'
      : c.format === 'svg' ? 'Vector file with real millimetre dimensions, for design and stencil software.'
      : 'Image at 300 dpi with the resolution stored, so it prints at the right size.';
    const pages = this.el.querySelector('.ex-pages')!;
    if (isPdf) {
      const plan = planTiles(w, h, c.paper);
      const n = plan.tiles.length;
      pages.textContent = n === 1
        ? `Fits on one ${PAPERS[c.paper].label} page${plan.landscape ? ' (landscape)' : ''}.`
        : `Larger than one page: split over ${n} ${PAPERS[c.paper].label} pages (${plan.cols} × ${plan.rows}) with 1 cm overlaps and alignment crosses.`;
    } else pages.textContent = '';
  }
}
