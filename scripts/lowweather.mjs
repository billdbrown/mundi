/**
 * Weather on the ground (precip.ts): finds land under the thickest cloud, warm and cold, and
 * shoots it from low down, a few frames apart (rain, snow, overcast, lightning).
 *
 *   node scripts/lowweather.mjs <outdir> [seed=77] [alt=1.012] [frames=3] [light=follow]
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', alt = '1.012', frames = '3', light = 'follow'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
await page.goto(`http://localhost:5291/#seed=${seed}`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async (l) => { const m = window.mundi; m.capture(true); m.view.setOptions({ light: l }); await m.view.whenReady(); }, light);
await page.waitForTimeout(1500);
const spots = await page.evaluate(() => {
  const v = window.mundi.view, w = window.mundi.world, P = w.grid.centers, u = v.cloudU;
  let warm = null, cold = null;
  const d = { x: 0, y: 0, z: 0 };
  for (let c = 0; c < w.grid.count; c += 3) {
    if (w.water[c] !== 0) continue;
    d.x = P[c * 3]; d.y = P[c * 3 + 1]; d.z = P[c * 3 + 2];
    const cv = v.precip.coverAt(d, v.weatherDays, u.uCloudTime.value, u.uStorms.value);
    const t = w.temperature[c];
    if (t > 0.45 && (!warm || cv > warm.cv)) warm = { c, cv, t };
    if (t < 0.2 && (!cold || cv > cold.cv)) cold = { c, cv, t };
  }
  return [warm, cold].filter(Boolean).map((s) => ({ ...s, lon: Math.atan2(P[s.c * 3], P[s.c * 3 + 2]) * 57.2958, lat: Math.asin(P[s.c * 3 + 1]) * 57.2958 }));
});
console.log(JSON.stringify(spots));
for (const [k, s] of spots.entries()) {
  await page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [s.lon, s.lat, Number(alt)]);
  await page.waitForTimeout(5000);
  for (let i = 0; i < Number(frames); i++) {
    await page.screenshot({ path: `${out}/low-${seed}-${k ? 'cold' : 'warm'}-${i}.png` });
    if (i === 0) console.log(k ? 'cold' : 'warm', JSON.stringify(await page.evaluate(() => window.mundi.view.precip.state)));
    await page.waitForTimeout(400);
  }
}
if (errors.length) console.log('errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
