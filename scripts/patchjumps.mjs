/**
 * Where the close-up patch has cliffs: reads its captures and baked relief back from the GPU,
 * rebuilds each grid vertex's height (dunes.ts PATCH_GLSL: ground, valley carve, erosion,
 * channel, sea sink) and lists the steepest steps between neighbours, with each term's share.
 *
 *   node scripts/patchjumps.mjs <seed> <target> [alt]     target: southmouth or a cell number
 *   LAND=1 skips steps that touch the sea.
 */
import { chromium } from 'playwright-core';
const [seed = '3', target = 'southmouth', alt = '1.009'] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
await page.goto('http://localhost:5291/');
await page.waitForFunction(() => window.mundi?.world, null, { timeout: 60000 });
await page.evaluate((s) => window.mundi.load('seed=' + s, { look: 'photo', grid: false, clouds: false }), seed);
await page.evaluate(() => window.mundi.view.whenReady?.());
await page.evaluate(() => { window.mundi.capture(true); window.mundi.freeze(10); });
const aim = () => page.evaluate(([t, a]) => {
  const m = window.mundi, w = m.world, P = w.grid.centers;
  let q;
  if (t === 'southmouth') {
    const list = [];
    for (let c = 0; c < w.grid.count; c++) {
      if (!w.river[c] || w.water[c] !== 0) continue;
      const n = w.downstream[c], cy = P[c * 3 + 1];
      if (n >= 0 && w.water[n] === 1 && (P[n * 3 + 1] - cy) < -0.6 * Math.hypot(P[n * 3] - P[c * 3], P[n * 3 + 1] - cy, P[n * 3 + 2] - P[c * 3 + 2])) list.push(c);
    }
    list.sort((x, y) => w.flow[y] - w.flow[x]);
    const b = list[0], dn = w.downstream[b];
    q = [0, 1, 2].map((i) => P[b * 3 + i] * 0.65 + P[dn * 3 + i] * 0.35);
  } else { const c = Number(t); q = [P[c * 3], P[c * 3 + 1], P[c * 3 + 2]]; }
  const ql = Math.hypot(...q);
  m.orbit(Math.atan2(q[0], q[2]) * 57.2958, Math.asin(q[1] / ql) * 57.2958, a);
}, [target, Number(alt)]);
await aim(); await page.waitForTimeout(2500); await aim(); await page.waitForTimeout(8000);
const res = await page.evaluate((land) => {
  const v = window.mundi.view, dp = v.dunePatch, r = v.renderer;
  const read = (t) => {
    const W = t.width, H = t.height, buf = new Uint16Array(W * H * 4);
    r.readRenderTargetPixels(t, 0, 0, W, H, buf);
    const f = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) { const h = buf[i], s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023; f[i] = s * (e === 0 ? m / 1024 * 2 ** -14 : e === 31 ? NaN : (1 + m / 1024) * 2 ** (e - 15)); }
    return { W, H, f };
  };
  const b0 = read(dp.bake[0]), capA = read(dp.capA), capR = read(dp.capR), N = b0.W, PR = 0.05, A = 0.15;
  const map = (t) => PR * t * (A + (1 - A) * Math.abs(t));
  const samp = (t, lx, ly) => { const x = Math.min(t.W - 1, Math.max(0, Math.floor((lx / (2 * PR) + 0.5) * t.W))), y = Math.min(t.H - 1, Math.max(0, Math.floor((ly / (2 * PR) + 0.5) * t.H))); const k = (y * t.W + x) * 4; return [t.f[k], t.f[k + 1], t.f[k + 2], t.f[k + 3]]; };
  const vx = (i, j) => {
    const lx = map(i / (N - 1) * 2 - 1), ly = map(j / (N - 1) * 2 - 1), k = (j * N + i) * 4;
    const ca = samp(capA, lx, ly), cr = samp(capR, lx, ly), h = ca[0] / 50;
    const sea = ca[0] < 0 ? Math.min(0.002, -h * 3) * Math.min(1, Math.max(0, (cr[2] - 0.3) / 0.4)) : 0;
    return { h, carve: b0.f[k], ero: b0.f[k + 1], chan: b0.f[k + 3], sea: -sea, r: cr[0], b: cr[2], lat: Math.hypot(lx, ly) };
  };
  const tot = (o) => o.h + o.carve + o.ero + o.chan + o.sea;
  const jumps = [];
  for (let j = 1; j < N - 1; j++) for (let i = 1; i < N - 1; i++) for (const [di, dj] of [[1, 0], [0, 1]]) {
    const a = vx(i, j), b = vx(i + di, j + dj);
    if (a.lat > 0.03) continue;   // near the camera
    if (land && (a.b > 0.5 || b.b > 0.5)) continue;   // LAND=1: dry land only
    const sp = Math.abs(map((i + di) / (N - 1) * 2 - 1) - map(i / (N - 1) * 2 - 1)) + Math.abs(map((j + dj) / (N - 1) * 2 - 1) - map(j / (N - 1) * 2 - 1));
    const d = tot(b) - tot(a);
    jumps.push({ slope: Math.abs(d) / sp, d, i, j, terms: ['h', 'carve', 'ero', 'chan', 'sea'].map((k) => k + ' ' + ((b[k] - a[k]) * 1e4).toFixed(2)).join('  '), r: [a.r.toFixed(2), b.r.toFixed(2)], b: [a.b.toFixed(2), b.b.toFixed(2)], hA: (a.h * 1e4).toFixed(1) });
  }
  jumps.sort((x, y) => y.slope - x.slope);
  const n45 = jumps.filter((x) => x.slope > 1).length, n70 = jumps.filter((x) => x.slope > 2.7).length;
  return { N, n45, n70, total: jumps.length, top: jumps.slice(0, 15) };
}, !!process.env.LAND);
console.log(`steps steeper than 45 deg: ${res.n45}, than 70 deg: ${res.n70} (of ${res.total} near the camera). Steepest (1e-4 radius per term):`);
for (const j of res.top) console.log(`slope ${j.slope.toFixed(1)}  d ${(j.d * 1e4).toFixed(2)}  ${j.terms}  river ${j.r}  sea ${j.b}  ground ${j.hA}`);
await browser.close();
