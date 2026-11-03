/**
 * Weather shots: over the strongest storm (or the tropics) at night, a burst of frames so
 * lightning shows, and optionally low down.
 *
 *   node scripts/weathershot.mjs <outdir> [seed=77] [alt=2.0] [hour=23] [frames=6] [light=cycle]
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', alt = '2.0', hour = '23', frames = '6', light = 'cycle'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
await page.goto(`http://localhost:5291/#seed=${seed}`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async (l) => { const m = window.mundi; m.capture(true); m.view.setOptions({ light: l }); await m.view.whenReady(); }, light);
await page.waitForTimeout(1500);
const at = await page.evaluate(() => {
  // The strongest storm now, tropical first.
  const S = window.mundi.view.cloudU.uStorms.value.filter((v) => v.w > 0.3).sort((a, b) => (a.z < 0 ? -1 : 1) - (b.z < 0 ? -1 : 1) || b.w - a.w);
  return S.length ? { lon: S[0].x * 57.2958, lat: S[0].y * 57.2958, tropical: S[0].z < 0, w: S[0].w } : { lon: 20, lat: 5, none: true };
});
console.log(JSON.stringify(at));
await page.evaluate(([a, b, h, hr]) => { window.mundi.orbit(a, b, h); window.mundi.view.setLocalHour(hr); }, [at.lon, at.lat, Number(alt), Number(hour)]);
await page.waitForTimeout(3000);
for (let i = 0; i < Number(frames); i++) {
  await page.screenshot({ path: `${out}/wx-${seed}-${alt}-${i}.png` });
  await page.waitForTimeout(180);
}
if (errors.length) console.log('errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
