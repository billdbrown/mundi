/**
 * Animals (fauna.ts): low shots over a few kinds of group, at a few sizes.
 *
 *   node scripts/faunashot.mjs <outdir> [seed=77] [sizes=1,4,8] [alt=1.009] [kinds=bison,deer,rabbit,bird]
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', sizes = '1,4,8', alt = '1.009', kinds = 'bison,deer,rabbit,bird,wildebeest,caribou'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: Number(process.env.VW ?? 900), height: Number(process.env.VH ?? 600) } })).newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
await page.goto(`http://localhost:5291/${process.env.QS ?? ""}#seed=${seed}${process.env.HX ?? ""}`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { const m = window.mundi; m.capture(true); await m.view.whenReady(); });
// A group of each kind asked for, in clear weather where possible.
const spots = await page.evaluate((ks) => {
  const v = window.mundi.view, w = window.mundi.world, f = v.fauna, u = v.cloudU, found = {};
  for (let c = 0; c < w.grid.count; c++) {
    for (const g of f.groupsOf(c)) {
      if (!ks.includes(g.kind) || found[g.kind]) continue;
      if (v.precip.coverAt(g.home, v.weatherDays, u.uCloudTime.value, u.uStorms.value) > 0.55) continue;
      found[g.kind] = { kind: g.kind, cell: c, lon: Math.atan2(g.home.x, g.home.z) * 57.2958, lat: Math.asin(g.home.y) * 57.2958 };
    }
  }
  return Object.values(found);
}, kinds.split(','));
console.log(JSON.stringify(spots.map((s) => s.kind)));
for (const size of sizes.split(',').map(Number)) {
  await page.evaluate((s) => window.mundi.view.fauna.setSize(s), size);
  for (const s of spots) {
    // The low view looks at the ground under the orbit point.
    await page.evaluate(([a, b, h]) => window.mundi.orbit(a, b, h), [s.lon, s.lat, Number(alt)]);
    await page.waitForTimeout(800);
    // Then over where the group is now (it wanders round its home).
    await page.evaluate(([c, k, h]) => { const g = window.mundi.view.fauna.groupsOf(c).find((x) => x.kind === k); const p = g.at ?? g.home; window.mundi.orbit(Math.atan2(p.x, p.z) * 57.2958, Math.asin(p.y) * 57.2958, h); }, [s.cell, s.kind, Number(alt)]);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${out}/fauna-${s.kind}-x${size}.png` });
  }
}
if (errors.length) console.log('errors:\n' + [...new Set(errors)].join('\n'));
await browser.close();
