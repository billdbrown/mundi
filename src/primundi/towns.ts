/**
 * What a town is like (2026-11-07, overnight loop 3, "towns with character"): its trade, from what
 * its land makes (the goods cheapest there against their usual price, atlas.ts) or where it stands
 * (a crossroads, an old holy place); and the line that says so. The hex shows the trade (props round
 * the town) and the market leans on it (what the town wants).
 */
import type { World } from '../world.ts';
import { BIOMES } from '../biomes.ts';
import { GOODS, G, type Atlas, type Place } from './atlas.ts';

export type Trade = 'fishing' | 'timber' | 'mining' | 'salt' | 'farming' | 'herding' | 'trapping' | 'weaving' | 'smithing' | 'market' | 'shrine';
export const TRADES: Record<Trade, { name: string; good: number | null; wants: number[] }> = {
  fishing: { name: 'fishing', good: G.fish, wants: [G.salt, G.timber] },
  timber: { name: 'timber', good: G.timber, wants: [G.tools, G.grain] },
  mining: { name: 'mining', good: G.ore, wants: [G.timber, G.grain] },
  salt: { name: 'salt-pan', good: G.salt, wants: [G.grain, G.timber] },
  farming: { name: 'farming', good: G.grain, wants: [G.tools, G.cloth] },
  herding: { name: 'herding', good: G.wool, wants: [G.grain, G.salt] },
  trapping: { name: 'trapping', good: G.furs, wants: [G.salt, G.tools] },
  weaving: { name: 'weaving', good: G.cloth, wants: [G.wool, G.spice] },
  smithing: { name: 'smithing', good: G.tools, wants: [G.ore, G.timber] },
  market: { name: 'market', good: null, wants: [G.spice, G.cloth] },
  shrine: { name: 'shrine', good: null, wants: [G.spice, G.cloth] },
};
const BY_GOOD = new Map<number, Trade>(Object.entries(TRADES).filter(([, t]) => t.good != null).map(([k, t]) => [t.good!, k as Trade]));

/** Each good's median price across a world's places: what "cheap here" is measured against, so a
 * town's trade is what sets it apart, not what every place round it makes. */
const medians = new WeakMap<Atlas, number[]>();
function medianPrices(a: Atlas): number[] {
  let m = medians.get(a);
  if (!m) {
    m = GOODS.map((_, i) => { const v = a.places.map((p) => p.price[i]).sort((x, y) => x - y); return v[v.length >> 1] || 1; });
    medians.set(a, m);
  }
  return m;
}
/** Trades worked out before the market leans on them (applyTradeWants), so they stay put. */
const tradeCache = new WeakMap<Atlas, Trade[][]>();
/** A place's trades: the main one, and sometimes a second. */
export function tradesOf(w: World, a: Atlas, p: Place): Trade[] {
  const c = tradeCache.get(a);
  if (c && c[p.id]) return c[p.id];
  return tradesFresh(w, a, p);
}
/** What each town's trade wants, a little dearer there: a fishing town pays more for salt and
 * timber. Once per atlas, after it's built (main.ts, the playtest). */
export const WANT_MARKUP = 1.15;
const nudged = new WeakSet<Atlas>();
export function applyTradeWants(w: World, a: Atlas) {
  if (nudged.has(a)) return;
  nudged.add(a);
  const all = a.places.map((p) => tradesFresh(w, a, p));
  tradeCache.set(a, all);
  for (const p of a.places) for (const g of TRADES[all[p.id][0]].wants) p.price[g] *= WANT_MARKUP;
}
function tradesFresh(w: World, a: Atlas, p: Place): Trade[] {
  // Its goods, cheapest against what they cost elsewhere first (relics never).
  const med = medianPrices(a);
  const cheap = GOODS.map((_, i) => ({ i, k: p.price[i] / med[i] })).filter((x) => x.i !== G.relics && BY_GOOD.has(x.i)).sort((x, y) => x.k - y.k);
  // A fishing town has to be on the water.
  const coast = w.grid.neighbors[p.cell].some((n) => w.water[n] !== 0);
  const made = cheap.filter((x) => x.k < 0.85 && (x.i !== G.fish || coast)).map((x) => BY_GOOD.get(x.i)!);
  const roads = w.grid.neighbors[p.cell].filter((n) => a.road[n]).length;
  // An old place, settled among the first, is sometimes a holy one.
  const holy = p.founded <= 200 && ((p.id * 2654435761) >>> 0) % 3 === 0;
  const out: Trade[] = [];
  if (holy) out.push('shrine');
  else if (made.length) out.push(made[0]);
  else out.push(roads >= 3 || p.town ? 'market' : 'farming');
  const second = holy ? made[0] : made[1];
  if (second && !out.includes(second)) out.push(second);
  if (out[0] !== 'market' && roads >= 4 && p.town && out.length < 2) out.push('market');
  return out.slice(0, 2);
}

/** A line of who a place is: what it does, where it sits, where it came from. */
export function townLine(w: World, a: Atlas, p: Place): string {
  const c = p.cell, nb = w.grid.neighbors[c];
  const coast = nb.some((n) => w.water[n] === 1), river = !!w.river[c], lake = nb.some((n) => w.water[n] === 2);
  const high = w.elevation[c] > 0.3;
  const t = tradesOf(w, a, p), first = TRADES[t[0]];
  const size = p.capital ? 'the seat of its realm' : p.pop > 6000 ? 'city' : p.town ? 'town' : p.pop < 300 ? 'hamlet' : 'village';
  const kind = p.capital ? size : t[0] === 'market' ? `a market ${size}` : t[0] === 'shrine' ? `a ${size} round an old shrine` : `a ${first.name} ${size}`;
  const where = coast ? (river ? 'where a river meets the sea' : 'on the coast') : lake ? 'on a lakeshore' : river ? 'on a river' : high ? 'up in the hills' : `in the ${BIOMES[w.biome[c]].name.toLowerCase()}`;
  const also = t[1] ? (t[1] === 'market' ? ', and a market for the roads round it' : TRADES[t[1]].good != null ? `, with ${GOODS[TRADES[t[1]].good!].name.toLowerCase()} besides` : '') : '';
  const origin = p.parent ? ` Settled from ${p.parent} in year ${p.founded}.` : p.founded <= 200 ? ' One of the first places people settled.' : ` Founded in year ${p.founded}.`;
  return `${kind[0].toUpperCase() + kind.slice(1)} ${where}${also}.${origin}`;
}
