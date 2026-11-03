/**
 * Rivers up close: low, tilted shots over rivers on sloping ground, to see whether the water
 * sits in its valley.
 *
 *   node scripts/rivershot.mjs <outdir> [seed=77] [alts=1.012,1.02] [n=3]
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', alts = '1.012,1.02', n = '3'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.goto(`http://localhost:5291/#seed=${seed}`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { const m = window.mundi; m.capture(true); await m.view.whenReady(); });
await page.waitForFunction(() => window.mundi.view.terrainShadow.valleys.ready, null, { timeout: 300000, polling: 200 });
// River cells on the side of a slope: the most height difference among their neighbours.
const spots = await page.evaluate((k) => {
  const w = window.mundi.world, P = w.grid.centers, out = [];
  const cand = [];
  for (let c = 0; c < w.grid.count; c++) {
    if (!w.river[c] || w.water[c] !== 0 || w.temperature[c] < 0.5 || w.moisture[c] > 0.35) continue;
    let lo = 9, hi = -9;
    for (const nb of w.grid.neighbors[c]) { lo = Math.min(lo, w.elevation[nb]); hi = Math.max(hi, w.elevation[nb]); }
    cand.push([hi - lo, c]);
  }
  cand.sort((a, b) => b[0] - a[0]);
  for (const [, c] of cand) {
    if (out.some((o) => Math.abs(o.c - c) < 0)) continue;
    const p = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]];
    if (out.some((o) => o.p[0] * p[0] + o.p[1] * p[1] + o.p[2] * p[2] > 0.99)) continue;
    out.push({ c, p, lon: Math.atan2(p[0], p[2]) * 57.2958, lat: Math.asin(p[1]) * 57.2958, e: w.elevation[c] });
    if (out.length >= k) break;
  }
  return out;
}, Number(n));
for (const s of spots) {
  for (const alt of alts.split(',').map(Number)) {
    // The tilted view looks north at the point below: stand a little south so the river is mid-frame.
    await page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [s.lon, s.lat, alt]);
    await page.waitForTimeout(5000);
    await page.screenshot({ path: `${out}/river-${seed}-${s.c}-${alt}.png` });
  }
}
console.log(JSON.stringify(spots.map((s) => [s.c, s.e.toFixed(3)])));
if (errors.length) console.log('errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
