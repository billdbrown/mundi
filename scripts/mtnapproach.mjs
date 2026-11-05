/**
 * Do mountains keep their shape as you come down to them? Centres the view on the highest
 * ground, then screenshots at a series of heights, either side of where the close-up patch
 * takes over (dunepatch.ts PATCH_MAX_DIST, 1.12), and while panning past it.
 *
 *   node scripts/mtnapproach.mjs <outdir> [seed=77] [rank=0]    rank: 0 highest cell, 1 next range...
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', rank = '0'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
await page.goto('http://localhost:5291/', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async (s) => { const m = window.mundi; await m.load('seed=' + s, { look: 'photo', grid: false, clouds: false }); m.capture(true); await m.view.whenReady(); m.freeze(10); }, seed);
// Valleys arrive a few seconds after load and fade in.
await page.waitForFunction(() => window.mundi.view.terrainShadow.valleys.ready, null, { timeout: 120000 });
await page.waitForTimeout(3000);
const at = await page.evaluate((rk) => {
  const w = window.mundi.world, P = w.grid.centers, idx = [];
  for (let c = 0; c < w.grid.count; c++) idx.push(c);
  idx.sort((a, b) => w.elevation[b] - w.elevation[a]);
  // Skip cells near an already chosen one, so each rank is a different range.
  const picks = [];
  for (const c of idx) {
    if (picks.some((p) => P[p * 3] * P[c * 3] + P[p * 3 + 1] * P[c * 3 + 1] + P[p * 3 + 2] * P[c * 3 + 2] > 0.99)) continue;
    picks.push(c); if (picks.length > rk) break;
  }
  const c = picks[rk];
  return [Math.atan2(P[c * 3], P[c * 3 + 2]) * 57.2958, Math.asin(P[c * 3 + 1]) * 57.2958];
}, Number(rank));
console.log('at', at.map((x) => x.toFixed(2)).join(','));
const go = (lon, lat, h) => page.evaluate(([a, b, d]) => window.mundi.orbit(a, b, d), [lon, lat, h]);
for (const h of [1.13, 1.115, 1.09, 1.06, 1.04, 1.025]) {
  await go(at[0], at[1], h);
  await page.waitForTimeout(h < 1.12 ? 5000 : 2500);
  await page.screenshot({ path: `${out}/h${h.toFixed(3)}.png` });
}
// Pan across at a mid height: the patch recentres as it goes, the range passing through its edge.
for (let i = 0; i <= 4; i++) {
  await go(at[0] + 1.5 - i * 0.75, at[1], 1.05);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/pan${i}.png` });
}
await browser.close();
