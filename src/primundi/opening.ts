/**
 * The first ten minutes (decision 2026-11-07): you build the caravan by walking your home town.
 * Crew at the tavern, beasts at the inn's yard, a first load at the market, all from one purse.
 * Then a first errand, a first road with someone on it, and word of a place very far away.
 *
 * This file is the pure part: who's looking for work, and where the far place is. The moves that
 * change a save are in sim.ts.
 */
import { makeRng } from '../rng.ts';
import { nameMaker } from '../gamedata.ts';
import type { World } from '../world.ts';
import type { Atlas, Place } from './atlas.ts';
import { hireCost, makeMember, type Lean, type Member, type Origin } from './caravan.ts';
import { tradesOf } from './towns.ts';

/** Someone in the tavern looking for a place in a caravan. */
export interface Candidate { m: Member; cost: number; lean: Lean }
/** Most people you can take on before setting out (the leader besides). */
export const SETUP_MAX = 5;

const dot = (w: World, a: number, b: number) => {
  const P = w.grid.centers;
  return P[a * 3] * P[b * 3] + P[a * 3 + 1] * P[b * 3 + 1] + P[a * 3 + 2] * P[b * 3 + 2];
};

/** Six people in the home tavern, each with a stat line, maybe a way about them, and something they want. */
export function candidates(w: World, a: Atlas, home: Place, origin: Origin, seed: number): Candidate[] {
  const rng = makeRng((seed * 48271 + home.id * 7 + 3) >>> 0), names = nameMaker(seed * 29 + 11);
  const leans: Lean[] = origin === 'cartographers' ? ['scout', 'scout', 'fighter', 'fighter', 'hunter', 'hand'] : ['fighter', 'fighter', 'fighter', 'hand', 'hand', 'scout'];
  const byNear = a.places.filter((p) => p.id !== home.id).sort((x, y) => dot(w, y.cell, home.cell) - dot(w, x.cell, home.cell));
  const near = byNear[0]?.name ?? 'the next town', far = byNear[Math.floor(byNear.length * 0.6)]?.name ?? 'the far towns';
  const shrine = byNear.slice(0, 30).find((p) => tradesOf(w, a, p)[0] === 'shrine')?.name;
  const coast = w.grid.neighbors[home.cell].some((n) => w.water[n] === 1);
  const wishes = [
    coast ? 'has never been out of sight of the sea, and means to be' : 'wants to see the sea before they are old',
    `has a sister who went to ${far} years ago and never wrote`,
    `owes money in ${near}, and would rather pay it than run`,
    shrine ? `swore to visit the shrine at ${shrine}` : 'wants to stand on the highest ground there is',
    'wants enough orrels to buy a farm, and then never travel again',
    `has walked every road round ${home.name} and wants new ones`,
    'is leaving something behind, and won\'t say what',
    'wants to be the first to see what is under the storm',
  ];
  // Shuffle the wishes, so no two share one.
  for (let i = wishes.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [wishes[i], wishes[j]] = [wishes[j], wishes[i]]; }
  return leans.map((lean, i) => {
    const m = makeMember(names(), lean, rng);
    m.wish = wishes[i];
    return { m, cost: hireCost(m), lean };
  });
}

/** The place the opening's rumour points at: as far as it gets from home on the same land, a town
 * if there is one out there. */
export function farPlace(w: World, a: Atlas, continent: Int32Array, home: Place): Place | null {
  const k = continent[home.cell];
  const same = a.places.filter((p) => p.id !== home.id && continent[p.cell] === k);
  if (!same.length) return null;
  same.sort((x, y) => dot(w, x.cell, home.cell) - dot(w, y.cell, home.cell));
  // Of the farthest tenth, the biggest.
  const tail = same.slice(0, Math.max(1, Math.ceil(same.length / 10)));
  return tail.reduce((b, p) => (p.pop > b.pop ? p : b), tail[0]);
}

/** Where the rumour says it is: a few hexes off the truth, so it's a direction, not a pin. */
export function farGuess(w: World, far: Place, seed: number): number {
  const rng = makeRng((seed * 69069 + far.id) >>> 0);
  let c = far.cell;
  for (let i = 0, n = 2 + Math.floor(rng() * 3); i < n; i++) { const nb = w.grid.neighbors[c]; c = nb[Math.floor(rng() * nb.length)]; }
  return c;
}
