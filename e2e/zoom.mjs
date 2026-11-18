// Zoom: wheel and trackpad pinch towards the pointer, buttons, keys,
// double-click on the body, two-finger pinch on a phone.
import pw from 'playwright';
const { chromium, devices } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const log = (s) => console.log(s);
const ready = (page) => page.waitForFunction(() => window.__app?.surfaceInfo()?.labels === true, null, { timeout: 60000 });
const settle = (page) => page.waitForFunction(() => window.__app.zoomSettled(), null, { timeout: 10000 }).then(() => page.waitForTimeout(100));
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(page);
await page.evaluate(() => { window.__app.closeBodyPanel(); window.__app.choosePreset('female-thin'); window.__app.setPose({}, false); window.__app.viewFrom(0); });
await page.waitForTimeout(900);

// 1. Mouse wheel over the left forearm: the skin under the pointer stays under it.
const st = await page.locator('#stage').boundingBox();
// A point on the body a little off-centre (upper chest / shoulder area).
const cursor = await page.evaluate(([cx, cy]) => {
  for (let r = 0; r <= 300; r += 10) for (let a = 0; a < 24; a++) {
    const x = cx + 60 + r * Math.cos(a * Math.PI / 12), y = cy - 120 + r * Math.sin(a * Math.PI / 12);
    // Whole pixels: mouse events report integer coordinates.
    if (window.__app.pickAt(Math.round(x), Math.round(y))) return { x: Math.round(x), y: Math.round(y) };
  }
  return null;
}, [st.x + st.width / 2, st.y + st.height / 2]);
log(`zoom point on screen: (${cursor.x.toFixed(0)}, ${cursor.y.toFixed(0)})`);
const skin0 = await page.evaluate(([x, y]) => window.__app.pickAt(x, y), [cursor.x, cursor.y]);
const d0 = await page.evaluate((p) => window.__app.cameraDistanceTo(p), skin0);
await page.mouse.move(cursor.x, cursor.y);
for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -100); await page.waitForTimeout(60); }
await settle(page);
const skin1 = await page.evaluate(([x, y]) => window.__app.pickAt(x, y), [cursor.x, cursor.y]);
const d1 = await page.evaluate((p) => window.__app.cameraDistanceTo(p), skin0);
const drift = Math.hypot(...skin1.map((v, i) => v - skin0[i])) * 1000;
log(`8 wheel notches in: camera ${(d0 * 100).toFixed(0)} -> ${(d1 * 100).toFixed(0)} cm from the skin under the pointer; that skin drifted ${drift.toFixed(1)} mm`);
await page.screenshot({ path: `${out}/zm-1-wheel-in.png` });

// 2. Trackpad pinch (wheel with ctrlKey) keeps zooming smoothly towards the same spot.
await page.keyboard.down('Control');
for (let i = 0; i < 15; i++) { await page.mouse.wheel(0, -6); await page.waitForTimeout(25); }
await page.keyboard.up('Control');
await settle(page);
const d2 = await page.evaluate((p) => window.__app.cameraDistanceTo(p), skin0);
const skin2 = await page.evaluate(([x, y]) => window.__app.pickAt(x, y), [cursor.x, cursor.y]);
log(`trackpad pinch: ${(d1 * 100).toFixed(0)} -> ${(d2 * 100).toFixed(0)} cm, drift ${(Math.hypot(...skin2.map((v, i) => v - skin0[i])) * 1000).toFixed(1)} mm`);

// 3. Closest zoom stops at about 7 cm.
for (let i = 0; i < 30; i++) { await page.mouse.wheel(0, -200); await page.waitForTimeout(20); }
await settle(page);
log(`zoom-in limit: ${((await page.evaluate((p) => window.__app.cameraDistanceTo(p), skin0)) * 100).toFixed(1)} cm from the skin`);
await page.screenshot({ path: `${out}/zm-2-closest.png` });

// 4. Zoom out with the wheel, then the buttons and keys.
for (let i = 0; i < 25; i++) { await page.mouse.wheel(0, 150); await page.waitForTimeout(20); }
await settle(page);
const z0 = await page.evaluate(() => window.__app.zoomDistance());
await page.click('#view-chips [data-zoom="in"]'); await settle(page);
const z1 = await page.evaluate(() => window.__app.zoomDistance());
await page.click('#view-chips [data-zoom="out"]'); await settle(page);
const z2 = await page.evaluate(() => window.__app.zoomDistance());
await page.keyboard.press('+'); await settle(page);
const z3 = await page.evaluate(() => window.__app.zoomDistance());
await page.keyboard.press('0'); await page.waitForTimeout(900);
const z4 = await page.evaluate(() => window.__app.zoomDistance());
log(`buttons and keys: ${z0.toFixed(2)} m, + button ${z1.toFixed(2)}, - button ${z2.toFixed(2)}, + key ${z3.toFixed(2)}, 0 key (whole body) ${z4.toFixed(2)}`);

// 5. Double-click on the body zooms in on that spot.
const before = await page.evaluate(() => window.__app.zoomDistance());
const spot = { x: st.x + st.width / 2, y: st.y + st.height * 0.4 };
await page.mouse.click(spot.x, spot.y); await page.waitForTimeout(120); await page.mouse.click(spot.x, spot.y);
await settle(page);
log(`double-click on the body: distance ${before.toFixed(2)} -> ${(await page.evaluate(() => window.__app.zoomDistance())).toFixed(2)} m`);
await page.screenshot({ path: `${out}/zm-3-dblclick.png` });

// 6. Phone: two-finger pinch.
const phone = await (await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, hasTouch: true })).newPage();
await phone.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(phone);
await phone.evaluate(() => { window.__app.closeBodyPanel(); window.__app.viewFrom(0); });
await phone.waitForTimeout(1200);
const pd0 = await phone.evaluate(() => window.__app.zoomDistance());
const cdp = await phone.context().newCDPSession(phone);
const c = { x: 196, y: 300 };
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: c.x - 20, y: c.y, id: 0 }, { x: c.x + 20, y: c.y, id: 1 }] });
for (let i = 1; i <= 12; i++) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: c.x - 20 - 8 * i, y: c.y, id: 0 }, { x: c.x + 20 + 8 * i, y: c.y, id: 1 }] });
  await phone.waitForTimeout(30);
}
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await phone.waitForTimeout(500);
log(`phone pinch out (fingers apart): distance ${pd0.toFixed(2)} -> ${(await phone.evaluate(() => window.__app.zoomDistance())).toFixed(2)} m`);
await phone.screenshot({ path: `${out}/zm-phone.png` });
await browser.close();
