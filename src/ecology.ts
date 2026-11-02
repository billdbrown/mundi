/**
 * Finer biomes (the B switch, WorldParams.ecology): the broad climate biomes (biomes.ts,
 * landBiome) split by the local things that make real landscapes differ — standing water, a
 * coast, a big river, a dry basin, the side of a continent, altitude, rock. Each new biome has a
 * cause, so it turns up where that cause is (mangroves on hot muddy coasts, bogs on cold wet
 * flats, salt flats in dry basins), not as noise; and lone specks are removed, so every patch is
 * a few cells at least.
 *
 * Every refined biome keeps the broad one it refines (BIOME_BASE), and code that asks "is this
 * forest, open country, dry?" asks of that (baseOf).
 */
import { B } from './biomes.ts';
import type { Grid } from './grid.ts';

const LAND = 0, OCEAN = 1, LAKE = 2;

export interface EcoInput {
  grid: Grid;
  elevation: Float32Array;
  temperature: Float32Array;
  moisture: Float32Array;
  water: Uint8Array;
  river: Uint8Array;
  biome: Uint8Array;
  seed: number;
}

function hash(n: number): number {
  let h = (n | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Refines w.biome in place. */
export function refineBiomes(w: EcoInput) {
  const g = w.grid, N = g.count, P = g.centers, nb = g.neighbors;
  const { elevation: E, temperature: T, moisture: M, water, river, biome } = w;
  // Distance to the sea, in cells (land), and to land (sea), by breadth-first search.
  const coast = new Int32Array(N).fill(1 << 20), q: number[] = [];
  for (let c = 0; c < N; c++) if (water[c] === OCEAN) { coast[c] = 0; q.push(c); }
  for (let i = 0; i < q.length; i++) for (const n of nb[q[i]]) if (coast[n] > coast[q[i]] + 1) { coast[n] = coast[q[i]] + 1; q.push(n); }
  // Roughness: the biggest height step to a neighbour (land only).
  const rough = (c: number) => { let r = 0; for (const n of nb[c]) if (water[n] !== OCEAN) r = Math.max(r, Math.abs(E[n] - E[c])); return r; };
  const lat = (c: number) => Math.abs(Math.asin(Math.max(-1, Math.min(1, P[c * 3 + 1])))) * 57.2958;
  // Sea to the west within k cells: the west coasts where winters are wet and summers dry.
  const seaWest = (c: number, k: number) => {
    let cur = c;
    for (let s = 0; s < k; s++) {
      const x = P[cur * 3], z = P[cur * 3 + 2];
      let best = cur, bd = -Infinity;
      for (const n of nb[cur]) {
        const d = -((P[n * 3] - x) * z + (P[n * 3 + 2] - z) * -x);   // along west = (−z, 0, x)
        if (d > bd) { bd = d; best = n; }
      }
      cur = best;
      if (water[cur] === OCEAN) return true;
    }
    return false;
  };
  // Broad regions (a few cells across), for things that come in districts: limestone country.
  const region = (c: number, salt: number) => {
    // Smooth value noise on the sphere: hashed lattice in 3D at a coarse scale, trilinear.
    const f = 6, x = P[c * 3] * f + 50, y = P[c * 3 + 1] * f + 50, z = P[c * 3 + 2] * f + 50;
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
    const s = (t: number) => t * t * (3 - 2 * t);
    const h = (a: number, b: number, d: number) => hash(((a * 73856093) ^ (b * 19349663) ^ (d * 83492791)) + salt * 101 + w.seed * 7);
    let v = 0;
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      v += h(xi + dx, yi + dy, zi + dz) * (dx ? s(xf) : 1 - s(xf)) * (dy ? s(yf) : 1 - s(yf)) * (dz ? s(zf) : 1 - s(zf));
    }
    return v;
  };

  const out = Uint8Array.from(biome);
  for (let c = 0; c < N; c++) {
    const b = biome[c], e = E[c], t = T[c], m = M[c];
    if (water[c] === OCEAN) {
      if (b !== B.SHALLOWS && b !== B.OCEAN) continue;
      let landN = 0;
      for (const n of nb[c]) if (water[n] !== OCEAN) landN++;
      const nearLand = coast[c] <= 1 || landN > 0;
      if (b === B.SHALLOWS && landN >= 3 && t > 0.45) out[c] = B.LAGOON;
      else if (b === B.SHALLOWS && t > 0.72 && region(c, 7) > 0.42) out[c] = B.REEF;
      else if (nearLand && e > -0.3 && t > 0.24 && t < 0.55) out[c] = B.KELP;
      continue;
    }
    if (water[c] !== LAND) continue;
    const r = rough(c);
    const flat = r < 0.06;
    let lakeN = 0, riverN = 0, seaN = 0;
    for (const n of nb[c]) { if (water[n] === LAKE) lakeN++; if (river[n]) riverN++; if (water[n] === OCEAN) seaN++; }
    const wetSide = lakeN > 0 || river[c] > 0 || riverN > 0;
    const la = lat(c);
    // Mountains: meadows above the trees, forests on their flanks, cloud forest in the tropics.
    if ((b === B.MOUNTAIN || b === B.RAINFOREST || b === B.DRY_FOREST) && e > 0.4 && t > 0.6 && m > 0.5) { out[c] = B.CLOUD_FOREST; continue; }
    if (b === B.MOUNTAIN) {
      if (m > 0.42 && e < 0.7 && t > 0.33) out[c] = B.MONTANE_FOREST;
      else if (m > 0.3 && t > 0.26) out[c] = B.ALPINE_MEADOW;
      continue;
    }
    if (b === B.PEAK || b === B.ICE) continue;
    // Coasts: mangroves in the hot wet tropics, salt marsh in temperate lowlands.
    if (seaN > 0 && e < 0.1 && flat) {
      if (t > 0.74 && m > 0.38) { out[c] = B.MANGROVE; continue; }
      if (t > 0.38 && t < 0.74 && m > 0.38) { out[c] = B.SALT_MARSH; continue; }
    }
    // Standing water inland: swamp (warm), marsh (temperate), bog (cold).
    if (flat && e < 0.2 && (wetSide || m > 0.62)) {
      if (t > 0.66 && m > 0.55) { out[c] = B.SWAMP; continue; }
      if (t > 0.42 && t <= 0.72 && m > 0.42) { out[c] = B.MARSH; continue; }
    }
    if (flat && e < 0.35 && t > 0.16 && t < 0.42 && m > 0.4) { out[c] = B.BOG; continue; }
    // A big river's floodplain.
    if (river[c] === 2 && e < 0.25 && m > 0.28 && t > 0.3) { out[c] = B.FLOODPLAIN; continue; }
    // Dry country.
    if (b === B.DESERT || b === B.STEPPE) {
      if (lakeN > 0 && m < 0.3) { out[c] = B.SALT_FLAT; continue; }
      if ((river[c] || riverN > 0) && e > 0.15 && e < 0.6 && m < 0.35) { out[c] = B.CANYONS; continue; }
      if (e > 0.25 && r > 0.13 && region(c, 9) > 0.55) { out[c] = B.BADLANDS; continue; }
      if (b === B.DESERT && t < 0.55) { out[c] = B.COLD_DESERT; continue; }
      if (b === B.DESERT && m > 0.15) { out[c] = B.DESERT_SCRUB; continue; }
    }
    if (b === B.TUNDRA && m < 0.16) { out[c] = B.POLAR_DESERT; continue; }
    // Wet winters, dry summers: west coasts in the subtropics.
    if (t > 0.55 && t < 0.82 && m > 0.22 && m < 0.48 && la > 24 && la < 44 && coast[c] <= 5 && seaWest(c, 6)) {
      out[c] = B.CHAPARRAL; continue;
    }
    // Limestone country: tower karst in warm wet hills.
    if (t > 0.6 && m > 0.5 && e > 0.12 && e < 0.5 && region(c, 3) > 0.62) { out[c] = B.KARST; continue; }
    // Cool, wet, windswept coasts and uplands: heath and moor.
    if (t > 0.3 && t < 0.58 && m > 0.5 && (coast[c] <= 2 || e > 0.3) && region(c, 5) > 0.5 && (b === B.GRASSLAND || b === B.FOREST || b === B.TEMPERATE_RAIN || b === B.TAIGA)) {
      out[c] = B.HEATH; continue;
    }
    if (b === B.TAIGA && t < 0.27 && coast[c] >= 6) { out[c] = B.LARCH; continue; }
    if ((b === B.TAIGA && t > 0.36) || (b === B.FOREST && t < 0.5)) { out[c] = B.MIXED_FOREST; continue; }
    if (b === B.GRASSLAND && m > 0.37) { out[c] = B.PRAIRIE; continue; }
    if (b === B.SAVANNA && m > 0.33 && (seaN > 0 || wetSide)) { out[c] = B.PALM_SAVANNA; continue; }
    if ((b === B.DRY_FOREST && m > 0.56) || (b === B.RAINFOREST && m < 0.7)) { out[c] = B.MONSOON; continue; }
  }
  // Specks: a refined cell with no neighbour of the same biome goes back to its broad biome;
  // a cell ringed (4+ neighbours) by one refinement of its own broad biome joins it.
  const res = Uint8Array.from(out);
  for (let c = 0; c < N; c++) {
    const b = out[c];
    if (b < FIRST_FINE) {
      const counts = new Map<number, number>();
      for (const n of nb[c]) if (out[n] >= FIRST_FINE && BIOME_BASE[out[n]] === b) counts.set(out[n], (counts.get(out[n]) ?? 0) + 1);
      for (const [k, v] of counts) if (v >= 4) res[c] = k;
      continue;
    }
    if (b === B.REEF || b === B.LAGOON || b === B.KELP || b === B.MANGROVE || b === B.SALT_MARSH || b === B.FLOODPLAIN || b === B.CANYONS || b === B.SALT_FLAT) continue;   // thin by nature
    if (!nb[c].some((n) => out[n] === b)) res[c] = biome[c];
  }
  biome.set(res);
}

/** The first refined biome's id: below it, the broad ones. */
export const FIRST_FINE = B.SWAMP;
/** The broad biome each refined one refines. */
export const BIOME_BASE: Record<number, number> = {
  [B.SWAMP]: B.RAINFOREST, [B.MARSH]: B.GRASSLAND, [B.BOG]: B.TUNDRA, [B.FLOODPLAIN]: B.GRASSLAND,
  [B.MANGROVE]: B.RAINFOREST, [B.SALT_MARSH]: B.GRASSLAND, [B.SALT_FLAT]: B.DESERT, [B.COLD_DESERT]: B.DESERT,
  [B.BADLANDS]: B.DESERT, [B.CHAPARRAL]: B.DRY_FOREST, [B.DESERT_SCRUB]: B.STEPPE, [B.POLAR_DESERT]: B.TUNDRA,
  [B.ALPINE_MEADOW]: B.MOUNTAIN, [B.MONTANE_FOREST]: B.TAIGA, [B.LARCH]: B.TAIGA, [B.CLOUD_FOREST]: B.RAINFOREST,
  [B.MIXED_FOREST]: B.FOREST, [B.HEATH]: B.GRASSLAND, [B.PRAIRIE]: B.GRASSLAND, [B.MONSOON]: B.DRY_FOREST,
  [B.PALM_SAVANNA]: B.SAVANNA, [B.REEF]: B.SHALLOWS, [B.KELP]: B.SHALLOWS, [B.LAGOON]: B.SHALLOWS,
  [B.KARST]: B.RAINFOREST, [B.CANYONS]: B.DESERT,
};
/** A biome's broad biome (itself, if it is one). */
export const baseOf = (b: number): number => BIOME_BASE[b] ?? b;
