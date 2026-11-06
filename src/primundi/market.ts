/**
 * Markets. Each place has an equilibrium price per good (atlas.ts, from what its land makes and
 * its people need) and a resting stock. Buying draws the stock down and the price up; selling the
 * reverse; left alone, a stock drifts back to rest over a couple of weeks. Grain is cheapest just
 * after the local harvest.
 *
 * Only stocks a caravan has touched are stored, with the day they were last set, and are relaxed
 * lazily when read: four hundred markets cost nothing until visited.
 */
import type { World } from '../world.ts';
import { GOODS, G, type Atlas, type Place } from './atlas.ts';

/** Days for a disturbed stock to recover about two thirds of the way back. */
const RECOVER_DAYS = 14;
/** What a market pays, against what it asks. */
export const SPREAD = 0.85;

export interface Touched { day: number; stock: number[] }
export type Stocks = Record<number, Touched>;

/** The stock of every good at a place on a day. */
export function stockAt(p: Place, stocks: Stocks, day: number): number[] {
  const t = stocks[p.id];
  if (!t) return [...p.stock];
  const k = Math.exp(-(day - t.day) / RECOVER_DAYS);
  return t.stock.map((s, g) => p.stock[g] + (s - p.stock[g]) * k);
}

/** Harvest: grain dearer before it, cheaper after, by hemisphere (doy 0..365). */
function seasonFactor(w: World, p: Place, g: number, doy: number): number {
  if (g !== G.grain) return 1;
  const north = w.grid.centers[p.cell * 3 + 1] >= 0;
  const harvest = north ? 250 : 65;
  return 1 + 0.18 * Math.cos((2 * Math.PI * (doy - harvest - 120)) / 365);
}

/** The asking price of one unit at a given stock. */
function askAt(w: World, p: Place, g: number, stock: number, doy: number): number {
  const scarcity = Math.pow(p.stock[g] / Math.max(0.5, stock), 0.7);
  return p.price[g] * seasonFactor(w, p, g, doy) * Math.max(0.4, Math.min(3, scarcity));
}

export interface Quote { buy: number; sell: number; stock: number }
/** What each good costs (buy) and fetches (sell) at a place today, in whole orrels. */
export function quotes(w: World, p: Place, stocks: Stocks, day: number, doy: number): Quote[] {
  const st = stockAt(p, stocks, day);
  return GOODS.map((_, g) => {
    const a = askAt(w, p, g, st[g], doy);
    // Relics have no stock to speak of: markets buy them, never sell them.
    if (g === G.relics) return { buy: 0, sell: Math.max(1, Math.round(a * SPREAD)), stock: 0 };
    return { buy: Math.max(1, Math.round(a)), sell: Math.max(1, Math.round(askAt(w, p, g, st[g] + 1, doy) * SPREAD)), stock: Math.floor(st[g]) };
  });
}

/** Trade `n` units (positive: the caravan buys; negative: it sells). Returns the orrels it costs
 * the caravan (negative when it earns), priced unit by unit so a big sale drives its own price down. */
export function trade(w: World, p: Place, stocks: Stocks, day: number, doy: number, g: number, n: number): number {
  const st = stockAt(p, stocks, day);
  let total = 0;
  for (let i = 0; i < Math.abs(n); i++) {
    if (n > 0) {
      if (st[g] < 1) break;
      total += Math.max(1, Math.round(askAt(w, p, g, st[g], doy)));
      st[g] -= 1;
    } else {
      total -= Math.max(1, Math.round(askAt(w, p, g, st[g] + 1, doy) * SPREAD));
      st[g] += 1;
    }
  }
  stocks[p.id] = { day, stock: st.map((x) => Math.round(x * 100) / 100) };
  return total;
}

/** A ration (a person's food for a day), priced off local grain. */
export function rationPrice(w: World, p: Place, stocks: Stocks, day: number, doy: number): number {
  return Math.max(0.2, quotes(w, p, stocks, day, doy)[G.grain].buy / 8);
}

/** What a caravan remembers of a market: the prices as of the day it heard them. */
export interface Known { day: number; buy: number[]; sell: number[] }
export function remember(known: Record<number, Known>, p: Place, q: Quote[], day: number) {
  known[p.id] = { day, buy: q.map((x) => x.buy), sell: q.map((x) => x.sell) };
}

/** The best price the caravan knows of, elsewhere, to sell a good at. */
export function bestKnownSell(atlas: Atlas, known: Record<number, Known>, g: number, except: number): { place: Place; price: number; age: number; day: number } | null {
  let best: { place: Place; price: number; age: number; day: number } | null = null;
  for (const [id, k] of Object.entries(known)) {
    const pid = Number(id);
    if (pid === except) continue;
    if (!best || k.sell[g] > best.price) best = { place: atlas.places[pid], price: k.sell[g], age: 0, day: k.day };
  }
  return best;
}
