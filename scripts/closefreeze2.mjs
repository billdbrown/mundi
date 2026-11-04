/**
 * Closing Mundi: how long does the rest of Chrome stall? Keeps a probe tab open with a rAF ticker,
 * opens Mundi, waits N seconds (optionally flying low), closes it, then measures (a) round-trips to
 * the browser process and (b) the probe tab's longest frame gap over the next 20 s.
 *   node scripts/closefreeze2.mjs <wait seconds...>   LOW=1 fly low first; LOOK_URL=... (default live site)
 */
import { chromium } from 'playwright-core';
const waits = process.argv.slice(2).map(Number);
const url = process.env.LOOK_URL ?? 'https://mundi.bill.computer/';
for (const wait of waits.length ? waits : [5, 15, 40]) {
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: [] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const cdp = await browser.newBrowserCDPSession();
  const probe = await ctx.newPage();
  await probe.setContent('<canvas id=c width=200 height=200></canvas>');
  await probe.evaluate(() => {
    const gl = document.getElementById('c').getContext('webgl2'); window.gaps = []; let last = performance.now();
    const f = (t) => { gl.clearColor(Math.random(), 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT); window.gaps.push([t, t - last]); last = t; requestAnimationFrame(f); }; requestAnimationFrame(f);
  });
  const page = await ctx.newPage();
  await page.goto(url);
  if (process.env.LOW) {
    await page.waitForFunction(() => window.mundi?.world, null, { timeout: 180000 });
    await page.evaluate(() => { const m = window.mundi, w = m.world, P = w.grid.centers; let c = 0; for (let i = 0; i < w.grid.count; i++) if (w.water[i] === 0 && w.moisture[i] > w.moisture[c] && w.temperature[i] > 0.5) c = i; m.orbit(Math.atan2(P[c * 3], P[c * 3 + 2]) * 57.2958, Math.asin(P[c * 3 + 1]) * 57.2958, 1.008); });
  }
  await page.waitForTimeout(wait * 1000);
  await probe.bringToFront();
  const tClose = await probe.evaluate(() => performance.now());
  const t0 = Date.now();
  if (!process.env.NOCLOSE) await page.close({ runBeforeUnload: false });
  const closeMs = Date.now() - t0;
  let worstRtt = 0;
  for (let i = 0; i < 100; i++) { const a = Date.now(); await cdp.send('Browser.getVersion'); worstRtt = Math.max(worstRtt, Date.now() - a); await new Promise(r => setTimeout(r, 100)); }
  const worstGap = await probe.evaluate((tc) => Math.round(Math.max(0, ...window.gaps.filter(([t]) => t > tc).map(([, g]) => g))), tClose);
  console.log(`wait ${wait}s${process.env.LOW ? ' low' : ''}: close() ${closeMs} ms · worst browser round-trip ${worstRtt} ms · worst probe-tab frame gap ${worstGap} ms`);
  await browser.close();
}
