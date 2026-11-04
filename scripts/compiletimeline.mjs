// When is Mundi compiling? The page logs its own compile state every 250 ms; read once at the end.
import { chromium } from 'playwright-core';
const secs = Number(process.argv[2] ?? 150), url = process.env.LOOK_URL ?? 'https://mundi.bill.computer/';
const browser = await chromium.launch({ headless: false, channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addInitScript(() => {
  window.__tl = []; let last = ''; const t0 = performance.now();
  setInterval(() => {
    const v = window.mundi?.view, p = v?.renderer?.info?.programs; if (!p) return;
    const s = `${p.length} programs, ${p.filter(x => !x.isReady()).length} compiling · gate ${!!v.gateReady} low ${!!v.lowReady} map ${!!v.mapReady}`;
    if (window.__hurry) v.hurryCompiles?.(); const o = v.otherLookReady; const s2 = s + ' other ' + !!o; if (s2 !== last) { last = s2; window.__tl.push(((performance.now() - t0) / 1000).toFixed(1).padStart(6) + '  ' + s2); } if (false) { window.__tl.push(((performance.now() - t0) / 1000).toFixed(1).padStart(6) + '  ' + s); last = s; }
  }, 250);
});
const page = await ctx.newPage();
page.goto(url, { timeout: 0 }).catch(() => {});
await new Promise(r => setTimeout(r, secs * 1000));
console.log((await page.evaluate(() => window.__tl)).join('\n'));
await browser.close();
