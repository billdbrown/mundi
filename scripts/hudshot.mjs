/**
 * The hex view's HUD (hexui.ts) next to the classic panel: screenshots of each, with the
 * popovers open in turn, on a desktop screen and a phone.
 *   node scripts/hudshot.mjs <base url> <outdir> [spot=river]
 */
import { chromium } from 'playwright-core';
const [base = 'http://localhost:5293/', out = '.', spot = 'river'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const errors = [];
for (const [vw, vh, tag] of [[1440, 900, 'desk'], [390, 844, 'phone']]) {
  const page = await browser.newPage({ viewport: { width: vw, height: vh }, deviceScaleFactor: tag === 'phone' ? 2 : 1 });
  page.on('pageerror', (e) => errors.push(e.message));
  for (const ui of ['hud', 'classic']) {
    await page.goto('about:blank');
    await page.goto(`${base}hex.html#seed=1&spot=${spot}${ui === 'classic' ? '&ui=classic' : ''}`);
    await page.waitForFunction(() => window.hex?.map && !window.hex.busy, null, { timeout: 120000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${out}/${tag}-${ui}.png` });
    if (ui === 'hud') {
      for (const [i, n] of [[1, 'layers'], [2, 'settings']]) {
        await page.locator('.hud-rail > button').nth(i).click();
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${out}/${tag}-hud-${n}.png` });
      }
      await page.locator('.hud-top .hud-icon').click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${out}/${tag}-hud-about.png` });
    }
  }
  await page.close();
}
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
