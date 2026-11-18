// Size a design on the body, then export it as a stencil at that size.
// Verifies the files: PDF (with pypdf, if installed), SVG dimensions, PNG dpi.
import pw from 'playwright';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const { chromium, devices } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const log = (s) => console.log(s);
const ready = (page) => page.waitForFunction(() => window.__app?.surfaceInfo()?.labels === true, null, { timeout: 60000 });
const idle = async (page) => { await page.waitForFunction(() => !window.__app.busy(), null, { timeout: 30000 }); await page.waitForTimeout(400); };
const py = (code, file) => execFileSync('python3', ['-I', '-c', code, file]).toString().trim();

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
const page = await ctx.newPage();
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') log(`error: ${m.text()}`); });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(page);
await page.evaluate(() => { window.__app.closeBodyPanel(); window.__app.choosePreset('male-athletic'); window.__app.setPose({}, false); });
await page.waitForTimeout(700);
await page.evaluate(() => window.__app.goTo('forearm-outer-left')); await page.waitForTimeout(900);
await page.waitForFunction(() => window.__app.zoomSettled());
const st = await page.locator('#stage').boundingBox();
await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [st.x + st.width / 2, st.y + st.height / 2]);
await idle(page);
await page.waitForFunction(() => window.__app.zoomSettled()); // the view glides clear of the design panel
log(`size tag: ${await page.evaluate(() => window.__app.sizeTagText())}`);

// Resize on the body with the corner handle.
const h = await page.evaluate(() => window.__app.handles());
const hs = await page.evaluate((p) => window.__app.toScreen(p), h.scale);
const c0 = await page.evaluate(() => { const p = window.__app.selected().placement; return window.__app.toScreen(window.__app.shownPoint(p.tri, p.point)); });
const dir = { x: hs.x - c0.x, y: hs.y - c0.y }; const L = Math.hypot(dir.x, dir.y);
log(`corner handle is ${await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === 'CANVAS' ? 'clear of the panel' : 'COVERED by ' + document.elementFromPoint(x, y)?.className, [hs.x, hs.y])}`);
await page.mouse.move(hs.x, hs.y); await page.mouse.down();
for (let i = 1; i <= 10; i++) { await page.mouse.move(hs.x - dir.x / L * 3 * i, hs.y - dir.y / L * 3 * i); await page.waitForTimeout(40); }
await page.mouse.up(); await idle(page);
log(`after dragging the corner inwards: ${await page.evaluate(() => window.__app.sizeTagText())}`);
await page.screenshot({ path: `${out}/se-1-resized.png` });

// Alt + scroll over the design makes it bigger.
const cc = await page.evaluate(() => { const p = window.__app.selected().placement; return window.__app.toScreen(window.__app.shownPoint(p.tri, p.point)); });
const wBefore = await page.evaluate(() => window.__app.selected().placement.widthCm);
await page.mouse.move(cc.x, cc.y);
await page.keyboard.down('Alt');
for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(60); }
await page.keyboard.up('Alt');
await page.waitForTimeout(500); await idle(page);
const wAfter = await page.evaluate(() => window.__app.selected().placement.widthCm);
log(`Alt + scroll: width ${wBefore} -> ${wAfter} cm; camera did not zoom: ${await page.evaluate(() => window.__app.zoomSettled())}`);
const size = await page.evaluate(() => { const d = window.__app.selected(); return { w: d.placement.widthCm, h: d.result.heightCm }; });
log(`placement lines:\n  ${(await page.evaluate(() => window.__app.placementLines())).join('\n  ')}`);

