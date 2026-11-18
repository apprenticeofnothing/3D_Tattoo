import pw from 'playwright';
const { chromium } = pw;
const out = process.argv[2], objDir = process.argv[3];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') logs.push(`error: ${m.text()}`); });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.getElementById('status').textContent.includes('Building'), null, { timeout: 30000 });
await page.evaluate(() => localStorage.clear());
await page.setInputFiles('#file', [`${objDir}/body.obj`, `${objDir}/body.mtl`]);
await page.waitForFunction(() => /triangles/.test(document.getElementById('status').textContent) && !/Placeholder/.test(document.getElementById('status').textContent), null, { timeout: 60000 });
await page.waitForTimeout(1200);
logs.push(`loaded: ${await page.textContent('#status')}`);
await page.screenshot({ path: `${out}/orient-1-loaded.png` });
await page.evaluate(() => window.__app.changeOrientation((o) => { o.turn += 1; }));
await page.waitForTimeout(1200);
logs.push(`turned: ${await page.textContent('#status')}`);
await page.screenshot({ path: `${out}/orient-2-turned.png` });
await page.click('#btn-more'); await page.click('.menu-item:has-text("Orientation")'); await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/orient-3-sheet.png` });
await page.click('.menu-item:has-text("Change which axis is up")'); await page.waitForTimeout(1200);
logs.push(`up changed: ${await page.textContent('#status')}`);
await page.screenshot({ path: `${out}/orient-4-up.png` });
// place a design on the loaded scan to make sure mapping works on an imported mesh
// The synthetic file is Z-up (as photogrammetry exports often are): back to upright.
await page.evaluate(() => window.__app.changeOrientation((o) => { o.up = 'z'; o.turn = 0; }));
await page.waitForTimeout(1200);
await page.evaluate(() => window.__app.closeBodyPanel()); // it opens when a scan loads and would offset the view
await page.evaluate(() => window.__app.goTo('chest')); await page.waitForTimeout(900);
const stage = await page.locator('#stage').boundingBox();
logs.push(`placed on scan: ${await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [stage.x + stage.width / 2, stage.y + stage.height / 2])}`);
await page.waitForFunction(() => !window.__app.busy(), null, { timeout: 30000 }); await page.waitForTimeout(500);
logs.push(`readout: ${(await page.textContent('#p-readout')).replace(/\s+/g, ' ').slice(0, 160)}`);
await page.screenshot({ path: `${out}/orient-5-design.png` });
await browser.close();
console.log(logs.join('\n'));
