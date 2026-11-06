/**
 * The hex view's camera (hexcamera.ts) driven by synthetic input: pan, turn, zoom in to the
 * limit and out to it, with a screenshot after each and the camera pose printed.
 *   node scripts/camtest.mjs <base url> <outdir> [spot=mountain]
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
const pose = () => page.evaluate(() => { const c = window.hex.scene.parent ?? null; return null; });
const cam = async (label) => {
  await page.waitForTimeout(900);
  const p = await page.evaluate(() => window.hex.camPose());
  console.log(label.padEnd(12), p);
  await page.screenshot({ path: `${out}/${spot}-${label}.png` });
};
await cam('start');
// Right-drag pan 300 px left.
await page.mouse.move(640, 400); await page.mouse.down({ button: 'right' });
for (let i = 1; i <= 20; i++) { await page.mouse.move(640 - i * 15, 400); await page.waitForTimeout(16); }
await page.mouse.up({ button: 'right' });
await cam('pan');
// Middle-drag turn.
await page.mouse.move(640, 400); await page.mouse.down({ button: 'middle' });
for (let i = 1; i <= 20; i++) { await page.mouse.move(640 + i * 15, 400 - i * 3); await page.waitForTimeout(16); }
await page.mouse.up({ button: 'middle' });
await cam('turn');
// Zoom in hard (to the limit), then out hard.
await page.mouse.move(700, 450);
for (let i = 0; i < 40; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(20); }
await cam('zoomin');
for (let i = 0; i < 60; i++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(20); }
await cam('zoomout');
// Keys.
await page.keyboard.down('KeyW'); await page.waitForTimeout(600); await page.keyboard.up('KeyW');
await page.keyboard.down('KeyQ'); await page.waitForTimeout(400); await page.keyboard.up('KeyQ');
await cam('keys');
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
