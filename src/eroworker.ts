/**
 * Runs the analytical erosion (analyticerosion.ts) off the main thread, on the height map the
 * terrain shadows capture around the view. Input: that map as half floats (RGBA, height x50 in
 * R), n x n, and its frame (centre, east, north, half-width). Output: carving and drainage
 * area on the same grid.
 */
import { analyticErosion } from './analyticerosion.ts';
import { makeSimplex } from './noise.ts';
import { DataUtils } from 'three';

export interface EroRequest {
  id: number;
  half: Uint16Array;
  size: number;                 // the half-float map's width
  c: number[]; e: number[]; nn: number[]; r: number;
}
/** packed: carving and log2 drainage area, half floats, RG, (n/2)^2 (to upload cheaply). */
export interface EroResult { id: number; n: number; packed: Uint16Array }

const noise = makeSimplex(4242);
const TABLE = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  const s = i & 0x8000 ? -1 : 1, e = (i >> 10) & 0x1f, f = i & 0x3ff;
  TABLE[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? 0 : s * Math.pow(2, e - 15) * (1 + f / 1024);
}

self.onmessage = (ev: MessageEvent<EroRequest>) => {
  const { id, half, size, c, e, nn, r } = ev.data;
  const n = size, N = n * n;
  const height = new Float32Array(N), jitter = new Float32Array(N);
  const s = (2 * r) / n;
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    // The half-float map: R = height x50.
    height[y * n + x] = TABLE[half[(y * size + x) * 4]] / 50;
    // Roughness anchored to the world, so channels don't jump as the region moves.
    const lx = ((x + 0.5) / n * 2 - 1) * r, ly = ((y + 0.5) / n * 2 - 1) * r;
    const z = Math.sqrt(Math.max(0, 1 - lx * lx - ly * ly));
    const px = c[0] * z + e[0] * lx + nn[0] * ly, py = c[1] * z + e[1] * lx + nn[1] * ly, pz = c[2] * z + e[2] * lx + nn[2] * ly;
    const f1 = 1 / (4 * s), f2 = 1 / (14 * s);
    jitter[y * n + x] = s * (0.25 * noise(px * f1, py * f1, pz * f1) + 0.37 * noise(px * f2 + 7, py * f2, pz * f2));
  }
  // Slopes for a given drainage area in fixed ground units, whatever the grid spacing.
  // (Not scaled by grid spacing: at coarse spacings that made every slope gentle and wore whole
  // lowlands down.)
  const m = 0.45, k = 1.4;
  const { carve, area } = analyticErosion({ height, n, spacing: s, jitter, k, m, });
  // Plains don't get canyons: carving needs relief to cut into (mountains, uplands).
  // No cut deeper than half the land's height (valleys, not gorges to sea level).
  for (let i = 0; i < N; i++) {
    const t = Math.max(0, Math.min(1, (height[i] - 0.0025) / 0.004));
    carve[i] = Math.min(carve[i], 0.5 * Math.max(0, height[i])) * t * t * (3 - 2 * t);
  }
  // Halved (2x2 averages) and packed as half floats: a 1024² float texture took ~100 ms to upload.
  const m2 = n / 2, packed = new Uint16Array(m2 * m2 * 2);
  for (let y = 0; y < m2; y++) for (let x = 0; x < m2; x++) {
    let cv = 0, ar = 0;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = (y * 2 + dy) * n + x * 2 + dx;
      cv += carve[i]; ar = Math.max(ar, area[i]);
    }
    packed[(y * m2 + x) * 2] = DataUtils.toHalfFloat(cv / 4);
    packed[(y * m2 + x) * 2 + 1] = DataUtils.toHalfFloat(Math.log2(ar));
  }
  const res: EroResult = { id, n: m2, packed };
  (self as unknown as Worker).postMessage(res, [packed.buffer]);
};
