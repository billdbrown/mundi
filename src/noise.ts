import { makeRng } from './rng.ts';

const GRAD = [
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
];
const F3 = 1 / 3;
const G3 = 1 / 6;

export type Noise3 = (x: number, y: number, z: number) => number;

/** 3D simplex noise, roughly -1..1. Sampled on the sphere surface so there are no seams. */
export function makeSimplex(seed: number): Noise3 {
  const rng = makeRng(seed);
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = p[i]; p[i] = p[j]; p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const corner = (gi: number, x: number, y: number, z: number) => {
    let t = 0.6 - x * x - y * y - z * z;
    if (t < 0) return 0;
    t *= t;
    const g = (gi % 12) * 3;
    return t * t * (GRAD[g] * x + GRAD[g + 1] * y + GRAD[g + 2] * z);
  };

  return (x, y, z) => {
    const s = (x + y + z) * F3;
    const i = Math.floor(x + s), j = Math.floor(y + s), k = Math.floor(z + s);
    const t = (i + j + k) * G3;
    const x0 = x - (i - t), y0 = y - (j - t), z0 = z - (k - t);

    let i1, j1, k1, i2, j2, k2;
    if (x0 >= y0) {
      if (y0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
      else if (x0 >= z0) { i1 = 1; j1 = 0; k1 = 0; i2 = 1; j2 = 0; k2 = 1; }
      else { i1 = 0; j1 = 0; k1 = 1; i2 = 1; j2 = 0; k2 = 1; }
    } else {
      if (y0 < z0) { i1 = 0; j1 = 0; k1 = 1; i2 = 0; j2 = 1; k2 = 1; }
      else if (x0 < z0) { i1 = 0; j1 = 1; k1 = 0; i2 = 0; j2 = 1; k2 = 1; }
      else { i1 = 0; j1 = 1; k1 = 0; i2 = 1; j2 = 1; k2 = 0; }
    }

    const ii = i & 255, jj = j & 255, kk = k & 255;
    const n0 = corner(perm[ii + perm[jj + perm[kk]]], x0, y0, z0);
    const n1 = corner(perm[ii + i1 + perm[jj + j1 + perm[kk + k1]]],
      x0 - i1 + G3, y0 - j1 + G3, z0 - k1 + G3);
    const n2 = corner(perm[ii + i2 + perm[jj + j2 + perm[kk + k2]]],
      x0 - i2 + 2 * G3, y0 - j2 + 2 * G3, z0 - k2 + 2 * G3);
    const n3 = corner(perm[ii + 1 + perm[jj + 1 + perm[kk + 1]]],
      x0 - 1 + 3 * G3, y0 - 1 + 3 * G3, z0 - 1 + 3 * G3);
    return 32 * (n0 + n1 + n2 + n3);
  };
}

/** Fractal noise: octaves of simplex at doubling frequency, halving amplitude. Roughly -1..1. */
export function fbm(noise: Noise3, x: number, y: number, z: number, octaves: number, freq = 1): number {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * freq, y * freq, z * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}
