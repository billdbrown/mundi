/**
 * Where a Primundi game starts. Any habitable cell, on any continent, not just the best few sites
 * (Bill, 2026-11-06: "there's fun in being on the suboptimal continent and learning that later").
 * The start bias leans the draw:
 *
 * - gentle: good land in a mild, wet climate, often by a river or coast;
 * - any: anywhere people could live, weighted a little toward better land;
 * - harsh: a hard climate (dry, cold or hot and dry) that can still just support a settlement,
 *   such as a thin river through desert.
 *
 * Pure and deterministic: the same world, bias and seed always give the same cell.
 */
import { B } from '../biomes.ts';
import { baseOf } from '../ecology.ts';
import { makeRng } from '../rng.ts';
import { WATER_LAND, type World } from '../world.ts';
import type { GameData } from '../gamedata.ts';

export type StartBias = 'gentle' | 'any' | 'harsh';
export const BIASES: { id: StartBias; label: string; note: string }[] = [
  { id: 'gentle', label: 'Gentle', note: 'Mild, well-watered land' },
  { id: 'any', label: 'Any', note: 'Wherever people could live' },
  { id: 'harsh', label: 'Harsh', note: 'Dry, cold or scorched: hard going' },
];

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
  const rng = makeRng((seed ^ (bias === 'gentle' ? 0x51 : bias === 'harsh' ? 0xa7 : 0x3c)) >>> 0);
  const cells: number[] = [], weights: number[] = [];
  for (let c = 0; c < w.grid.count; c++) {
    if (w.water[c] !== WATER_LAND) continue;
    const s = gd.score[c];
    if (s <= 0.5) continue;                       // nobody could live here
    const hard = harshness(w, c);
    let wt: number;
    if (bias === 'gentle') wt = hard < 0.25 && s >= 1.2 ? s * s : 0;
    else if (bias === 'harsh') wt = hard > 0.5 ? hard * Math.min(s, 2) : 0;
    else wt = s;
    if (wt > 0) { cells.push(c); weights.push(wt); }
  }
  // Too strict for this world: fall back to anywhere habitable.
  if (!cells.length) return bias === 'any' ? (gd.sites[0]?.cell ?? 0) : pickStart(w, gd, 'any', seed);
  let total = 0;
  for (const x of weights) total += x;
  let r = rng() * total;
  for (let i = 0; i < cells.length; i++) { r -= weights[i]; if (r <= 0) return cells[i]; }
  return cells[cells.length - 1];
}
