// Arm pose check: designs ride with the skin, taps and drags work on a posed
// arm, measuring works, the pose persists, panel on desktop and phone.
import pw from 'playwright';
const { chromium, devices } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const log = (s) => console.log(s);
const idle = async (page) => { await page.waitForFunction(() => window.__app && !window.__app.busy(), null, { timeout: 30000 }); await page.waitForTimeout(400); };
const ready = (page) => page.waitForFunction(() => window.__app?.surfaceInfo()?.labels === true, null, { timeout: 60000 });

const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') log(`error: ${m.text()}`); });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(page);
await page.evaluate(() => { window.__app.closeBodyPanel(); window.__app.choosePreset('male-athletic'); });
await page.waitForTimeout(800);
const stage = await page.locator('#stage').boundingBox();
const cx = stage.x + stage.width / 2, cy = stage.y + stage.height / 2;

// 1. Place on the relaxed inner forearm.
await page.evaluate(() => window.__app.goTo('forearm-inner-left')); await page.waitForTimeout(900);
log(`placed relaxed: ${await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [cx, cy])}`);
await idle(page);
await page.screenshot({ path: `${out}/ap-1-relaxed.png` });
const restPoint = await page.evaluate(() => window.__app.selected().placement.point);

// 2. Inner arm pose via the panel.
await page.click('#btn-pose'); await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/ap-2-panel.png` });
await page.click('.pp-presets [data-preset="inner"]'); await page.waitForTimeout(1200); await idle(page);
const after = await page.evaluate(() => { const p = window.__app.selected().placement; return { point: p.point, shown: window.__app.shownPoint(p.tri, p.point) }; });
log(`inner pose: anchor rest point unchanged ${JSON.stringify(after.point) === JSON.stringify(restPoint)}, shown moved ${(Math.hypot(...after.shown.map((v, i) => v - restPoint[i])) * 100).toFixed(1)} cm`);
await page.screenshot({ path: `${out}/ap-3-inner.png` });
await page.click('.pose-panel [data-close]'); await page.waitForTimeout(400);
await page.screenshot({ path: `${out}/ap-4-inner-closed.png` });

// 3. Tap to place a second design on the posed arm: it must appear where tapped.
// Hide the first design so it does not catch the drag below.
await page.evaluate(() => window.__app.set((d) => { d.placement.hidden = true; d.decal.mesh.visible = false; }));
await idle(page);
await page.evaluate(() => window.__app.goTo('forearm-inner-left')); await page.waitForTimeout(900);
const tap = { x: cx - 30, y: cy + 10 };
log(`placed posed: ${await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [tap.x, tap.y])}`);
await idle(page);
const scr = await page.evaluate(() => { const p = window.__app.selected().placement; return window.__app.toScreen(window.__app.shownPoint(p.tri, p.point)); });
log(`tap -> design centre on screen: off by ${Math.hypot(scr.x - tap.x, scr.y - tap.y).toFixed(1)} px`);

// 4. Drag it on the posed arm.
const from = scr;
await page.mouse.move(from.x, from.y); await page.mouse.down();
for (let i = 1; i <= 10; i++) { await page.mouse.move(from.x + 4 * i, from.y - 3 * i); await page.waitForTimeout(40); }
await page.mouse.up(); await idle(page);
const scr2 = await page.evaluate(() => { const p = window.__app.selected().placement; return window.__app.toScreen(window.__app.shownPoint(p.tri, p.point)); });
log(`drag by (40,-30) px: design centre moved (${(scr2.x - from.x).toFixed(0)}, ${(scr2.y - from.y).toFixed(0)}) px`);
await page.screenshot({ path: `${out}/ap-5-dragged.png` });

// 5. Measure around the posed forearm.
await page.click('#btn-measure'); await page.click('.seg-btn[data-measure="around"]');
const onArm = await page.evaluate(([x, y]) => {
  for (let r = 0; r <= 120; r += 10) for (let a = 0; a < 12; a++) {
    const px = x + r * Math.cos(a * Math.PI / 6), py = y + r * Math.sin(a * Math.PI / 6);
    if (window.__app.pickSurface(px, py)) return { x: px, y: py };
  }
  return { x, y };
}, [cx, cy]);
await page.mouse.click(onArm.x, onArm.y); await page.waitForTimeout(600);
log(`measure around: ${await page.evaluate(() => window.__app.measureText())}`);
await page.screenshot({ path: `${out}/ap-6-measure.png` });
await page.click('#measure-done');

// 6. Flex pose with the left arm only, then reload.
await page.evaluate(() => window.__app.setPose({ left: { raise: 90, forward: 0, twist: 85, bend: 100, turn: 60 }, right: undefined }, false));
await page.waitForTimeout(600);
await page.evaluate(() => window.__app.goTo('upper-arm-inner-left')); await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/ap-7-flex-left.png` });
await page.reload({ waitUntil: 'networkidle' }); await ready(page); await page.waitForTimeout(1500); await idle(page);
log(`after reload: pose ${JSON.stringify(await page.evaluate(() => window.__app.builderState().pose))}, designs ${await page.evaluate(() => window.__app.placed().length)}`);
await page.screenshot({ path: `${out}/ap-8-reloaded.png` });
await ctx.close();

const phone = await (await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, hasTouch: true })).newPage();
await phone.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(phone);
await phone.evaluate(() => { window.__app.closeBodyPanel(); window.__app.openPosePanel(); });
await phone.waitForTimeout(500);
await phone.click('.pp-presets [data-preset="flex"]'); await phone.waitForTimeout(900);
await phone.screenshot({ path: `${out}/ap-phone.png` });
await browser.close();
