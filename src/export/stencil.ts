// Stencil export: the flat design at exactly the size chosen on the body.
// Because the mapping preserves lengths along the skin, the flat design
// at W x H centimetres is the stencil that lies on that skin.

import { crc32 } from '../capture/zip';
import type { DesignSource } from '../app/project';
import { PdfDoc } from './pdf';

export type Paper = 'a4' | 'letter';
export const PAPERS: Record<Paper, { label: string; w: number; h: number }> = {
  a4: { label: 'A4', w: 210, h: 297 },
  letter: { label: 'US Letter', w: 215.9, h: 279.4 },
};
export const MARGIN = 12; // mm, safe for most printers
export const HEADER = 20; // mm reserved at the top for labels
export const FOOTER = 30; // mm reserved at the bottom for the calibration ruler
export const OVERLAP = 10; // mm shared between neighbouring tiles

export interface Tile { col: number; row: number; x0: number; y0: number; w: number; h: number }
export interface TilePlan {
  paper: Paper; landscape: boolean; pageW: number; pageH: number;
  areaW: number; areaH: number; cols: number; rows: number; tiles: Tile[];
}

function split(total: number, area: number): Array<[number, number]> {
  if (total <= area) return [[0, total]];
  const count = Math.ceil((total - area) / (area - OVERLAP)) + 1;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < count; i++) {
    const start = i * (area - OVERLAP);
    out.push([start, Math.min(area, total - start)]);
  }
  return out;
}

/** Pages needed to print a W x H mm design at 100%, picking the orientation that needs fewer pages. */
export function planTiles(widthMm: number, heightMm: number, paper: Paper): TilePlan {
  const p = PAPERS[paper];
  const plans = [false, true].map((landscape) => {
    const pageW = landscape ? p.h : p.w, pageH = landscape ? p.w : p.h;
    const areaW = pageW - 2 * MARGIN, areaH = pageH - 2 * MARGIN - HEADER - FOOTER;
    const xs = split(widthMm, areaW), ys = split(heightMm, areaH);
    const tiles: Tile[] = [];
    ys.forEach(([y0, h], row) => xs.forEach(([x0, w], col) => tiles.push({ col, row, x0, y0, w, h })));
    return { paper, landscape, pageW, pageH, areaW, areaH, cols: xs.length, rows: ys.length, tiles };
  });
  return plans[1].tiles.length < plans[0].tiles.length ? plans[1] : plans[0];
}

/** Registration crosses (design mm) in the overlap strips, so tiles can be lined up. */
export function registrationMarks(plan: TilePlan, widthMm: number, heightMm: number): Array<[number, number]> {
  const marks: Array<[number, number]> = [];
  const along = (len: number) => { const n = Math.max(2, Math.ceil(len / 60)); return Array.from({ length: n }, (_, i) => ((i + 0.5) * len) / n); };
  for (let c = 1; c < plan.cols; c++) {
    const x = plan.tiles.find((t) => t.col === c)!.x0 + OVERLAP / 2;
    for (const y of along(heightMm)) marks.push([x, y]);
  }
  for (let r = 1; r < plan.rows; r++) {
    const y = plan.tiles.find((t) => t.row === r)!.y0 + OVERLAP / 2;
    for (const x of along(widthMm)) marks.push([x, y]);
  }
  return marks;
}

// ---------- rendering ----------

/** An image element for a design source (SVG text or bitmap data URL). */
export async function sourceImage(src: DesignSource): Promise<HTMLImageElement> {
  const url = src.kind === 'svg' ? URL.createObjectURL(new Blob([src.data], { type: 'image/svg+xml' })) : src.data;
  try {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('could not decode the design')); img.src = url; });
    return img;
  } finally {
    if (src.kind === 'svg') setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

/**
 * Draw the part [x0, x0+w] x [y0, y0+h] (design mm) of a W x H mm design
 * onto a new canvas at `dpi`. `white` fills the background (for print).
 */
export function renderRegion(img: HTMLImageElement, W: number, H: number, region: { x0: number; y0: number; w: number; h: number }, dpi: number, mirror: boolean, white: boolean): HTMLCanvasElement {
  const pxPerMm = dpi / 25.4;
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(region.w * pxPerMm));
  c.height = Math.max(1, Math.round(region.h * pxPerMm));
  const ctx = c.getContext('2d')!;
  if (white) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(pxPerMm, 0, 0, pxPerMm, -region.x0 * pxPerMm, -region.y0 * pxPerMm);
  if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
  ctx.drawImage(img, 0, 0, W, H);
  return c;
}

async function canvasBytes(c: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('could not encode image'))), type, quality));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Insert (or replace) a pHYs chunk so the PNG states its print resolution. */
export function pngWithDpi(png: Uint8Array, dpi: number): Uint8Array {
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm); dv.setUint32(12, ppm); chunk[16] = 1; // unit: metre
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  // Walk chunks: copy all except an existing pHYs, insert ours after IHDR.
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  let o = 8;
  const pv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (o < png.length) {
    const len = pv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const end = o + 12 + len;
    if (type !== 'pHYs') parts.push(png.subarray(o, end));
    if (type === 'IHDR') parts.push(chunk);
    o = end;
  }
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let k = 0;
  for (const p of parts) { out.set(p, k); k += p.length; }
  return out;
}

