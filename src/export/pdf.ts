// Minimal PDF writer for print-accurate stencils: pages sized in
// millimetres, lines, rectangles, text in the standard Helvetica fonts,
// and JPEG images. Coordinates are millimetres from the top-left corner.
// Everything is produced in the browser; nothing is uploaded.

const PT = 72 / 25.4; // points per millimetre

export interface PdfImage { jpeg: Uint8Array; widthPx: number; heightPx: number }

type Op =
  | { k: 'line'; x1: number; y1: number; x2: number; y2: number; w: number; gray: number; dash?: number[] }
  | { k: 'rect'; x: number; y: number; w: number; h: number; lw: number; gray: number; fill?: number }
  | { k: 'text'; x: number; y: number; size: number; s: string; bold?: boolean; gray?: number }
  | { k: 'image'; img: number; x: number; y: number; w: number; h: number };

export class PdfPage {
  ops: Op[] = [];
  constructor(readonly widthMm: number, readonly heightMm: number) {}
  line(x1: number, y1: number, x2: number, y2: number, w = 0.25, gray = 0, dash?: number[]): this { this.ops.push({ k: 'line', x1, y1, x2, y2, w, gray, dash }); return this; }
  rect(x: number, y: number, w: number, h: number, lw = 0.25, gray = 0, fill?: number): this { this.ops.push({ k: 'rect', x, y, w, h, lw, gray, fill }); return this; }
  /** Text baseline at (x, y) mm; size in points. */
  text(x: number, y: number, s: string, size = 9, bold = false, gray = 0): this { this.ops.push({ k: 'text', x, y, size, s, bold, gray }); return this; }
  image(img: number, x: number, y: number, w: number, h: number): this { this.ops.push({ k: 'image', img, x, y, w, h }); return this; }
}

/** WinAnsi-encoded PDF string literal (covers Latin-1, including the multiplication sign and degree sign). */
function pdfString(s: string): string {
  let out = '(';
  for (const ch of s) {
    let c = ch.codePointAt(0)!;
    if (ch === '–' || ch === '—') c = 0x96; // en dash in WinAnsi
    else if (ch === '’') c = 0x92;
    else if (c > 255) c = 0x3f; // '?'
    if (c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if (c < 32 || c > 126) out += '\\' + c.toString(8).padStart(3, '0');
    else out += String.fromCharCode(c);
  }
  return out + ')';
}

const n = (v: number) => (Math.abs(v) < 1e-9 ? '0' : v.toFixed(3).replace(/\.?0+$/, ''));

export class PdfDoc {
  readonly pages: PdfPage[] = [];
  readonly images: PdfImage[] = [];
  constructor(readonly title = 'Stencil') {}

  addPage(widthMm: number, heightMm: number): PdfPage { const p = new PdfPage(widthMm, heightMm); this.pages.push(p); return p; }
  addImage(img: PdfImage): number { this.images.push(img); return this.images.length - 1; }

  private content(p: PdfPage): string {
    const H = p.heightMm;
    const X = (x: number) => n(x * PT), Y = (y: number) => n((H - y) * PT);
    const out: string[] = [];
    for (const o of p.ops) {
      if (o.k === 'line') {
        out.push(`${n(o.gray)} G ${n(o.w * PT)} w ${o.dash ? `[${o.dash.map((d) => n(d * PT)).join(' ')}] 0 d` : '[] 0 d'} ${X(o.x1)} ${Y(o.y1)} m ${X(o.x2)} ${Y(o.y2)} l S`);
      } else if (o.k === 'rect') {
        const path = `${X(o.x)} ${Y(o.y + o.h)} ${n(o.w * PT)} ${n(o.h * PT)} re`;
        if (o.fill !== undefined) out.push(`${n(o.fill)} g ${path} f`);
        if (o.lw > 0) out.push(`${n(o.gray)} G ${n(o.lw * PT)} w [] 0 d ${path} S`);
      } else if (o.k === 'text') {
        out.push(`BT /${o.bold ? 'F2' : 'F1'} ${n(o.size)} Tf ${n(o.gray ?? 0)} g ${X(o.x)} ${Y(o.y)} Td ${pdfString(o.s)} Tj ET`);
      } else {
        out.push(`q ${n(o.w * PT)} 0 0 ${n(o.h * PT)} ${X(o.x)} ${Y(o.y + o.h)} cm /Im${o.img} Do Q`);
      }
    }
    return out.join('\n');
  }

  /** The finished PDF file. */
  build(): Uint8Array {
    const enc = new TextEncoder();
    const chunks: Uint8Array[] = [];
    const offsets: number[] = [];
    let pos = 0;
    const push = (b: Uint8Array) => { chunks.push(b); pos += b.length; };
    const str = (s: string) => {
      // Latin-1 bytes (content streams only use ASCII and octal escapes).
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      push(b);
    };
    // Object numbers: 1 catalog, 2 pages, 3 F1, 4 F2, 5 info, then images, then page+content pairs.
    const imgBase = 6;
    const pageBase = imgBase + this.images.length;
    const total = pageBase + this.pages.length * 2 - 1;
    const obj = (num: number, body: () => void) => { offsets[num] = pos; str(`${num} 0 obj\n`); body(); str('\nendobj\n'); };
    str('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
    obj(1, () => str('<< /Type /Catalog /Pages 2 0 R >>'));
    const kids = this.pages.map((_, i) => `${pageBase + i * 2} 0 R`).join(' ');
    obj(2, () => str(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`));
    obj(3, () => str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
    obj(4, () => str('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));
    obj(5, () => str(`<< /Title ${pdfString(this.title)} /Producer (Tattoo preview) >>`));
    this.images.forEach((im, i) => obj(imgBase + i, () => {
      str(`<< /Type /XObject /Subtype /Image /Width ${im.widthPx} /Height ${im.heightPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${im.jpeg.length} >>\nstream\n`);
      push(im.jpeg);
      str('\nendstream');
    }));
    const xobjects = this.images.map((_, i) => `/Im${i} ${imgBase + i} 0 R`).join(' ');
    this.pages.forEach((p, i) => {
      const pageNum = pageBase + i * 2, contentNum = pageNum + 1;
      obj(pageNum, () => str(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(p.widthMm * PT)} ${n(p.heightMm * PT)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> /XObject << ${xobjects} >> >> /Contents ${contentNum} 0 R >>`));
      const c = this.content(p);
      obj(contentNum, () => { str(`<< /Length ${c.length} >>\nstream\n`); str(c); str('\nendstream'); });
    });
    const xref = pos;
    let x = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= total; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    str(x);
    str(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
    void enc;
    const out = new Uint8Array(pos);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }
}
