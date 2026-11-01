/**
 * Frame time at a few views, with the erosion filter on and off: a rough GPU cost check.
 *
 *   node scripts/fps.mjs
 */
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(process.env.LOOK_URL ?? 'http://localhost:5291/');
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 60000 });
await page.evaluate(() => window.mundi.load('seed=77', { look: 'photo', grid: false, clouds: false }));
const ms = () => page.evaluate(() => new Promise((res) => {
  // Reading a pixel back waits for the GPU, so the time includes the fragment work.
  const gl = window.mundi.view.renderer.getContext(), px = new Uint8Array(4);
  let n = 0; const t0 = performance.now();
  const f = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); if (++n < 120) requestAnimationFrame(f); else res((performance.now() - t0) / n); };
  requestAnimationFrame(f);
}));
for (const alt of [1.012, 1.05, 1.2]) {
  await page.evaluate((a) => window.mundi.orbit(20, 10, a), alt);
  await page.waitForTimeout(1500);
  const r = [];
  for (const e of [0, 1, 0, 1]) { await page.evaluate((v) => { window.mundi.view.cloudU.uErosion.value = v; }, e); await page.waitForTimeout(300); r.push((await ms()).toFixed(2)); }
  console.log(`alt ${alt}: off ${r[0]}/${r[2]} ms, on ${r[1]}/${r[3]} ms`);
}
await browser.close();
