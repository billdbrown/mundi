/**
 * Rivers against the ground under them: reads the ground patch's captured heights and baked
 * relief back from the GPU and compares, along the rivers near the view's centre, the water's
 * drawn height with the ground's at the centreline and beside it.
 *
 *   node scripts/riverprobe.mjs [seed=77] [cell] [alt=1.012]
 */
import { chromium } from 'playwright-core';
const [seed = '77', cellArg, alt = '1.012'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await (await browser.newContext({ viewport: { width: 900, height: 600 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e).slice(0, 300)));
await page.goto(`http://localhost:5291/#seed=${seed}`, { timeout: 240000 });
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 240000 });
await page.evaluate(async () => { const m = window.mundi; m.capture(true); await m.view.whenReady(); });
await page.waitForFunction(() => window.mundi.view.terrainShadow.valleys.ready, null, { timeout: 300000, polling: 200 });
const cell = Number(cellArg ?? 11496);
await page.evaluate(([c, h]) => {
  const w = window.mundi.world, P = w.grid.centers;
  window.mundi.orbit(Math.atan2(P[c * 3], P[c * 3 + 2]) * 57.2958, Math.asin(P[c * 3 + 1]) * 57.2958, h);
}, [cell, Number(alt)]);
await page.waitForTimeout(6000);
const res = await page.evaluate(() => {
  const v = window.mundi.view, dp = v.dunePatch, r = v.renderer, THREE_N = 288, PR = 0.05, A = 0.15;
  const read = (t) => {
    const W = t.width, H = t.height, buf = new Uint16Array(W * H * 4);
    r.readRenderTargetPixels(t, 0, 0, W, H, buf);
    const f = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) {   // half to float
      const h = buf[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
      f[i] = s * (e === 0 ? m / 1024 * 2 ** -14 : e === 31 ? NaN : (1 + m / 1024) * 2 ** (e - 15));
    }
    return { W, H, f };
  };
  const capA = read(dp.capA), capR = read(dp.capR), b0 = read(dp.bake[0]);
  const u = dp.u, C = u.uPatchC.value, E = u.uPatchE.value, Nn = u.uPatchN.value;
  const samp = (t, uvx, uvy) => {
    const x = Math.min(t.W - 1, Math.max(0, Math.floor(uvx * t.W))), y = Math.min(t.H - 1, Math.max(0, Math.floor(uvy * t.H)));
    const i = (y * t.W + x) * 4; return [t.f[i], t.f[i + 1], t.f[i + 2], t.f[i + 3]];
  };
  const gridT = (x) => { const ax = Math.min(Math.abs(x) / PR, 1); return Math.sign(x) * (-A + Math.sqrt(A * A + 4 * (1 - A) * ax)) / (2 * (1 - A)); };
  const cam = v.camera.position;
  // Ground (radius) under direction p, as the patch draws it, and the lift things on it get.
  const at = (p) => {
    const lat = [p[0] * E.x + p[1] * E.y + p[2] * E.z, p[0] * Nn.x + p[1] * Nn.y + p[2] * Nn.z];
    const ca = samp(capA, lat[0] / (2 * PR) + 0.5, lat[1] / (2 * PR) + 0.5);
    const gu = (gridT(lat[0]) * 0.5 + 0.5) * (THREE_N - 1) / THREE_N + 0.5 / THREE_N, gv = (gridT(lat[1]) * 0.5 + 0.5) * (THREE_N - 1) / THREE_N + 0.5 / THREE_N;
    const b = samp(b0, gu, gv);
    const far = 1 - Math.min(1, Math.max(0, (Math.hypot(p[0] - cam.x, p[1] - cam.y, p[2] - cam.z) - 0.08) / 0.14));
    const rr = samp(capR, lat[0] / (2 * PR) + 0.5, lat[1] / (2 * PR) + 0.5);
    return { base: 1 + ca[0] / 50, liftC: b[0], ero: b[1] * far, chan: b[3], water: rr[0], ground: 1 + ca[0] / 50 + b[0] + b[1] * far + b[3], follow: b[0] + b[1] * far };
  };
  const g = v.rivers.geometry.getAttribute('position'), rows = [];
  for (let i = 0; i + 1 < g.count; i += 2) {
    const a = [g.getX(i), g.getY(i), g.getZ(i)], bq = [g.getX(i + 1), g.getY(i + 1), g.getZ(i + 1)];
    const m = [(a[0] + bq[0]) / 2, (a[1] + bq[1]) / 2, (a[2] + bq[2]) / 2], l = Math.hypot(...m), d = m.map((x) => x / l);
    const cd = Math.acos(Math.min(1, d[0] * C.x + d[1] * C.y + d[2] * C.z)); if (cd > 0.045) continue;
    const side = [bq[0] - a[0], bq[1] - a[1], bq[2] - a[2]].map((x) => x / l), hw = Math.hypot(...side) / 2;
    const s0 = at(d);
    const water = l + s0.follow - 0.0004;   // (dunes.ts RIVER_SINK)
    const off = (k) => { const q = d.map((x, j) => x + side[j] * k); const n = Math.hypot(...q); return at(q.map((x) => x / n)).ground; };
    rows.push({ cd, water, mid: s0.ground, w: hw, L3: off(-1.5), R3: off(1.5), L6: off(-3), R6: off(3), carve: s0.liftC, chan: s0.chan, mask: s0.water });
    if (rows.length > 4000) break;
  }
  return rows;
});
const fmt = (x) => (x * 1e4).toFixed(1).padStart(6);
console.log('units 1e-4 radius. water-mid, water-bank at 0.75w/1.5w each side (+ = water above ground), carve, chan, mask, halfwidth');
for (let i = 0; i < res.length; i += Math.max(1, Math.floor(res.length / 40))) {
  const r = res[i];
  console.log([r.water - r.mid, r.water - r.L3, r.water - r.R3, r.water - r.L6, r.water - r.R6, r.carve, r.chan].map(fmt).join(' '), r.mask.toFixed(2), fmt(r.w));
}
for (const [lo, hi] of [[0, 0.01], [0.01, 0.02], [0.02, 0.03], [0.03, 0.045]]) {
  const rs = res.filter((r) => r.cd >= lo && r.cd < hi); if (!rs.length) continue;
  const q = (f) => { const a = rs.map(f).sort((x, y) => x - y); return [0.5, 0.9, 1].map((k) => fmt(a[Math.min(a.length - 1, Math.floor(a.length * k))])).join(''); };
  console.log(`dist ${lo}-${hi} n=${rs.length}  water-mid ${q((r) => r.water - r.mid)}  water-bank ${q((r) => Math.max(r.water - r.L3, r.water - r.R3))}  water-3w ${q((r) => Math.max(r.water - r.L6, r.water - r.R6))}  carve ${q((r) => -r.carve)}`);
}
const worst = res.map((r) => Math.max(r.water - r.L3, r.water - r.R3));
worst.sort((a, b) => b - a);
console.log('rows', res.length, 'water above bank (1.5w), p50/p90/max', fmt(worst[Math.floor(worst.length / 2)]), fmt(worst[Math.floor(worst.length * 0.1)]), fmt(worst[0]));
if (errors.length) console.log(errors.join('\n'));
await browser.close();
