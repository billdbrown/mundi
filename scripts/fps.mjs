/**
 * Frame time at a few heights, with features switched off one at a time: where the time goes.
 * Each frame reads a pixel back, which waits for the GPU, so times include fragment work.
 * Also reports main-thread time spent in the view's frame() (JavaScript, not GPU).
 *
 *   node scripts/fps.mjs            (W, H, DPR env to change the screen; default 1440x900 @2)
 */
import { chromium } from 'playwright-core';
const W = Number(process.env.W ?? 1440), H = Number(process.env.H ?? 900), DPR = Number(process.env.DPR ?? 2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await (await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DPR })).newPage();
await page.goto(process.env.LOOK_URL ?? 'http://localhost:5291/');
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 60000 });
await page.evaluate(() => window.mundi.load('seed=77', { look: 'photo', grid: false, clouds: true }));
await page.waitForTimeout(10000);   // let clouds, weather and history workers finish
await page.evaluate(() => {
  const v = window.mundi.view, f = v.frame.bind(v);
  window.__js = 0; v.frame = () => { const t = performance.now(); f(); window.__js += performance.now() - t; };
});
const measure = () => page.evaluate(() => new Promise((res) => {
  const gl = window.mundi.view.renderer.getContext(), px = new Uint8Array(4);
  let n = 0; window.__js = 0; const t0 = performance.now();
  const f = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); if (++n < 90) requestAnimationFrame(f); else res([(performance.now() - t0) / n, window.__js / n]); };
  requestAnimationFrame(f);
}));
const configs = {
  full: () => {},
  'no erosion': (v) => { v.cloudU.uErosion.value = 0; },
  'no trees': (v) => { v.setOptions({ trees: false }); },
  'no clouds': (v) => { v.setOptions({ clouds: false }); },
  'dpr 1': (v) => { v.renderer.setPixelRatio(1); window.dispatchEvent(new Event('resize')); },
  'full again': () => {},
};
const reset = (v) => { v.cloudU.uErosion.value = 1; v.setOptions({ trees: true, clouds: true }); v.renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); window.dispatchEvent(new Event('resize')); };
for (const alt of [1.012, 1.04, 1.2, 2.5]) {
  await page.evaluate((a) => window.mundi.orbit(-90.6, 4.9, a), alt);
  await page.waitForTimeout(2500);
  const row = [];
  for (const [name, fn] of Object.entries(configs)) {
    await page.evaluate(`(${reset.toString()})(window.mundi.view)`);
    await page.evaluate(`(${fn.toString()})(window.mundi.view)`);
    await page.waitForTimeout(4000);
    const [ms, js] = await measure();
    row.push(`${name} ${ms.toFixed(1)}${name === 'full' ? ` (js ${js.toFixed(1)})` : ''}`);
  }
  console.log(`alt ${alt}: ` + row.join(' | '));
}
await browser.close();