// Export: open the dialog via the panel button.
async function exportAs(format, opts = {}) {
  await page.click('#p-export');
  await page.waitForTimeout(200);
  await page.click(`.export-sheet [data-format="${format}"]`);
  if (opts.paper) await page.click(`.export-sheet [data-paper="${opts.paper}"]`);
  const mirror = page.locator('.export-sheet [data-mirror]');
  if ((await mirror.isChecked()) !== !!opts.mirror) await mirror.click();
  if (format === 'pdf') { const pl = page.locator('.export-sheet [data-placement]'); if ((await pl.isChecked()) !== (opts.placement ?? true)) await pl.click(); }
  const note = await page.textContent('.export-sheet .ex-pages');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.export-sheet [data-go]')]);
  const path = `${out}/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  return { path, name: dl.suggestedFilename(), note };
}

const pdf = await exportAs('pdf', { paper: 'a4', placement: true });
log(`PDF: ${pdf.name} (${pdf.note})`);
const pdfCheck = py(`
import sys, re, pypdf
r = pypdf.PdfReader(sys.argv[1]); pt = 72/25.4
p0 = r.pages[0]; mb = p0.mediabox
data = p0.get_contents().get_data().decode('latin1')
m = re.search(r'q ([\\d.]+) 0 0 ([\\d.]+) ([\\d.]+) ([\\d.]+) cm /Im0 Do Q', data)
print(len(r.pages), round(float(mb.width)/pt, 1), round(float(mb.height)/pt, 1), round(float(m.group(1))/pt, 2), round(float(m.group(2))/pt, 2))
print('|'.join(t for t in [p0.extract_text().splitlines()[1], r.pages[-1].extract_text().splitlines()[2]]))
`, pdf.path).split('\n');
const [pages, pw_, ph_, iw, ih] = pdfCheck[0].split(' ').map(Number);
log(`PDF check: ${pages} pages, page ${pw_} x ${ph_} mm, stencil image printed at ${iw} x ${ih} mm (on-body size ${(size.w * 10).toFixed(1)} x ${(size.h * 10).toFixed(1)} mm)`);
log(`PDF text: ${pdfCheck[1]}`);

const svg = await exportAs('svg', { mirror: true });
const svgText = fs.readFileSync(svg.path, 'utf8');
log(`SVG: ${svg.name}: ${/<svg[^>]*width="([^"]+)"[^>]*height="([^"]+)"/.exec(svgText).slice(1).join(' x ')}, mirrored ${svgText.includes('matrix(-1 0 0 1')}`);

const png = await exportAs('png');
log(`PNG: ${png.name}: ${py("import sys; from PIL import Image; im=Image.open(sys.argv[1]); print(im.size, [round(v) for v in im.info.get('dpi')])", png.path)} (expected ${Math.round(size.w * 10 / 25.4 * 300)} px wide at 300 dpi)`);

// A big piece tiles over several pages.
await page.evaluate(() => window.__app.set((d) => { d.placement.widthCm = 45; }));
await idle(page);
const big = await exportAs('pdf', { paper: 'letter', placement: false });
log(`45 cm design: ${big.note} -> ${py('import sys, pypdf; print(len(pypdf.PdfReader(sys.argv[1]).pages))', big.path)} pages in the file`);
await page.screenshot({ path: `${out}/se-2-dialog.png` });
await page.click('#p-export'); await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/se-3-dialog-open.png` });
await page.click('.export-sheet [data-close]');
await ctx.close();

// Phone: two fingers on the design resize it.
const phone = await (await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, hasTouch: true })).newPage();
await phone.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(phone);
await phone.evaluate(() => { window.__app.closeBodyPanel(); window.__app.goTo('stomach'); });
await phone.waitForTimeout(1500);
const ps = await phone.locator('#stage').boundingBox();
await phone.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [ps.x + ps.width / 2, ps.y + ps.height * 0.35]);
await phone.waitForFunction(() => !window.__app.busy()); await phone.waitForTimeout(500);
const pc = await phone.evaluate(() => { const p = window.__app.selected().placement; return window.__app.toScreen(window.__app.shownPoint(p.tri, p.point)); });
const w0 = await phone.evaluate(() => window.__app.selected().placement.widthCm);
const cdp = await phone.context().newCDPSession(phone);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pc.x, y: pc.y, id: 0 }] });
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pc.x, y: pc.y, id: 0 }, { x: pc.x + 40, y: pc.y, id: 1 }] });
for (let i = 1; i <= 10; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pc.x - 2 * i, y: pc.y, id: 0 }, { x: pc.x + 40 + 6 * i, y: pc.y + 2 * i, id: 1 }] }); await phone.waitForTimeout(40); }
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await phone.waitForTimeout(800);
const after = await phone.evaluate(() => ({ w: window.__app.selected().placement.widthCm, r: window.__app.selected().placement.rotation * 180 / Math.PI }));
log(`phone two-finger resize: width ${w0} -> ${after.w} cm (fingers spread 40 -> ${Math.hypot(120, 20).toFixed(0)} px), rotation ${after.r.toFixed(0)} degrees`);
await phone.screenshot({ path: `${out}/se-phone.png` });
await browser.close();
