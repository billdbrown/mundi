/**
 * The game's reading of a world and its history: the places a caravan can visit, what each one
 * makes and needs, the roads worth keeping, and what it costs to cross a hex.
 *
 * Towns are the history sim's settlements as they stand at its last year. Its roads are denser
 * than the game wants (Bill, 2026-11-06), so the atlas keeps a backbone: per continent, a spanning
 * tree between the larger towns, routed along the old roads where they help.
 *
 * Pure and deterministic, so it is tested (test/primundi.test.ts).
 */
import { B } from '../biomes.ts';
import { baseOf } from '../ecology.ts';
import { WATER_LAND, WATER_LAKE, WATER_OCEAN, type World } from '../world.ts';
import { RES_FERTILE, RES_FISH, RES_ORE, RES_TIMBER, type GameData } from '../gamedata.ts';
import { HISTORY_YEARS, farmRadius, popAt, realmAt, type History } from '../civ.ts';

// --- Goods ------------------------------------------------------------------------------------
export interface Good { id: string; name: string; base: number }
/** Prices in orrels. Relics are never made: they come out of ruins. */
export const GOODS: Good[] = [
  { id: 'grain', name: 'Grain', base: 4 },
  { id: 'fish', name: 'Salt fish', base: 6 },
  { id: 'salt', name: 'Salt', base: 9 },
  { id: 'timber', name: 'Timber', base: 6 },
  { id: 'ore', name: 'Ore', base: 10 },
  { id: 'wool', name: 'Wool', base: 8 },
  { id: 'furs', name: 'Furs', base: 22 },
  { id: 'cloth', name: 'Cloth', base: 20 },
  { id: 'tools', name: 'Tools', base: 26 },
  { id: 'spice', name: 'Spice', base: 40 },
  { id: 'relics', name: 'Relics', base: 150 },
];
export const G = Object.fromEntries(GOODS.map((g, i) => [g.id, i])) as Record<string, number>;
const NG = GOODS.length;

const SALTY = new Set<number>([B.SALT_FLAT, B.SALT_MARSH, B.DESERT, B.COLD_DESERT, B.BADLANDS]);
const FURRY = new Set<number>([B.TAIGA, B.LARCH, B.TUNDRA, B.MONTANE_FOREST]);
const WOOLLY = new Set<number>([B.STEPPE, B.GRASSLAND, B.PRAIRIE, B.HEATH, B.ALPINE_MEADOW, B.CHAPARRAL]);
const SPICY = new Set<number>([B.RAINFOREST, B.MONSOON, B.CLOUD_FOREST, B.PALM_SAVANNA, B.MANGROVE]);

/** What one hex yields of each raw good (crafted goods come from towns, below). */
function yields(w: World, gd: GameData, c: number, out: Float32Array) {
  const r = gd.resources[c], b = w.biome[c];
  if (r & RES_FERTILE) out[G.grain] += 1;
  if (r & RES_FISH) out[G.fish] += 0.8;
  if (r & RES_TIMBER) out[G.timber] += 0.7;
  if (r & RES_ORE) out[G.ore] += 0.6;
  if (SALTY.has(b)) out[G.salt] += b === B.SALT_FLAT || b === B.SALT_MARSH ? 1 : 0.25;
  if (w.water[c] === WATER_LAND && w.grid.neighbors[c].some((n) => w.water[n] === WATER_OCEAN)) out[G.salt] += 0.15;
  if (FURRY.has(b)) out[G.furs] += 0.5;
  if (WOOLLY.has(b)) out[G.wool] += 0.5;
  if (SPICY.has(b)) out[G.spice] += 0.35;
}

/** What a person needs of each good, per thousand people (luxuries scale faster, below). */
const NEED = [1.4, 0.5, 0.35, 0.5, 0.2, 0.35, 0.12, 0.25, 0.2, 0.06, 0.02];
const LUXURY = new Set([G.furs, G.cloth, G.tools, G.spice, G.relics]);

// --- Places -----------------------------------------------------------------------------------
export interface Place {
  /** Index in Atlas.places (also the save's id for it). */
  id: number;
  cell: number;
  name: string;
  pop: number;
  town: boolean;
  /** The realm it belongs to, or '' for none. */
  realm: string;
  /** The equilibrium price of each good here, before stock and season. */
  price: Float32Array;
  /** How many units of each good the market holds when left alone. */
  stock: Float32Array;
}

