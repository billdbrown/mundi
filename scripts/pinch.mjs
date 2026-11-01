/**
 * Simulated two-finger pinches on a phone-sized page; prints the camera distance (drawn,
 * untilted) after each. Pinching out from the ground must reach orbit again.
 *
 *   node scripts/pinch.mjs
 */
import { chromium } from 'playwright-core';
const url = process.env.LOOK_URL ?? 'http://localhost:5291/';
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(url);
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const cdp = await ctx.newCDPSession(page);
const dist = () => page.evaluate(() => { const v = window.mundi.view; return [v.camera.position.length().toFixed(4), v.virtualPos?.length().toFixed(4)]; });
async function pinch(from, to, steps = 12) {
  const cx = 195, cy = 400;
  const pts = (s) => [{ x: cx - s, y: cy, id: 1 }, { x: cx + s, y: cy, id: 2 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + (to - from) * i / steps) });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(400);
}
console.log('start', await dist());
for (let i = 0; i < 6; i++) { await pinch(40, 150); console.log('in', await dist()); }
for (let i = 0; i < 3; i++) { await pinch(80, 60); console.log('small out', await dist()); }
for (let i = 0; i < 8; i++) { await pinch(150, 40); console.log('out', await dist()); }
// A pinch that starts over the interface must not zoom the page.
console.log('page scale', await page.evaluate(() => visualViewport.scale));
await browser.close();
