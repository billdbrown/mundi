/**
 * The planet as a dungeon (decision 2026-11-08): how far a hex lies from the roads and the places
 * people live, cut into four bands. Danger and reward rise with depth: bandits fight harder, a
 * lost fight more often kills (Bill: "early on chance of death very low, further out more likely a
 * fight can be lethal"), the road throws up more, and what you find out there is worth more.
 *
 * Pure: worked out once per atlas from the world, nothing saved.
 */
import type { World } from '../world.ts';
import type { Atlas } from './atlas.ts';
import { BANDIT_FIGHT, type Stat } from './caravan.ts';

export type Band = 0 | 1 | 2 | 3;
export interface BandInfo {
  name: string;
  /** Hexes from the nearest road or place, at least. */
  from: number;
  /** Bandits' fighting strength, low to high (caravan.ts BANDIT_FIGHT is the Settled one). */
  bandits: [number, number];
  /** The chance a lost fight kills someone. */
  lethal: number;
  /** What finds out here are worth, against Settled's. */
  finds: number;
  /** How much more often the road throws something up. */
  events: number;
  /** Map tint (RGB) for the planet's depth layer. */
  tint: [number, number, number];
}
/** Measured on three worlds: about a quarter of land is Settled, a quarter Frontier, and the rest
 * Wild and Deep, with big wild interiors on some worlds (up to a third of land 15+ hexes out). */
export const BANDS: BandInfo[] = [
  { name: 'Settled', from: 0, bandits: [BANDIT_FIGHT.min, BANDIT_FIGHT.max], lethal: 0.02, finds: 1, events: 1, tint: [120, 170, 120] },
  { name: 'Frontier', from: 2, bandits: [6, 13], lethal: 0.08, finds: 1.5, events: 1.15, tint: [222, 196, 96] },
  { name: 'Wild', from: 5, bandits: [9, 17], lethal: 0.2, finds: 2, events: 1.3, tint: [226, 128, 60] },
  { name: 'Deep', from: 11, bandits: [12, 22], lethal: 0.4, finds: 3, events: 1.5, tint: [196, 52, 52] },
];
export const bandOfHexes = (d: number): Band => (d >= BANDS[3].from ? 3 : d >= BANDS[2].from ? 2 : d >= BANDS[1].from ? 1 : 0);

const cache = new WeakMap<Atlas, Uint8Array>();
/** Hexes from the nearest road or place for every land cell (walking over land only); land no
 * road reaches counts as Deep. Water is 0. */
export function depthMap(w: World, a: Atlas): Uint8Array {
  let d8 = cache.get(a);
  if (d8) return d8;
  const N = w.grid.count, nb = w.grid.neighbors, d = new Int32Array(N).fill(-1), q: number[] = [];
  for (let c = 0; c < N; c++) if (w.water[c] === 0 && (a.road[c] || a.placeAt[c] >= 0)) { d[c] = 0; q.push(c); }
  for (let i = 0; i < q.length; i++) for (const n of nb[q[i]]) if (d[n] < 0 && w.water[n] === 0) { d[n] = d[q[i]] + 1; q.push(n); }
  d8 = new Uint8Array(N);
  for (let c = 0; c < N; c++) d8[c] = w.water[c] !== 0 ? 0 : d[c] < 0 ? 255 : Math.min(254, d[c]);
  cache.set(a, d8);
  return d8;
}
export const bandAt = (w: World, a: Atlas, cell: number): Band => bandOfHexes(depthMap(w, a)[cell]);

/** A hex's depth as stats: "Wild · Bandits 9–17 · Lethal 20% · Finds ×2". */
export function depthStats(b: Band): Stat[] {
  const x = BANDS[b];
  return [
    { k: 'Depth', v: x.name, good: null },
    { k: 'Bandits', v: `${x.bandits[0]}–${x.bandits[1]}`, good: b === 0 ? null : false },
    { k: 'Lethal', v: `${Math.round(x.lethal * 100)}%`, good: b === 0 ? null : false },
    { k: 'Finds', v: `×${x.finds}`, good: b === 0 ? null : true },
  ];
}