export interface Atlas {
  places: Place[];
  /** Place id at each cell, −1 for none. */
  placeAt: Int32Array;
  /** 1 where the backbone road runs. */
  road: Uint8Array;
  /** Road segments (pairs of neighbouring cells), for drawing. */
  roadEdges: [number, number][];
}

/** People at or above this make a town; below, a village. */
export const TOWN_POP = 2500;

export function buildAtlas(w: World, gd: GameData, h: History): Atlas {
  const N = w.grid.count, nb = w.grid.neighbors, year = HISTORY_YEARS;
  const placeAt = new Int32Array(N).fill(-1);
  const places: Place[] = [];
  for (const s of h.settlements) {
    const pop = popAt(s, year);
    if (pop <= 0 || w.water[s.cell] !== WATER_LAND || placeAt[s.cell] >= 0) continue;
    const r = realmAt(s, year);
    const realm = r >= 0 ? h.realms.find((x) => x.id === r)?.name ?? '' : '';
    const id = places.length;
    places.push({ id, cell: s.cell, name: s.name, pop: Math.round(pop), town: pop >= TOWN_POP, realm, price: new Float32Array(NG), stock: new Float32Array(NG) });
    placeAt[s.cell] = id;
  }

  // The backbone: per continent, a spanning tree between towns, nearest first.
  const road = new Uint8Array(N);
  const oldRoad = new Uint8Array(N);
  for (const r of h.roads) for (const c of r.cells) oldRoad[c] = 1;
  const towns = places.filter((p) => p.town);
  const coastal = new Uint8Array(N);
  for (let c = 0; c < N; c++) if (w.water[c] === WATER_LAND && nb[c].some((n) => w.water[n] === WATER_OCEAN)) coastal[c] = 1;
  const P = w.grid.centers;
  const ang = (a: number, b: number) => Math.acos(Math.min(1, P[a * 3] * P[b * 3] + P[a * 3 + 1] * P[b * 3 + 1] + P[a * 3 + 2] * P[b * 3 + 2]));
  const byCont = new Map<number, Place[]>();
  for (const t of towns) {
    const k = gd.continent[t.cell];
    if (!byCont.has(k)) byCont.set(k, []);
    byCont.get(k)!.push(t);
  }
  const cellA = Math.sqrt((4 * Math.PI) / N);
  for (const group of byCont.values()) {
    // Prim's tree on straight distance; long links (over ~14 hexes) are left unbuilt: open country.
    const inTree = new Set([0]);
    while (inTree.size < group.length) {
      let best = Infinity, bi = -1, bj = -1;
      for (const i of inTree) for (let j = 0; j < group.length; j++) {
        if (inTree.has(j)) continue;
        const d = ang(group[i].cell, group[j].cell);
        if (d < best) { best = d; bi = i; bj = j; }
      }
      inTree.add(bj);
      if (best > cellA * 14) continue;
      // Roads keep a hex back from the sea (Bill, 2026-11-06): a coastal town's road heads inland
      // at once. Only where there's no other way (a narrow neck of land) does one follow the shore.
      const from = group[bi].cell, to = group[bj].cell;
      const cost = (a: number, b: number) => (oldRoad[b] ? 0.35 : 1) * terrainCost(w, a, b);
      const path = findPath(w, from, to, cost, (c) => !coastal[c], 22)
        ?? findPath(w, from, to, (a, b) => cost(a, b) * (coastal[b] && b !== to ? 12 : 1), () => true, 22 * 12);
      if (path) for (const c of path) road[c] = 1;
    }
  }
  const roadEdges: [number, number][] = [];
  for (let c = 0; c < N; c++) if (road[c]) for (const n of nb[c]) if (n > c && road[n]) roadEdges.push([c, n]);

  // Markets: what the land round each place makes, against what its people need.
  const tmp = new Float32Array(NG);
  for (const p of places) {
    const prod = new Float32Array(NG);
    const R = 1 + Math.round(farmRadius(p.pop));
    const labour = 0.5 + p.pop / 2000;
    for (const c of ringCells(w, p.cell, R)) {
      tmp.fill(0);
      yields(w, gd, c, tmp);
      for (let g = 0; g < NG; g++) prod[g] += tmp[g] * labour;
    }
    // Crafts: big towns weave what wool comes in and forge tools where there's ore and timber.
    if (p.pop >= 1500) {
      prod[G.cloth] += (p.pop / 2000) * (0.4 + Math.min(1, prod[G.wool] / 4));
      prod[G.tools] += (p.pop / 2000) * (0.2 + Math.min(1, prod[G.ore] / 3) * Math.min(1, (prod[G.timber] + 1) / 3));
    }
    const k = p.pop / 1000;
    for (let g = 0; g < NG; g++) {
      const need = NEED[g] * (LUXURY.has(g) ? Math.pow(k, 1.25) : k) * (g === G.furs && w.temperature[p.cell] < 0.4 ? 2 : 1);
      const e = 0.15;
      p.price[g] = GOODS[g].base * clamp(Math.sqrt((need + e) / (prod[g] + e)), 0.35, 3);
      p.stock[g] = Math.round(6 + 5 * (prod[g] + need) * (p.town ? 1.5 : 1));
    }
  }
  // Trade along the backbone evens prices out a little between joined towns.
  const comp = roadComponents(w, road);
  const sum = new Map<number, { n: number; lg: Float64Array }>();
  for (const p of places) {
    const k = nearbyComponent(w, comp, p.cell);
    if (k < 0) continue;
    if (!sum.has(k)) sum.set(k, { n: 0, lg: new Float64Array(NG) });
    const s = sum.get(k)!;
    s.n++;
    for (let g = 0; g < NG; g++) s.lg[g] += Math.log(p.price[g]);
  }
  for (const p of places) {
    const k = nearbyComponent(w, comp, p.cell), s = k >= 0 ? sum.get(k) : undefined;
    if (!s || s.n < 2) continue;
    for (let g = 0; g < NG; g++) p.price[g] = Math.exp(Math.log(p.price[g]) * 0.7 + (s.lg[g] / s.n) * 0.3);
  }
  return { places, placeAt, road, roadEdges };
}

