/**
 * River mouths up close: the biggest rivers' mouths on a world, from low and a little out to sea.
 *
 *   node scripts/mouth.mjs <outdir> <prefix> seed[,seed...] [alt=1.02] [lens=earth|map]
 */
import { chromium } from 'playwright-core';
const [out, prefix, seeds, alt = '1.02', lens = 'earth'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
await page.goto('http://localhost:5291/', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
for (const seed of seeds.split(',')) {
  const look = lens === 'map' ? { look: 'map', grid: false } : { look: 'photo' };
  await page.evaluate(async ([s, o]) => { const m = window.mundi; await m.load('seed=' + s, { ...o, clouds: false }); m.capture(true); await m.view.whenReady(); }, [seed, look]);
  const mouths = await page.evaluate(() => {
    const w = window.mundi.world, g = w.grid, P = g.centers, out = [];
    for (let c = 0; c < g.count; c++) {
      if (w.river[c] !== 2) continue;
      const sea = g.neighbors[c].find((n) => w.water[n] === 1);
      if (sea === undefined) continue;
      out.push([w.flow[c], c, sea]);
    }
    out.sort((a, b) => b[0] - a[0]);
    return out.slice(0, 2).map(([, c, s]) => {
      // Stand over the sea cell, looking back at the mouth.
      const x = (P[c * 3] + P[s * 3] * 2) / 3, y = (P[c * 3 + 1] + P[s * 3 + 1] * 2) / 3, z = (P[c * 3 + 2] + P[s * 3 + 2] * 2) / 3;
      return [Math.atan2(x, z) * 57.2958, Math.asin(y / Math.hypot(x, y, z)) * 57.2958];
    });
  });
  for (let i = 0; i < mouths.length; i++) {
    await page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [mouths[i][0], mouths[i][1], Number(alt)]);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${out}/${prefix}-${seed}-${i}.png` });
  }
}
await browser.close();
