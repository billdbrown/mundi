/**
 * What a game would want from a world: named continents, resources per cell, suggested
 * settlement sites, and a JSON export of all of it. Pure, so it is unit-tested.
 */
import { B, BIOMES } from './biomes.ts';
import { WATER_LAKE, WATER_LAND, WATER_OCEAN, type World } from './world.ts';
import { makeRng } from './rng.ts';

export const RES_ORE = 1, RES_TIMBER = 2, RES_FISH = 4, RES_FERTILE = 8;
export const RESOURCE_NAMES: [number, string][] = [[RES_ORE, 'ore'], [RES_TIMBER, 'timber'], [RES_FISH, 'fish'], [RES_FERTILE, 'fertile']];

export interface Continent { id: number; name: string; cells: number }
export interface Site { cell: number; score: number; name: string }
export interface GameData {
  /** Continent id per cell (−1 for ocean). Lakes belong to the land around them. */
  continent: Int32Array;
  continents: Continent[];
  /** Bitmask of RES_* per cell. */
  resources: Uint8Array;
  sites: Site[];
  /** How good each cell is to live on (−1: not at all). */
  score: Float32Array;
}

const FOREST = new Set<number>([B.FOREST, B.TEMPERATE_RAIN, B.RAINFOREST, B.TAIGA, B.DRY_FOREST]);
export const FARMLAND: Partial<Record<number, number>> = {
  [B.GRASSLAND]: 1, [B.FOREST]: 0.8, [B.DRY_FOREST]: 0.7, [B.SAVANNA]: 0.6, [B.TEMPERATE_RAIN]: 0.6,
  [B.RAINFOREST]: 0.5, [B.STEPPE]: 0.4, [B.BEACH]: 0.4, [B.TAIGA]: 0.3, [B.TUNDRA]: 0.1, [B.DESERT]: 0.1,
};

/** Pronounceable invented names from syllables. Deterministic per seed. */
export function nameMaker(seed: number): () => string {
  const rng = makeRng(seed * 97 + 3);
  const on = ['b', 'd', 'k', 'l', 'm', 'n', 'r', 's', 't', 'v', 'z', 'th', 'sh', 'kr', 'dr', 'gl', 'br', 'h', 'f', 'g'];
  // Mostly single vowels: stacked pairs read as noise ("Maebraeou").
  const nu = ['a', 'e', 'i', 'o', 'u', 'a', 'e', 'i', 'o', 'a', 'ae', 'ia'];
  const co = ['', '', 'n', 'r', 'l', 's', 'th', 'm', 'nd', 'rk'];
  const pick = <T,>(a: T[]) => a[Math.floor(rng() * a.length)];
  const used = new Set<string>();
  return () => {
    for (;;) {
      const n = 2 + Math.floor(rng() * 2);
      let s = '';
      for (let i = 0; i < n; i++) s += pick(on) + pick(nu) + (i === n - 1 ? pick(co) : '');
      const name = s.charAt(0).toUpperCase() + s.slice(1);
      if (name.length >= 4 && !used.has(name)) { used.add(name); return name; }
    }
  };
}

