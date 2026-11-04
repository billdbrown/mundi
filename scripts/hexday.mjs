/**
 * One hex through a day: a screenshot per hour, for judging the time-of-day lighting.
 * Usage: [CELL=12010] [STYLE=golden] [HOURS=5.5,6.3,...] [W=1280 H=800] node scripts/hexday.mjs <base url> <outdir>
 */
import { chromium } from 'playwright-core';
const [base = 'http://localhost:5173/', out = '.'] = process.argv.slice(2);
const cell = process.env.CELL ?? '12010', style = process.env.STYLE ?? 'golden';
const hours = (process.env.HOURS ?? '5.5,6.3,9,12,16,17.6,18.2,19,23').split(',').map(Number);
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`${base}hex.html#seed=1&cell=${cell}&style=${style}`);
await page.waitForFunction(() => window.hex?.map && !window.hex.busy, null, { timeout: 180000 });
await page.waitForFunction(() => window.hex.scene.getObjectByName('context'), null, { timeout: 60000 }).catch(() => {});
await page.evaluate(() => window.hex.capture(true));
for (const hr of hours) {
  await page.evaluate((t) => window.hex.setTime(t), hr);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${cell}-${style}-${String(hr).replace('.', '_')}.png` });
  console.log(hr);
}
console.log(errors.length ? errors : 'no page errors');
await browser.close();
