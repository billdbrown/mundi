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
const coast = await page.evaluate((alt) => {
  const { view, world: w } = window.worldgen;
  const g = w.grid, P = g.centers;
  let best = -1, bestScore = -1;
  for (let c = 0; c < g.count; c++) {
    if (w.water[c] !== 1) continue;
    const land = g.neighbors[c].filter((n) => w.water[n] === 0).length;
    const lat = Math.abs(P[c * 3 + 1]);
    const score = land * (lat < 0.5 ? 1 : 0.2) + (w.river[g.neighbors[c].find((n) => w.water[n] === 0) ?? 0] ? 3 : 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  const x = P[best * 3], y = P[best * 3 + 1], z = P[best * 3 + 2];
  // Back off along a tangent so the view is oblique, not straight down.
  let tx = -z, ty = 0, tz = x; const tl = Math.hypot(tx, ty, tz) || 1; tx /= tl; tz /= tl;
  view.camera.position.set(x * alt + tx * 0.06, y * alt, z * alt + tz * 0.06);
  return best;
}, Number(process.env.ALT ?? 1.06));
await page.waitForTimeout(1500);
await page.screenshot({ path: `${out}/coast.png` });
console.log('coast cell', coast);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
