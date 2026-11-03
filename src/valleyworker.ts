/**
 * Valleys for the whole planet in one job (valleys.ts): the analytical erosion on a cube-sphere
 * grid (cubeErosion in analyticerosion.ts), so water flows across the cube's face edges.
 *
 * Input: the six faces' captured heights (half floats, RGBA, height x50 in R), n x n each,
 * face-major. Output: carving and log2 drainage area, half floats, RG, same layout.
 */
import { cubeErosion, cubeFace } from './analyticerosion.ts';
import { makeSimplex } from './noise.ts';
import { DataUtils } from 'three';

export interface ValleyRequest { half: Uint16Array; n: number; gen: number; unit: number }
export interface ValleyResult { packed: Uint16Array; n: number; gen: number; ms: number }

const noise = makeSimplex(4242);
const TABLE = new Float32Array(65536);
for (let i = 0; i < 65536; i++) {
  const s = i & 0x8000 ? -1 : 1, e = (i >> 10) & 0x1f, f = i & 0x3ff;
  TABLE[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? 0 : s * Math.pow(2, e - 15) * (1 + f / 1024);
}

self.onmessage = (ev: MessageEvent<ValleyRequest>) => {
  const t0 = performance.now();
  const { half, n, gen, unit } = ev.data;
  const F = n * n, N = 6 * F;
  const height = new Float32Array(N), jitter = new Float32Array(N);
  // Grid spacing at a face's centre (radians); toward the edges it is up to ~2x finer.
  const s = 2 / n, f1 = 1 / (4 * s), f2 = 1 / (14 * s);
  const p = [0, 0, 0];
  for (let f = 0; f < 6; f++) {
    const a = cubeFace(f);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const c = f * F + y * n + x;
      height[c] = TABLE[half[c * 4]] / 50;
      // Roughness anchored to the world, so channels start somewhere (the tiles' noise).
      const u = ((x + 0.5) / n) * 2 - 1, v = ((y + 0.5) / n) * 2 - 1, l = 1 / Math.sqrt(1 + u * u + v * v);
      p[a.k] = a.sign * l; p[a.i] = u * l; p[a.j] = v * l;
      jitter[c] = s * (0.25 * noise(p[0] * f1, p[1] * f1, p[2] * f1) + 0.37 * noise(p[0] * f2 + 7, p[1] * f2, p[2] * f2));
    }
  }
  const { carve, area } = cubeErosion({ height, n, jitter, k: 1.4, m: 0.45, unit });
  // As the tiles had it: plains don't get canyons, and no cut deeper than half the land's height.
  const packed = new Uint16Array(N * 2);
  for (let i = 0; i < N; i++) {
    const t = Math.max(0, Math.min(1, (height[i] - 0.0025) / 0.004));
    // Depth eased toward 0.003 (about a third of a high range's height): the biggest rivers'
    // valleys came out deep and only a texel or two wide, black trenches in shadow.
    const C = 0.003, raw = Math.min(carve[i], 0.5 * Math.max(0, height[i]));
    const cv = C * Math.tanh(raw / C) * t * t * (3 - 2 * t);
    packed[i * 2] = DataUtils.toHalfFloat(cv);
    packed[i * 2 + 1] = DataUtils.toHalfFloat(Math.log2(Math.max(1, area[i])));
  }
  const res: ValleyResult = { packed, n, gen, ms: performance.now() - t0 };
  (self as unknown as Worker).postMessage(res, [packed.buffer]);
};
