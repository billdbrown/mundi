/**
 * Visual regression tests: render a fixed set of worlds and camera views with animation frozen,
 * compare each against a saved baseline, and write an HTML report with diffs and timings.
 *
 *   npm run visual                  compare against baselines (exit 1 if anything changed)
 *   npm run visual -- --update      accept the current renders as the new baselines
 *   npm run visual -- --only coast  run cases whose name contains "coast"
 *
 * Starts its own Vite server and drives a local Edge (BROWSER=chrome to switch). Renders are
 * deterministic on one machine and GPU; a different GPU will differ slightly, so baselines
 * belong to the machine that made them.
 */
import { createServer } from 'vite';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'test', 'visual');
const BASE = path.join(DIR, 'baseline'), CUR = path.join(DIR, 'current'), DIFF = path.join(DIR, 'diff');
const W = 960, H = 600;
/** Share of pixels allowed to differ before a case counts as changed. */
const TOLERANCE = 0.001;

const ORBIT = 3.2;
const CASES = [
  { name: 'earth-77-front', hash: 'seed=77', view: { orbit: [0, 15, ORBIT] } },
  { name: 'earth-77-back', hash: 'seed=77', view: { orbit: [180, 15, ORBIT] } },
  { name: 'earth-77-coast', hash: 'seed=77', view: { spot: 'coast', alt: 1.09 } },
  { name: 'earth-77-river', hash: 'seed=77', view: { spot: 'river', alt: 1.16 } },
  { name: 'earth-77-mouth', hash: 'seed=77', view: { spot: 'mouth', alt: 1.1 } },
  { name: 'earth-4242-mouth', hash: 'seed=4242', view: { spot: 'mouth', alt: 1.1 } },
  { name: 'dryriver-77', hash: 'seed=77', view: { spot: 'dryriver', alt: 1.3 } },
  { name: 'dryriver-77-photo', hash: 'seed=77', opts: { look: 'photo' }, view: { spot: 'dryriver', alt: 1.3 } },
  { name: 'dryriver-4242-photo', hash: 'seed=4242', opts: { look: 'photo' }, view: { spot: 'dryriver', alt: 1.15 } },
  { name: 'earth-77-lake', hash: 'seed=77', view: { spot: 'lake', alt: 1.14 } },
  { name: 'earth-77-desert', hash: 'seed=77', view: { spot: 'desert', alt: 1.08 } },
  { name: 'earth-77-mountain', hash: 'seed=77', view: { spot: 'mountain', alt: 1.28 } },
  { name: 'tiles-77', hash: 'seed=77', opts: { style: 'tiles' }, view: { orbit: [180, 15, ORBIT] } },
  { name: 'tiles-77-coast', hash: 'seed=77', opts: { style: 'tiles' }, view: { spot: 'coast', alt: 1.12 } },
  { name: 'elevation-77', hash: 'seed=77', opts: { mode: 'elevation' }, view: { orbit: [180, 15, ORBIT] } },
  { name: 'earth-4242', hash: 'seed=4242', view: { orbit: [60, 20, ORBIT] } },
  { name: 'earth-4242-coast', hash: 'seed=4242', view: { spot: 'coast', alt: 1.1 } },
  { name: 'pangaea-1903', hash: 'seed=1903&continents=1&ocean=0.55', view: { orbit: [0, 25, ORBIT] } },
  { name: 'daynight-77', hash: 'seed=77', opts: { light: 'cycle' }, view: { orbit: [75, 15, ORBIT] } },
  { name: 'sites-4242', hash: 'seed=4242', opts: { sites: true }, view: { orbit: [60, 20, ORBIT] } },
  { name: 'photo-77', hash: 'seed=77', opts: { look: 'photo' }, view: { orbit: [180, 15, ORBIT] } },
  { name: 'flat-77', hash: 'seed=77', opts: { look: 'photo' }, map: true, view: { orbit: [180, 0, ORBIT] } },
  { name: 'flat-77-map', hash: 'seed=77', opts: { look: 'map', grid: true, clouds: false }, map: true, view: { orbit: [180, 0, ORBIT] } },
  { name: 'photo-4242', hash: 'seed=4242', opts: { look: 'photo' }, view: { orbit: [60, 20, ORBIT] } },
  { name: 'nwinter-77', hash: 'seed=77', day: 353, view: { orbit: [180, 40, ORBIT] } },
  { name: 'nsummer-77', hash: 'seed=77', day: 171, view: { orbit: [180, 40, ORBIT] } },
  { name: 'iceage-1903', hash: 'seed=1903&heat=-0.3', view: { orbit: [0, 45, ORBIT] } },
];

const args = process.argv.slice(2);
const update = args.includes('--update');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const cases = CASES.filter((c) => !only || c.name.includes(only));

for (const d of [BASE, CUR, DIFF]) fs.mkdirSync(d, { recursive: true });

// Page-load limit; VISUAL_TIMEOUT (seconds) raises it when the machine is busy (shader compiles slow).
const LOAD_MS = Number(process.env.VISUAL_TIMEOUT ?? 30) * 1000;
const server = await createServer({ root: ROOT, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });

