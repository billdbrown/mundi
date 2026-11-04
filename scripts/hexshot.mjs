/**
 * Screenshots of the hex view for a few kinds of spot, from above and (WALK=1) at eye level.
 * Usage: [SPOTS=river,mountain,coast] [WALK=1] node scripts/hexshot.mjs <base url> <outdir>
 * base url is the dev server root, e.g. http://localhost:5173/
 */
import { chromium } from 'playwright-core';
const [base = 'http://localhost:5173/', out = '.'] = process.argv.slice(2);
const spots = (process.env.SPOTS ?? 'river,mountain,coast').split(',');
const variants = ['default'];
const seed = process.env.SEED ?? '1';
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const settle = async () => {
  await page.waitForFunction(() => window.hex?.map && !window.hex.busy, null, { timeout: 120000 });
  await page.waitForTimeout(700);
};
for (const spot of spots) {
  await page.goto("about:blank");
  await page.goto(`${base}hex.html#seed=${seed}&spot=${spot}`);
  await settle();
  for (const v of variants) {
    await page.evaluate(() => window.hex.resetView());
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${out}/${spot}-${v}.png` });
    if (process.env.WALK) {
      // Eye level near the centre, looking across the hex.
      await page.evaluate(() => { const m = window.hex.map; window.hex.look(m.size * 0.08, -m.size * 0.2, 1.7, -m.size * 0.1, m.size * 0.25); });
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${out}/${spot}-${v}-eye.png` });
    }
    console.log(spot, v, await page.textContent('#facts'), '|', await page.textContent('#timing'));
  }
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
