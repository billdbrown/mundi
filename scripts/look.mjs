/**
 * Screenshots for judging the look, by place and height. A dev aid alongside visual.mjs (which
 * is for regressions): shots aim at the most typical cell of a biome, or a debug spot.
 *
 *   node scripts/look.mjs <outdir> <tag> [shot...]
 *
 * A shot is name=seed:target:alt[:lens] (lens: map, elev) (seed may carry more hash, e.g. 77&detail=40), where target is a biome list (b12, b8+9) or a debug
 * spot (desert, river, coast...), bigriver, bigmouth, or @lon,lat. `zoom=seed:target` shoots a descent at several heights.
 * URL from LOOK_URL (default http://localhost:5291/). TOPDOWN=1 looks straight down (no tilt);
 * ERO=0 turns the erosion filter off. HOUR=17 lights by the sun at that local hour;
 * NOSHADOW=1 turns terrain shadows off. Debug switches: NOPATCH, NOWATER, NORIVER (river not drawn),
 * NOTREES, NOPRE (no patch depth pass), PATCHWIRE (patch as wireframe), MAGENTA (clear colour);
 * WAIT=ms after the view settles. Targets also: southmouth[N], the Nth biggest river mouth with
 * the sea to its south, seen from the sea (the low camera looks north).
 */
import { chromium } from 'playwright-core';

const [out = '.', tag = 'look', ...specs] = process.argv.slice(2);
const url = process.env.LOOK_URL ?? 'http://localhost:5291/';
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: Number(process.env.W ?? 1100), height: Number(process.env.H ?? 700) } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 500)); });
await page.goto(url);
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 60000 });

let seedNow = -1;
async function aim(seed, target, alt, lens) {
  if (seed !== seedNow || lens) {
    const opts = lens === 'map' ? { look: 'map', grid: true, clouds: false } : lens === 'elev' ? { mode: 'elevation', grid: false, clouds: false } : { look: 'photo', grid: false, clouds: process.env.CLOUDS === '1' };
    await page.evaluate(([s, o]) => window.mundi.load('seed=' + s, o), [seed, opts]);
    await page.evaluate(() => window.mundi.view.whenReady?.());
    await page.evaluate(() => { window.mundi.capture(true); window.mundi.freeze(10); });
    seedNow = seed;
  }
  return page.evaluate(([t, a]) => {
    const m = window.mundi, w = m.world, P = w.grid.centers;
    if (t === 'bigmouth') {
      // The biggest river where it meets the sea.
      let best = -1;
      for (let c = 0; c < w.grid.count; c++) if (w.river[c] && w.water[c] === 0 && w.grid.neighbors[c].some((n) => w.water[n] === 1) && (best < 0 || w.flow[c] > w.flow[best])) best = c;
      m.orbit(Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958, a);
      return best;
    }
    if (t.startsWith('southmouth')) {
      // A big river mouth with the sea to its south, so the tilted camera (looking north) sees it
      // from the sea: sea in front, river running away. southmouth2 = the second biggest, etc.
      const rank = Number(t.slice(10) || 1), list = [];
      for (let c = 0; c < w.grid.count; c++) {
        if (!w.river[c] || w.water[c] !== 0) continue;
        const n = w.downstream[c], cy = P[c * 3 + 1];
        if (n >= 0 && w.water[n] === 1 && (P[n * 3 + 1] - cy) < -0.6 * Math.hypot(P[n * 3] - P[c * 3], P[n * 3 + 1] - cy, P[n * 3 + 2] - P[c * 3 + 2])) list.push(c);
      }
      list.sort((x, y) => w.flow[y] - w.flow[x]);
      if (!list.length) return -1;   // (none faces south: nothing to aim at)
      const best = list[Math.min(rank, list.length) - 1], dn = w.downstream[best];
      // Aim just inland of the edge the river leaves by.
      const q = [0, 1, 2].map((i) => P[best * 3 + i] * 0.65 + P[dn * 3 + i] * 0.35), ql = Math.hypot(...q);
      m.orbit(Math.atan2(q[0], q[2]) * 57.2958, Math.asin(q[1] / ql) * 57.2958, a);
      return best;
    }
    if (t === 'bigriver') {
      // The biggest river cell away from the sea.
      let best = -1;
      for (let c = 0; c < w.grid.count; c++) if (w.river[c] && w.water[c] === 0 && !w.grid.neighbors[c].some((n) => w.water[n] === 1) && (best < 0 || w.flow[c] > w.flow[best])) best = c;
      m.orbit(Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958, a);
      return best;
    }
    if (/^[0-9]+$/.test(t)) { const c = Number(t); m.orbit(Math.atan2(P[c * 3], P[c * 3 + 2]) * 57.2958, Math.asin(P[c * 3 + 1]) * 57.2958, a); return c; }
    if (t.startsWith('@')) { const [lo, la] = t.slice(1).split(',').map(Number); m.orbit(lo, la, a); return -1; }
    if (t === 'hills') {
      // Upland away from mountains: land cells of middling height in a block of the same.
      const mid = (c) => w.water[c] === 0 && w.elevation[c] > 0.22 && w.elevation[c] < 0.45;
      let best = -1, bd = -1;
      for (let c = 0; c < w.grid.count; c++) {
        if (!mid(c)) continue;
        let n = 0;
        for (const nb of w.grid.neighbors[c]) { if (mid(nb)) n++; for (const n2 of w.grid.neighbors[nb]) if (mid(n2)) n++; }
        if (n > bd) { bd = n; best = c; }
      }
      m.orbit(Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958, a);
      return best;
    }
    if (!t.startsWith('b')) return m.flyTo(t, a);
    const bs = t.slice(1).split('+').map(Number);
    let best = -1, bd = -1;
    for (let c = 0; c < w.grid.count; c++) {
      if (!bs.includes(w.biome[c])) continue;
      let n = 0;
      for (const nb of w.grid.neighbors[c]) { if (bs.includes(w.biome[nb])) n++; for (const n2 of w.grid.neighbors[nb]) if (bs.includes(w.biome[n2])) n++; }
      if (n > bd) { bd = n; best = c; }
    }
    m.orbit(Math.atan2(P[best * 3], P[best * 3 + 2]) * 57.2958, Math.asin(P[best * 3 + 1]) * 57.2958, a);
    return best;
  }, [target, alt]);
}

