/**
 * Does a place look the same when you come back to it? Turns a trial switch on, settles,
 * screenshots, pans away (in steps, as a person would) and back, screenshots again, and prints
 * how much changed. Mid-pan frames are saved too.
 *
 *   node scripts/stability.mjs <outdir> <key> seed:bBIOME[+BIOME]:alt [settle ms]
 */
import { chromium } from 'playwright-core';
const [out, key, spec, settle = '30000'] = process.argv.slice(2);
const [seed, target, alt] = spec.split(':');
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
await page.goto('http://localhost:5291/', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async (s) => { const m = window.mundi; await m.load('seed=' + s, { look: 'photo', grid: false, clouds: false }); m.capture(true); await m.view.whenReady(); }, seed);
const at = await page.evaluate((t) => {
  const w = window.mundi.world, P = w.grid.centers, bs = t.slice(1).split('+').map(Number);
  let best = -1, bd = -1;
  for (let c = 0; c < w.grid.count; c++) { if (!bs.includes(w.biome[c])) continue; let n = 0; for (const nb of w.grid.neighbors[c]) if (bs.includes(w.biome[nb])) n++; if (n > bd) { bd = n; best = c; } }
  return [Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958];
}, target);
const go = (lon, lat) => page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [lon, lat, Number(alt)]);
await go(at[0], at[1]);
await page.keyboard.press(key);
await page.waitForTimeout(Number(settle));
await page.screenshot({ path: `${out}/a.png` });
for (let i = 1; i <= 6; i++) { await go(at[0] + i * 1.5, at[1]); await page.waitForTimeout(1500); if (i === 3) await page.screenshot({ path: `${out}/mid.png` }); }
for (let i = 5; i >= 0; i--) { await go(at[0] + i * 1.5, at[1]); await page.waitForTimeout(1500); }
await page.waitForTimeout(4000);
await page.screenshot({ path: `${out}/b.png` });
await browser.close();