export function gameData(w: World): GameData {
  const g = w.grid, N = g.count, nb = g.neighbors;
  const names = nameMaker(w.params.seed);

  // Continents: connected land (lakes included), biggest first so the big ones get names first.
  const continent = new Int32Array(N).fill(-1);
  const comps: number[][] = [];
  for (let c = 0; c < N; c++) {
    if (w.water[c] === WATER_OCEAN || continent[c] >= 0) continue;
    const id = comps.length, members = [c];
    continent[c] = id;
    for (let i = 0; i < members.length; i++) {
      for (const n of nb[members[i]]) {
        if (w.water[n] !== WATER_OCEAN && continent[n] < 0) { continent[n] = id; members.push(n); }
      }
    }
    comps.push(members);
  }
  const order = comps.map((m, i) => i).sort((a, b) => comps[b].length - comps[a].length);
  const remap = new Int32Array(comps.length);
  const continents: Continent[] = order.map((old, i) => {
    remap[old] = i;
    return { id: i, name: comps[old].length >= 30 ? names() : `Isle ${i}`, cells: comps[old].length };
  });
  for (let c = 0; c < N; c++) if (continent[c] >= 0) continent[c] = remap[continent[c]];

  // Resources.
  const resources = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    const b = w.biome[c];
    if (w.water[c] === WATER_LAND) {
      if (w.elevation[c] > 0.45 && b !== B.ICE) resources[c] |= RES_ORE;
      if (FOREST.has(b)) resources[c] |= RES_TIMBER;
      if ((FARMLAND[b] ?? 0) >= 0.6 && (w.moisture[c] > 0.4 || w.river[c] || nb[c].some((n) => w.river[n]))) resources[c] |= RES_FERTILE;
    } else if (w.water[c] === WATER_LAKE || b === B.SHALLOWS) {
      if (nb[c].some((n) => w.water[n] === WATER_LAND)) resources[c] |= RES_FISH;
    }
  }

  // Sites: score every habitable land cell, then pick greedily, keeping them apart.
  const score = new Float32Array(N).fill(-1);
  for (let c = 0; c < N; c++) {
    if (w.water[c] !== WATER_LAND || w.temperature[c] < 0.2) continue;
    const b = w.biome[c];
    if (b === B.ICE || b === B.PEAK || b === B.MOUNTAIN) continue;
    let s = FARMLAND[b] ?? 0;
    if (w.river[c]) s += 1;
    else if (nb[c].some((n) => w.river[n])) s += 0.5;
    if (nb[c].some((n) => w.water[n] === WATER_OCEAN)) s += 0.6;
    if (nb[c].some((n) => w.water[n] === WATER_LAKE)) s += 0.4;
    let near = resources[c];
    for (const n of nb[c]) near |= resources[n];
    for (const [bit] of RESOURCE_NAMES) if (near & bit) s += 0.2;
    s -= Math.max(0, w.elevation[c] - 0.3);           // hard to build on high ground
    score[c] = s;
  }
  const candidates: number[] = [];
  for (let c = 0; c < N; c++) if (score[c] > 0.8) candidates.push(c);
  candidates.sort((a, b) => score[b] - score[a] || a - b);
  let land = 0;
  for (let c = 0; c < N; c++) if (w.water[c] === WATER_LAND) land++;
  const want = Math.min(40, Math.max(3, Math.round(land / 180)));
  const gap = Math.max(2, Math.round(w.params.detail / 6));
  const blocked = new Uint8Array(N);
  const sites: Site[] = [];
  for (const c of candidates) {
    if (sites.length >= want) break;
    if (blocked[c]) continue;
    sites.push({ cell: c, score: Math.round(score[c] * 100) / 100, name: names() });
    // Block everything within `gap` steps.
    let ring = [c];
    blocked[c] = 1;
    for (let d = 0; d < gap; d++) {
      const next: number[] = [];
      for (const r of ring) for (const n of nb[r]) if (!blocked[n]) { blocked[n] = 1; next.push(n); }
      ring = next;
    }
  }
  return { continent, continents, resources, sites, score };
}

/** Everything as plain JSON: one entry per cell, plus continents and sites. */
export function exportJSON(w: World, gd: GameData): string {
  const g = w.grid, P = g.centers;
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const cells: ({ lat: number; lon: number } & Record<string, unknown>)[] = [];
  for (let c = 0; c < g.count; c++) {
    const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
    cells.push({
      id: c,
      lat: r3((Math.asin(Math.max(-1, Math.min(1, y))) * 180) / Math.PI),
      lon: r3((Math.atan2(z, -x) * 180) / Math.PI),
      neighbors: Array.from(g.neighbors[c]),
      biome: BIOMES[w.biome[c]].name,
      water: w.water[c] === WATER_OCEAN ? 'ocean' : w.water[c] === WATER_LAKE ? 'lake' : 'land',
      elevation: r3(w.elevation[c]),
      temperature: r3(w.temperature[c]),
      moisture: r3(w.moisture[c]),
      river: w.river[c] ? r3(w.flow[c] / w.riverThreshold) : 0,
      downstream: w.downstream[c],
      plate: w.plate[c],
      continent: gd.continent[c],
      resources: RESOURCE_NAMES.filter(([bit]) => gd.resources[c] & bit).map(([, n]) => n),
    });
  }
  return JSON.stringify({
    generator: 'mundi',
    params: w.params,
    cellCount: g.count,
    continents: gd.continents,
    sites: gd.sites.map((s) => ({ ...s, lat: cells[s.cell].lat, lon: cells[s.cell].lon })),
    cells,
  });
}
