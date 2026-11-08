/**
 * Other traders on the roads (2026-11-07, night 2, loop A "living roads"). Bill: "It would be fun
 * to see other dots, maybe fainter, of other traders moving around, kind of at that scope."
 *
 * A few dozen caravans, each with a home town, going town to neighbouring town along the backbone
 * roads (atlas.roadPaths), resting a few days in each. Nothing is stored: every trader's journeys
 * follow from the seed, worked out leg by leg as far as the day asked for, so a reload shows the
 * same traffic. The map draws them as faint dots; passing one on the road is meeting that trader
 * (sim.ts folkHere).
 */
import type { World } from '../world.ts';
import { makeRng } from '../rng.ts';
import { nameMaker } from '../gamedata.ts';
import { stepDays, type Atlas } from './atlas.ts';

/** Day of the year a game's day 0 is (sim.ts START_DOY, repeated here to keep this module free of sim). */
const START_DOY = 100;
/** Traders per town on the road network, and the bounds on how many in all. */
export const TRAFFIC_PER_TOWN = 0.5, TRAFFIC_MIN = 6, TRAFFIC_MAX = 70;
/** Days a trader rests in a town between legs. */
export const REST_DAYS: [number, number] = [1, 4];

export interface Trader { i: number; name: string; home: number }
/** One journey, town to neighbouring town. `t[k]`: the day they reach path[k]. */
export interface Leg { n: number; from: number; to: number; path: number[]; t: number[] }
/** A trader on the road on some day: which leg, the hex they're in and the next, and how far between. */
export interface OnRoad { trader: Trader; leg: Leg; cell: number; next: number; frac: number }

export class Traffic {
  readonly traders: Trader[] = [];
  private legs: Leg[][] = [];
  private rngs: (() => number)[] = [];
  /** Road paths out of each town (by its cell), oriented away from it. */
  private out = new Map<number, number[][]>();
  private w: World;
  private a: Atlas;

  constructor(w: World, a: Atlas, seed: number) {
    this.w = w; this.a = a;
    for (const p of a.roadPaths) {
      if (p.length < 2) continue;
      const s = p[0], e = p[p.length - 1];
      if (a.placeAt[s] < 0 || a.placeAt[e] < 0) continue;
      if (!this.out.has(s)) this.out.set(s, []);
      if (!this.out.has(e)) this.out.set(e, []);
      this.out.get(s)!.push(p);
      this.out.get(e)!.push([...p].reverse());
    }
    const towns = [...this.out.keys()].sort((x, y) => x - y);
    if (!towns.length) return;
    const n = Math.max(TRAFFIC_MIN, Math.min(TRAFFIC_MAX, Math.round(towns.length * TRAFFIC_PER_TOWN)));
    const names = nameMaker((seed * 31 + 17) >>> 0);
    for (let i = 0; i < n; i++) {
      const rng = makeRng((seed * 2654435761 + i * 40503 + 977) >>> 0);
      const home = a.placeAt[towns[Math.floor(rng() * towns.length)]];
      this.traders.push({ i, name: names(), home });
      this.rngs.push(rng);
      // They're already about their business when the game starts: the first leg sets out a little
      // before day 0.
      this.legs.push([]);
      this.addLeg(i, a.places[home].cell, -rng() * 12);
    }
  }

  private addLeg(i: number, fromCell: number, depart: number) {
    const rng = this.rngs[i], legs = this.legs[i], prev = legs[legs.length - 1];
    let ways = this.out.get(fromCell) ?? [];
    // Not straight back the way they came, unless it's the only road.
    if (prev && ways.length > 1) ways = ways.filter((p) => p[p.length - 1] !== prev.path[0]);
    if (!ways.length) return;
    const path = ways[Math.floor(rng() * ways.length)];
    const t = [depart];
    const doy = ((START_DOY + Math.floor(depart)) % 365 + 365) % 365;
    for (let k = 1; k < path.length; k++) t.push(t[k - 1] + stepDays(this.w, this.a, path[k - 1], path[k], doy));
    legs.push({ n: legs.length, from: this.a.placeAt[path[0]], to: this.a.placeAt[path[path.length - 1]], path, t });
  }

  /** Make sure trader i's legs reach past `day`. */
  private extend(i: number, day: number) {
    const legs = this.legs[i], rng = this.rngs[i];
    let guard = 0;
    while (legs.length && legs[legs.length - 1].t[legs[legs.length - 1].t.length - 1] <= day && guard++ < 10000) {
      const last = legs[legs.length - 1], arrive = last.t[last.t.length - 1];
      const before = legs.length;
      this.addLeg(i, last.path[last.path.length - 1], arrive + REST_DAYS[0] + rng() * (REST_DAYS[1] - REST_DAYS[0]));
      if (legs.length === before) break;
    }
  }

  /** Where trader i is on a day: on the road (with their leg), or null (in a town, resting). */
  where(i: number, day: number): OnRoad | null {
    this.extend(i, day);
    const legs = this.legs[i];
    // The leg under way: the last that has set out by now.
    for (let k = legs.length - 1; k >= 0; k--) {
      const L = legs[k];
      if (L.t[0] > day) continue;
      if (L.t[L.t.length - 1] <= day) return null;
      let j = 0;
      while (j + 1 < L.t.length && L.t[j + 1] <= day) j++;
      const frac = (day - L.t[j]) / Math.max(1e-6, L.t[j + 1] - L.t[j]);
      return { trader: this.traders[i], leg: L, cell: L.path[j], next: L.path[j + 1], frac };
    }
    return null;
  }

  /** Everyone on the road on a day. */
  onRoad(day: number): OnRoad[] {
    const out: OnRoad[] = [];
    for (let i = 0; i < this.traders.length; i++) { const r = this.where(i, day); if (r) out.push(r); }
    return out;
  }

  /** Who's in a hex on a day. */
  inCell(cell: number, day: number): OnRoad[] {
    return this.onRoad(day).filter((r) => r.cell === cell);
  }

  /** Arrivals at a town between two days (for prices: what they brought). */
  arrivals(pid: number, from: number, to: number): Leg[] {
    const out: Leg[] = [];
    for (let i = 0; i < this.traders.length; i++) {
      this.extend(i, to);
      for (const L of this.legs[i]) { const at = L.t[L.t.length - 1]; if (L.to === pid && at > from && at <= to) out.push(L); }
    }
    return out;
  }
}

/** The id a meeting with a trader on one of their legs goes by (save.finds `folk:<id>`). */
export const trafficId = (r: OnRoad) => `t${r.trader.i}-${r.leg.n}`;