const results = [];
try {
  // One page for every case: worlds are swapped in place with mundi.load(), so the app's
  // modules are fetched once. (Reloading per case was slower and flaky when ports were scarce.)
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  let errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push(m.text()); });
  const openPage = async () => {
    for (let attempt = 1; ; attempt++) {
      try { await page.goto(url, { timeout: LOAD_MS }); await page.waitForFunction(() => window.mundi?.world, null, { timeout: LOAD_MS }); await page.evaluate(async () => {
        await window.mundi.ready(); await window.mundi.view.whenReady();
        // Every look's shaders before the first case (the background compile, hurried).
        const v = window.mundi.view; v.hurryCompiles();
        await new Promise((res) => { const c = () => (v.otherLookReady ? res() : setTimeout(c, 200)); c(); });
      }); return; }
      catch (e) { if (attempt >= 3) throw e; console.log(`load failed (${e.message.split(/\r?\n/)[0]}), retrying`); }
    }
  };
  await openPage();
  // A case that never finishes (say, the page threw while drawing) fails after this long
  // instead of hanging the whole run.
  const CASE_TIMEOUT = Math.max(60000, 2 * LOAD_MS);
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out after ${CASE_TIMEOUT / 1000} s`)), CASE_TIMEOUT))]);
  for (const tc of cases) {
    errors = [];
    let timings;
    try {
      timings = await withTimeout(runCase(tc));
    } catch (e) {
      errors.push(e.message.split(/\r?\n/)[0]);
      results.push({ name: tc.name, file: `${tc.name}.png`, timings: { gen: 0, mesh: 0 }, errors: [...errors], status: 'error', ratio: null });
      console.log(`error    ${tc.name}`);
      for (const m of errors) console.log(`         ! ${m}`);
      await openPage();                       // the page may be wedged; start fresh for the next case
      continue;
    }
    await finishCase(tc, timings);
  }
  async function runCase(tc) {
    return page.evaluate(async (tc) => {
      const wg = window.mundi;
      wg.capture(true);
      wg.freeze(10);
      await wg.load(tc.hash, tc.opts ?? {});
      wg.view.setDay(tc.day ?? 80);
      wg.view.setMap(false);
      if (tc.view.orbit) wg.orbit(...tc.view.orbit);
      else wg.flyTo(tc.view.spot, tc.view.alt);
      if (tc.map) wg.view.setMap(true);   // the flat map opens centred on where the globe looked
      await wg.view.whenReady();          // shaders compiled (render.ts's gate), map switch done
      // Two frames: one to apply the camera, one to draw with it.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return wg.timings;
    }, tc);
  }
  async function finishCase(tc, timings) {
    await page.waitForTimeout(250);
    const file = `${tc.name}.png`;
    await page.screenshot({ path: path.join(CUR, file) });

    const r = { name: tc.name, file, timings, errors, status: 'new', ratio: null };
    const basePath = path.join(BASE, file);
    if (fs.existsSync(basePath)) {
      const a = PNG.sync.read(fs.readFileSync(basePath));
      const b = PNG.sync.read(fs.readFileSync(path.join(CUR, file)));
      if (a.width !== b.width || a.height !== b.height) {
        r.status = 'changed'; r.ratio = 1;
      } else {
        const diff = new PNG({ width: a.width, height: a.height });
        const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.03, includeAA: false });
        fs.writeFileSync(path.join(DIFF, file), PNG.sync.write(diff));
        r.ratio = n / (a.width * a.height);
        r.status = r.ratio > TOLERANCE ? 'changed' : 'same';
      }
    }
    if (errors.length) r.status = 'error';
    if (update) fs.copyFileSync(path.join(CUR, file), basePath);
    results.push(r);
    const pct = r.ratio === null ? '   —  ' : `${(r.ratio * 100).toFixed(2).padStart(5)}%`;
    console.log(`${r.status.padEnd(8)} ${pct}  gen ${String(timings.gen).padStart(4)} ms  mesh ${String(timings.mesh).padStart(4)} ms  clouds ${String(timings.clouds ?? 0).padStart(4)} ms  ${tc.name}`);
    for (const e of errors) console.log(`         ! ${e}`);
  }
} finally {
  await browser.close();
  await server.close();
}

// Report: baseline | current | diff per case, changed ones first.
const order = { error: 0, changed: 1, new: 2, same: 3 };
results.sort((a, b) => order[a.status] - order[b.status]);
const rows = results.map((r) => `
  <section class="${r.status}">
    <h2>${r.name} <span>${r.status}${r.ratio !== null ? ` · ${(r.ratio * 100).toFixed(2)}% pixels differ` : ''} · gen ${r.timings.gen} ms · mesh ${r.timings.mesh} ms</span></h2>
    ${r.errors.map((e) => `<p class="err">${e.replace(/</g, '&lt;')}</p>`).join('')}
    <div class="imgs">
      <figure><img src="baseline/${r.file}" onerror="this.replaceWith('no baseline')"><figcaption>baseline</figcaption></figure>
      <figure><img src="current/${r.file}"><figcaption>current</figcaption></figure>
      <figure><img src="diff/${r.file}" onerror="this.replaceWith('—')"><figcaption>diff</figcaption></figure>
    </div>
  </section>`).join('');
fs.writeFileSync(path.join(DIR, 'report.html'), `<!doctype html><meta charset="utf-8"><title>mundi visual report</title>
<style>
  body { background: #0b0e14; color: #dfe6f0; font: 14px system-ui, sans-serif; margin: 16px; }
  h1 { font-size: 18px; } h2 { font-size: 15px; margin: 18px 0 6px; } h2 span { color: #8a96a8; font-weight: normal; }
  .changed h2 { color: #ffb454; } .error h2, .err { color: #ff6b6b; } .new h2 { color: #6fb3ff; }
  .imgs { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  figure { margin: 0; } img { width: 100%; display: block; border: 1px solid #222; } figcaption { color: #8a96a8; font-size: 12px; }
</style>
<h1>mundi visual report ${update ? '(baselines updated)' : ''} — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}</h1>
${rows}`);

const changed = results.filter((r) => r.status === 'changed' || r.status === 'error');
console.log(`\n${results.length} cases · ${changed.length} changed/error · report: test/visual/report.html${update ? ' · baselines updated' : ''}`);
process.exit(!update && changed.length ? 1 : 0);
