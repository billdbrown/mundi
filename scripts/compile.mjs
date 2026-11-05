/**
 * Shader compile timeline on a fresh page: when each stage of the gate finishes (orbit view,
 * low-altitude, flat map, other look), and how smooth frames are meanwhile while the camera
 * keeps turning (as someone looking round would). Frame times: median and 95th percentile of the
 * gaps between frames, over the whole background compile.
 *
 *   node scripts/compile.mjs [dpr=2]      (LOOK_URL to point elsewhere)
 */
import { chromium } from 'playwright-core';
const url = process.env.LOOK_URL ?? 'http://localhost:5291/';
const dpr = Number(process.argv[2] ?? 2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr })).newPage();
await page.addInitScript(() => {
  window.__gaps = [];
  let last = performance.now();
  window.__worst = [0, 0];
  const tick = () => { const t = performance.now(); window.__gaps.push(t - last); if (t - last > window.__worst[0]) window.__worst = [t - last, t]; last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
// UNTIL=low: stop once the low-altitude shaders are in (the map's and other look's compile only
// when wanted, so otherwise this waits out the 400 s limit).
if (process.env.UNTIL === 'low') await page.addInitScript(() => { window.__untilLow = true; });
const t0 = Date.now();
await page.goto(url + '#seed=77', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.view, null, { timeout: 240000 });
const stages = await page.evaluate(() => new Promise((res) => {
  const v = window.mundi.view, t = performance.now(), out = {};
  window.__gaps = []; window.__worst = [0, 0]; window.__t0 = t;
  // Turn slowly for 4 s, then rest 4 s, as if looking round.
  let a = -90.6;
  const spin = () => { if (window.mundi.world && v.gateReady && (performance.now() / 4000 | 0) % 2 === 0) { a += 0.05; window.mundi.orbit(a, 4.9, 2.2); } };
  const check = () => {
    spin();
    for (const k of ['gateReady', 'lowReady', 'mapReady', 'otherLookReady']) if (v[k] && !(k in out)) out[k] = (performance.now() - t) / 1000;
    if ('otherLookReady' in out || (window.__untilLow && 'lowReady' in out) || performance.now() - t > 400000) res(out);
    else requestAnimationFrame(check);
  };
  check();
}));
const g = await page.evaluate(() => window.__gaps.slice().sort((a, b) => a - b));
const worst = await page.evaluate(() => [window.__worst[0], (window.__worst[1] - window.__t0) / 1000]);
const q = (p) => g[Math.min(g.length - 1, Math.floor(g.length * p))].toFixed(1);
console.log(`dpr ${dpr}: ` + Object.entries(stages).map(([k, s]) => `${k} ${s.toFixed(1)} s`).join(', ') +
  ` | frames ${g.length}, median ${q(0.5)} ms, p95 ${q(0.95)} ms, worst ${worst[0].toFixed(0)} ms ending at ${worst[1].toFixed(1)} s (page ${((Date.now() - t0) / 1000).toFixed(0)} s)`);
await browser.close();
