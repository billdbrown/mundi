/**
 * Ad-hoc screenshots of a running dev server in a local Edge: orbit, far side, a zoomed view,
 * and a close-up of a named spot. For repeatable comparisons use scripts/visual.mjs instead.
 * Usage: [ZOOM=n] [SPOT=coast|river|mountain] [ALT=1.1] node scripts/shot.mjs <url> <outdir>
 */
import { chromium } from 'playwright-core';
const [url = 'http://localhost:5173/', out = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForFunction(() => document.querySelector('#stats')?.textContent);
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/orbit.png` });
// Drag to spin the globe round and shoot the far side.
await page.mouse.move(900, 400); await page.mouse.down();
await page.mouse.move(250, 400, { steps: 20 }); await page.mouse.up();
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/orbit-back.png` });
console.log('stats:', await page.textContent('#stats'));
// Zoom in close to the surface.
await page.mouse.move(640, 400);
for (let i = 0; i < Number(process.env.ZOOM ?? 8); i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/close.png` });
// Fly to a coastline and look along it at an angle, for judging water and shores.
const coast = await page.evaluate(([alt, spot]) => window.worldgen.flyTo(spot, alt),
  [Number(process.env.ALT ?? 1.06), process.env.SPOT ?? 'coast']);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/coast.png` });
console.log('coast cell', coast);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
