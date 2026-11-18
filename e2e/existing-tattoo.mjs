// Existing tattoos from photos, checked against a known truth.
//
// The "photos" are renders of the app's own body with a bold test tattoo
// (test-assets/bold-tattoo.svg) placed at a known spot and size, taken the
// way the capture tips recommend: arm held out from the body, camera square
// to the limb. Each scenario imports a photo through the editor, as a
// person would, and reports how far the result is from the truth:
//   A  close-up of the forearm, everything automatic: size and orientation
//   B  wide side shot + tap on the tattoo + close-up: where it is
//   C  a typed tape-measure width: exact size
//   D  phone: the editor and placing work with touch-sized layout
//
// Size error is from the spread of the ink around its centre (independent
// of rotation and of how dark the ink came out); orientation from the angle
// between "towards the red dot" and the forearm, on the skin in 3D.
import pw from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2];
const svg = path.resolve('test-assets/bold-tattoo.svg');
const ring = path.resolve('test-assets/ring-tattoo.svg'); // its width does not depend on how it is turned
const ARM_OUT = { left: { raise: 80, forward: 20, twist: 0, bend: 5, turn: 0 } };
const browser = await pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const log = (s) => console.log(s);
const idle = (page) => page.waitForFunction(() => !window.__app.busy(), null, { timeout: 60000 });
const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => Math.hypot(...a);
const angle = (a, b) => (Math.acos(Math.max(-1, Math.min(1, a.reduce((s, v, i) => s + v * b[i], 0) / (norm(a) * norm(b))))) * 180) / Math.PI;

async function start(ctxOpts) {
  const page = await (await browser.newContext(ctxOpts)).newPage();
  page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__app?.surfaceInfo()?.labels === true, null, { timeout: 60000 });
  return page;
}

/** Place the bold tattoo 7 cm wide on a region, inked; return its truth. */
async function plantTattoo(page, region, pose, offset = { x: 0, y: 0 }, file = svg) {
  await page.evaluate((p) => { window.__app.closeBodyPanel(); window.__app.choosePreset('male-athletic'); window.__app.setPose(p, false); }, pose);
  await page.waitForTimeout(900);
  await page.evaluate((r) => window.__app.goTo(r), region);
  await page.waitForTimeout(1300);
  await page.setInputFiles('#design-file', file);
  await page.waitForTimeout(400);
  const st = await page.locator('#stage').boundingBox();
  await page.mouse.click(st.x + st.width / 2 + offset.x, st.y + st.height / 2 + offset.y);
  await page.waitForFunction(() => window.__app.selected() && !window.__app.busy());
  await page.evaluate(() => window.__app.set((d) => { d.placement.widthCm = 7; d.placement.mode = 'inked'; }));
  await idle(page); await page.waitForTimeout(300);
  return page.evaluate(() => window.__app.inkStats());
}

async function photo(page, file) {
  const url = await page.evaluate(() => window.__app.photoDataUrl());
  fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
  return url;
}

/** View direction square to the forearm (the current view with its component along the posed forearm removed). */
async function squareToForearm(page) {
  return page.evaluate(() => {
    const d = window.__app.cameraDir();
    const e = window.__app.posedJoint('left', 'elbow'), w = window.__app.posedJoint('left', 'wrist');
    const a = [w[0] - e[0], w[1] - e[1], w[2] - e[2]], al = Math.hypot(...a);
    const k = (d[0] * a[0] + d[1] * a[1] + d[2] * a[2]) / (al * al);
    const p = [d[0] - k * a[0], d[1] - k * a[1], d[2] - k * a[2]], pl = Math.hypot(...p);
    return p.map((v) => v / pl);
  });
}

/** Close-up: `dist` metres from the tattoo, square to the forearm (as a careful phone photo is). */
async function closeUp(page, truth, file, dist = 0.25, dir) {
  dir ??= await squareToForearm(page);
  const c = truth.centre;
  await page.evaluate(([pos, tgt]) => window.__app.lookAt(pos, tgt), [[c[0] - dir[0] * dist, c[1] - dir[1] * dist, c[2] - dir[2] * dist], c]);
  await page.waitForTimeout(900);
  return photo(page, file);
}

async function hideTruth(page, id) {
  await page.evaluate((i) => { const d = window.__app.placed().find((x) => x.placement.id === i); d.placement.hidden = true; d.decal.mesh.visible = false; }, id);
}

