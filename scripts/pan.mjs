/**
 * Main-thread cost while gliding low over the ground (where trees are generated as you go):
 * per-frame JavaScript time, median / 95th percentile / worst, and the tree layer's share.
 *
 *   node scripts/pan.mjs
 */
import { chromium } from 'playwright-core';
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
await page.goto('http://localhost:5291/');
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 60000 });
await page.evaluate(() => window.mundi.load('seed=77', { look: 'photo' }));
await page.waitForTimeout(8000);
for (const alt of [1.012, 1.04]) {
  const r = await page.evaluate((alt) => new Promise((res) => {
    const v = window.mundi.view, f = v.frame.bind(v), times = [], fl = [];
    const fu = v.flora.update.bind(v.flora); v.flora.update = (...a) => { const t = performance.now(); fu(...a); fl.push(performance.now() - t); };
    let lon = -95, n = 0;
    v.frame = () => { window.mundi.orbit(lon += 0.03, 4.9, alt); const t = performance.now(); f(); times.push(performance.now() - t); };
    const stop = () => { v.frame = f; window.__top = times.map((t, i) => [t, i]).sort((a, b) => b[0] - a[0]).slice(0, 4).map(([t, i]) => i + ':' + t.toFixed(0)).join(' '); times.sort((a, b) => a - b); fl.sort((a, b) => a - b); res([times[times.length >> 1], times[Math.floor(times.length * 0.95)], times[times.length - 1], times.length, fl[Math.floor(fl.length * 0.95)], fl[fl.length - 1]]); };
    setTimeout(stop, 4000);
  }), alt);
  console.log('worst frames', await page.evaluate(() => window.__top));
  console.log(`alt ${alt}: js per frame p50 ${r[0].toFixed(1)} p95 ${r[1].toFixed(1)} max ${r[2].toFixed(1)} ms over ${r[3]} frames; flora p95 ${r[4].toFixed(1)} max ${r[5].toFixed(1)}`);
}
await browser.close();
