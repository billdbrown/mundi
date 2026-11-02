/**
 * Steady frame time at five heights on a fresh page, after the background shader compile:
 *   node scripts/perf.mjs [dpr=2] [full|nopatch|noshadow|noero|notrees|noclouds]
 */
import { chromium } from 'playwright-core';
const [dpr, mode] = [Number(process.argv[2] ?? 2), process.argv[3] ?? 'full'];
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })).newPage();
await page.goto('http://localhost:5291/#seed=77', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.waitForFunction(() => window.mundi.view.otherLookReady, null, { timeout: 400000, polling: 500 });
await page.evaluate((m) => {
  const v = window.mundi.view;
  if (m === 'nopatch') { const p = v.dunePatch; p.update = () => { p.mesh.visible = false; }; }
  if (m === 'noshadow') { const s = v.terrainShadow; s.update = () => { s.u.uShOn.value = 0; }; }
  if (m === 'noero') v.cloudU.uErosion.value = 0;
  if (m === 'notrees') v.setOptions({ trees: false });
  if (m === 'noclouds') v.setOptions({ clouds: false });
}, mode);
const measure = () => page.evaluate(() => new Promise((res) => {
  const gl = window.mundi.view.renderer.getContext(), px = new Uint8Array(4);
  let n = 0; const t0 = performance.now();
  const f = () => { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); if (++n < 120) requestAnimationFrame(f); else res((performance.now() - t0) / n); };
  requestAnimationFrame(f);
}));
const row = [];
for (const alt of [1.008, 1.03, 1.1, 1.4, 2.5]) {
  await page.evaluate((a) => window.mundi.orbit(-90.6, 4.9, a), alt);
  await page.waitForTimeout(6000);
  const a = await measure(), b = await measure();
  row.push(`${alt}: ${Math.min(a, b).toFixed(1)}`);
}
console.log(`dpr ${dpr} ${mode.padEnd(9)} ` + row.join('  '));
await browser.close();