async function waitAnalysis(page) {
  await page.waitForTimeout(300);
  await page.waitForFunction(() => !/Looking for|Finding where|Reading/.test(document.querySelector('.ex-status')?.textContent ?? ''), null, { timeout: 120000 });
}

async function placeAndCompare(page, truth, label, width) {
  if (width) await page.fill('.ex-editor [data-width]', String(width));
  await page.click('.ex-editor [data-go]');
  await page.waitForFunction(() => document.querySelector('.ex-editor').classList.contains('hidden'), null, { timeout: 30000 });
  await idle(page); await page.waitForTimeout(300);
  const got = await page.evaluate(() => window.__app.inkStats());
  const scale = got.spread / truth.spread - 1;
  const where = norm(sub(got.centre, truth.centre)) * 100;
  // Orientation relative to the forearm: the angle between "towards the red dot" and the
  // elbow-to-wrist direction, compared (independent of where around the arm it sits).
  const arm = await page.evaluate(() => { const e = window.__app.posedJoint('left', 'elbow'), w = window.__app.posedJoint('left', 'wrist'); return [w[0] - e[0], w[1] - e[1], w[2] - e[2]]; });
  const turn = got.red && truth.red ? Math.abs(angle(sub(got.red, got.centre), arm) - angle(sub(truth.red, truth.centre), arm)) : NaN;
  log(`${label}: ${got.widthCm} x ${got.heightCm.toFixed(1)} cm image; ink size ${(scale * 100).toFixed(1)}% off; centre ${where.toFixed(1)} cm from the truth; orientation along the arm ${turn.toFixed(0)} deg off`);
  return { got, scale, where, turn };
}