function roadComponents(w: World, road: Uint8Array): Int32Array {
  const comp = new Int32Array(road.length).fill(-1);
  let k = 0;
  for (let c = 0; c < road.length; c++) {
    if (!road[c] || comp[c] >= 0) continue;
    const q = [c];
    comp[c] = k;
    for (let i = 0; i < q.length; i++) for (const n of w.grid.neighbors[q[i]]) if (road[n] && comp[n] < 0) { comp[n] = k; q.push(n); }
    k++;
  }
  return comp;
}
function nearbyComponent(w: World, comp: Int32Array, c: number): number {
  if (comp[c] >= 0) return comp[c];
  for (const n of w.grid.neighbors[c]) if (comp[n] >= 0) return comp[n];
  return -1;
}

/** Cells within `r` steps of `c`, over land and inland or shallow water (fishing grounds). */
export function ringCells(w: World, c: number, r: number): number[] {
  const seen = new Set([c]);
  let ring = [c];
  for (let d = 0; d < r; d++) {
    const next: number[] = [];
    for (const x of ring) for (const n of w.grid.neighbors[x]) if (!seen.has(n)) { seen.add(n); next.push(n); }
    ring = next;
  }
  return [...seen];
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

// --- Crossing a hex ---------------------------------------------------------------------------
/** Days to cross a hex of each biome on foot with pack beasts, on the flat, in fair weather. */
const DAYS: Partial<Record<number, number>> = {
  [B.GRASSLAND]: 0.45, [B.STEPPE]: 0.45, [B.PRAIRIE]: 0.45, [B.SAVANNA]: 0.5, [B.PALM_SAVANNA]: 0.55, [B.BEACH]: 0.5,
  [B.FLOODPLAIN]: 0.6, [B.CHAPARRAL]: 0.6, [B.HEATH]: 0.6, [B.ALPINE_MEADOW]: 0.8, [B.TUNDRA]: 0.7,
  [B.DESERT]: 0.6, [B.DESERT_SCRUB]: 0.6, [B.COLD_DESERT]: 0.65, [B.SALT_FLAT]: 0.5, [B.POLAR_DESERT]: 0.9,
  [B.BADLANDS]: 0.9, [B.CANYONS]: 1.2, [B.KARST]: 1.0,
  [B.FOREST]: 0.8, [B.MIXED_FOREST]: 0.8, [B.DRY_FOREST]: 0.7, [B.TEMPERATE_RAIN]: 1.0, [B.TAIGA]: 0.9, [B.LARCH]: 0.9,
  [B.MONTANE_FOREST]: 1.1, [B.CLOUD_FOREST]: 1.3, [B.RAINFOREST]: 1.3, [B.MONSOON]: 1.1,
  [B.SWAMP]: 1.5, [B.MARSH]: 1.3, [B.BOG]: 1.4, [B.MANGROVE]: 1.6, [B.SALT_MARSH]: 1.2,
  [B.MOUNTAIN]: 1.6, [B.PEAK]: 3.0, [B.ICE]: 2.5,
};

/** Can a caravan stand on this cell at all? (No boats yet.) */
export const walkable = (w: World, c: number) => w.water[c] === WATER_LAND;

/** Days from cell a into its neighbour b, before roads and season. */
export function terrainCost(w: World, a: number, b: number): number {
  let d = DAYS[w.biome[b]] ?? DAYS[baseOf(w.biome[b])] ?? 0.8;
  const rise = w.elevation[b] - w.elevation[a];
  d += Math.max(0, rise) * 6 + Math.abs(rise) * 1.5;
  if (w.river[b] && !w.river[a]) d += 0.25;            // a ford
  return d;
}

/** The temperature on the ground at a cell on a day of the year (sky.ts seasonalTemp, roughly). */
export function seasonalTemp(w: World, c: number, doy: number): number {
  const s = Math.sin((2 * Math.PI * (doy - 80)) / 365);
  return w.temperature[c] + 0.24 * w.grid.centers[c * 3 + 1] * s;
}
export const SNOW_TEMP = 0.18;

/** Days from a into b: terrain, the road, snow. */
export function stepDays(w: World, atlas: Atlas, a: number, b: number, doy: number): number {
  let d = terrainCost(w, a, b);
  if (atlas.road[a] && atlas.road[b]) d *= 0.5;
  if (seasonalTemp(w, b, doy) < SNOW_TEMP) d *= 1.5;
  return d;
}

/** Cheapest path from a to b (both included), A* on the hex grid. `ok` says which cells may be
 * walked; the goal is always allowed. Gives up past `maxCost` (in the cost's units). `minStep` is
 * the cheapest any step can be, for the heuristic (a bigger one is faster and a little less exact). */
export function findPath(w: World, a: number, b: number, cost: (a: number, b: number) => number, ok: (c: number) => boolean, maxCost = Infinity, minStep = 0.3): number[] | null {
  if (a === b) return [a];
  if (!walkable(w, b)) return null;
  const P = w.grid.centers, N = w.grid.count, nb = w.grid.neighbors;
  const cellA = Math.sqrt((4 * Math.PI) / N);
  const bx = P[b * 3], by = P[b * 3 + 1], bz = P[b * 3 + 2];
  const h = (c: number) => (Math.acos(Math.min(1, P[c * 3] * bx + P[c * 3 + 1] * by + P[c * 3 + 2] * bz)) / cellA) * minStep;
  const g = new Float64Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), done = new Uint8Array(N);
  g[a] = 0;
  const heap = new Heap();
  heap.push(a, h(a));
  while (heap.size) {
    const c = heap.pop();
    if (c === b) {
      const out = [b];
      let x = b;
      while (x !== a) { x = from[x]; out.push(x); }
      return out.reverse();
    }
    if (done[c]) continue;
    done[c] = 1;
    if (g[c] > maxCost) return null;
    for (const n of nb[c]) {
      if (done[n] || !walkable(w, n) || (n !== b && !ok(n))) continue;
      const gn = g[c] + cost(c, n);
      if (gn < g[n]) { g[n] = gn; from[n] = c; heap.push(n, gn + h(n)); }
    }
  }
  return null;
}

class Heap {
  private k: number[] = []; private v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, pri: number) {
    const k = this.k, v = this.v;
    k.push(key); v.push(pri);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (v[p] <= v[i]) break;
      [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.k, v = this.v, top = k[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < k.length && v[l] < v[m]) m = l;
        if (r < k.length && v[r] < v[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

/** Is there fresh water here (river, lake shore, or a town's wells)? */
export function hasWater(w: World, atlas: Atlas, c: number): boolean {
  if (w.river[c] || atlas.placeAt[c] >= 0) return true;
  // Wet country has streams and springs enough: water only runs short in dry land.
  if (w.moisture[c] > 0.45) return true;
  return w.grid.neighbors[c].some((n) => w.water[n] === WATER_LAKE || w.river[n]);
}
