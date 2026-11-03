/**
 * How much plant geometry is drawn low over a forest: instances and corners (vertices) a
 * frame, in Auto and in Fast quality (Fast draws distant plants as stand-ins, lodflora.ts),
 * with a screenshot of each. The vertex count is what slows a laptop's built-in graphics.
 *
 *   node scripts/plantload.mjs <outdir> [seed=77] [alts=1.008,1.03,1.1]
 */
import { chromium } from 'playwright-core';
const [out, seed = '77', alts = '1.008,1.03,1.1'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(`http://localhost:5291/#seed=${seed}&fauna=0`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { window.mundi.capture(true); await window.mundi.view.whenReady(); });
for (const q of ['auto', 'fast']) {
  for (const z of alts.split(',').map(Number)) {
    const r = await page.evaluate(async ([q, z]) => {
      const v = window.mundi.view, w = window.mundi.world, P = w.grid.centers;
      v.setQuality(q);
      let c0 = 0; for (let c = 0; c < w.grid.count; c++) if (w.biome[c] === 10) { c0 = c; break; }   // temperate forest
      window.mundi.orbit(Math.atan2(P[c0 * 3], P[c0 * 3 + 2]) * 57.2958, Math.asin(P[c0 * 3 + 1]) * 57.2958, z);
      await new Promise((r) => setTimeout(r, 6000));
      let inst = 0, verts = 0;
      v.flora.group.traverse((o) => { if (o.isInstancedMesh && o.visible && o.count) { inst += o.count; verts += o.count * o.geometry.getAttribute('position').count; } });
      return { inst, vertsM: +(verts / 1e6).toFixed(1) };
    }, [q, z]);
    console.log(q.padEnd(5), z, `plants ${r.inst}  corners ${r.vertsM} M`);
    await page.screenshot({ path: `${out}/plants-${q}-${z}.png` });
  }
}
await browser.close();
