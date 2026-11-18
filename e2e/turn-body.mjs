// Turning the body: drag the floor ring, tilt, double-click reset, view
// buttons, and placing/posing still landing correctly on a turned body.
import pw from 'playwright';
const { chromium, devices } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const log = (s) => console.log(s);
const ready = (page) => page.waitForFunction(() => window.__app?.surfaceInfo()?.labels === true, null, { timeout: 60000 });
async function drag(page, from, to, steps = 20) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await page.waitForTimeout(25); }
  await page.mouse.up(); await page.waitForTimeout(300);
}
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') log(`error: ${m.text()}`); });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(page);
await page.evaluate(() => { window.__app.closeBodyPanel(); window.__app.choosePreset('male-thin'); window.__app.setPose({}, false); window.__app.viewFrom(0); });
await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/tb-1-front.png` });
const yaw = () => page.evaluate(() => window.__app.cameraYaw());
const elev = () => page.evaluate(() => window.__app.cameraElevation());

// 1. Grab the front of the ring and drag right: the body's front swings to the right.
const front = await page.evaluate(() => window.__app.ringScreen(0));
const y0 = await yaw();
await drag(page, front, { x: front.x + 200, y: front.y });
const y1 = await yaw();
log(`front of ring dragged right 200 px: camera yaw ${y0.toFixed(0)} -> ${y1.toFixed(0)} degrees (body turned ${(y0 - y1).toFixed(0)} degrees)`);
await page.screenshot({ path: `${out}/tb-2-turned.png` });

// 2. Grab the back of the ring and drag right: turns the other way.
const back = await page.evaluate(() => window.__app.ringScreen(180));
await page.evaluate(() => window.__app.viewFrom(0)); await page.waitForTimeout(900);
const b0 = await yaw();
const back2 = await page.evaluate(() => window.__app.ringScreen(180));
await drag(page, back2, { x: back2.x + 200, y: back2.y });
log(`back of ring dragged right: yaw change ${((await yaw()) - b0).toFixed(0)} degrees (opposite sign to the front drag)`);

// 3. Tilt: drag the ring down.
await page.evaluate(() => window.__app.viewFrom(0)); await page.waitForTimeout(900);
const e0 = await elev();
const f2 = await page.evaluate(() => window.__app.ringScreen(0));
await drag(page, f2, { x: f2.x, y: f2.y + 120 });
log(`ring dragged down 120 px: camera elevation ${e0.toFixed(0)} -> ${(await elev()).toFixed(0)} degrees (looking down on the body)`);
await page.screenshot({ path: `${out}/tb-3-tilted.png` });
// Tilt is limited.
const f3 = await page.evaluate(() => window.__app.ringScreen(0));
await drag(page, f3, { x: f3.x, y: f3.y + 600 }, 30);
log(`tilt limit: elevation ${(await elev()).toFixed(0)} degrees (max 80)`);

// 4. Double-click the ring: back to the front.
const f4 = await page.evaluate(() => window.__app.ringScreen(0));
await page.mouse.dblclick(f4.x, f4.y); await page.waitForTimeout(900);
log(`double-click: yaw ${(await yaw()).toFixed(0)}, elevation ${(await elev()).toFixed(0)}`);

// 5. View buttons.
for (const [label, want] of [['Back', 180], ['Left', 90], ['Right', -90], ['Front', 0]]) {
  await page.click(`#view-chips >> text=${label}`); await page.waitForTimeout(900);
  log(`${label} button: yaw ${(await yaw()).toFixed(0)} (want ${want})`);
  if (label === 'Back') await page.screenshot({ path: `${out}/tb-4-back.png` });
}

// 6. On a turned body, taps still land exactly and arm handles still track.
await page.click('#view-chips >> text=Left'); await page.waitForTimeout(900);
const st = await page.locator('#stage').boundingBox();
const tap = { x: st.x + st.width / 2, y: st.y + st.height * 0.38 };
log(`placed on turned body: ${await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [tap.x, tap.y])}`);
await page.waitForFunction(() => !window.__app.busy()); await page.waitForTimeout(300);
const c = await page.evaluate(() => { const p = window.__app.selected().placement; return window.__app.toScreen(window.__app.shownPoint(p.tri, p.point)); });
log(`tap -> design centre off by ${Math.hypot(c.x - tap.x, c.y - tap.y).toFixed(1)} px`);
await page.screenshot({ path: `${out}/tb-5-design-side.png` });
await page.click('#btn-pose'); await page.waitForTimeout(400);
const w0 = await page.evaluate(() => window.__app.jointScreen('left', 'wrist'));
const wt = { x: w0.x + 60, y: w0.y - 140 };
await drag(page, w0, wt);
const w1 = await page.evaluate(() => window.__app.jointScreen('left', 'wrist'));
log(`wrist drag on turned body: off by ${Math.hypot(w1.x - wt.x, w1.y - wt.y).toFixed(1)} px`);
await page.screenshot({ path: `${out}/tb-6-pose-side.png` });

const phone = await (await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, hasTouch: true })).newPage();
await phone.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(phone);
await phone.evaluate(() => { window.__app.closeBodyPanel(); window.__app.viewFrom(0); });
await phone.waitForTimeout(900);
const pf = await phone.evaluate(() => window.__app.ringScreen(0));
const py0 = await phone.evaluate(() => window.__app.cameraYaw());
const cdp = await phone.context().newCDPSession(phone);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pf.x, y: pf.y }] });
for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pf.x + 10 * i, y: pf.y }] }); await phone.waitForTimeout(30); }
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await phone.waitForTimeout(400);
log(`phone: finger on the ring turned the body ${(py0 - (await phone.evaluate(() => window.__app.cameraYaw()))).toFixed(0)} degrees`);
await phone.screenshot({ path: `${out}/tb-phone.png` });
await browser.close();
