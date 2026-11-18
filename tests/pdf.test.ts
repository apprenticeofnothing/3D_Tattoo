import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { PdfDoc } from '../src/export/pdf';

// Smallest valid JPEG (1x1 white), for structure tests.
const JPEG_1PX = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=', 'base64'));

function parse(pdf: Uint8Array) {
  const text = Buffer.from(pdf).toString('latin1');
  const xrefPos = Number(/startxref\n(\d+)/.exec(text)![1]);
  const xref = text.slice(xrefPos).split('\n');
  const count = Number(xref[1].split(' ')[1]);
  const offsets = xref.slice(3, 2 + count).map((l) => Number(l.slice(0, 10)));
  return { text, offsets };
}

describe('PDF writer', () => {
  it('writes a valid cross-reference table: every offset points at its object', () => {
    const doc = new PdfDoc('Test');
    const img = doc.addImage({ jpeg: JPEG_1PX, widthPx: 1, heightPx: 1 });
    doc.addPage(210, 297).text(20, 20, 'Width 12.5 × 8 cm, rotated 30° (test)').line(10, 10, 60, 10).rect(10, 30, 50, 20).image(img, 20, 60, 100, 50);
    doc.addPage(279.4, 215.9).text(10, 10, 'Page 2', 12, true);
    const pdf = doc.build();
    const { text, offsets } = parse(pdf);
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    offsets.forEach((o, i) => expect(text.slice(o, o + 12), `object ${i + 1}`).toMatch(new RegExp(`^${i + 1} 0 obj`)));
    expect(text).toContain('/Count 2');
  });

  it('sizes pages and images in exact millimetres', () => {
    const doc = new PdfDoc();
    const img = doc.addImage({ jpeg: JPEG_1PX, widthPx: 1, heightPx: 1 });
    doc.addPage(210, 297).image(img, 10, 20, 123.4, 56.7);
    const { text } = parse(doc.build());
    const pt = 72 / 25.4;
    expect(text).toContain(`/MediaBox [0 0 ${(210 * pt).toFixed(3).replace(/\.?0+$/, '')} ${(297 * pt).toFixed(3).replace(/\.?0+$/, '')}]`);
    // Image matrix: width and height in points.
    const m = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/.exec(text)!;
    expect(Number(m[1]) / pt).toBeCloseTo(123.4, 2);
    expect(Number(m[2]) / pt).toBeCloseTo(56.7, 2);
    expect(Number(m[3]) / pt).toBeCloseTo(10, 2);
    expect(297 - (Number(m[4]) / pt + 56.7)).toBeCloseTo(20, 2); // top edge at y = 20 mm
  });

  it('encodes special characters for the standard fonts', () => {
    const doc = new PdfDoc();
    doc.addPage(100, 100).text(5, 5, 'a (b) \\ × ° é');
    const { text } = parse(doc.build());
    expect(text).toContain('(a \\(b\\) \\\\ \\327 \\260 \\351)');
  });

  it('opens in a real PDF parser when one is installed', () => {
    let have = true;
    try { execFileSync('python3', ['-I', '-c', 'import pypdf'], { stdio: 'ignore' }); } catch { have = false; }
    if (!have) return; // optional check
    const doc = new PdfDoc('Check');
    doc.addPage(210, 297).text(10, 10, 'Hello');
    const out = execFileSync('python3', ['-I', '-c', 'import sys,io,pypdf; r=pypdf.PdfReader(io.BytesIO(sys.stdin.buffer.read())); print(len(r.pages), r.pages[0].extract_text().strip())'], { input: Buffer.from(doc.build()) }).toString().trim();
    expect(out).toBe('1 Hello');
  });
});
