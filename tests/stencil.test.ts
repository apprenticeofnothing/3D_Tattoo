import { describe, expect, it } from 'vitest';
import { deflateSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { MARGIN, OVERLAP, PAPERS, planTiles, pngDpi, pngWithDpi, registrationMarks, stencilSvg } from '../src/export/stencil';
import { crc32 } from '../src/capture/zip';

function tinyPng(): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set([...type].map((c) => c.charCodeAt(0)), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, 2); dv.setUint32(4, 2); ihdr[8] = 8; ihdr[9] = 6; // 2x2 RGBA
  const raw = new Uint8Array(2 * (1 + 8)); // filter byte + 2 px * 4
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

describe('stencil pages', () => {
  it('fits a 10 x 8 cm design on one A4 page, centred within margins', () => {
    const plan = planTiles(100, 80, 'a4');
    expect(plan.tiles.length).toBe(1);
    expect(plan.landscape).toBe(false);
    expect(plan.areaW).toBeCloseTo(210 - 2 * MARGIN);
  });

  it('turns the page for a wide design that fits sideways', () => {
    const plan = planTiles(240, 120, 'a4');
    expect(plan.tiles.length).toBe(1);
    expect(plan.landscape).toBe(true);
  });

  it('tiles a 45 x 60 cm back piece with 1 cm overlaps that cover the whole design', () => {
    for (const paper of ['a4', 'letter'] as const) {
      const W = 450, H = 600;
      const plan = planTiles(W, H, paper);
      expect(plan.tiles.length).toBeGreaterThan(4);
      for (const t of plan.tiles) {
        expect(t.w).toBeLessThanOrEqual(plan.areaW + 1e-9);
        expect(t.h).toBeLessThanOrEqual(plan.areaH + 1e-9);
      }
      // Coverage: every 5 mm grid point lies in some tile; neighbours overlap by OVERLAP.
      for (let x = 0; x <= W; x += 5) for (let y = 0; y <= H; y += 5) {
        expect(plan.tiles.some((t) => x >= t.x0 - 1e-9 && x <= t.x0 + t.w + 1e-9 && y >= t.y0 - 1e-9 && y <= t.y0 + t.h + 1e-9), `${x},${y}`).toBe(true);
      }
      const row0 = plan.tiles.filter((t) => t.row === 0).sort((a, b) => a.col - b.col);
      for (let i = 1; i < row0.length; i++) expect(row0[i - 1].x0 + row0[i - 1].w - row0[i].x0).toBeCloseTo(OVERLAP, 9);
      // Every registration mark appears on at least two pages.
      for (const [mx, my] of registrationMarks(plan, W, H)) {
        const on = plan.tiles.filter((t) => mx >= t.x0 && mx <= t.x0 + t.w && my >= t.y0 && my <= t.y0 + t.h).length;
        expect(on).toBeGreaterThanOrEqual(2);
      }
      expect(PAPERS[paper].w).toBeGreaterThan(200);
    }
  });
});

describe('stencil files', () => {
  it('stores the print resolution in a PNG and keeps it valid', () => {
    const png = pngWithDpi(tinyPng(), 300);
    expect(pngDpi(png)).toBeCloseTo(300, 0);
    expect(pngDpi(pngWithDpi(png, 600))).toBeCloseTo(600, 0); // replaced, not duplicated
    let ok = true;
    try { execFileSync('python3', ['-I', '-c', 'import sys,io; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); im.load(); print(im.info.get("dpi"))'], { input: Buffer.from(png) }); } catch { ok = false; }
    expect(ok).toBe(true);
  });

  it('gives an SVG design exact millimetre dimensions and can mirror it', () => {
    const src = { id: 'd', kind: 'svg' as const, name: 'x.svg', data: '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="10 20 200 100"><circle cx="60" cy="70" r="20"/></svg>' };
    const out = stencilSvg(src, 123.45, 61.7, false);
    expect(out).toMatch(/<svg width="123.45mm" height="61.7mm" preserveAspectRatio="none"[^>]*viewBox="10 20 200 100"/);
    expect(out).not.toMatch(/width="200"/);
    const m = stencilSvg(src, 100, 50, true);
    expect(m).toContain('<g transform="matrix(-1 0 0 1 220 0)"><circle'); // 2*10 + 200
    const bmp = stencilSvg({ id: 'b', kind: 'bitmap', name: 'x.png', data: 'data:image/png;base64,AAAA' }, 80, 40, true);
    expect(bmp).toContain('width="80mm" height="40mm" viewBox="0 0 80 40"');
    expect(bmp).toContain('transform="matrix(-1 0 0 1 80 0)"');
  });

  it('adds a viewBox when the SVG has none', () => {
    const out = stencilSvg({ id: 'd', kind: 'svg', name: 'x.svg', data: '<svg xmlns="http://www.w3.org/2000/svg" width="50" height="25"><rect width="50" height="25"/></svg>' }, 50, 25, false);
    expect(out).toContain('viewBox="0 0 50 25"');
    expect(out).toContain('width="50mm"');
  });
});
