/**
 * Birds (fauna.ts): a shot of each kind asked for, the camera beside the group at its height,
 * looking at it (the normal low view looks down at the ground, under the birds).
 *
 *   node scripts/birdshot.mjs <outdir> [seed=77] [kinds=eagle,vulture,...] [back=60]   back: body lengths away
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', kinds = 'eagle,vulture,hawk,goose,crane,egret,parrot,songbird,flamingo,gull', back = '60'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 400)));
await page.goto(`http://localhost:5291/#seed=${seed}`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { const m = window.mundi; m.capture(true); await m.view.whenReady(); });
const spots = await page.evaluate((ks) => {
  const v = window.mundi.view, w = window.mundi.world, f = v.fauna, u = v.cloudU, found = {};
  for (let c = 0; c < w.grid.count; c++) for (const g of f.groupsOf(c)) {
    if (!ks.includes(g.kind) || found[g.kind]) continue;
    if (v.precip.coverAt(g.home, v.weatherDays, u.uCloudTime.value, u.uStorms.value) > 0.4) continue;
    found[g.kind] = { kind: g.kind, cell: c, lon: Math.atan2(g.home.x, g.home.z) * 57.2958, lat: Math.asin(g.home.y) * 57.2958 };
  }
  return Object.values(found);
}, kinds.split(','));
console.log(JSON.stringify(spots.map((s) => s.kind)));
for (const s of spots) {
  // Fly low over the home first, so the ground patch and the animals near it are made.
  await page.evaluate(([a, b]) => window.mundi.orbit(a, b, 1.01), [s.lon, s.lat]);
  await page.waitForTimeout(2500);
  // Then, each frame, put the camera beside the group's birds and look at their middle.
  await page.evaluate(([c, k, back]) => {
    const v = window.mundi.view, cam = v.camera, f = v.fauna;
    v.controls.enabled = false; v.setFloor(0.0003);
    v.controls.update = () => false;
    const tick = () => {
      const g = f.groupsOf(c).find((x) => x.kind === k);
      const meshes = g ? g.shapes.map((s) => f.meshes.get(s)).filter((m) => m?.count) : [];
      // The group's birds: the instances nearest its middle direction.
      if (g?.at) {
        let best = null, bd = Infinity;
        const p = new cam.position.constructor(), M = new cam.matrix.constructor();
        for (const m of meshes) for (let i = 0; i < m.count; i++) {
          m.getMatrixAt(i, M); p.setFromMatrixPosition(M);
          const d = p.clone().normalize().distanceTo(g.at);
          if (d < bd) { bd = d; best = p.clone(); }
        }
        if (best) {
          const up = best.clone().normalize();
          const side = new cam.position.constructor(up.z, 0, -up.x).normalize();
          cam.position.copy(best).addScaledVector(side, g.size * back).addScaledVector(up, g.size * back * 0.15);
          cam.up.copy(up);
          cam.lookAt(best);
          cam.updateMatrixWorld();
        }
      }
      window.__bt = requestAnimationFrame(tick);
    };
    tick();
  }, [s.cell, s.kind, Number(back)]);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/bird-${s.kind}.png` });
  await page.evaluate(() => { cancelAnimationFrame(window.__bt); window.mundi.view.controls.enabled = true; });
}
if (errors.length) console.log(errors.join('\n'));
await browser.close();
