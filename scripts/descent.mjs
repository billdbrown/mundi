/**
 * The first descent into a world: frames slower than 50 ms on the way down from orbit, with
 * the shader programs compiled during each and the time spent in the view's frame().
 *
 *   node scripts/descent.mjs
 */
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
await page.goto(process.env.LOOK_URL ?? 'http://localhost:5291/#seed=77');
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 60000 });
await page.waitForTimeout(6000);   // clouds and workers settle; nothing has been near the ground yet
const log = await page.evaluate(() => new Promise((res) => {
  const v = window.mundi.view, f = v.frame.bind(v), out = [];
  const lon = -90.6, lat = 4.9, t0 = performance.now(), T = 4000;
  let last = performance.now();
  v.frame = () => {
    const now = performance.now(), u = Math.min(1, (now - t0) / T);
    const alt = 3.4 * Math.pow(1.012 / 3.4, u);           // even zoom in log height
    window.mundi.orbit(lon, lat, alt);
    const progs = v.renderer.info.programs.length, ts = performance.now();
    f();
    const js = performance.now() - ts, gap = now - last;
    last = now;
    if (gap > 50 || js > 50) out.push(`gap ${gap.toFixed(0)} ms before alt ${alt.toFixed(3)}; frame() ${js.toFixed(0)} ms; programs ${progs}->${v.renderer.info.programs.length}` + v.renderer.info.programs.slice(progs).map((p) => " [" + p.name + " " + p.cacheKey.slice(0, 400) + "]").join(""));
    if (u >= 1 && now - t0 > T + 1500) { v.frame = f; res(out); }
  };
}));
console.log(log.join('\n') || 'no slow frames');
await browser.close();