// ---- A: close-up of the forearm, held out from the body --------------------
{
  const page = await start({ viewport: { width: 1280, height: 800 } });
  const truth = await plantTattoo(page, 'forearm-outer-left', ARM_OUT);
  await page.evaluate(() => window.__app.deselect());
  const url = await closeUp(page, truth, `${out}/et-A-photo.jpg`);
  await hideTruth(page, truth.id);
  // A real photo carries its lens in EXIF; a render of the view passes it directly.
  const fA = await page.evaluate(() => window.__app.cameraFocalPx());
  await page.evaluate(([u, f]) => window.__app.openExistingPhoto(u, 'forearm.jpg', f), [url, fA]);
  await waitAnalysis(page);
  log(`A editor: "${await page.textContent('.ex-status')}" hint "${await page.textContent('.ex-hint')}"`);
  await page.screenshot({ path: `${out}/et-A-editor.png` });
  await placeAndCompare(page, truth, 'A close-up, automatic');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/et-A-placed.png` });
  await page.context().close();
}

// ---- B: wide shot to find where, then a close-up for the design -------------
// Arms relaxed, the ring on the outer forearm, photographed from the
// person's left at a normal height; tap it; add a close-up; type 7 cm.
{
  const page = await start({ viewport: { width: 900, height: 1300 } });
  const truth = await plantTattoo(page, 'forearm-outer-left', {}, { x: 0, y: 40 }, ring);
  await page.evaluate(() => window.__app.deselect());
  await page.evaluate(() => window.__app.viewFrom(90));
  await page.waitForTimeout(1500);
  const tp = await page.evaluate((p) => window.__app.toScreen(p), truth.centre);
  const stb = await page.locator('#stage').boundingBox();
  const wide = await photo(page, `${out}/et-B-wide.jpg`);
  const side = await page.evaluate(() => window.__app.cameraDir());
  await closeUp(page, truth, `${out}/et-B-close.jpg`, 0.4, side);
  // Where a person would drag the handles: the forearm's real outline around the tattoo.
  const want = await page.evaluate((id) => window.__app.trueForearmGuides(id, 'left', 230), truth.id);
  await hideTruth(page, truth.id);
  const t0 = Date.now();
  await page.evaluate((u) => window.__app.openExistingPhoto(u, 'wide.jpg'), wide);
  await waitAnalysis(page);
  log(`B wide photo analysed in ${((Date.now() - t0) / 1000).toFixed(1)} s: "${await page.textContent('.ex-hint')}"`);
  const c = await page.evaluate((p) => window.__app.existingImport.photoToClient(p), { x: tp.x - stb.x, y: tp.y - stb.y });
  await page.mouse.click(c.x, c.y);
  await waitAnalysis(page);
  log(`B after tapping the tattoo: "${await page.textContent('.ex-hint')}" region ${await page.inputValue('[data-region]')}`);
  await page.screenshot({ path: `${out}/et-B-editor-wide.png` });
  const fB = await page.evaluate(() => window.__app.cameraFocalPx());
  await page.evaluate(async ([u, f]) => { const b = await (await fetch(u)).blob(); await window.__app.existingImport.useCloseUp(b, f); }, ['data:image/jpeg;base64,' + fs.readFileSync(`${out}/et-B-close.jpg`).toString('base64'), fB]);
  await page.waitForTimeout(1500);
  log(`B close-up added: "${await page.textContent('.ex-status')}"`);
  // The arm lies in front of the body here, so the automatic guides follow the wrong outline:
  // drag the four handles onto the forearm's edges, as a person would.
  for (const k of ['p0', 'p1', 'q0', 'q1']) {
    const from = await page.evaluate((key) => window.__app.existingImport.photoToClient(window.__app.existingImport.handlePositions()[key]), k);
    const to = await page.evaluate((p) => window.__app.existingImport.photoToClient(p), want[k]);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let i = 1; i <= 8; i++) { await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8); await page.waitForTimeout(20); }
    await page.mouse.up();
  }
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/et-B-editor-close.png` });
  const resB = await placeAndCompare(page, truth, 'B wide + tap + close-up, 7 cm measured', 7);
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/et-B-placed.png` });
  // Side by side from the close-up's camera: the result, then the truth.
  await page.evaluate(() => window.__app.deselect());
  await closeUp(page, { centre: resB.got.anchor }, `${out}/et-B-result-view.jpg`, 0.4, side);
  await page.evaluate((i) => { const d = window.__app.placed().find((x) => x.placement.id === i); d.placement.hidden = false; d.decal.mesh.visible = true; }, truth.id);
  await page.evaluate((i) => { const d = window.__app.placed().find((x) => x.placement.id === i); d.placement.hidden = true; d.decal.mesh.visible = false; }, resB.got.id);
  await closeUp(page, truth, `${out}/et-B-truth-view.jpg`, 0.4, side);
  await page.context().close();
}

// ---- C: typed width (tape measure) of a ring 7 cm across --------------------
{
  const page = await start({ viewport: { width: 1280, height: 800 } });
  const truth = await plantTattoo(page, 'forearm-outer-left', ARM_OUT, { x: 0, y: 0 }, ring);
  await page.evaluate(() => window.__app.deselect());
  const url = await closeUp(page, truth, `${out}/et-C-photo.jpg`);
  await hideTruth(page, truth.id);
  await page.evaluate(([u, f]) => window.__app.openExistingPhoto(u, 'forearm.jpg', f), [url, await page.evaluate(() => window.__app.cameraFocalPx())]);
  await waitAnalysis(page);
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/et-C-editor.png` });
  const r = await placeAndCompare(page, truth, 'C ring measured 7 cm across', 7);
  log(`C image width on the body: ${r.got.widthCm} cm (ink 7 cm plus the margin around it)`);
  await page.context().close();
}

// ---- D: phone ---------------------------------------------------------------
{
  const page = await start({ ...pw.devices['iPhone 15'], deviceScaleFactor: 1 });
  const url = 'data:image/jpeg;base64,' + fs.readFileSync(`${out}/et-A-photo.jpg`).toString('base64');
  await page.evaluate((u) => window.__app.openExistingPhoto(u, 'forearm.jpg'), url);
  await waitAnalysis(page);
  await page.screenshot({ path: `${out}/et-D-phone-editor.png` });
  await page.locator('.ex-side').evaluate((e) => e.scrollTo(0, 9999));
  await page.tap('.ex-editor [data-go]');
  await page.waitForFunction(() => document.querySelector('.ex-editor').classList.contains('hidden'), null, { timeout: 30000 });
  await idle(page); await page.waitForTimeout(1200);
  log(`D phone: placed ${await page.evaluate(() => window.__app.placed().filter((d) => d.placement.existing).length)} existing tattoo(s); status "${await page.textContent('#status')}"`);
  await page.screenshot({ path: `${out}/et-D-phone-placed.png` });
}
await browser.close();
