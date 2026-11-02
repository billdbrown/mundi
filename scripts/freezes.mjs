/**
 * The three moments the page has frozen: loading a world, the first descent to the ground, and
 * the first switch to the flat map. For each, the longest main-thread stall (the longest gap
 * between frames, and the longest 'long task'), and how many shader programs were built.
 *
 *   node scripts/freezes.mjs        (LOOK_URL to point elsewhere)
 */
import { chromium } from 'playwright-core';
const url = process.env.LOOK_URL ?? 'http://localhost:5291/';
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })).newPage();
await page.addInitScript(() => {
  window.__long = [];
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
  window.__gap = 0;
  let last = performance.now();
  const tick = () => { const t = performance.now(); window.__gap = Math.max(window.__gap, t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
});
const reset = () => page.evaluate(() => { window.__long = []; window.__gap = 0; window.__frame = 0; });
const report = async (name, t0) => {
  const r = await page.evaluate(() => ({ gap: Math.max(window.__gap, window.__frame ?? 0), long: Math.max(0, ...window.__long), progs: window.mundi?.view?.renderer.info.programs.length ?? 0 }));
  console.log(`${name.padEnd(16)} longest frame gap ${r.gap.toFixed(0).padStart(6)} ms, longest task ${r.long.toFixed(0).padStart(6)} ms, programs ${r.progs}${t0 ? `, took ${((Date.now() - t0) / 1000).toFixed(1)} s` : ''}`);
};

let t0 = Date.now();
await page.goto(url + '#seed=77', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
// Also time each call of the view's own frame (a stall inside it may not show as a frame gap).
await page.evaluate(() => { const v = window.mundi.view, f = v.frame.bind(v); window.__frame = 0; v.frame = () => { const t = performance.now(); f(); window.__frame = Math.max(window.__frame, performance.now() - t); }; });
const tWorld = Date.now();
await page.waitForFunction(() => window.mundi.view.gateReady, null, { timeout: 240000, polling: 200 });
console.log(`world drawn (stand-in) after ${((tWorld - t0) / 1000).toFixed(1)} s; full view after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
await page.waitForTimeout(4000);
await report('world load', t0);

await reset(); t0 = Date.now();
await page.evaluate(() => new Promise((res) => {
  const start = performance.now();
  const step = () => {
    const u = Math.min(1, (performance.now() - start) / 5000);
    window.mundi.orbit(-90.6, 4.9, 3.4 * Math.pow(1.015 / 3.4, u));
    if (u < 1) requestAnimationFrame(step); else res();
  };
  requestAnimationFrame(step);
}));
await page.waitForTimeout(3000);
await report('first descent', t0);

// The Map layer (button): the map look on the globe, a rebuild with other shaders.
if (process.env.LAYER !== '0') {
  await reset(); t0 = Date.now();
  await page.evaluate(() => document.querySelector('#lenses [data-lens=map]').click());
  await page.waitForFunction(() => window.mundi.view.gateReady, null, { timeout: 240000, polling: 200 }); await page.waitForTimeout(3000);
  await report('Map layer', t0);
  await reset(); t0 = Date.now();
  await page.evaluate(() => document.querySelector('#lenses [data-lens=earth]').click());
  await page.waitForFunction(() => window.mundi.view.gateReady, null, { timeout: 240000, polling: 200 }); await page.waitForTimeout(3000);
  await report('Earth layer', t0);
}
await reset(); t0 = Date.now();
await page.evaluate(() => window.mundi.orbit(-90.6, 4.9, 2.2));
await page.waitForTimeout(1500);
await reset(); t0 = Date.now();
await page.evaluate(() => window.mundi.view.setMap(true));
await page.waitForFunction(() => window.mundi.view.mapMode, null, { timeout: 240000, polling: 200 });
await page.waitForTimeout(3000);
await report('first map switch', t0);
await reset();
await page.evaluate(() => window.mundi.view.setMap(false));
await page.waitForTimeout(3000);
await report('back to globe', 0);
// A second world: its shaders are already compiled, so it should come straight up.
await reset(); t0 = Date.now();
await page.evaluate(() => window.mundi.load('seed=4242', { look: 'photo' }));
await page.waitForFunction(() => window.mundi.view.gateReady, null, { timeout: 240000, polling: 100 });
await page.waitForTimeout(2000);
await report('second world', t0);
await browser.close();
