/**
 * The finer biomes (ecology.ts) off and on, one shot pair each: finds the biome's biggest patch
 * on a world (its cell with most same-biome neighbours), and shoots it from the same camera
 * with &ecology=1 and without.
 *
 *   node scripts/biomes.mjs <outdir> name=seed:BIOME_ID:alt ...      (HOUR=… as look.mjs)
 *   PARAM=deltas: the deltas switch instead, and BIOME_ID 'delta' finds delta land (deltas.ts).
 */
import { chromium } from 'playwright-core';
const [out, ...shots] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1000, height: 640 } })).newPage();
await page.goto('http://localhost:5291/', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
const load = (hash) => page.evaluate(async (h) => { const m = window.mundi; await m.load(h, { look: 'photo', grid: false, clouds: false }); m.capture(true); await m.view.whenReady(); }, hash);
for (const spec of shots) {
  const [name, seed, id, alt] = spec.split(/[=:]/);
  const param = process.env.PARAM ?? 'ecology';
  await load(`seed=${seed}&${param}=1`);
  const at = await page.evaluate((b) => {
    const w = window.mundi.world, P = w.grid.centers;
    let best = -1, bd = -1;
    if (b === 'delta') {
      const ds = []; for (let c = 0; c < w.grid.count; c++) if (w.water[c] === 0 && Math.abs(w.elevation[c] - 0.012) < 1e-6) ds.push(c);
      if (!ds.length) return null;
      const c = ds[0], o = w.grid.neighbors[c].find((n) => w.water[n] === 1) ?? c;
      // Out over the sea a little, looking back at it.
      const x = P[c * 3] * 0.6 + P[o * 3] * 0.4, y = P[c * 3 + 1] * 0.6 + P[o * 3 + 1] * 0.4, z = P[c * 3 + 2] * 0.6 + P[o * 3 + 2] * 0.4;
      return [Math.atan2(x, z) * 57.2958, Math.asin(y / Math.hypot(x, y, z)) * 57.2958];
    }
    b = Number(b);
    for (let c = 0; c < w.grid.count; c++) { if (w.biome[c] !== b) continue; let n = 0; for (const nb of w.grid.neighbors[c]) if (w.biome[nb] === b) n++; if (n > bd) { bd = n; best = c; } }
    if (best < 0) return null;
    return [Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958];
  }, id === 'delta' ? 'delta' : Number(id));
  if (!at) { console.log(name, 'none'); continue; }
  const shoot = async (file) => {
    await page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [at[0], at[1], Number(alt)]);
    if (process.env.HOUR) await page.evaluate((h) => { const v = window.mundi.view; v.setOptions({ light: 'cycle' }); v.setLocalHour(Number(h)); }, process.env.HOUR);
    await page.waitForTimeout(4000);
    await page.screenshot({ path: `${out}/${file}` });
  };
  await shoot(`${name}-on.png`);
  await load(`seed=${seed}`);
  await shoot(`${name}-off.png`);
}
await browser.close();