/** Read the print resolution (dpi) stored in a PNG, or null. */
export function pngDpi(png: Uint8Array): number | null {
  const pv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  while (o < png.length) {
    const len = pv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    if (type === 'pHYs') return pv.getUint32(o + 8) * 0.0254;
    o += 12 + len;
  }
  return null;
}

// ---------- SVG ----------

/** The design as an SVG with real millimetre dimensions (prints at exactly that size). */
export function stencilSvg(src: DesignSource, widthMm: number, heightMm: number, mirror: boolean): string {
  const W = +widthMm.toFixed(2), H = +heightMm.toFixed(2);
  if (src.kind === 'bitmap') {
    const flip = mirror ? ` transform="matrix(-1 0 0 1 ${W} 0)"` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">\n<image${flip} x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="none" href="${src.data}" xlink:href="${src.data}"/>\n</svg>\n`;
  }
  const text = src.data;
  const m = /<svg\b[^>]*>/i.exec(text);
  if (!m) throw new Error('not an SVG file');
  let tag = m[0];
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*("[^"]*"|'[^']*')`, 'i').exec(tag)?.[1].slice(1, -1);
  let vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (!vb || vb.length !== 4 || vb.some((v) => !Number.isFinite(v))) {
    const w = parseFloat(attr('width') ?? '') || 100, h = parseFloat(attr('height') ?? '') || 100;
    vb = [0, 0, w, h];
    tag = tag.replace(/<svg\b/i, `<svg viewBox="0 0 ${w} ${h}"`);
  }
  // Exact physical size; the drawing is stretched to it exactly like on the body.
  tag = tag.replace(/\s(width|height|preserveAspectRatio)\s*=\s*("[^"]*"|'[^']*')/gi, '');
  tag = tag.replace(/<svg\b/i, `<svg width="${W}mm" height="${H}mm" preserveAspectRatio="none"`);
  let body = text.slice(m.index + m[0].length);
  const close = body.lastIndexOf('</svg>');
  const inner = close >= 0 ? body.slice(0, close) : body;
  body = mirror ? `<g transform="matrix(-1 0 0 1 ${2 * vb[0] + vb[2]} 0)">${inner}</g></svg>` : `${inner}</svg>`;
  return text.slice(0, m.index) + tag + body + '\n';
}

// ---------- PDF ----------

export interface StencilInfo {
  name: string;
  widthMm: number;
  heightMm: number;
  mirror: boolean;
  /** Placement details for the artist (lines of text). */
  placement: string[];
  /** Picture of the design on the body (JPEG), optional. */
  snapshot?: { jpeg: Uint8Array; widthPx: number; heightPx: number };
}

const fmt = (mm: number) => (mm / 10).toFixed(1).replace(/\.0$/, '');
const inch = (mm: number) => (mm / 25.4).toFixed(2);

/** Calibration rulers: 5 cm with mm ticks, and 2 in with 1/8 in ticks. */
function rulers(page: import('./pdf').PdfPage, x: number, y: number): void {
  page.text(x, y - 4.5, 'Check the print: this line must measure exactly 5 cm', 7, false, 0.25);
  page.line(x, y, x + 50, y, 0.3);
  for (let i = 0; i <= 50; i++) page.line(x + i, y, x + i, y - (i % 10 === 0 ? 3 : i % 5 === 0 ? 2 : 1), 0.15);
  for (let i = 0; i <= 5; i++) page.text(x + i * 10 - 0.8, y + 3.2, String(i), 6);
  const x2 = x + 70;
  page.text(x2, y - 4.5, 'and this one exactly 2 inches', 7, false, 0.25);
  page.line(x2, y, x2 + 50.8, y, 0.3);
  for (let i = 0; i <= 16; i++) page.line(x2 + i * 3.175, y, x2 + i * 3.175, y - (i % 8 === 0 ? 3 : i % 4 === 0 ? 2 : 1), 0.15);
  for (let i = 0; i <= 2; i++) page.text(x2 + i * 25.4 - 0.8, y + 3.2, String(i), 6);
}

function cropMarks(page: import('./pdf').PdfPage, x: number, y: number, w: number, h: number): void {
  const L = 5, g = 1.5;
  for (const [cx, cy, sx, sy] of [[x, y, -1, -1], [x + w, y, 1, -1], [x, y + h, -1, 1], [x + w, y + h, 1, 1]] as const) {
    page.line(cx + sx * g, cy, cx + sx * (g + L), cy, 0.2);
    page.line(cx, cy + sy * g, cx, cy + sy * (g + L), 0.2);
  }
}

function cross(page: import('./pdf').PdfPage, x: number, y: number): void {
  page.line(x - 3, y, x + 3, y, 0.2, 0.2);
  page.line(x, y - 3, x, y + 3, 0.2, 0.2);
  page.rect(x - 1.2, y - 1.2, 2.4, 2.4, 0.15, 0.2);
}

/** Build the stencil PDF: design at 100% (tiled if larger than the paper), optional placement sheet. */
export async function stencilPdf(img: HTMLImageElement, info: StencilInfo, paper: Paper, placementSheet: boolean, dpi = 300): Promise<Uint8Array> {
  const W = info.widthMm, H = info.heightMm;
  const plan = planTiles(W, H, paper);
  const doc = new PdfDoc(`${info.name} stencil ${fmt(W)} x ${fmt(H)} cm`);
  const marks = registrationMarks(plan, W, H);
  const total = plan.tiles.length;
  for (const [i, t] of plan.tiles.entries()) {
    const page = doc.addPage(plan.pageW, plan.pageH);
    const top = MARGIN + HEADER;
    // Centre a single-page design; tiles start at the content area's corner.
    const ox = MARGIN + (total === 1 ? (plan.areaW - t.w) / 2 : 0);
    const oy = top + (total === 1 ? (plan.areaH - t.h) / 2 : 0);
    page.text(MARGIN, MARGIN + 5, `${info.name}`, 12, true);
    page.text(MARGIN, MARGIN + 11, `Stencil size ${fmt(W)} × ${fmt(H)} cm (${inch(W)} × ${inch(H)} in) as measured along the skin${info.mirror ? ', mirrored for transfer' : ''}.`, 8.5);
    page.text(MARGIN, MARGIN + 16, total > 1
      ? `Page ${i + 1} of ${total}: row ${t.row + 1}, column ${t.col + 1}. Pages overlap by 1 cm; line up the crosses. Print at 100% (actual size), never "fit to page".`
      : 'Print at 100% (actual size), never "fit to page". Check the rulers below before transferring.', 8, false, 0.2);
    const tileImg = renderRegion(img, W, H, t, dpi, info.mirror, true);
    const jpeg = await canvasBytes(tileImg, 'image/jpeg', 0.95);
    const id = doc.addImage({ jpeg, widthPx: tileImg.width, heightPx: tileImg.height });
    page.image(id, ox, oy, t.w, t.h);
    // Edges of the stencil: crop marks at the design's own corners on the page they fall on.
    const isLeft = t.x0 === 0, isTop = t.y0 === 0, isRight = t.x0 + t.w >= W - 1e-6, isBottom = t.y0 + t.h >= H - 1e-6;
    if (isLeft && isTop && isRight && isBottom) cropMarks(page, ox, oy, t.w, t.h);
    else {
      page.rect(ox, oy, t.w, t.h, 0.15, 0.6);
      if (isLeft && isTop) cropMarks(page, ox, oy, 0, 0);
    }
    void isRight; void isBottom;
    for (const [mx, my] of marks) {
      if (mx >= t.x0 - 1e-6 && mx <= t.x0 + t.w + 1e-6 && my >= t.y0 - 1e-6 && my <= t.y0 + t.h + 1e-6) {
        cross(page, ox + mx - t.x0, oy + my - t.y0);
      }
    }
    rulers(page, MARGIN, plan.pageH - MARGIN - 12);
  }
  if (placementSheet) {
    const p = PAPERS[paper];
    const page = doc.addPage(p.w, p.h);
    page.text(MARGIN, MARGIN + 6, `Placement: ${info.name}`, 14, true);
    let y = MARGIN + 14;
    if (info.snapshot) {
      const id = doc.addImage(info.snapshot);
      const maxW = p.w - 2 * MARGIN, maxH = p.h * 0.55;
      const s = Math.min(maxW / info.snapshot.widthPx, maxH / info.snapshot.heightPx);
      const w = info.snapshot.widthPx * s, h = info.snapshot.heightPx * s;
      page.image(id, MARGIN + (maxW - w) / 2, y, w, h);
      page.rect(MARGIN + (maxW - w) / 2, y, w, h, 0.2, 0.7);
      y += h + 8;
    }
    for (const line of info.placement) { page.text(MARGIN, y, line, 10); y += 6; }
    page.text(MARGIN, p.h - MARGIN, 'Made with Tattoo preview. Sizes are measured along the skin, the way a stencil lies on it.', 7, false, 0.4);
  }
  return doc.build();
}

/** PNG at `dpi` with the resolution stored, so printing at 100% gives the stencil size. */
export async function stencilPng(img: HTMLImageElement, widthMm: number, heightMm: number, mirror: boolean, dpi = 300): Promise<Uint8Array> {
  // Keep the canvas under ~60 megapixels for very large pieces.
  const maxPx = 60e6;
  const px = (widthMm / 25.4 * dpi) * (heightMm / 25.4 * dpi);
  const useDpi = px > maxPx ? Math.floor(dpi * Math.sqrt(maxPx / px)) : dpi;
  const c = renderRegion(img, widthMm, heightMm, { x0: 0, y0: 0, w: widthMm, h: heightMm }, useDpi, mirror, false);
  return pngWithDpi(await canvasBytes(c, 'image/png'), useDpi);
}
