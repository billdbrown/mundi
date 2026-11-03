/**
 * Plants up close in a few biomes (the species families, species.ts): finds each biome's biggest
 * patch and shoots it low, tilted, from the same height.
 *
 *   node scripts/flora.mjs <outdir> [tag] [seed=77] [alt=1.008]
 */
import { chromium } from 'playwright-core';
const [out, tag = 'now', seed = '77', alt = '1.008'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
await page.goto(`http://localhost:5291/#seed=${seed}`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { const m = window.mundi; m.capture(true); await m.view.whenReady(); });
if (process.env.BIG) await page.evaluate(() => window.mundi.view.flora.setScale(1));   // (inspection: plants 6x)
const spots = await page.evaluate(async () => {
  const { B } = await import('/src/biomes.ts');
  const w = window.mundi.world, P = w.grid.centers, out = {};
  for (const [name, id] of [['forest', B.FOREST], ['taiga', B.TAIGA], ['savanna', B.SAVANNA], ['rainforest', B.RAINFOREST], ['desert', B.DESERT_SCRUB], ['marsh', B.MARSH]]) {
    let best = -1, bd = -1;
    for (let c = 0; c < w.grid.count; c++) { if (w.biome[c] !== id) continue; let n = 0; for (const nb of w.grid.neighbors[c]) if (w.biome[nb] === id) n++; if (n > bd) { bd = n; best = c; } }
    if (best >= 0) out[name] = [Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958];
  }
  return out;
});
for (const [name, at] of Object.entries(spots)) {
  await page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [at[0], at[1], Number(alt)]);
  await page.waitForTimeout(4500);
  await page.screenshot({ path: `${out}/flora-${name}-${tag}.png`, timeout: 120000 });
}
console.log(Object.keys(spots).join(' '), errors.length ? '\nerrors:\n' + [...new Set(errors)].join('\n') : '');
await browser.close();
