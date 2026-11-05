/**
 * Does the orbit terrain (sky.ts ORBIT) draw the same as the full one where render.ts switches
 * between them? Screenshots the same views with each (view.terrainOverride), just above the
 * switching height for the viewport, and counts the pixels that differ (pixelmatch, as the visual
 * suite). Run it at a big viewport too: the switch height rises with the pixel count.
 *
 *   node scripts/orbitcheck.mjs <outdir> [width=1000] [height=640] [dpr=1]
 */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import fs from 'node:fs';
const [out, W = '1000', H = '640', DPR = '1'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: +W, height: +H }, deviceScaleFactor: +DPR })).newPage();
await page.goto('http://localhost:5291/', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
const VIEWS = [[0, 20], [90, -10], [200, 45], [300, 60], [40, -42], [150, 5]];
for (const seed of ['77', '4242']) {
  await page.evaluate(async (s) => { const m = window.mundi; await m.load('seed=' + s, { look: 'photo', grid: false, clouds: true }); m.capture(true); await m.view.whenReady(); m.freeze(10); }, seed);
  await page.waitForTimeout(3000);
  for (const [lon, lat] of VIEWS) {
    // Just above where the orbit terrain takes over (render.ts orbitTerrainOk), and higher.
    for (const k of [1.02, 1.5]) {
      const shots = [];
      for (const which of ['orbit', 'full']) {
        await page.evaluate(([lon, lat, k, which]) => {
          const v = window.mundi.view, h = v.renderer.domElement.height;
          const pixel = (2 * Math.tan((v.camera.fov * Math.PI) / 360)) / h;
          const alt = Math.max(0.6, (0.0008 * 0.45 * 1.3) / pixel) * k;
          v.terrainOverride = which;
          window.mundi.orbit(lon, lat, 1 + alt);
        }, [lon, lat, k, which]);
        await page.waitForTimeout(1500);
        const f = `${out}/s${seed}-${lon}_${lat}-k${k}-${which}.png`;
        await page.screenshot({ path: f });
        shots.push(PNG.sync.read(fs.readFileSync(f)));
      }
      const [a, b] = shots, d = new PNG({ width: a.width, height: a.height });
      const n = pixelmatch(a.data, b.data, d.data, a.width, a.height, { threshold: 0.03, includeAA: false });
      fs.writeFileSync(`${out}/s${seed}-${lon}_${lat}-k${k}-diff.png`, PNG.sync.write(d));
      console.log(`seed ${seed} view ${lon},${lat} x${k}: ${n} px differ (${((100 * n) / (a.width * a.height)).toFixed(3)}%)`);
    }
  }
}
await page.evaluate(() => { window.mundi.view.terrainOverride = null; });
await browser.close();
