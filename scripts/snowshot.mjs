/**
 * Snowy peaks in the hex view, for judging the snow: for each seed's mountain spot, the hex's
 * highest point from three distances (the starting view, a mid view of the summit, and a low
 * look across at it), plus how much of the hex is snow.
 *   node scripts/snowshot.mjs <base url> <outdir> [seeds=1,77,4242] [tag=now]
 */
import { chromium } from 'playwright-core';
const [base = 'http://localhost:5293/', out = '.', seedArg = '1,77,4242', tag = 'now'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
for (const seed of seedArg.split(',')) {
  await page.goto('about:blank');
  await page.goto(`${base}hex.html#seed=${seed}&spot=mountain`);
  await page.waitForFunction(() => window.hex?.map && !window.hex.busy, null, { timeout: 120000 });
  await page.evaluate(() => { window.hex.capture(true); });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const m = window.hex.map, { res, size, heights, layers } = m, step = size / (res - 1), half = size / 2;
    let best = -Infinity, bi = 0, bj = 0, snow = 0, land = 0;
    const L = layers.length / (res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const v = j * res + i, x = -half + i * step, y = -half + j * step;
      if (Math.hypot(x, y) > m.localWidth * 0.45) continue;
      if (heights[v] > 0) { land++; snow += layers[v * L + 4]; }
      if (heights[v] > best) { best = heights[v]; bi = i; bj = j; }
    }
    return { px: -half + bi * step, py: -half + bj * step, h: best, size, snowPct: Math.round((100 * snow) / Math.max(1, land)), biome: m.info.biome };
  });
  console.log(`seed ${seed}: ${info.biome}, peak ${info.h.toFixed(0)} m, snow ${info.snowPct}% of the land`);
  await page.screenshot({ path: `${out}/snow-${seed}-a-${tag}.png` });
  const look = async (k, dist, up) => {
    await page.evaluate(([p, dist, up]) => {
      // From the south-west of the peak, looking at it.
      window.hex.look(p.px - dist * 0.6, p.py - dist * 0.8, up, p.px, p.py, 0);
    }, [info, dist, up]);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/snow-${seed}-${k}-${tag}.png` });
  };
  await look('b', info.size * 0.35, info.h + info.size * 0.15);
  await look('c', info.size * 0.25, info.h * 0.6);
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
