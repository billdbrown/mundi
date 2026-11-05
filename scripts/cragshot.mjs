/**
 * Close-up rock: screenshots low over the steepest bare (unfrozen) high ground, where crags show.
 * HOUR=15 local solar time.
 * Picks high land cells away from the poles, ranked, then a few heights and a pan at the lowest.
 *
 *   node scripts/cragshot.mjs <outdir> [seed=4242] [rank=0] [maxLat=35]
 */
import { chromium } from 'playwright-core';
const [out, seed = '4242', rank = '0', maxLat = '35'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
page.on('console', (m) => { if (m.type() === 'error' || /ERROR|warning X/.test(m.text())) console.log('console:', m.text().slice(0, 400)); });
await page.goto('http://localhost:5291/', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async (s) => { const m = window.mundi; await m.load('seed=' + s, { look: 'photo', grid: false, clouds: false, light: 'cycle' }); m.capture(true); await m.view.whenReady(); m.freeze(10); }, seed);
await page.waitForFunction(() => window.mundi.view.terrainShadow.valleys.ready, null, { timeout: 120000 });
await page.waitForTimeout(3000);
const at = await page.evaluate(([rk, ml]) => {
  const w = window.mundi.world, P = w.grid.centers, idx = [];
  const sinMax = Math.sin(ml / 57.2958);
  for (let c = 0; c < w.grid.count; c++) if (Math.abs(P[c * 3 + 1]) < sinMax) idx.push(c);
  idx.sort((a, b) => w.elevation[b] - w.elevation[a]);
  const picks = [];
  for (const c of idx) {
    if (picks.some((p) => P[p * 3] * P[c * 3] + P[p * 3 + 1] * P[c * 3 + 1] + P[p * 3 + 2] * P[c * 3 + 2] > 0.99)) continue;
    picks.push(c); if (picks.length > rk) break;
  }
  const c = picks[rk];
  return [Math.atan2(P[c * 3], P[c * 3 + 2]) * 57.2958, Math.asin(P[c * 3 + 1]) * 57.2958];
}, [Number(rank), Number(maxLat)]);
console.log('at', at.map((x) => x.toFixed(2)).join(','));
const hour = Number(process.env.HOUR ?? 15);
const go = (lon, lat, h) => page.evaluate(async ([a, b, d, hr]) => { window.mundi.orbit(a, b, d); await new Promise((r) => setTimeout(r, 400)); window.mundi.view.setLocalHour(hr); }, [lon, lat, h, hour]);
for (const h of [1.04, 1.025, 1.016]) {
  await go(at[0], at[1], h);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${out}/h${h.toFixed(3)}.png` });
}
for (let i = 0; i <= 2; i++) {
  await go(at[0] + 0.4 - i * 0.4, at[1] - 0.3, 1.016);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/pan${i}.png` });
}
await browser.close();
