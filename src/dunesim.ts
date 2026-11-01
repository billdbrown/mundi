/**
 * Sand dunes by Werner's slab model (Werner 1995, "Eolian dunes: computer simulations and
 * attractor interpretation", Geology 23:1107), on a small grid that wraps at the edges, so the
 * result tiles.
 *
 * Sand is a stack of slabs on each cell. Over and over: pick a cell at random and lift a slab
 * off it (unless it lies in the wind shadow of a dune upwind), carry it a fixed hop downwind,
 * and drop it there with a probability that is higher on sand than on bare ground and certain
 * in a wind shadow; if it doesn't stick, it hops on. Slopes steeper than sand's angle of repose
 * (~34°) avalanche. Nothing else. Out of it come the dune types of real deserts, set by the
 * wind and how much sand there is (Wasson & Hyde 1983):
 *
 *   one steady wind, little sand   barchans: crescents, horns downwind
 *   one steady wind, much sand     transverse ridges, across the wind
 *   two alternating winds          linear (seif) ridges, along the mean wind
 *   winds from all round           star dunes
 *
 * Heights are returned in cell widths, so their slopes are true slopes (lee faces ~0.67).
 */
import { makeRng } from './rng.ts';

export interface DuneOptions {
  size: number;          // grid cells along each side (the tile wraps)
  sand: number;          // mean slabs per cell
  winds: number[];       // wind directions (radians, 0 = toward +x), taken in turn
  sweeps: number;        // slab moves per cell, in total
  hop: number;           // hop length, cells
  bare?: number;         // chance a slab sticks on bare ground (0.4); lower gathers sand into piles
  seed: number;
}

/** Slab thickness in cell widths: with an avalanche threshold of 2 slabs, ~34°. */
const SLAB = 1 / 3;
const REPOSE = 2;                         // slabs: steepest step allowed between neighbours
const SHADOW = Math.tan((15 * Math.PI) / 180) / SLAB;   // slabs of drop per cell of shadow
const P_SAND = 0.6;

export function simulateDunes(o: DuneOptions): Float32Array {
  const n = o.size, N = n * n, bare = o.bare ?? 0.4;
  const h = new Int32Array(N);
  const rng = makeRng(o.seed);
  const wrap = (v: number) => ((v % n) + n) % n;
  const at = (x: number, y: number) => wrap(y) * n + wrap(x);

  // Start with the sand scattered evenly, a little rough.
  const total = Math.round(o.sand * N);
  for (let i = 0; i < total; i++) h[Math.floor(rng() * N)]++;

  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  /** Drop slabs off a cell that stands too high above a neighbour (downhill, repeatedly). */
  const slideDown = (x: number, y: number) => {
    for (let guard = 0; guard < 64; guard++) {
      const i = at(x, y);
      let best = -1, bx = 0, by = 0, drop = REPOSE;
      for (const [dx, dy] of NB) {
        const d = h[i] - h[at(x + dx, y + dy)];
        if (d > drop) { drop = d; best = at(x + dx, y + dy); bx = x + dx; by = y + dy; }
      }
      if (best < 0) return;
      h[i]--; h[best]++; x = bx; y = by;
    }
  };
  /** A pit left by a lifted slab: neighbours too high above it slide in. */
  const slideIn = (x: number, y: number) => {
    for (let guard = 0; guard < 64; guard++) {
      const i = at(x, y);
      let best = -1, bx = 0, by = 0, rise = REPOSE;
      for (const [dx, dy] of NB) {
        const d = h[at(x + dx, y + dy)] - h[i];
        if (d > rise) { rise = d; best = at(x + dx, y + dy); bx = x + dx; by = y + dy; }
      }
      if (best < 0) return;
      h[best]--; h[i]++; x = bx; y = by;
    }
  };

  const steps = Math.round(o.sweeps * N);
  const perWind = Math.max(1, Math.round(N * 2));       // switch winds every couple of sweeps
  let wx = 1, wy = 0, hx = o.hop, hy = 0;
  const setWind = (a: number) => {
    wx = Math.cos(a); wy = Math.sin(a);
    hx = Math.round(wx * o.hop); hy = Math.round(wy * o.hop);
    if (hx === 0 && hy === 0) hx = 1;
  };
  /** In the lee of something upwind: a drop steeper than the 15° shadow line. */
  const shadowed = (x: number, y: number) => {
    const hi = h[at(x, y)];
    for (let k = 1; k <= 24; k++) {
      const u = h[at(Math.round(x - wx * k), Math.round(y - wy * k))];
      if (u - hi > SHADOW * k) return true;
      if (u - hi < SHADOW * k - 60) break;            // nothing upwind tall enough to matter
    }
    return false;
  };

  let wind = 0;
  setWind(o.winds[0]);
  for (let s = 0; s < steps; s++) {
    if (s % perWind === 0 && o.winds.length > 1) setWind(o.winds[wind++ % o.winds.length]);
    const x = Math.floor(rng() * n), y = Math.floor(rng() * n), i = y * n + x;
    if (h[i] === 0 || shadowed(x, y)) continue;
    h[i]--;
    slideIn(x, y);
    let cx = x, cy = y;
    for (let hops = 0; hops < 200; hops++) {
      // A little sideways scatter: hops exactly along grid rows left the rows independent
      // (stripes of bare ground along the wind, streaks on every slope).
      const side = rng(), sx = side < 0.2 ? -1 : side > 0.8 ? 1 : 0;
      cx = wrap(cx + hx - sx * Math.round(wy)); cy = wrap(cy + hy + sx * Math.round(wx));
      const j = cy * n + cx;
      const p = shadowed(cx, cy) ? 1 : h[j] > 0 ? P_SAND : bare;
      if (rng() < p) { h[j]++; slideDown(cx, cy); break; }
    }
  }

  // Slab steps are blocky (as real geometry they showed as sawteeth along every slip face);
  // a blur rounds them, keeping the slip faces steep.
  let f = Float32Array.from(h, (v) => v * SLAB);
  for (let pass = 0; pass < 6; pass++) {
    const g = new Float32Array(N);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      g[y * n + x] = (4 * f[at(x, y)] + f[at(x + 1, y)] + f[at(x - 1, y)] + f[at(x, y + 1)] + f[at(x, y - 1)]) / 8;
    }
    f = g;
  }
  return f;
}
