/**
 * Screenshots of the running dev server in a local Edge, for checking the look without a person.
 * Usage: node scripts/shot.mjs <url> <outdir>
 */
import { chromium } from 'playwright-core';
const [url = 'http://localhost:5173/', out = '.'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto(url);
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/orbit.png` });
console.log('stats:', await page.textContent('#stats'));
// Zoom in close to the surface.
await page.mouse.move(640, 400);
for (let i = 0; i < Number(process.env.ZOOM ?? 8); i++) { await page.mouse.wheel(0, -300); await page.waitForTimeout(60); }
await page.waitForTimeout(1200);
await page.screenshot({ path: `${out}/close.png` });
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
