// Same Chrome profile twice: does the second visit still compile (time to first view, freeze on close at 20 s)?
import { chromium } from 'playwright-core';
import os from 'os'; import path from 'path'; import fs from 'fs';
const dir = path.join(os.tmpdir(), 'mundi-warm-profile'); fs.rmSync(dir, { recursive: true, force: true });
const url = process.env.LOOK_URL ?? 'https://mundi.bill.computer/';
for (const run of [1, 2, 3]) {
  const ctx = await chromium.launchPersistentContext(dir, { headless: false, channel: 'chrome', viewport: { width: 1440, height: 900 } });
  const page = ctx.pages()[0] ?? await ctx.newPage();
  const t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => !document.querySelector('#loader:not(.done)') && window.mundi?.world, null, { timeout: 180000 }).catch(() => {});
  const ready = Date.now() - t0;
  await page.waitForTimeout(Math.max(0, 20000 - ready));
  const probe = await ctx.newPage();
  await probe.setContent('<canvas id=c></canvas>');
  await probe.evaluate(() => { const gl = document.getElementById('c').getContext('webgl2'); window.g = 0; let l = performance.now(); const f = t => { gl.clear(gl.COLOR_BUFFER_BIT); window.g = Math.max(window.g, t - l); l = t; requestAnimationFrame(f); }; requestAnimationFrame(f); });
  await probe.waitForTimeout(500); await probe.evaluate(() => window.g = 0);
  await page.close();
  await probe.waitForTimeout(15000);
  console.log(`visit ${run}: view ready ${(ready / 1000).toFixed(1)} s · freeze after close ${Math.round(await probe.evaluate(() => window.g))} ms`);
  await ctx.close();
}
