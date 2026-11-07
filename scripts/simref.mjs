// Primundi reference run: a fixed game played through the debug handle and the card buttons, with
// the dice pinned, the save dumped. For refactors of the rules (sim.ts): run it before and after
// and compare the two files; they should be identical.
// node scripts/simref.mjs http://localhost:5173 before.json [seed]
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const [base, outFile, seed = 'zalund'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`${base}/primundi.html`);
await page.evaluate(() => localStorage.clear());
await page.reload();
await page.waitForSelector('#launch form');
await page.fill('#civ', 'Test Caravan');
await page.fill('#seed', seed);
await page.click('#begin');
await page.waitForFunction(() => { const f = document.getElementById('hexframe'); return f && f.contentWindow?.hex?.map && !f.contentWindow.hex.busy; }, null, { timeout: 240000 });
await page.waitForTimeout(1000);
const result = await page.evaluate(() => {
  const p = window.primundi, s = p.save, a = p.atlas, w = p.world;
  // Pinned dice.
  let x = 12345;
  const orig = Math.random;
  Math.random = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const trace = [];
  const card = () => document.getElementById('card');
  const click = (sel) => { const b = card()?.querySelector(sel); if (b && !b.disabled) { b.click(); return true; } return false; };
  // Deal with whatever card is up: choose the first option, go on, appoint the first.
  const settle = () => {
    for (let k = 0; k < 6; k++) {
      if (click('[data-act="choose"]')) { trace.push(`chose @${s.day.toFixed(2)}`); continue; }
      if (click('[data-act="after"]')) continue;
      if (click('[data-act="appoint"]')) continue;
      break;
    }
  };
  try {
    p.closeHex();
    const home = s.home;
    // Market: buy three of the first good on sale; supplies: ten days of food; the notice board: take the first job.
    p.openTown(home, 'market');
    for (let i = 0; i < 3; i++) click('[data-act="buy"]:not([disabled])');
    p.openTown(home, 'supplies'); click('[data-act="rations"][data-n="10"]');
    p.openTown(home, 'work'); click('[data-act="take"]');
    p.openTown(home, 'rest'); click('[data-act="hire"]');
    click('[data-act="close"]');
    trace.push(`after town: orrels ${s.caravan.orrels} cargo ${s.caravan.cargo.join(',')} jobs ${s.jobs.length}`);
    // Travel: to the nearest other known place, then on to the next, a few legs.
    for (let leg = 0; leg < 4; leg++) {
      const known = a.places.filter((q) => s.revealed.includes(q.cell) && q.cell !== s.cell);
      const P = w.grid.centers, h = s.cell;
      const d = (c) => Math.acos(Math.min(1, P[c * 3] * P[h * 3] + P[c * 3 + 1] * P[h * 3 + 1] + P[c * 3 + 2] * P[h * 3 + 2]));
      known.sort((q, r) => d(q.cell) - d(r.cell));
      const to = known[leg % Math.max(1, known.length)];
      if (!to) break;
      p.travelTo(to.cell);
      trace.push(`leg ${leg} to ${to.name} route ${s.route.length}`);
      for (let t = 0; t < 400 && s.route.length; t++) { p.advance(0.25); settle(); }
      p.closeHex(); settle();
      // Sell everything carried, here.
      const pid = a.placeAt[s.cell];
      if (pid >= 0) {
        p.openTown(pid, 'market');
        for (let k = 0; k < 20; k++) if (!click('[data-act="sell"]:not([disabled])')) break;
        p.openTown(pid, 'supplies'); click('[data-act="charts"]');
        p.openTown(pid, 'rest'); click('[data-act="rest"][data-n="1"]');
        p.openTown(pid, 'tavern'); click('[data-act="round"]');
        click('[data-act="close"]');
      }
      trace.push(`at ${s.cell} day ${s.day.toFixed(3)} orrels ${s.caravan.orrels} earned ${s.caravan.earned.toFixed(1)} alive ${s.caravan.members.filter((m) => m.alive).length}`);
    }
    // A few days idle.
    for (let t = 0; t < 40; t++) { p.advance(0.25); settle(); }
  } finally { Math.random = orig; }
  return { trace, save: JSON.parse(JSON.stringify(s)) };
});
writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(result.trace.join('\n'));
console.log(logs.join('\n'));
await browser.close();
