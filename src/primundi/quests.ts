/**
 * Work a caravan can take on, made from the world as it is: real places, real prices, real hexes.
 * Bill, 2026-11-06: more than one at a time, better managed, and more to do than deliveries.
 *
 * - deliver: carry something to another place;
 * - procure: bring a good this place is short of (bought wherever it's cheap);
 * - bounty: drive off a band on a named hex, then come back for the money;
 * - survey: go and look at a hex in the storm, then come back with the chart;
 * - relic: search an old site on a named hex, and bring back what's there.
 *
 * Offers are drawn per place per month from a seeded RNG, so a place's notice board is the same
 * each time you look in a month, and changes the next.
 */
import { makeRng } from '../rng.ts';
import { nameMaker } from '../gamedata.ts';
import { WATER_LAND, type World } from '../world.ts';
import { GOODS, G, ringCells, type Atlas, type Place } from './atlas.ts';

export type QuestKind = 'deliver' | 'procure' | 'bounty' | 'survey' | 'relic';
export interface Quest {
  /** Stable per offer: place, month, slot. */
  id: string;
  kind: QuestKind;
  giver: string;
  /** The place that offered it (where procure, bounty, survey and relic are handed in). */
  from: number;
  /** Deliver: the place to take it to. */
  to?: number;
  /** Bounty, survey, relic: the hex to go to. */
  cell?: number;
  /** Procure: what, and how much. */
  good?: number;
  qty?: number;
  /** Deliver: what is carried. */
  item?: string;
  reward: number;
  taken: number;
  /** The task on the road is done; only the handing in is left. */
  done?: boolean;
}

/** Most jobs a caravan can carry at once. */
export const MAX_QUESTS = 4;

const ITEMS = ['sealed letter', 'parcel of seed', 'small locked box', 'bolt of fine cloth', 'bundle of deeds', 'wrapped icon', 'crate of medicines', 'cask of good oil', 'box of instruments'];

/** What a place has on its notice board this month (taken ones left out by the caller). */
export function offersAt(w: World, a: Atlas, continent: Int32Array, p: Place, month: number, seed: number, revealed: Set<number>, quotePrice: (p: Place, g: number) => number): Quest[] {
  const rng = makeRng((seed * 131 + p.id * 977 + month * 7919) >>> 0);
  const names = nameMaker(seed + p.id * 13 + month * 101);
  const n = (p.town ? 2 : 1) + (rng() < 0.5 ? 1 : 0);
  const P = w.grid.centers, cellA = Math.sqrt((4 * Math.PI) / w.grid.count);
  const hexes = (x: number, y: number) => Math.acos(Math.min(1, P[x * 3] * P[y * 3] + P[x * 3 + 1] * P[y * 3 + 1] + P[x * 3 + 2] * P[y * 3 + 2])) / cellA;
  const kinds: QuestKind[] = ['deliver', 'deliver', 'procure', 'bounty', 'survey', 'relic'];
  const out: Quest[] = [];
  const used = new Set<QuestKind>();
  for (let slot = 0; slot < n * 3 && out.length < n; slot++) {
    const kind = kinds[Math.floor(rng() * kinds.length)];
    if (used.has(kind) && kind !== 'deliver') continue;
    const base = { id: `${p.id}-${month}-${slot}`, kind, giver: names(), from: p.id, reward: 0, taken: 0 };
    if (kind === 'deliver') {
      const cands = a.places.filter((o) => o.id !== p.id && continent[o.cell] === continent[p.cell] && hexes(o.cell, p.cell) >= 4 && hexes(o.cell, p.cell) <= 16);
      if (!cands.length) continue;
      const to = cands[Math.floor(rng() * cands.length)];
      out.push({ ...base, to: to.id, item: ITEMS[Math.floor(rng() * ITEMS.length)], reward: Math.round(15 + hexes(to.cell, p.cell) * 6) });
    } else if (kind === 'procure') {
      // Something dear here: the goods this place lacks most.
      const dear = GOODS.map((g, i) => ({ i, k: p.price[i] / g.base })).filter((x) => x.i !== G.relics).sort((x, y) => y.k - x.k).slice(0, 3);
      const g = dear[Math.floor(rng() * dear.length)].i;
      const qty = 3 + Math.floor(rng() * 6);
      out.push({ ...base, good: g, qty, reward: Math.round(qty * quotePrice(p, g) * 1.35 + 10) });
    } else {
      // A hex some way off: for a bounty, on or near a road; for a survey, in the storm.
      const ring = ringCells(w, p.cell, kind === 'survey' ? 14 : 10).filter((c) => w.water[c] === WATER_LAND && continent[c] === continent[p.cell] && a.placeAt[c] < 0);
      const far = ring.filter((c) => {
        const d = hexes(c, p.cell);
        if (kind === 'survey') return d >= 6 && !revealed.has(c);
        if (kind === 'bounty') return d >= 3 && d <= 10 && (a.road[c] || w.grid.neighbors[c].some((x) => a.road[x]));
        return d >= 4;
      });
      if (!far.length) continue;
      const cell = far[Math.floor(rng() * far.length)], d = hexes(cell, p.cell);
      const reward = kind === 'bounty' ? Math.round(60 + d * 6) : kind === 'survey' ? Math.round(30 + d * 7) : Math.round(50 + d * 6);
      out.push({ ...base, cell, reward });
    }
    used.add(kind);
  }
  return out;
}

