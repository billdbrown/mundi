/**
 * Screenshot pairs with a trial switch (render.ts trials) off and on: same page, same framing.
 *
 *   node scripts/trial.mjs <outdir> <key> name=seed:bBIOME[+BIOME]:alt ...   (or volcN: the Nth volcano)
 *   HOUR=17 lights by the sun at that local hour (as look.mjs). WAIT=ms after switching on.
 */
import { chromium } from 'playwright-core';
const [out, key, ...shots] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
await page.goto('http://localhost:5291/', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
for (const spec of shots) {
  const [name, seed, target, alt] = spec.split(/[=:]/);
  await page.evaluate(async (s) => { const m = window.mundi; await m.load('seed=' + s, { look: 'photo', grid: false, clouds: false }); m.capture(true); await m.view.whenReady(); }, seed);
  await page.evaluate(([t, a]) => {
    const m = window.mundi, w = m.world, P = w.grid.centers;
    if (t.startsWith('volc')) { const v = m.view.cloudU.uVolc.value[Number(t.slice(4) || 0)]; m.orbit(Math.atan2(v.x, v.z) * 57.2958, Math.asin(v.y) * 57.2958, Number(a)); return; }
    const bs = t.slice(1).split('+').map(Number);
    let best = -1, bd = -1;
    for (let c = 0; c < w.grid.count; c++) { if (!bs.includes(w.biome[c])) continue; let n = 0; for (const nb of w.grid.neighbors[c]) if (bs.includes(w.biome[nb])) n++; if (n > bd) { bd = n; best = c; } }
    m.orbit(Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958, Number(a));
  }, [target, alt]);
  if (process.env.HOUR) await page.evaluate((h) => { const v = window.mundi.view; v.setOptions({ light: 'cycle' }); v.setLocalHour(Number(h)); }, process.env.HOUR);
  for (const on of [false, true]) {
    const cur = await page.evaluate((k) => window.mundi.view.trials.find((t) => t.key === k).on, key);
    if (cur !== on) await page.keyboard.press(key);
    await page.waitForTimeout(on ? Number(process.env.WAIT || 3500) : 3500);
    await page.screenshot({ path: `${out}/${name}-${on ? 'on' : 'off'}.png` });
  }
}
await browser.close();
