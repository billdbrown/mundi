/**
 * Every hex style on every gallery hex, from each style's own camera, plus an HTML page laying
 * them out side by side (rows: hexes, columns: styles) with each style's frame rate.
 * Usage: [CELLS=12010,15979] [STYLES=tabletop,earth] [EYE=1] node scripts/hexgallery.mjs <base url> <outdir>
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const [base = 'http://localhost:5173/', out = '.'] = process.argv.slice(2);
const cells = (process.env.CELLS ?? '12010,15979,11783,5602,35274').split(',');
const names = { 12010: 'River', 15979: 'Forest', 11783: 'Coast', 5602: 'Mountain', 35274: 'Desert' };
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
const settle = async () => {
  await page.waitForFunction(() => window.hex?.map && !window.hex.busy, null, { timeout: 180000 });
  // The backdrop of neighbouring hexes follows the hex.
  await page.waitForFunction(() => window.hex.scene.getObjectByName('context'), null, { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(600);
};
const styles = process.env.STYLES ? process.env.STYLES.split(',') : null;
const rows = [];
let allStyles = [];
for (const cell of cells) {
  await page.goto('about:blank');
  await page.goto(`${base}hex.html#seed=1&cell=${cell}`);
  await settle();
  allStyles = styles ?? await page.evaluate(() => [...document.querySelectorAll('#styles button')].map((b) => b.dataset.id));
  const row = { cell, shots: [] };
  for (const st of allStyles) {
    await page.evaluate((id) => { window.hex.pickStyle(id); window.hex.capture(true); }, st);
    await page.waitForTimeout(1600);                 // let the fps meter settle
    const fps = await page.textContent('#fps');
    const file = `${cell}-${st}.png`;
    await page.screenshot({ path: `${out}/${file}` });
    let eye = null;
    if (process.env.EYE) {
      await page.evaluate(() => { const m = window.hex.map; window.hex.look(m.size * 0.06, -m.size * 0.12, 1.7, -m.size * 0.05, m.size * 0.2); });
      await page.waitForTimeout(500);
      eye = `${cell}-${st}-eye.png`;
      await page.screenshot({ path: `${out}/${eye}` });
    }
    row.shots.push({ st, file, eye, fps });
    console.log(cell, st, fps);
  }
  rows.push(row);
}
const html = `<!doctype html><meta charset="utf-8"><title>Hex styles</title>
<style>body{font:13px system-ui;background:#1b1f24;color:#ddd;margin:16px}table{border-collapse:collapse}
td,th{padding:4px;vertical-align:top}img{width:420px;display:block;border-radius:4px}th{font-weight:600;text-align:left}
small{color:#8a96a0}</style>
<h1>Hex styles</h1><p>Rows: gallery hexes (seed 1). Columns: styles. Frame rates are this machine's, not the old laptop's.</p>
<table><tr><th></th>${allStyles.map((s) => `<th>${s}</th>`).join('')}</tr>
${rows.map((r) => `<tr><th>${names[r.cell] ?? ''}<br><small>${r.cell}</small></th>${r.shots.map((s) => `<td><a href="${s.file}"><img src="${s.file}"></a>${s.eye ? `<a href="${s.eye}"><img src="${s.eye}"></a>` : ''}<small>${s.fps ?? ''}</small></td>`).join('')}</tr>`).join('\n')}
</table>`;
fs.writeFileSync(`${out}/index.html`, html);
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no page errors');
await browser.close();
