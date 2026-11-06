/**
 * The hex card (hexcard.ts): click a land hex near the middle of the planet, time the picture
 * arriving, screenshot, then Enter and check the hex view opened.
 *   node scripts/cardtest.mjs <base url> <outdir>
 */
import { chromium } from 'playwright-core';
const [base = 'http://localhost:5293/', out = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}#seed=77`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world && window.mundi.view.gateReady, null, { timeout: 240000 });
await page.waitForTimeout(6000);
const pickLand = (k) => page.evaluate((k) => {
  const w = window.mundi.world, v = window.mundi.view, cands = [];
  for (let c = 0; c < w.grid.count; c += 7) {
    if (w.water[c] !== 0) continue;
    const s = v.screenOf(c);
    if (s && s.front) cands.push([Math.hypot(s.x - innerWidth * 0.45, s.y - innerHeight * 0.5), c, s.x, s.y]);
  }
  cands.sort((a, b) => a[0] - b[0]);
  return cands[k];
}, k);
for (const [i, k] of [[1, 0], [2, 40], [3, 80]]) {
  const [, c, x, y] = await pickLand(k);
  await page.keyboard.press('Escape');
  const t0 = Date.now();
  await page.mouse.click(x, y);
  await page.waitForSelector('#hexcard:not([hidden])');
  await page.screenshot({ path: `${out}/card${i}-a.png` });
  await page.waitForSelector('#hexcard.ready', { timeout: 60000 });
  console.log(await page.evaluate(() => document.querySelector('#hexframe').contentDocument.querySelector('#timing').textContent));
  console.log(`cell ${c}: picture in ${Date.now() - t0} ms;`, await page.textContent('#hexcard .body'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/card${i}-b.png` });
}
const t1 = Date.now();
await page.click('#hexcard .enter');
await page.waitForFunction(() => document.querySelector('#hexframe.open') && document.querySelector('#hexframe').contentWindow.hex?.map && !document.querySelector('#hexframe').contentWindow.hex.busy, null, { timeout: 60000 });
console.log(`entered, hex ready in ${Date.now() - t1} ms`);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/card-entered.png` });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
