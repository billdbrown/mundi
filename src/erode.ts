/**
 * River erosion on the cell grid: the stream-power model geomorphologists use for mountain
 * ranges (Braun & Willett 2013; Cordonnier et al. 2016 for terrain generation).
 *
 * Land rises (tectonic uplift, here from the plate model's heights) and rivers cut down in
 * proportion to their discharge and slope:  dh/dt = U − K·A^m·S. At balance, slope falls with
 * drainage area, S = U / (K·A^m): ridges are steep and big rivers run in long, low valleys,
 * which is what gives real ranges their branching spurs and valleys. Each round routes water
 * by priority-flood (every cell drains to the sea, through basins if need be), accumulates
 * drainage area down the tree, and updates heights implicitly from the sea upward, which is
 * stable for any time step. No deposition: a cell lower than its outlet (a basin) only rises
 * with uplift, so lake basins survive.
 *
 * The carved heights are mapped back onto the original height distribution, so the share of
 * lowland, upland and mountain stays as calibrated (snow lines, lapse rates, mountain biomes);
 * erosion changes where the high and low ground is, not how much of it there is.
 */
import type { Grid } from './grid.ts';

export interface ErosionOptions {
  /** Rounds of route-and-erode. */
  iterations: number;
  /** Erodibility × time step. Larger: deeper valleys relative to ridges. */
  k: number;
  /** Area exponent: how much more a big river cuts than a small one. */
  m: number;
  /** How much of the carved shape to keep, 0..1 (the rest is the original). */
  blend: number;
  /**
   * Basins at least this deep (filled minus height) are kept as they were, rims included, so
   * the lakes the generator makes survive. Rivers would otherwise cut their outlets down and
   * drain them, which is what happens to real lakes, given time.
   */
  keepBasins: number;
}

export const EROSION_DEFAULTS: ErosionOptions = { iterations: 30, k: 1.2, m: 0.6, blend: 1, keepBasins: 0.09 };

/**
 * Erode land heights (elev ≥ 0 is land; ocean cells are outlets and are left alone).
 * rain: relative precipitation per cell (scales drainage area), or null for uniform.
 * Returns new land heights, same distribution as the input's.
 */
export function erodeLand(grid: Grid, elev: Float32Array, rain: Float32Array | null, o: ErosionOptions = EROSION_DEFAULTS): Float32Array {
  const N = grid.count, nbrs = grid.neighbors;
  const land: number[] = [];
  for (let c = 0; c < N; c++) if (elev[c] >= 0) land.push(c);
  if (!land.length) return elev;

  // Uplift: the plate model's heights stand for where crust is being pushed up.
  const U = new Float32Array(N);
  for (const c of land) U[c] = 0.02 + elev[c];
  const h = Float32Array.from(elev);
  const order = new Int32Array(N), rcv = new Int32Array(N), area = new Float32Array(N);
  const heap = new Heap(N), done = new Uint8Array(N);
  const EPS = 1e-6;
  const filled = new Float32Array(N);

  for (let it = 0; it < o.iterations; it++) {
    // Route: priority-flood from the sea. Pop order runs from the outlets upward.
    done.fill(0);
    let n = 0;
    for (let c = 0; c < N; c++) if (elev[c] < 0) { heap.push(c, h[c]); done[c] = 1; filled[c] = h[c]; rcv[c] = -1; }
    while (heap.size) {
      const c = heap.pop();
      if (elev[c] >= 0) order[n++] = c;
      for (const nb of nbrs[c]) {
        if (done[nb]) continue;
        done[nb] = 1;
        filled[nb] = Math.max(h[nb], filled[c] + EPS);
        rcv[nb] = c;
        heap.push(nb, filled[nb]);
      }
    }
    // Drainage area (rain-weighted), from the top of each tree down.
    for (let i = 0; i < n; i++) { const c = order[i]; area[c] = rain ? rain[c] : 1; }
    for (let i = n - 1; i >= 0; i--) {
      const c = order[i], r = rcv[c];
      if (r >= 0 && elev[r] >= 0) area[r] += area[c];
    }
    // Erode, from the outlets up, so each receiver is already updated (implicit in time).
    for (let i = 0; i < n; i++) {
      const c = order[i], r = rcv[c];
      const hr = r >= 0 ? h[r] : 0;
      const up = h[c] + U[c] * 0.05;
      if (hr >= up) { h[c] = up; continue; }        // basin: no cutting, no filling
      const F = o.k * Math.pow(area[c], o.m);
      h[c] = Math.max(0.0005, (up + F * hr) / (1 + F));
    }
  }

  // Keep some of the original, then give the result the original's height distribution.
  let hMax = 0;
  for (const c of land) hMax = Math.max(hMax, h[c]);
  const mixed = new Float32Array(land.length);
  for (let i = 0; i < land.length; i++) {
    const c = land[i];
    mixed[i] = elev[c] * (1 - o.blend) + (h[c] / Math.max(1e-6, hMax)) * o.blend;
  }
  const rank = Array.from(land.keys()).sort((a, b) => mixed[a] - mixed[b]);
  const target = land.map((c) => elev[c]).sort((a, b) => a - b);
  const out = Float32Array.from(elev);
  rank.forEach((i, k) => { out[land[i]] = target[k]; });

  // Lake basins: original floors, and a rim no lower than the old spill level.
  const filled0 = new Float32Array(N);
  done.fill(0);
  for (let c = 0; c < N; c++) if (elev[c] < 0) { heap.push(c, elev[c]); done[c] = 1; filled0[c] = elev[c]; }
  while (heap.size) {
    const c = heap.pop();
    for (const nb of nbrs[c]) {
      if (done[nb]) continue;
      done[nb] = 1;
      filled0[nb] = Math.max(elev[nb], filled0[c] + EPS);
      heap.push(nb, filled0[nb]);
    }
  }
  for (const c of land) {
    if (filled0[c] - elev[c] <= o.keepBasins) continue;
    out[c] = elev[c];
    for (const nb of nbrs[c]) {
      if (elev[nb] >= 0 && filled0[nb] - elev[nb] <= o.keepBasins) out[nb] = Math.max(out[nb], filled0[c]);
    }
  }
  return out;
}

class Heap {
  private ids: Int32Array;
  private keys: Float32Array;
  size = 0;
  constructor(capacity: number) { this.ids = new Int32Array(capacity); this.keys = new Float32Array(capacity); }
  push(id: number, key: number) {
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop(): number {
    const top = this.ids[0];
    const id = this.ids[--this.size], key = this.keys[this.size];
    let i = 0;
    for (;;) {
      let m = 2 * i + 1;
      if (m >= this.size) break;
      if (m + 1 < this.size && this.keys[m + 1] < this.keys[m]) m++;
      if (this.keys[m] >= key) break;
      this.ids[i] = this.ids[m]; this.keys[i] = this.keys[m];
      i = m;
    }
    this.ids[i] = id; this.keys[i] = key;
    return top;
  }
}
