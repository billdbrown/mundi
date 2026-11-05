/**
 * The planet's own render of a hex beside the hex view's map of it, from the same camera angle
 * (the planet's automatic low-altitude tilt, looking north). Writes <cell>.png per cell.
 * Usage: [SEED=1] [DIST=0.035] node scripts/hexcompare.mjs <base url> <outdir> <cell|spot>...
 */
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import fs from 'node:fs';
import { planetValleys, giveValleys } from './planetvalleys.mjs';
const [base, out, ...targets] = process.argv.slice(2);
const seed = process.env.SEED ?? '1', dist = Number(process.env.DIST ?? 0.035);
const browser = await chromium.launch({ channel: process.env.BROWSER ?? 'msedge', args: ['--use-angle=d3d11', '--enable-gpu'] });
const W = 960, H = 640;
const planet = await browser.newPage({ viewport: { width: W, height: H } });
const hex = await browser.newPage({ viewport: { width: W, height: H } });
// Generous: on a shared GPU (other sessions rendering) a frame can take a while.
for (const pg of [planet, hex]) pg.setDefaultTimeout(180000);
await planet.goto(`${base}#seed=${seed}`);
await planet.waitForFunction(() => window.mundi?.world, null, { timeout: 180000 });
await planet.evaluate(() => window.mundi.ready());
await planet.evaluate(() => window.mundi.capture(true));
const valleys = process.env.NOVALLEYS ? null : await planetValleys(browser, base, seed);
for (const t of targets) {
  const cell = /^\d+$/.test(t) ? Number(t) : await planet.evaluate((s) => window.mundi.findSpot ? window.mundi.findSpot(s) : -1, t);
  // Camera above the cell; the view tilts itself near the ground. Read back where it ended up.
  const pose = await planet.evaluate(async ([c, dist]) => {
    const m = window.mundi, v = m.view, P = m.world.grid.centers;
    const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
    const lat = Math.asin(y) * 180 / Math.PI, lon = Math.atan2(x, z) * 180 / Math.PI;
    v.highlight(c);
    // The view decides its own pivot near the ground, so aim, see where the screen's centre
    // landed, and correct the aim by the miss until it lands on the cell.
    let ax = x, ay = y, az = z, hit;
    const cam = v.camera, dir = new cam.position.constructor();
    for (let i = 0; i < 4; i++) {
      const l = Math.hypot(ax, ay, az);
      m.orbit(Math.atan2(ax, az) * 180 / Math.PI, Math.asin(ay / l) * 180 / Math.PI, 1.0 + dist);
      await new Promise((r) => setTimeout(r, i === 3 ? 4000 : 1200));
      cam.getWorldDirection(dir);
      v.raycaster.set(cam.position, dir);
      hit = v.raycaster.intersectObject(v.terrain, false)[0];
      if (!hit) break;
      const q = hit.point.clone().normalize();
      ax += x - q.x; ay += y - q.y; az += z - q.z;
    }
    // The ground point at the screen's centre, in real metres east and north of the cell's centre.
    let e = 0, n = 0;
    if (hit) {
      const p = hit.point.clone().normalize(), R = 640000;
      let ex = z, ez = -x; const el = Math.hypot(ex, ez); ex /= el; ez /= el;
      const nx = y * ez, ny = z * ex - x * ez, nz = -y * ex;
      const dd = p.x * x + p.y * y + p.z * z;
      e = (p.x * ex + p.z * ez) / dd * R; n = (p.x * nx + p.y * ny + p.z * nz) / dd * R;
    }
    return { tilt: v.tilt, dist: hit ? hit.distance : dist, fov: cam.fov, e, n };
  }, [cell, dist]);
  await planet.screenshot({ path: `${out}/_planet.png` });
  await hex.goto('about:blank');
  await hex.goto(`${base}hex.html#seed=${seed}&cell=${cell}${process.env.HEXQ ? "&" + process.env.HEXQ : ""}`);
  await hex.waitForFunction(() => window.hex?.map && !window.hex.busy, null, { timeout: 120000 });
  if (valleys) await giveValleys(hex, valleys);
  await hex.evaluate(([p]) => { window.hex.capture(true); window.hex.pose(p.dist, p.tilt, p.fov, p.e, p.n); }, [pose]);
  await hex.waitForTimeout(1200);
  await hex.screenshot({ path: `${out}/_hex.png` });
  const a = PNG.sync.read(fs.readFileSync(`${out}/_planet.png`)), b = PNG.sync.read(fs.readFileSync(`${out}/_hex.png`));
  const o = new PNG({ width: W * 2 + 8, height: H });
  o.data.fill(255);
  PNG.bitblt(a, o, 0, 0, W, H, 0, 0);
  PNG.bitblt(b, o, 0, 0, W, H, W + 8, 0);
  fs.writeFileSync(`${out}/${cell}.png`, PNG.sync.write(o));
  console.log(cell, JSON.stringify(pose));
}
fs.rmSync(`${out}/_planet.png`); fs.rmSync(`${out}/_hex.png`);
await browser.close();
