import pw from 'playwright';
const { chromium } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const logs = [];
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') logs.push(`error: ${m.text()}`); });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => !document.getElementById('status').textContent.includes('Building'), null, { timeout: 30000 });
  await page.waitForFunction(() => window.__app?.surfaceInfo?.() !== null, null, { timeout: 60000 });
  await page.evaluate(() => window.__app.closeBodyPanel?.());
await page.evaluate(() => localStorage.clear());
await page.waitForTimeout(800);
const stage = await page.locator('#stage').boundingBox();
const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;
await page.evaluate(() => window.__app.goTo('forearm-outer-left')); await page.waitForTimeout(900);
await page.click('#btn-measure'); await page.waitForTimeout(200);
// Second tap: the farthest of a ring of candidate points (up to 120 px away) that still lands on the body.
const second = await page.evaluate(([x, y]) => {
  let best = null;
  for (let r = 120; r >= 40 && !best; r -= 20) {
    for (let a = 0; a < 16; a++) {
      const px = x + r * Math.cos((a / 16) * 2 * Math.PI), py = y + r * Math.sin((a / 16) * 2 * Math.PI);
      if (window.__app.pickSurface(px, py)) { best = { x: px, y: py }; break; }
    }
  }
  return best;
}, [cx, cy]);
await page.mouse.click(cx, cy); await page.waitForTimeout(300);
await page.mouse.click(second.x, second.y); await page.waitForTimeout(800);
logs.push(`distance: ${await page.evaluate(() => window.__app.measureText())}`);
await page.screenshot({ path: `${out}/m-1-distance.png` });
await page.click('.seg-btn[data-measure="around"]'); await page.waitForTimeout(200);
await page.mouse.click(cx, cy); await page.waitForTimeout(800);
logs.push(`around: ${await page.evaluate(() => window.__app.measureText())}`);
await page.screenshot({ path: `${out}/m-2-around.png` });
await page.click('#measure-done');
// keyboard nudge
logs.push(`placed: ${await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [cx, cy])}`);
await page.waitForFunction(() => !window.__app.busy(), null, { timeout: 30000 }); await page.waitForTimeout(300);
const before = await page.evaluate(() => window.__app.selected().placement.point);
await page.keyboard.press('Shift+ArrowUp'); await page.waitForFunction(() => !window.__app.busy()); await page.waitForTimeout(200);
await page.keyboard.press('Shift+ArrowUp'); await page.waitForFunction(() => !window.__app.busy()); await page.waitForTimeout(200);
await page.keyboard.press(']'); await page.waitForFunction(() => !window.__app.busy()); await page.waitForTimeout(200);
const after = await page.evaluate(() => ({ p: window.__app.selected().placement.point, rot: window.__app.selected().placement.rotation }));
logs.push(`nudge: moved ${(Math.hypot(after.p[0] - before[0], after.p[1] - before[1], after.p[2] - before[2]) * 100).toFixed(2)} cm (expect ~2), rotation ${(after.rot * 180 / Math.PI).toFixed(1)} deg (expect -1)`);
await page.screenshot({ path: `${out}/m-3-nudged.png` });
await browser.close();
console.log(logs.join('\n'));