/** One line saying what the job is. */
export function questTitle(q: Quest, a: Atlas): string {
  switch (q.kind) {
    case 'deliver': return `Carry a ${q.item} to ${a.places[q.to!].name}`;
    case 'procure': return `Bring ${q.qty} ${GOODS[q.good!].name.toLowerCase()} to ${a.places[q.from].name}`;
    case 'bounty': return 'Drive off the band on the road';
    case 'survey': return 'Chart a hex in the storm';
    case 'relic': return 'Search an old site';
  }
}

/** The offer as its giver puts it. */
export function questPitch(q: Quest, a: Atlas, dir: (cell: number) => string): string {
  const here = a.places[q.from].name;
  switch (q.kind) {
    case 'deliver': return `"This ${q.item} has to reach ${a.places[q.to!].name}, ${dir(a.places[q.to!].cell)} of here. They'll pay you there."`;
    case 'procure': return `"We can't get ${GOODS[q.good!].name.toLowerCase()} for love or money. Bring me ${q.qty} and I'll pay well over the odds."`;
    case 'bounty': return `"A band has been stopping carts ${dir(q.cell!)} of here. Drive them off and come back to ${here} for your money."`;
    case 'survey': return `"Nobody has been ${dir(q.cell!)} of here since the storm came down. Go and look, draw what you see, and bring it back."`;
    case 'relic': return `"There's an old place ${dir(q.cell!)} of here that my grandmother talked about. Whatever's in it, bring it to me."`;
  }
}

/** Where the job takes you next: a place or a hex. */
export function questTarget(q: Quest, a: Atlas): number {
  if (q.kind === 'deliver') return a.places[q.to!].cell;
  if (q.kind === 'procure' || q.done) return a.places[q.from].cell;
  return q.cell!;
}

/** Can it be handed in here, at place `pid`, with this cargo? */
export function canHandIn(q: Quest, pid: number, cargo: number[]): boolean {
  if (q.kind === 'deliver') return q.to === pid;
  if (q.kind === 'procure') return q.from === pid && cargo[q.good!] >= q.qty!;
  return q.from === pid && !!q.done;
}

/** Where it stands, in a few words. */
export function questStatus(q: Quest, a: Atlas, cargo: number[]): string {
  if (q.kind === 'deliver') return `To ${a.places[q.to!].name}`;
  if (q.kind === 'procure') return `You carry ${Math.min(cargo[q.good!], q.qty!)} of ${q.qty}`;
  if (q.done) return `Done: back to ${a.places[q.from].name}`;
  return q.kind === 'bounty' ? 'Find them on the marked hex' : q.kind === 'survey' ? 'Reach the marked hex' : 'Search the marked hex';
}
