/**
 * Where a Primundi game starts. Any habitable cell, on any continent, not just the best few sites
 * (Bill, 2026-11-06: "there's fun in being on the suboptimal continent and learning that later").
 * The start bias leans the draw:
 *
 * - gentle: good land in a mild, wet climate, often by a river or coast;
 * - any: anywhere people could live, weighted a little toward better land;
 * - harsh: a hard climate (dry, cold or hot and dry);
 * - inhospitable: the very edge of what can support a settlement, such as a thin river through
 *   desert.
 *
 * (pickStart and harshness, the climate, are the old way; the hometown is pickHome, by the wild.)
 *
 * Pure and deterministic: the same world, bias and seed always give the same cell.
 */
import { B } from '../biomes.ts';
import { baseOf } from '../ecology.ts';
import { makeRng } from '../rng.ts';
import { WATER_LAND, type World } from '../world.ts';
import type { GameData } from '../gamedata.ts';
import type { Atlas } from './atlas.ts';
import { bandOfHexes, depthMap, type Band } from './depth.ts';

/** The home's country (Bill, 2026-11-06: Gentle, Harsh, Inhospitable). 'any' is kept for old saves
 * and as the last fallback, not offered.
 *
 * Since 2026-11-09 the hometown's bias is how near the wild is (depth.ts), not its climate (Bill:
 * "home harshness has new meaning with the deep now"): gentle is deep in settled country, harsh a
 * frontier town with the Wild a few days off, inhospitable the last town before the Deep. */
export type StartBias = 'gentle' | 'harsh' | 'inhospitable' | 'any';
export const BIASES: { id: StartBias; label: string; note: string }[] = [
  { id: 'gentle', label: 'Gentle', note: 'Deep in settled country: the wild is a week away' },
  { id: 'harsh', label: 'Harsh', note: 'A frontier town: the Wild is a few days out' },
  { id: 'inhospitable', label: 'Inhospitable', note: 'The last town before the Deep' },
];
/** Too strict for a world: try the next milder. */
const MILDER: Record<StartBias, StartBias> = { inhospitable: 'harsh', harsh: 'gentle', gentle: 'any', any: 'any' };

const HARSH = new Set<number>([B.DESERT, B.COLD_DESERT, B.DESERT_SCRUB, B.SALT_FLAT, B.BADLANDS, B.CANYONS, B.TUNDRA, B.POLAR_DESERT, B.STEPPE, B.TAIGA, B.LARCH, B.HEATH, B.KARST]);

/** How harsh a cell's climate is, 0 (kind) .. 1 (barely livable). */
export function harshness(w: World, c: number): number {
  const t = w.temperature[c], m = w.moisture[c];
  const dry = Math.max(0, 0.45 - m) / 0.45;
  const cold = Math.max(0, 0.42 - t) / 0.42;
  const hot = Math.max(0, t - 0.78) / 0.22;
  return Math.min(1, Math.max(dry, cold * 0.9, hot * 0.6 + dry * 0.4) + (HARSH.has(baseOf(w.biome[c])) ? 0.25 : 0));
}

/** The start cell for this world, bias and game seed. */
export function pickStart(w: World, gd: GameData, bias: StartBias, seed: number): number {
  const rng = makeRng((seed ^ (bias === 'gentle' ? 0x51 : bias === 'harsh' ? 0xa7 : bias === 'inhospitable' ? 0xc5 : 0x3c)) >>> 0);
  const cells: number[] = [], weights: number[] = [];
  for (let c = 0; c < w.grid.count; c++) {
    if (w.water[c] !== WATER_LAND) continue;
    const s = gd.score[c];
    if (s <= 0.5) continue;                       // nobody could live here
    const hard = harshness(w, c);
    let wt: number;
    if (bias === 'gentle') wt = hard < 0.25 && s >= 1.2 ? s * s : 0;
    else if (bias === 'harsh') wt = hard > 0.3 && hard <= 0.65 ? Math.min(s, 2) : 0;
    else if (bias === 'inhospitable') wt = hard > 0.7 ? hard * Math.min(s, 2) : 0;
    else wt = s;
    if (wt > 0) { cells.push(c); weights.push(wt); }
  }
  // Too strict for this world: fall back to anywhere habitable.
  if (!cells.length) return bias === 'any' ? (gd.sites[0]?.cell ?? 0) : pickStart(w, gd, MILDER[bias], seed);
  let total = 0;
  for (const x of weights) total += x;
  let r = rng() * total;
  for (let i = 0; i < cells.length; i++) { r -= weights[i]; if (r <= 0) return cells[i]; }
  return cells[cells.length - 1];
}

/** Hexes over land from each cell to the nearest at depth `band` or deeper (depth.ts); 255 for none. */
export function hexesToBand(w: World, a: Atlas, band: Band): Uint8Array {
  const N = w.grid.count, nb = w.grid.neighbors, dm = depthMap(w, a), d = new Uint8Array(N).fill(255), q: number[] = [];
  for (let c = 0; c < N; c++) if (w.water[c] === WATER_LAND && bandOfHexes(dm[c]) >= band) { d[c] = 0; q.push(c); }
  for (let i = 0; i < q.length; i++) for (const n of nb[q[i]]) if (d[n] === 255 && w.water[n] === WATER_LAND && d[q[i]] < 254) { d[n] = d[q[i]] + 1; q.push(n); }
  return d;
}
/** How far the wild is from a hometown, by bias: hexes to the Wild for gentle (at least) and harsh
 * (at most), to the Deep for inhospitable (at most). */
export const HOME_WILD = { gentle: 8, harsh: [2, 5], inhospitable: 5 } as const;
/** The caravan's hometown: a real place from the history, leaned by the bias (how near the wild
 * is). Middling places are likelier than capitals or hamlets: somewhere with a market, not the
 * centre of the world. */
export function pickHome(w: World, a: Atlas, bias: StartBias, seed: number): number {
  const places = a.places;
  const rng = makeRng((seed ^ (bias === 'gentle' ? 0x93 : bias === 'harsh' ? 0x2d : bias === 'inhospitable' ? 0xe7 : 0x61)) >>> 0);
  const toWild = hexesToBand(w, a, 2), toDeep = bias === 'inhospitable' ? hexesToBand(w, a, 3) : null;
  // Inhospitable: within a few hexes of the Deep, or on a world with no town that near, the
  // towns nearest it (rather than falling back to harsh).
  const deepReach = toDeep ? Math.max(HOME_WILD.inhospitable, Math.min(...places.map((p) => toDeep[p.cell])) + 2) : 0;
  const ids: number[] = [], weights: number[] = [];
  for (const p of places) {
    const size = 1 / (1 + Math.abs(Math.log(p.pop / 1500)));
    const wild = toWild[p.cell];
    let wt: number;
    if (bias === 'gentle') wt = wild >= HOME_WILD.gentle ? size : 0;
    else if (bias === 'harsh') wt = wild >= HOME_WILD.harsh[0] && wild <= HOME_WILD.harsh[1] ? size : 0;
    else if (bias === 'inhospitable') wt = toDeep![p.cell] <= deepReach ? size : 0;
    else wt = size;
    if (wt > 0) { ids.push(p.id); weights.push(wt); }
  }
  if (!ids.length) return bias === 'any' ? (places[0]?.id ?? -1) : pickHome(w, a, MILDER[bias], seed);
  let total = 0;
  for (const x of weights) total += x;
  let r = rng() * total;
  for (let i = 0; i < ids.length; i++) { r -= weights[i]; if (r <= 0) return ids[i]; }
  return ids[ids.length - 1];
}
