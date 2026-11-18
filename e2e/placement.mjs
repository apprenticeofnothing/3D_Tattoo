import pw from 'playwright';
import fs from 'node:fs';
const { chromium, devices } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const logs = [];
const log = (s) => logs.push(s);
const idle = async (page) => { await page.waitForFunction(() => !window.__app.busy(), null, { timeout: 30000 }); await page.waitForTimeout(500); };
const sel = (page) => page.evaluate(() => { const d = window.__app.selected(); return d ? { id: d.placement.id, rot: d.placement.rotation, w: d.placement.widthCm, point: d.placement.point, mode: d.placement.mode } : null; });

async function drag(page, from, to, steps = 12) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await page.waitForTimeout(40); }
  await page.mouse.up();
}

async function desktop() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log(`[desktop] error: ${m.text()}`); });
  page.on('pageerror', (e) => log(`[desktop] pageerror: ${e.message}`));
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('status').textContent.includes('Building'), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__app?.surfaceInfo?.() !== null, null, { timeout: 60000 });
  await page.evaluate(() => window.__app.closeBodyPanel?.());
  await page.waitForTimeout(800);
  const stage = await page.locator('#stage').boundingBox();
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;

  // 1. Place on forearm
  await page.evaluate(() => window.__app.goTo('forearm-outer-left'));
  await page.waitForTimeout(900);
  log(`placed: ${await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [cx, cy])}`);
  await idle(page);
  await page.screenshot({ path: `${out}/p3-1-placed.png` });
  const s0 = await sel(page);

  // 2. Drag the design 80 px down
  const c0 = await page.evaluate((p) => window.__app.toScreen(p), s0.point);
  await drag(page, c0, { x: c0.x, y: c0.y + 80 });
  await idle(page);
  const s1 = await sel(page);
  const c1 = await page.evaluate((p) => window.__app.toScreen(p), s1.point);
  log(`drag: anchor screen y ${c0.y.toFixed(0)} -> ${c1.y.toFixed(0)} (expected ~+80), history ${JSON.stringify(await page.evaluate(() => window.__app.history()))}`);
  await page.screenshot({ path: `${out}/p3-2-dragged.png` });

  // 3. Rotate via handle: drag the rotate handle to the right
  let h = await page.evaluate(() => window.__app.handles());
  let hr = await page.evaluate((p) => window.__app.toScreen(p), h.rotate);
  const cc = await page.evaluate((p) => window.__app.toScreen(p), s1.point);
  // move the handle to a point 40 degrees clockwise around the centre
  const r = Math.hypot(hr.x - cc.x, hr.y - cc.y);
  const ang = Math.atan2(hr.y - cc.y, hr.x - cc.x) + (40 * Math.PI) / 180;
  await drag(page, hr, { x: cc.x + r * Math.cos(ang), y: cc.y + r * Math.sin(ang) });
  await idle(page);
  const s2 = await sel(page);
  log(`rotate: ${(s1.rot * 180 / Math.PI).toFixed(1)} -> ${(s2.rot * 180 / Math.PI).toFixed(1)} deg (expected about -40 or +40 depending on view side)`);
  await page.screenshot({ path: `${out}/p3-3-rotated.png` });

  // 4. Scale via handle: drag the scale handle away from the centre
  h = await page.evaluate(() => window.__app.handles());
  const hs = await page.evaluate((p) => window.__app.toScreen(p), h.scale);
  const c2 = await page.evaluate((p) => window.__app.toScreen(p), s2.point);
  const dir = { x: hs.x - c2.x, y: hs.y - c2.y }; const len = Math.hypot(dir.x, dir.y);
  await drag(page, hs, { x: hs.x + dir.x / len * 40, y: hs.y + dir.y / len * 40 });
  await idle(page);
  const s3 = await sel(page);
  log(`scale: width ${s2.w} -> ${s3.w} cm (expected larger)`);
  await page.screenshot({ path: `${out}/p3-4-scaled.png` });

  // 5. Undo twice, redo once
  await page.click('#btn-undo'); await idle(page);
  const u1 = await sel(page);
  await page.click('#btn-undo'); await idle(page);
  const u2 = await sel(page);
  await page.click('#btn-redo'); await idle(page);
  const r1 = await sel(page);
  log(`undo: width ${s3.w} -> ${u1.w} (expect ${s2.w}); rot -> ${(u2.rot * 180 / Math.PI).toFixed(1)} (expect ${(s1.rot * 180 / Math.PI).toFixed(1)}); redo rot ${(r1.rot * 180 / Math.PI).toFixed(1)} (expect ${(s2.rot * 180 / Math.PI).toFixed(1)})`);

  // 6. Second design on the shoulder, compare A/B
  await page.evaluate(() => window.__app.set((d) => { d.placement.option = 'A'; }));
  await page.evaluate(() => window.__app.goTo('shoulder-left'));
  await page.waitForTimeout(900);
  log(`placed 2: ${await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [cx, cy])}`);
  await idle(page);
  await page.evaluate(() => window.__app.set((d) => { d.placement.option = 'B'; d.placement.widthCm = 14; d.placement.mode = 'inked'; }));
  await idle(page);
  log(`chips: ${await page.locator('.chip').count()}, placed ${await page.evaluate(() => window.__app.placed().length)}`);
  await page.screenshot({ path: `${out}/p3-5-two.png` });
  await page.evaluate(() => window.__app.goTo('upper-arm-outer-left'));
  await page.waitForTimeout(900);
  await page.click('#btn-compare');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${out}/p3-6-compare.png` });
  await page.click('#btn-compare');

  // 7. Photo
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('#btn-photo')]);
  const photoPath = `${out}/p3-photo.png`; await dl.saveAs(photoPath);
  log(`photo: ${dl.suggestedFilename()} ${fs.statSync(photoPath).size} bytes`);

  // 8. Save project, then clear, then open it
  await page.click('#btn-more');
  const [dl2] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.click('.menu-item:has-text("Save project")')]);
  const projPath = `${out}/project.json`; await dl2.saveAs(projPath);
  const proj = JSON.parse(fs.readFileSync(projPath, 'utf8'));
  log(`saved project: ${proj.placements.length} placements, ${proj.designs.length} designs, ${(fs.statSync(projPath).size / 1024).toFixed(0)} kB`);
  page.once('dialog', (d) => d.accept());
  await page.click('#btn-more'); await page.click('.menu-item:has-text("Clear all designs")');
  await page.waitForTimeout(300);
  log(`after clear: ${await page.evaluate(() => window.__app.placed().length)}`);
  await page.setInputFiles('#project-file', projPath);
  await page.waitForTimeout(1500); await idle(page);
  log(`after open: ${await page.evaluate(() => window.__app.placed().length)} placed, status "${await page.textContent('#status')}"`);

  // 9. Reload: autosave restores
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('status').textContent.includes('Building'), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__app?.surfaceInfo?.() !== null, null, { timeout: 60000 });
  await page.evaluate(() => window.__app.closeBodyPanel?.());
  await page.waitForTimeout(1500); await idle(page);
  log(`after reload: ${await page.evaluate(() => window.__app.placed().length)} placed, status "${await page.textContent('#status')}"`);
  await page.evaluate(() => window.__app.goTo('shoulder-left')); await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/p3-7-restored.png` });
  await ctx.close();
}

async function phone() {
  const ctx = await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`[phone] pageerror: ${e.message}`));
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('status').textContent.includes('Building'), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__app?.surfaceInfo?.() !== null, null, { timeout: 60000 });
  await page.evaluate(() => window.__app.closeBodyPanel?.());
  await page.waitForTimeout(1500); await idle(page);
  log(`[phone] restored from autosave: ${await page.evaluate(() => window.__app.placed().length)}`);
  await page.evaluate(() => window.__app.goTo('forearm-outer-left')); await page.waitForTimeout(900);
  await page.screenshot({ path: `${out}/p3-phone-1.png` });
  await page.evaluate(() => window.__app.setCompare(true)); await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/p3-phone-compare.png` });
  await page.evaluate(() => window.__app.setCompare(false));
  await page.tap('#btn-add'); await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/p3-phone-add.png` });
  await ctx.close();
}

await desktop();
await phone();
await browser.close();
console.log(logs.join('\n'));
