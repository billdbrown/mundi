// One-off: a forced lightning flash in the rain, by day and by night (precip.ts).
import { chromium } from 'playwright-core';
const [out] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
await page.goto('http://localhost:5291/#seed=77', { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { const m = window.mundi; m.capture(true); m.view.setOptions({ light: 'cycle' }); await m.view.whenReady(); });
await page.evaluate(() => window.mundi.orbit(-174.57, -37.54, 1.012));
for (const hr of [14, 23]) {
  await page.evaluate((h) => window.mundi.view.setLocalHour(h), hr);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${out}/flash-${hr}-off.png` });
  await page.evaluate(() => { const p = window.mundi.view.precip; p.flashT = 0; p.flashPeak = 1; });
  await page.waitForTimeout(20);
  await page.screenshot({ path: `${out}/flash-${hr}-on.png` });
}
await browser.close();
