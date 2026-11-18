import pw from 'playwright';
const { chromium, devices } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const logs = [];
const waitIdle = async (page) => { await page.waitForFunction(() => !window.__app.busy(), null, { timeout: 30000 }); await page.waitForTimeout(700); };
async function run(name, ctxOpts) {
  const ctx = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(`[${name}] ${m.type()}: ${m.text()}`); else if (/computed|surface/.test(m.text())) logs.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', (e) => logs.push(`[${name}] pageerror: ${e.message}`));
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => !document.getElementById('status').textContent.includes('Building'), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__app?.surfaceInfo?.() !== null, null, { timeout: 60000 });
  await page.evaluate(() => window.__app.closeBodyPanel?.());
  await page.waitForTimeout(1000);
  const vp = page.viewportSize();
  const stage = await page.locator('#stage').boundingBox();
  const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
  // Forearm, stencil
  await page.evaluate(() => window.__app.goTo('forearm-outer-left'));
  await page.waitForTimeout(1000);
  const ok = await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [cx, cy]);
  logs.push(`[${name}] placed on forearm: ${ok}`);
  await waitIdle(page);
  await page.screenshot({ path: `${out}/${name}-forearm-stencil.png` });
  logs.push(`[${name}] readout: ${(await page.textContent('#p-readout')).replace(/\s+/g, ' ')}`);
  await page.click('.seg-btn[data-mode="heatmap"]'); await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}-forearm-heat.png` });
  await page.click('.seg-btn[data-mode="inked"]'); await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}-forearm-inked.png` });
  // Wrap mode band
  await page.click('.seg-btn[data-mode="stencil"]');
  await page.evaluate(() => window.__app.set((d) => { d.placement.wrap = true; d.placement.widthCm = 8; }));
  await waitIdle(page);
  await page.screenshot({ path: `${out}/${name}-forearm-wrap.png` });
  logs.push(`[${name}] wrap readout: ${(await page.textContent('#p-readout')).replace(/\s+/g, ' ')}`);
  // Rotate camera to the back of the arm to see the seam
  await page.evaluate(() => window.__app.goTo('forearm-inner-left'));
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${out}/${name}-forearm-wrap-inner.png` });
  // Shoulder, big design, heatmap
  await page.click('#p-remove');
  await page.evaluate(() => window.__app.goTo('shoulder-left'));
  await page.waitForTimeout(1000);
  const ok2 = await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [cx, cy]);
  logs.push(`[${name}] placed on shoulder: ${ok2}`);
  await waitIdle(page);
  await page.evaluate(() => window.__app.set((d) => { d.placement.widthCm = 16; }));
  await waitIdle(page);
  await page.screenshot({ path: `${out}/${name}-shoulder-stencil.png` });
  await page.click('.seg-btn[data-mode="heatmap"]'); await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/${name}-shoulder-heat.png` });
  logs.push(`[${name}] shoulder readout: ${(await page.textContent('#p-readout')).replace(/\s+/g, ' ')}`);
  await ctx.close();
}
await run('desktop', { viewport: { width: 1280, height: 800 } });
await run('phone', { ...devices['iPhone 15'], deviceScaleFactor: 1 });
await browser.close();
console.log(logs.join('\n'));
