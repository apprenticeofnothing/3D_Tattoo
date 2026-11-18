// Joint dragging: grab a wrist or elbow ring with the mouse and move the arm.
import pw from 'playwright';
const { chromium, devices } = pw;
const out = process.argv[2];
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const log = (s) => console.log(s);
const ready = (page) => page.waitForFunction(() => window.__app?.surfaceInfo()?.labels === true, null, { timeout: 60000 });
async function drag(page, from, to, steps = 20) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  for (let i = 1; i <= steps; i++) { await page.mouse.move(from.x + (to.x - from.x) * i / steps, from.y + (to.y - from.y) * i / steps); await page.waitForTimeout(30); }
  await page.mouse.up(); await page.waitForTimeout(300);
}
const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
page.on('pageerror', (e) => log(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') log(`error: ${m.text()}`); });
await page.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(page);
await page.evaluate(() => { window.__app.closeBodyPanel(); window.__app.choosePreset('female-athletic'); window.__app.setPose({}, false); });
await page.waitForTimeout(600);
// A design on the inner forearm, to see it ride along.
await page.evaluate(() => window.__app.goTo('forearm-inner-left')); await page.waitForTimeout(900);
const st = await page.locator('#stage').boundingBox();
await page.evaluate(([x, y]) => window.__app.placeTestAt(x, y), [st.x + st.width / 2, st.y + st.height / 2]);
await page.waitForFunction(() => !window.__app.busy()); await page.waitForTimeout(300);
await page.click('#btn-pose'); await page.waitForTimeout(300);
await page.evaluate(() => { const v = window.__app; }); // panel open: handles visible
await page.click('.pp-side [data-side="left"]');
// Reset the camera to the whole body.
await page.evaluate(() => document.querySelector('#btn-more') && null);
await page.evaluate(() => { const a = window.__app; a.goTo('chest'); }); await page.waitForTimeout(900);
await page.screenshot({ path: `${out}/jd-1-handles.png` });

// 1. Drag the left wrist up and across.
const w0 = await page.evaluate(() => window.__app.jointScreen('left', 'wrist'));
const target = { x: w0.x - 120, y: w0.y - 220 };
await drag(page, w0, target);
const w1 = await page.evaluate(() => window.__app.jointScreen('left', 'wrist'));
log(`wrist drag: pointer ended at (${target.x.toFixed(0)}, ${target.y.toFixed(0)}), wrist at (${w1.x.toFixed(0)}, ${w1.y.toFixed(0)}), off by ${Math.hypot(w1.x - target.x, w1.y - target.y).toFixed(1)} px`);
log(`left pose: ${JSON.stringify(await page.evaluate(() => window.__app.builderState().pose.left), (k, v) => typeof v === 'number' ? Math.round(v) : v)}, right pose: ${JSON.stringify(await page.evaluate(() => window.__app.builderState().pose.right ?? null))}`);
await page.screenshot({ path: `${out}/jd-2-wrist.png` });

// 2. Swing the left elbow up around the shoulder (a reachable path: same distance from the shoulder on screen).
const e0 = await page.evaluate(() => window.__app.jointScreen('left', 'elbow'));
const sh = await page.evaluate(() => window.__app.toScreen(window.__app.posedJoint('left', 'shoulder')));
const R = Math.hypot(e0.x - sh.x, e0.y - sh.y), a0 = Math.atan2(e0.y - sh.y, e0.x - sh.x);
const et = { x: sh.x + R * Math.cos(a0 - 0.6), y: sh.y + R * Math.sin(a0 - 0.6) };
await page.mouse.move(e0.x, e0.y); await page.mouse.down();
for (let i = 1; i <= 20; i++) { const a = a0 - 0.6 * i / 20; await page.mouse.move(sh.x + R * Math.cos(a), sh.y + R * Math.sin(a)); await page.waitForTimeout(30); }
await page.mouse.up(); await page.waitForTimeout(300);
const e1 = await page.evaluate(() => window.__app.jointScreen('left', 'elbow'));
log(`elbow swing: elbow off the pointer by ${Math.hypot(e1.x - et.x, e1.y - et.y).toFixed(1)} px`);
// Pulling beyond the upper arm's length stops at its reach, in the pointer's direction.
const e2 = await page.evaluate(() => window.__app.jointScreen('left', 'elbow'));
const beyond = { x: sh.x + 2 * (e2.x - sh.x), y: sh.y + 2 * (e2.y - sh.y) };
await drag(page, e2, beyond);
const e3 = await page.evaluate(() => window.__app.jointScreen('left', 'elbow'));
const angErr = Math.abs(Math.atan2(e3.y - sh.y, e3.x - sh.x) - Math.atan2(beyond.y - sh.y, beyond.x - sh.x)) * 180 / Math.PI;
log(`elbow pulled beyond reach: stays ${Math.hypot(e3.x - sh.x, e3.y - sh.y).toFixed(0)} px from the shoulder (arm length ${R.toFixed(0)} px), direction off by ${angErr.toFixed(1)} degrees`);
await page.screenshot({ path: `${out}/jd-3-elbow.png` });

// 3. Both arms mirrored: drag the right wrist, the left follows.
await page.click('.pp-side [data-side="both"]');
const r0 = await page.evaluate(() => window.__app.jointScreen('right', 'wrist'));
await drag(page, r0, { x: r0.x + 60, y: r0.y - 180 });
const pose = await page.evaluate(() => window.__app.builderState().pose);
log(`both arms: left = right ? ${JSON.stringify(pose.left) === JSON.stringify(pose.right)}`);
await page.screenshot({ path: `${out}/jd-4-both.png` });

// 4. Out-of-reach pull: drag far away; arm straight, within limits.
const r1 = await page.evaluate(() => window.__app.jointScreen('right', 'wrist'));
await drag(page, r1, { x: 60, y: 120 });
const p2 = await page.evaluate(() => window.__app.builderState().pose.right);
log(`far pull: bend ${p2.bend.toFixed(0)}°, raise ${p2.raise.toFixed(0)}°, forward ${p2.forward.toFixed(0)}°, twist ${p2.twist.toFixed(0)}°`);
await page.screenshot({ path: `${out}/jd-5-far.png` });
const designOk = await page.evaluate(() => window.__app.placed().length === 1);
log(`design still placed: ${designOk}`);

const phone = await (await browser.newContext({ ...devices['iPhone 15'], deviceScaleFactor: 1, hasTouch: true })).newPage();
await phone.goto('http://localhost:4173/', { waitUntil: 'networkidle' });
await ready(phone);
await phone.evaluate(() => { window.__app.closeBodyPanel(); window.__app.openPosePanel(); });
// Let the camera finish framing the body above the panel: the flight starts
// on the next frame, so wait a moment, then until the ring stops moving.
await phone.waitForTimeout(800);
let pw0 = await phone.evaluate(() => window.__app.jointScreen('left', 'wrist'));
for (let i = 0; i < 40; i++) {
  await phone.waitForTimeout(100);
  const p = await phone.evaluate(() => window.__app.jointScreen('left', 'wrist'));
  const still = Math.hypot(p.x - pw0.x, p.y - pw0.y) < 0.5;
  pw0 = p;
  if (still) break;
}
// Touch drag via CDP touch events.
const cdp = await phone.context().newCDPSession(phone);
await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pw0.x, y: pw0.y }] });
for (let i = 1; i <= 12; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: pw0.x - 3 * i, y: pw0.y - 6 * i }] }); await phone.waitForTimeout(30); }
await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
await phone.waitForTimeout(400);
log(`phone touch drag: left pose ${JSON.stringify(await phone.evaluate(() => window.__app.builderState().pose?.left ?? null), (k, v) => typeof v === 'number' ? Math.round(v) : v)}`);
await phone.screenshot({ path: `${out}/jd-phone.png` });
await browser.close();
