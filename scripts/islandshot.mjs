/**
 * Hotspot islands from above (hotspots.ts): one shot per island above water, so their shapes
 * can be checked.
 *
 *   node scripts/islandshot.mjs <outdir> [seed=77] [alt=1.08] [max=8]
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', alt = '1.08', max = '8'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 500, height: 400 } })).newPage();
await page.goto(`http://localhost:5291/#seed=${seed}`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { const m = window.mundi; m.capture(true); await m.view.whenReady(); });
const spots = await page.evaluate((k) => {
  const w = window.mundi.world, P = w.grid.centers;
  return w.hotspots.volcanoes.filter((v) => w.water[v.cell] === 0).slice(0, k)
    .map((v) => ({ c: v.cell, age: v.age, lon: Math.atan2(P[v.cell * 3], P[v.cell * 3 + 2]) * 57.2958, lat: Math.asin(P[v.cell * 3 + 1]) * 57.2958 }));
}, Number(max));
for (const s of spots) {
  await page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [s.lon, s.lat, Number(alt)]);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/island-${seed}-${s.c}-age${s.age}.png` });
}
console.log(spots.length, 'islands');
await browser.close();
