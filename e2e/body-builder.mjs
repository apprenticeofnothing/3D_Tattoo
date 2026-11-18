// Body builder check: first-run panel, presets, sliders, designs carried
// across body changes, region framing, persistence.
import pw from 'playwright';
const { chromium, devices } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const logs = [];
const log = (s) => { logs.push(s); console.log(s); };
const idle = async (page) => { await page.waitForFunction(() => window.__app && !window.__app.busy(), null, { timeout: 30000 }); await page.waitForTimeout(500); };
const ready = (page) => page.waitForFunction(() => window.__app?.surfaceInfo()?.labels === true, null, { timeout: 60000 });

async function desktop() {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') log(`[desktop] error: ${m.text()}`); });
  page.on('pageerror', (e) => log(`[desktop] pageerror: ${e.message}`));
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await ready(page);
  await page.waitForTimeout(1500);
  log(`first run: panel open ${await page.locator('.body-panel:not(.hidden)').count() === 1}, status "${await page.textContent('#status')}", surface ${JSON.stringify(await page.evaluate(() => window.__app.surfaceInfo()))}`);
  await page.screenshot({ path: `${out}/bb-1-first-run.png` });
  await page.click('.body-panel [data-close]');
  for (const id of ['female-thin', 'female-athletic', 'female-overweight', 'male-thin', 'male-athletic', 'male-overweight']) {
    await page.evaluate((id) => window.__app.choosePreset(id), id);
    await page.evaluate(() => document.getElementById('btn-more') && null);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${out}/bb-preset-${id}.png` });
    log(`${id}: ${await page.textContent('#status')}`);
  }
  // Place on the forearm of male-athletic, then change body: the design must stay on the same skin spot.
  await page.evaluate(() => window.__app.choosePreset('male-athletic')); await page.waitForTimeout(700);
  await page.evaluate(() => window.__app.goTo('forearm-outer-left')); await page.waitForTimeout(900);
  const stage = await page.locator('#stage').boundingBox();
  log(`placed: ${await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [stage.x + stage.width / 2, stage.y + stage.height / 2])}`);
  await idle(page);
  await page.screenshot({ path: `${out}/bb-2-design-athletic.png` });
  const before = await page.evaluate(() => { const p = window.__app.selected().placement; return { tri: p.tri, point: p.point, bary: p.bary }; });
  await page.evaluate(() => window.__app.choosePreset('male-overweight')); await idle(page);
  const after = await page.evaluate(() => { const p = window.__app.selected().placement; return { tri: p.tri, point: p.point, bary: p.bary }; });
  log(`carry over: tri ${before.tri} -> ${after.tri}, bary ${before.bary.map((v) => v.toFixed(3))} -> ${after.bary.map((v) => v.toFixed(3))}, moved ${(Math.hypot(...after.point.map((v, i) => v - before.point[i])) * 100).toFixed(1)} cm`);
  await page.screenshot({ path: `${out}/bb-3-design-overweight.png` });
  // Live slider: forearm size +100%
  await page.evaluate(() => window.__app.openBodyPanel());
  await page.click('.bp-group:nth-of-type(3) summary'); // Arms
  await page.waitForTimeout(300);
  await page.evaluate(() => { const s = window.__app.builderState(); window.__app.setBuilderParams({ ...s.params, details: { ...s.params.details, forearmSize: 1 } }, true); });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${out}/bb-4-live.png` });
  await page.waitForTimeout(900); await idle(page);
  log(`after slider: status "${await page.textContent('#status')}", readout "${(await page.textContent('#p-readout')).replace(/\s+/g, ' ').slice(0, 120)}"`);
  await page.screenshot({ path: `${out}/bb-5-slider-settled.png` });
  await page.click('.body-panel [data-close]');
  // Region framing on the A-pose
  for (const id of ['upper-arm-inner-left', 'shoulder-right', 'calf-left', 'upper-back', 'ribs-left', 'thigh-outer-right']) {
    await page.evaluate((id) => window.__app.goTo(id), id); await page.waitForTimeout(900);
    await page.screenshot({ path: `${out}/bb-region-${id}.png` });
  }
  // Persistence
  await page.reload({ waitUntil: 'networkidle' });
  await ready(page); await page.waitForTimeout(1500); await idle(page);
  log(`after reload: panel open ${await page.locator('.body-panel:not(.hidden)').count()}, body "${await page.textContent('#status')}", designs ${await page.evaluate(() => window.__app.placed().length)}, forearmSize ${await page.evaluate(() => window.__app.builderState().params.details.forearmSize)}`);
  // Save project, switch body, open project: body and design come back
  await page.click('#btn-more');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('.menu-item:has-text("Save project")')]);
  const proj = `${out}/bb-project.json`; await dl.saveAs(proj);
  await page.evaluate(() => window.__app.choosePreset('female-thin')); await idle(page);
  await page.setInputFiles('#project-file', proj);
  await page.waitForTimeout(2000); await idle(page);
  log(`after open: body "${await page.textContent('#status')}", designs ${await page.evaluate(() => window.__app.placed().length)}, preset ${await page.evaluate(() => window.__app.builderState().presetId)}`);
  await ctx.close();
}

async function phone() {
  const ctx = await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => log(`[phone] pageerror: ${e.message}`));
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await ready(page); await page.waitForTimeout(1500);
  await page.screenshot({ path: `${out}/bb-phone-1.png` });
  await page.evaluate(() => document.querySelector('.bp-body').scrollTop = 520);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/bb-phone-2.png` });
  await ctx.close();
}

await desktop();
await phone();
await browser.close();