for (const spec of specs) {
  const name = spec.slice(0, spec.indexOf('=')), rest = spec.slice(spec.indexOf('=') + 1);
  const [seed, target, alt, lens] = rest.split(':');
  if (name === 'zoom') {
    for (const a of [1.6, 1.3, 1.15, 1.08, 1.04, 1.02]) {
      await aim(seed, target, a, lens);
      await page.waitForTimeout(900);
      await page.screenshot({ path: `${out}/${tag}-zoom-${a}.png` });
    }
    continue;
  }
  await aim(seed, target, Number(alt), lens);
  await page.waitForTimeout(2500);
  await aim(seed, target, Number(alt), lens);   // again from close by: a long jump eases on past its mark
  if (process.env.TOPDOWN) await page.evaluate(() => { const v = window.mundi.view; v.tilt = 0; v.applyTilt = () => {}; v.sun.position.set(-2, 1.5, 2.6); });
  if (process.env.ERO) await page.evaluate((e) => { window.mundi.view.cloudU.uErosion.value = Number(e); }, process.env.ERO);
  if (process.env.HOUR) await page.evaluate((h) => { const v = window.mundi.view; v.setOptions({ light: 'cycle' }); v.setLocalHour(Number(h)); }, process.env.HOUR);
  if (process.env.NOSHADOW) await page.evaluate(() => { window.mundi.view.terrainShadow.update = () => { window.mundi.view.terrainShadow.u.uShOn.value = 0; }; });
  if (process.env.DAY) await page.evaluate((d) => { window.mundi.view.day = Number(d); }, process.env.DAY);
  if (process.env.NOPATCH) await page.evaluate(() => { const p = window.mundi.view.dunePatch; p.update = () => { p.mesh.visible = false; p.heightMesh.visible = false; p.u.uPatchOn.value = 0; }; });
  if (process.env.NORIVER) await page.evaluate(() => { const v = window.mundi.view; v.riverMat.colorWrite = false; if (v.streamMat) v.streamMat.colorWrite = false; });
  if (process.env.MAGENTA) await page.evaluate(() => { window.mundi.view.renderer.setClearColor(0xff00ff, 1); });
  if (process.env.NOPRE) await page.evaluate(() => { const p = window.mundi.view.dunePatch; p.depth.visible = false; p.colour.material.depthWrite = true; });
  if (process.env.NOTREES) await page.evaluate(() => { window.mundi.view.setOptions({ trees: false }); });
  if (process.env.NOSNOW) await page.evaluate(() => { window.mundi.view.cloudU.uSnow.value = 0; });
  if (process.env.PEAKSNOW) await page.evaluate((v) => { window.mundi.view.cloudU.uPeakSnow.value = Number(v); }, process.env.PEAKSNOW);
  if (process.env.PATCHWIRE) await page.evaluate(() => { window.mundi.view.dunePatch.colour.material.wireframe = true; });
  if (process.env.NOWATER) await page.evaluate(() => { const v = window.mundi.view; v.water.visible = false; v.applyVisibility = () => {}; });
  // Let the camera settle (it eases after a jump) and the ground patch recentre under it, or
  // shots catch the patch's old place: the plain terrain beyond its edge.
  for (let i = 0, last = ''; i < 60; i++) {
    await page.waitForTimeout(250);
    const st = await page.evaluate(() => {
      const v = window.mundi.view, c = v.camera.position, C = v.dunePatch.u.uPatchC.value, l = c.length();
      return [c.x, c.y, c.z].map((x) => x.toFixed(5)).join() + '|' + (Math.acos(Math.min(1, (c.x * C.x + c.y * C.y + c.z * C.z) / l)) < 0.01);
    });
    if (st === last && st.endsWith('true')) break;
    last = st;
  }
  await page.waitForTimeout(Number(process.env.WAIT ?? 1300));
  await page.screenshot({ path: `${out}/${tag}-${name}.png` });
}
console.log(errors.length ? errors.join('\n') : 'ok');
await browser.close();
