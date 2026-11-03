/**
 * The whole planet's valleys (trial V, valleys.ts): how long they take, and off/on shots over the
 * biggest mountain range at a few heights.
 *
 *   node scripts/valleys.mjs <outdir> [seed=77] [alts=1.25,1.12,1.06]
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', alts = '1.25,1.12,1.06'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.goto(`http://localhost:5291/#seed=${seed}&valleys=1`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { const m = window.mundi; m.capture(true); await m.view.whenReady(); });
const t0 = Date.now();
await page.waitForFunction(() => window.mundi.view.terrainShadow.valleys.ready, null, { timeout: 300000, polling: 200 });
const tm = await page.evaluate(() => window.mundi.view.terrainShadow.valleys.timings);
console.log(`valleys ready ${((Date.now() - t0) / 1000).toFixed(1)} s after the view; capture ${tm.capture.toFixed(0)} ms, erosion ${tm.faces.map((x) => (x / 1000).toFixed(1)).join(" ")} s, total ${(tm.total / 1000).toFixed(1)} s`);
const at = await page.evaluate(() => {
  const w = window.mundi.world, P = w.grid.centers; let best = -1, bd = -1;
  for (let c = 0; c < w.grid.count; c++) { if (w.water[c] !== 0 || w.elevation[c] < 0.5) continue; let n = 0; for (const nb of w.grid.neighbors[c]) n += w.elevation[nb]; if (n > bd) { bd = n; best = c; } }
  return [Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958];
});
for (const alt of alts.split(',').map(Number)) {
  for (const on of [false, true]) {
    await page.evaluate((v) => window.mundi.view.setValleys(v), on);
    await page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [at[0], at[1], alt]);
    await page.waitForTimeout(on ? 4000 : 3000);
    await page.screenshot({ path: `${out}/valleys-${seed}-${alt}-${on ? 'on' : 'off'}.png` });
  }
}
if (errors.length) console.log('errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
