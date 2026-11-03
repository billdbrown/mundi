// Frames of one group in motion (fauna.ts), to check the movement.
import { chromium } from 'playwright-core';
const [out, kind = 'rabbit', size = '10'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
await page.goto(`http://localhost:5291/?fauna=${size}&floor=0.0025#seed=77`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { window.mundi.capture(true); await window.mundi.view.whenReady(); });
await page.evaluate(async (kind) => {
  const v = window.mundi.view, w = window.mundi.world, f = v.fauna, u = v.cloudU;
  let found = null;
  for (let c = 0; c < w.grid.count && !found; c++) for (const g of f.groupsOf(c)) if (g.kind === kind && v.precip.coverAt(g.home, v.weatherDays, u.uCloudTime.value, u.uStorms.value) < 0.5) { found = g; break; }
  const p = found.home;
  window.mundi.orbit(Math.atan2(p.x, p.z) * 57.2958, Math.asin(p.y) * 57.2958, 1.002);
  await new Promise((r) => setTimeout(r, 1500));
  const q = found.at; window.mundi.orbit(Math.atan2(q.x, q.z) * 57.2958, Math.asin(q.y) * 57.2958, 1.002);
}, kind);
await page.waitForTimeout(1500);
for (let i = 0; i < 8; i++) { await page.screenshot({ path: `${out}/seq-${kind}-${i}.png` }); await page.waitForTimeout(120); }
await browser.close();
