/**
 * The walk mode (hexwalk.ts): drag the figure onto the map, walk, sprint, jump, look, and Esc
 * back; screenshots along the way and the camera pose.
 *   node scripts/walktest.mjs <base url> <outdir> [spot=mountain]
 */
import { chromium } from 'playwright-core';
const [base = 'http://localhost:5293/', out = '.', spot = 'mountain'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(`${base}hex.html#seed=1&spot=${spot}`);
await page.waitForFunction(() => window.hex?.map && !window.hex.busy, null, { timeout: 120000 });
await page.waitForTimeout(1000);
const shot = async (label, wait = 300) => {
  await page.waitForTimeout(wait);
  console.log(label.padEnd(10), JSON.stringify(await page.evaluate(() => window.hex.camPose())), 'active', await page.evaluate(() => window.hex.walker.active));
  await page.screenshot({ path: `${out}/walk-${label}.png` });
};
const peg = await page.locator('#pegman').boundingBox();
await page.mouse.move(peg.x + peg.width / 2, peg.y + peg.height / 2);
await page.mouse.down();
for (let i = 1; i <= 25; i++) { await page.mouse.move(peg.x - i * 20, peg.y - i * 12); await page.waitForTimeout(16); }
await shot('dragging', 100);
await page.mouse.up();
await shot('gliding', 400);
await shot('landed', 1200);
await page.keyboard.down('KeyW'); await shot('walking', 1500);
await page.keyboard.down('ShiftLeft'); await shot('sprint', 1500);
await page.keyboard.up('ShiftLeft'); await page.keyboard.up('KeyW');
await page.keyboard.press('Space'); await shot('jump', 150);
await shot('stopped', 1200);
await page.keyboard.press('Escape'); await shot('leaving', 500);
await shot('back', 1200);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
