/**
 * Does closing Mundi stall the browser? Opens Mundi, waits, closes the tab, then times how long a
 * fresh tab takes to get a WebGL frame out (it shares the GPU process, which a shader compile in
 * flight would block). Run against Chrome by default (CHANNEL=msedge for Edge).
 *
 *   node scripts/closefreeze.mjs [waitSeconds=40]      HEADED=1 shows the window; LOW=1 flies down over forest first
 */
import { chromium } from 'playwright-core';
const wait = Number(process.argv[2] ?? 40);
const browser = await chromium.launch({ headless: !process.env.HEADED, channel: process.env.CHANNEL ?? 'chrome', args: ['--use-angle=d3d11', '--enable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const glFrame = async () => {
  const p = await ctx.newPage();
  const t0 = Date.now();
  await p.setContent('<canvas id=c width=64 height=64></canvas>');
  await p.evaluate(() => { const gl = document.getElementById('c').getContext('webgl2'); gl.clearColor(1, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); const b = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return b[0]; });
  const ms = Date.now() - t0;
  await p.close();
  return ms;
};
console.log('baseline GL frame ms:', await glFrame());
const page = await ctx.newPage();
await page.goto(process.env.LOOK_URL ?? 'http://localhost:5291/');
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 120000 });
if (process.env.LOW) await page.evaluate(() => { const m = window.mundi, w = m.world, P = w.grid.centers; let c = 0; for (let i = 0; i < w.grid.count; i++) if (w.water[i] === 0 && w.moisture[i] > w.moisture[c] && w.temperature[i] > 0.5) c = i; m.orbit(Math.atan2(P[c * 3], P[c * 3 + 2]) * 57.2958, Math.asin(P[c * 3 + 1]) * 57.2958, 1.008); });
await page.waitForTimeout(wait * 1000);
console.log('js heap MB', await page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1e6)));
const t0 = Date.now();
await page.close({ runBeforeUnload: false });
const closeMs = Date.now() - t0;
console.log(`closed after ${wait}s: close ${closeMs} ms, then GL frame ${await glFrame()} ms`);
await browser.close();
