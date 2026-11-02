/**
 * River deltas (the D switch, WorldParams.deltas). A big river carries sediment, and where it
 * meets a shallow sea it builds land out into it: a low fan barely above the water, cut by
 * channels splitting toward the sea. Here: at the mouths of the biggest rivers on a shelf, the
 * sea cell the river drains into becomes low land, and for the biggest a neighbouring shelf cell
 * or two along the coast as well; the main channel runs on through to the new shore and the
 * side cells get channels of their own (distributaries). The ground is what deltas grow: marsh,
 * swamp or mangrove by climate, green floodplain in a desert, tundra in the cold.
 */
import { B } from './biomes.ts';
import type { Grid } from './grid.ts';

const LAND = 0, OCEAN = 1;

export interface DeltaInput {
  grid: Grid;
  elevation: Float32Array;
  surface: Float32Array;
  temperature: Float32Array;
  moisture: Float32Array;
  water: Uint8Array;
  biome: Uint8Array;
  downstream: Int32Array;
  flow: Float32Array;
  river: Uint8Array;
  riverThreshold: number;
}

/** Delta land's height (a little above the sea, so it is land but flat and low). */
const DELTA_E = 0.012;
/** Whether cell c is delta land (built here). */
export const isDelta = (water: Uint8Array, elevation: Float32Array, c: number) => water[c] === LAND && Math.abs(elevation[c] - DELTA_E) < 1e-6;

/** Builds deltas in place; returns the cells made land (for tests and the readout). */
export function buildDeltas(w: DeltaInput): number[] {
  const g = w.grid, N = g.count, nb = g.neighbors;
  const { elevation: E, water, downstream, flow, river, temperature: T, moisture: M, biome } = w;
  const T0 = w.riverThreshold;
  const mouths: [number, number][] = [];
  for (let c = 0; c < N; c++) {
    if (water[c] !== LAND || river[c] !== 2) continue;
    const o = downstream[c];
    if (o < 0 || water[o] !== OCEAN || E[o] < -0.3) continue;
    if (flow[c] < 8 * T0) continue;
    mouths.push([flow[c], c]);
  }
  mouths.sort((a, b) => b[0] - a[0]);
  const made: number[] = [];
  const taken = new Uint8Array(N);
  const coverOf = (c: number) => {
    const t = T[c], m = M[c];
    if (t < 0.22) return B.TUNDRA;
    if (m < 0.3) return B.FLOODPLAIN;
    if (t > 0.74) return m > 0.45 ? B.MANGROVE : B.SWAMP;
    return B.MARSH;
  };
  // The deepest sea neighbour of x that isn't delta: where its channel ends.
  const seaward = (x: number) => {
    let best = -1, bd = Infinity;
    for (const n of nb[x]) if (water[n] === OCEAN && !taken[n] && E[n] < bd) { bd = E[n]; best = n; }
    return best;
  };
  const makeLand = (x: number, f: number, r: number) => {
    taken[x] = 1;
    water[x] = LAND;
    E[x] = DELTA_E; w.surface[x] = DELTA_E;
    flow[x] = f; river[x] = r;
    M[x] = Math.max(M[x], 0.55);
    made.push(x);
  };
  for (const [f, c] of mouths.slice(0, 8)) {
    const o = downstream[c];
    if (taken[o] || nb[o].some((n) => taken[n])) continue;   // one delta a stretch of coast
    // The main lobe.
    makeLand(o, f, 2);
    // Side lobes for the biggest: shelf cells next to the main one that also touch the old coast.
    const lobes = f > 20 * T0 ? 2 : f > 12 * T0 ? 1 : 0;
    const side = nb[o].filter((n) => water[n] === OCEAN && E[n] > -0.3 && nb[n].some((k) => water[k] === LAND && !taken[k]))
      .sort((a, b) => E[b] - E[a]).slice(0, lobes);
    for (const s of side) makeLand(s, f * 0.3, 1);
    // Channels: each delta cell drains to its deepest sea neighbour.
    for (const x of [o, ...side]) {
      let d = seaward(x);
      if (d < 0) d = nb[x].find((n) => water[n] === OCEAN) ?? -1;
      downstream[x] = d;
      biome[x] = coverOf(x);
    }
  }
  return made;
}
