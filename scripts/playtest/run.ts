/**
 * The playtest bot: plays Primundi headless through the game's own rules (src/primundi/sim.ts) and
 * records what happens, day by day. Bots see only what a player sees: revealed hexes, the prices
 * they have learned, the cards' text. See scripts/playtest.ts for the batch and the report.
 */
import { generateWorld } from '../../src/world.ts';
import { gameData } from '../../src/gamedata.ts';
import { simulateHistory } from '../../src/civ.ts';
import { makeRng } from '../../src/rng.ts';
import { buildAtlas, ringCells, walkable, type Atlas } from '../../src/primundi/atlas.ts';
import { applyTradeWants } from '../../src/primundi/towns.ts';
import { quotes, trade } from '../../src/primundi/market.ts';
import { bestKnownSell } from '../../src/primundi/market.ts';
import { AMBITION_GOAL, appetite, best, cargoUsed, living, thirst, type Origin, type Skill } from '../../src/primundi/caravan.ts';
import { QUEST_ENCOUNTERS } from '../../src/primundi/encounters.ts';
import { bandAt } from '../../src/primundi/depth.ts';
import { findReady } from '../../src/primundi/finds.ts';
import { MAX_QUESTS, canHandIn, questTarget } from '../../src/primundi/quests.ts';
import type { StartBias } from '../../src/primundi/start.ts';
import {
  RATES, worldParams, newGame, quickSetup, meetFolk, makeGame, doyOf, setRoute, plan, advance, resolve, jobHere, findHere, findsAt,
  buy, sell, shortHere, buyRations, sellCharts, takeJob, handIn, jobsOffered, rest, hire, townRecruits, haul, appoint, angle, cellAngleOf,
  type Game, type Pending, type Ui,
} from '../../src/primundi/sim.ts';
import type { World } from '../../src/world.ts';
import type { GameData } from '../../src/gamedata.ts';

// --- Worlds -----------------------------------------------------------------------------------
export interface WorldSet { name: string; w: World; gd: GameData; a: Atlas; seed: number }
const worlds = new Map<string, WorldSet>();
/** A world exactly as the game makes it from its name (cached). */
export function worldFor(name: string): WorldSet {
  let ws = worlds.get(name);
  if (!ws) {
    const params = worldParams(name);
    const w = generateWorld(params);
    const gd = gameData(w);
    const a = buildAtlas(w, gd, simulateHistory(w, gd));
    applyTradeWants(w, a);
    ws = { name, w, gd, a, seed: params.seed };
    worlds.set(name, ws);
  }
  return ws;
}

// --- Choosing in a card -----------------------------------------------------------------------
/** In order of preference: the careful answer. A job is still done, carefully. */
const CAREFUL = [
  'Draw what you see', 'Fill the skins', 'Gather for half a day', 'Dig it out carefully', 'Wait for dark and take them sleeping',
  'Wait for it to drop', 'Hunker down', 'Dig in and wait it out', 'Make camp until it breaks', 'Rest it a day', 'Pour it out',
  'Keep the fires high and stand watch', 'Slip past', 'Talk it down', 'Turn and run', 'Ask the way', 'Swap news', 'Climb and sketch it', 'Add a stone',
  'Let them be', 'Leave it to the dead', 'Leave it be', 'Send them on', 'Share your food', 'Pass by', 'Walk on',
  'Swap news', 'Help them mend it', 'Sell them', 'Ask about the country',
];
/** The bold answer: fight, cross, push on, break in. */
const BOLD = [
  'Draw what you see', 'Fill the skins', 'Hunt the trail', 'Fight', 'Go in hard', 'Break straight in', 'Cross now', 'Push through it',
  'Keep walking', 'Boil it and drink it', 'Spread the load and press on', 'Carry them and keep going', 'Hunt them', 'Search it',
  'Go through it', 'Offer them a place', 'Break camp and move on', 'Climb and sketch it',
  'Sell them', 'Take two', 'Swap news',
];
function pick(p: Pending, style: 'careful' | 'bold'): number {
  const order = style === 'careful' ? CAREFUL : BOLD;
  let best = Math.max(0, p.choices.findIndex((c) => !c.locked)), bi = Infinity;
  p.choices.forEach((c, i) => { if (c.locked) return; const k = order.findIndex((l) => c.label.startsWith(l)); if (k >= 0 && k < bi) { bi = k; best = i; } });
  return best;
}

// --- Where the money came from ----------------------------------------------------------------
/** Earnings (the caravan's `earned`) by source, for the run in progress. */
let ledger: Record<string, number> = {};
/** Do something, and book what it earned under `kind`. */
function booked<T>(g: Game, kind: string, f: () => T): T {
  const before = g.s.caravan.earned;
  const r = f();
  const d = g.s.caravan.earned - before;
  if (d) ledger[kind] = (ledger[kind] ?? 0) + d;
  return r;
}

// --- Bots -------------------------------------------------------------------------------------
export type BotName = 'trader' | 'explorer' | 'jobber' | 'reckless' | 'deep' | 'idle';
export const BOT_NAMES: BotName[] = ['trader', 'explorer', 'jobber', 'reckless', 'deep', 'idle'];
interface Bot {
  style: 'careful' | 'bold';
  /** In a town with no route: trade, rest, take work. */
  town(pid: number): void;
  /** Where next (a cell), or null to wait a day. */
  next(): number | null;
}

/** Days to a cell by the planner, or Infinity. */
const daysTo = (g: Game, cell: number) => { if (cell === g.s.cell) return 0; const p = plan(g, cell); return p ? p.days : Infinity; };
/** Known places (on the map), nearest first by the planner's days, with their days. */
function knownPlaces(g: Game, except = -1) {
  return g.a.places.filter((p) => g.revealed.has(p.cell) && p.id !== except && p.cell !== g.s.cell)
    .map((p) => ({ p, d: daysTo(g, p.cell) })).filter((x) => x.d < Infinity).sort((x, y) => x.d - y.d);
}
/** Food for `days` days, topped up if the purse allows (keeping `keep` orrels). */
/** Take on whoever's best at `k` (or the cheapest, with null) among this month's recruits, within `max`. */
function hireBest(g: Game, pid: number, k: Skill | null, max: number) {
  const r = townRecruits(g, pid).filter((x) => x.cost <= max && x.cost <= g.s.caravan.orrels)
    .sort((a, b) => (k ? b.m.skills[k] - a.m.skills[k] : 0) || a.cost - b.cost)[0];
  if (r) hire(g, pid, r.i);
}
function provision(g: Game, pid: number, days: number, keep = 0) {
  const c = g.s.caravan, have = c.rations / Math.max(1, appetite(c));
  if (have >= days) return;
  let want = Math.ceil(days - have);
  while (want > 0 && !(c.orrels - keep > 0 && buyRations(g, pid, want))) want = Math.floor(want / 2);
}
/** Sell what's carried, a unit at a time as a player clicks, while the price here still covers
 * what it cost (or nothing known elsewhere pays better). `always`: sell the lot. */
function sellHere(g: Game, pid: number, always = false) {
  const s = g.s, c = s.caravan, p = g.a.places[pid];
  for (let gi = 0; gi < c.cargo.length; gi++) {
    const bk = bestKnownSell(g.a, s.known, gi, pid);
    while (c.cargo[gi] > 0) {
      const here = quotes(g.w, p, s.stocks, s.day, doyOf(s.day))[gi].sell, per = c.basis[gi] / c.cargo[gi];
      if (!always && here < per && bk && bk.price > here * 1.15) break;
      booked(g, 'trade', () => sell(g, pid, gi, 1));
    }
  }
}
/** What the k-th unit of a good is guessed to fetch where its price is known: a player knows a
 * market sinks as you sell into it, not by how much. */
const guessSell = (price: number, k: number) => price * Math.pow(0.93, k);
/** The best load to carry from here to one place the caravan knows prices for: a basket of goods,
 * bought a unit at a time while each still pays, and its profit per day of travel. */
function bestTrade(g: Game, pid: number, capacity: number, purse: number) {
  const s = g.s, p = g.a.places[pid], short = shortHere(g, pid);
  let best: { to: number; basket: number[]; rate: number } | null = null;
  for (const [id, k] of Object.entries(s.known)) {
    const to = Number(id);
    if (to === pid) continue;
    const d = daysTo(g, g.a.places[to].cell);
    if (d === Infinity || d > 20) continue;
    const st = JSON.parse(JSON.stringify(s.stocks));
    const basket = k.sell.map(() => 0);
    let profit = 0, spent = 0;
    for (let n = 0; n < capacity; n++) {
      let bg = -1, bm = 2;
      let bc = 0;
      for (let gi = 0; gi < basket.length; gi++) {
        const q = quotes(g.w, p, st, s.day, doyOf(s.day))[gi];
        if (short.has(gi) || !q.buy || q.stock < 1 || spent + q.buy > purse) continue;
        const m = guessSell(k.sell[gi], basket[gi]) - q.buy;
        if (m > bm) { bm = m; bg = gi; bc = q.buy; }
      }
      if (bg < 0) break;
      trade(g.w, p, st, s.day, doyOf(s.day), bg, 1);
      basket[bg]++; profit += bm; spent += bc;
    }
    const rate = profit / (d + 1);
    if (profit > 10 && (!best || rate > best.rate)) best = { to, basket, rate };
  }
  return best;
}

function traderBot(g: Game, rng: () => number, bold: boolean): Bot {
  let dest = -1;
  const visited = new Map<number, number>();
  return {
    style: bold ? 'bold' : 'careful',
    town(pid) {
      const s = g.s, c = s.caravan;
      visited.set(pid, s.day);
      sellHere(g, pid);
      if (c.unsoldCharts) booked(g, 'charts', () => sellCharts(g, pid));
      // Mend: rest when spirits are low or someone is hurt (free at home). The reckless never do.
      if (!bold && (c.morale < 35 || c.members.some((m) => m.alive && m.health !== 'well')) && (pid === s.home || c.orrels > 120)) rest(g, pid, 2);
      if (!bold && living(c).length < 5 && c.orrels > 200) hireBest(g, pid, 'fight', 80);
      // Keep enough for the road's food; carry the best basket the purse and the pack allow.
      const t = bestTrade(g, pid, c.capacity - cargoUsed(c), c.orrels - 40);
      dest = -1;
      if (t) {
        let got = 0;
        t.basket.forEach((n, gi) => { if (n) got += buy(g, pid, gi, n); });
        if (got > 0) dest = g.a.places[t.to].cell;
      }
      if (dest < 0) {
        // Nothing worth carrying: go and learn a market, the one known longest ago (or never).
        const ks = knownPlaces(g, pid).slice(0, 8);
        ks.sort((x, y) => ((s.known[x.p.id]?.day ?? -99) - (s.known[y.p.id]?.day ?? -99)) || x.d - y.d);
        if (ks.length) dest = ks[0].p.cell;
      }
      const tripDays = dest >= 0 ? daysTo(g, dest) : 5;
      provision(g, pid, Math.min(40, Math.ceil(tripDays * (bold ? 1.2 : 1.6)) + (bold ? 3 : 8)));
      void rng;
    },
    next() {
      if (dest >= 0 && dest !== g.s.cell) return dest;
      // Out in the country with nowhere set: the nearest town.
      const ks = knownPlaces(g);
      return ks.length ? ks[0].p.cell : null;
    },
  };
}

function explorerBot(g: Game, rng: () => number): Bot {
  let out = 0;
  return {
    style: 'careful',
    town(pid) {
      const c = g.s.caravan;
      if (c.unsoldCharts) booked(g, 'charts', () => sellCharts(g, pid));
      sellHere(g, pid, true);
      if (c.morale < 35 && (pid === g.s.home || c.orrels > 80)) rest(g, pid, 2);
      if (living(c).length < 5 && c.orrels > 160) hireBest(g, pid, best(c, 'scout') >= 3 ? null : 'scout', 90);
      provision(g, pid, 30);
      out = g.s.day;
    },
    next() {
      const s = g.s, c = s.caravan, w = g.w;
      const food = c.rations / Math.max(1, appetite(c)), water = c.water / Math.max(1, thirst(c));
      // Turn back for a town when food runs low or after a long time out.
      if (food < 12 || water < 4 || s.day - out > 30 || c.unsoldCharts > 120) {
        const ks = knownPlaces(g);
        if (ks.length && ks[0].d < food + 4) return ks[0].p.cell;
        if (ks.length) return ks[0].p.cell;
      }
      // Into the fog: a fogged hex 3 to 8 hexes off, the one with the most fog round it, a little at random.
      const cellA = cellAngleOf(w);
      let best = -1, bs = -Infinity;
      for (const c0 of g.revealed) for (const n of w.grid.neighbors[c0]) {
        if (g.revealed.has(n) || !walkable(w, n)) continue;
        const d = angle(w, s.cell, n) / cellA;
        if (d < 2 || d > 9) continue;
        const fog = ringCells(w, n, 2).filter((x) => !g.revealed.has(x)).length;
        const score = fog - d * 0.6 + rng() * 4;
        if (score > bs) { bs = score; best = n; }
      }
      if (best >= 0) return best;
      const ks = knownPlaces(g);
      return ks.length ? ks[Math.floor(rng() * Math.min(3, ks.length))].p.cell : null;
    },
  };
}

/** Out into the wild for what's worth more there (decision 2026-11-08: the planet as a dungeon):
 * heads for Wild and Deep hexes, fights what it meets, turns back for a town when food runs low,
 * after `TURN_DAYS` out, or once the haul is worth `TURN_HAUL`. Sells everything in town. */
const TURN_DAYS = 30, TURN_HAUL = 700;
function deepBot(g: Game, rng: () => number): Bot {
  let out = 0;
  return {
    style: 'bold',
    town(pid) {
      const c = g.s.caravan;
      if (c.unsoldCharts) booked(g, 'charts', () => sellCharts(g, pid));
      sellHere(g, pid, true);
      if ((c.morale < 35 || c.members.some((m) => m.alive && m.health !== 'well')) && (pid === g.s.home || c.orrels > 80)) rest(g, pid, 2);
      if (living(c).length < 6 && c.orrels > 160) hireBest(g, pid, 'fight', 100);
      provision(g, pid, 35);
      out = g.s.day;
    },
    next() {
      const s = g.s, c = s.caravan, w = g.w;
      const food = c.rations / Math.max(1, appetite(c)), water = c.water / Math.max(1, thirst(c));
      if (food < 12 || water < 4 || s.day - out > TURN_DAYS || haul(g).value > TURN_HAUL) {
        const ks = knownPlaces(g);
        if (ks.length) return ks[0].p.cell;
      }
      // The deepest land in reach: revealed or at the fog's edge, 3 to 10 hexes off.
      const cellA = cellAngleOf(w);
      let pick = -1, bs = -Infinity;
      for (const c0 of g.revealed) for (const n of [c0, ...w.grid.neighbors[c0]]) {
        if (!walkable(w, n)) continue;
        const d = angle(w, s.cell, n) / cellA;
        if (d < 2 || d > 6) continue;
        const score = bandAt(w, g.a, n) * 3 - d * 0.4 + (findsAt(g, n).includes('wilds') ? 3 : 0) + rng() * 2;
        if (score > bs) { bs = score; pick = n; }
      }
      if (pick >= 0) return pick;
      const ks = knownPlaces(g);
      return ks.length ? ks[0].p.cell : null;
    },
  };
}

/** Where the jobs in hand lead: their targets, or for a supply job still short of its goods, the
 * nearest known market selling them cheaply. */
function jobTargets(g: Game): number[] {
  const s = g.s, c = s.caravan;
  return s.jobs.map((q) => {
    if (q.kind !== 'procure' || c.cargo[q.good!] >= q.qty!) return questTarget(q, g.a);
    const src = Object.entries(s.known).filter(([id, k]) => Number(id) !== q.from && k.buy[q.good!] * q.qty! < q.reward * 0.8)
      .map(([id]) => g.a.places[Number(id)].cell).map((cell) => ({ cell, d: daysTo(g, cell) })).sort((x, y) => x.d - y.d)[0];
    return src ? src.cell : questTarget(q, g.a);
  });
}
function jobberBot(g: Game, rng: () => number): Bot {
  const trader = traderBot(g, rng, false);
  let dest = -1;
  return {
    style: 'careful',
    town(pid) {
      const s = g.s, c = s.caravan;
      // Goods for a supply job, if they're to be had here for less than it pays.
      for (const q of s.jobs) {
        if (q.kind !== 'procure' || q.from === pid || c.cargo[q.good!] >= q.qty!) continue;
        const qt = quotes(g.w, g.a.places[pid], s.stocks, s.day, doyOf(s.day))[q.good!];
        if (qt.buy && qt.buy * q.qty! < q.reward * 0.8) buy(g, pid, q.good!, q.qty! - c.cargo[q.good!]);
      }
      for (const q of [...s.jobs]) if (canHandIn(q, pid, c.cargo)) booked(g, `job:${q.kind}`, () => handIn(g, pid, q.id));
      if (c.unsoldCharts) booked(g, 'charts', () => sellCharts(g, pid));
      sellHere(g, pid, true);
      if ((c.morale < 35 || c.members.some((m) => m.alive && m.health !== 'well')) && (pid === s.home || c.orrels > 100)) rest(g, pid, 2);
      if (living(c).length < 5 && c.orrels > 200) hireBest(g, pid, 'fight', 80);
      for (const q of jobsOffered(g, g.a.places[pid])) {
        if (s.jobs.length >= MAX_QUESTS) break;
        if (q.kind === 'procure') {
          // Worth it if some market you know sells the goods for well under the reward, not far off.
          const src = Object.entries(s.known).filter(([id, k]) => Number(id) !== pid && k.buy[q.good!] * q.qty! < q.reward * 0.7)
            .map(([id]) => daysTo(g, g.a.places[Number(id)].cell)).sort((x, y) => x - y)[0];
          if (src == null || src > 15) continue;
        }
        if (daysTo(g, questTarget(q, g.a)) > 25) continue;
        takeJob(g, pid, q.id);
      }
      const ts = jobTargets(g).filter((t) => t !== s.cell).map((t) => ({ t, d: daysTo(g, t) })).filter((x) => x.d < Infinity).sort((x, y) => x.d - y.d);
      dest = ts.length ? ts[0].t : -1;
      if (dest < 0) { trader.town(pid); dest = trader.next() ?? -1; }
      provision(g, pid, Math.min(40, Math.ceil((dest >= 0 ? daysTo(g, dest) : 5) * 1.6) + 8));
    },
    next() {
      const s = g.s;
      const ts = jobTargets(g).filter((t) => t !== s.cell).map((t) => ({ t, d: daysTo(g, t) })).filter((x) => x.d < Infinity).sort((x, y) => x.d - y.d);
      if (ts.length) return ts[0].t;
      if (dest >= 0 && dest !== s.cell) return dest;
      const ks = knownPlaces(g);
      return ks.length ? ks[0].p.cell : null;
    },
  };
}

function idleBot(): Bot {
  return { style: 'careful', town() {}, next: () => null };
}

function makeBot(name: BotName, g: Game, rng: () => number): Bot {
  if (name === 'trader') return traderBot(g, rng, false);
  if (name === 'reckless') return traderBot(g, rng, true);
  if (name === 'explorer') return explorerBot(g, rng);
  if (name === 'jobber') return jobberBot(g, rng);
  if (name === 'deep') return deepBot(g, rng);
  return idleBot();
}

// --- One run ----------------------------------------------------------------------------------
export interface RunOpts { world: string; origin: Origin; bias: StartBias; bot: BotName; run: number; years: number }
export interface Day { day: number; orrels: number; earned: number; alive: number; hurt: number; food: number; water: number; revealed: number; charted: number; jobsDone: number; morale: number; cargo: number }
export interface RunResult {
  opts: RunOpts;
  home: string;
  days: Day[];
  /** Encounters met: the day, its id, the choice taken, how many died of it. */
  encounters: { day: number; id: string; choice: string; deaths: number }[];
  deaths: { day: number; cause: string }[];
  /** Days on which something happened (an arrival, a card, a trade): for the quiet stretches. */
  events: number[];
  ambitionDay: number | null;
  wiped: number | null;
  trips: number;
  /** Earnings by source (trade, charts, job:<kind>, encounters). */
  ledger: Record<string, number>;
  /** Days with no route and nowhere to go. */
  stuck: number;
  ms: number;
  /** Skill pips gained a person a year (learn.ts), over everyone who travelled. */
  pipsPerYear: number;
}

export function playRun(opts: RunOpts): RunResult {
  const t0 = performance.now();
  const ws = worldFor(opts.world);
  const { w, a, gd, seed } = ws;
  const queue: Pending[] = [];
  let arrived = false;
  const ui: Ui = {
    toast() {}, revealed() {}, halt() {}, changed() {}, routeChanged() {}, jobsChanged() {}, findUsed() {}, jobDone() {},
    blocked: () => queue.length > 0,
    encounter(e, ctx, quest) { queue.push({ e, ctx, choices: e.choices(ctx), quest }); },
    arrive() { arrived = true; },
    questHex(q) { arrived = true; if (q.kind === 'bounty' || q.kind === 'relic') queue.push(jobHere(g, q, QUEST_ENCOUNTERS)); },
    // Someone on the road: a bot always stops to meet them.
    folk(_cell, f) { queue.push(meetFolk(g, f)); },
    folkMet() {},
  };
  // The game a newcomer plays: building the caravan in town (Choose for me), then the errand.
  const s = newGame(w, a, seed, { name: 'Bot', origin: opts.origin, bias: opts.bias, world: opts.world, setup: true });
  const rng = makeRng((seed * 31 + opts.run * 7919 + opts.bot.length * 104729) >>> 0);
  const g = makeGame(w, a, gd, seed, s, ui, makeRng((seed * 13 + opts.run * 1009) >>> 0));
  quickSetup(g);
  const bot = makeBot(opts.bot, g, rng);
  const out: RunResult = { opts, home: a.places[s.home].name, days: [], encounters: [], deaths: [], events: [0], ambitionDay: null, wiped: null, trips: 0, ledger: {}, stuck: 0, ms: 0, pipsPerYear: 0 };
  const firstSeen = new Map<string, { sum: number; day: number }>(), lastSeen = new Map<string, { sum: number; day: number }>();
  const sumOf = (m: { skills: Record<string, number> }) => Object.values(m.skills).reduce((x, y) => x + y, 0);
  ledger = out.ledger;
  const end = opts.years * 365;
  const answer = () => {
    while (queue.length) {
      const p = queue.shift()!;
      const before = living(s.caravan).length;
      const i = pick(p, bot.style);
      booked(g, p.quest ? 'job-site' : 'encounters', () => resolve(g, p, i));
      const lost = before - living(s.caravan).length;
      out.encounters.push({ day: s.day, id: p.e.id, choice: p.choices[i].label, deaths: lost });
      for (let k = 0; k < lost; k++) out.deaths.push({ day: s.day, cause: p.e.id });
      out.events.push(s.day);
      if (living(s.caravan).length && !s.caravan.members.some((m) => m.alive && m.lead)) appoint(g, s.caravan.members.findIndex((m) => m.alive));
    }
  };
  const record = () => {
    const c = s.caravan;
    for (const m of s.caravan.members) { const e = { sum: sumOf(m), day: s.day }; if (m.alive) { if (!firstSeen.has(m.name)) firstSeen.set(m.name, e); lastSeen.set(m.name, e); } }
    out.days.push({
      day: Math.floor(s.day), orrels: c.orrels, earned: c.earned, alive: living(c).length, hurt: living(c).filter((m) => m.health !== 'well').length,
      food: c.rations / Math.max(1, appetite(c)), water: c.water / Math.max(1, thirst(c)), revealed: g.revealed.size, charted: s.charted, jobsDone: s.jobsDone, morale: c.morale, cargo: cargoUsed(c),
    });
    const prog = c.origin === 'traders' ? c.earned : s.charted;
    if (out.ambitionDay == null && prog >= AMBITION_GOAL[c.origin]) out.ambitionDay = s.day;
  };
  let lastDay = -1;
  let guard = 0;
  while (s.day < end && living(s.caravan).length && guard++ < 200000) {
    if (!s.route.length) {
      const pid = a.placeAt[s.cell];
      if (arrived || lastDay < 0) {
        arrived = false;
        out.events.push(s.day);
        if (pid >= 0) bot.town(pid);
        else for (const k of findsAt(g, s.cell)) {
          // Out in the country: walk to what there is to find here, and see to it.
          if (!findReady(k, s.finds[`${s.cell}:${k}`], s.day)) continue;
          const p = findHere(g, k);
          if (p) { queue.push(p); answer(); }
        }
      }
      const to = bot.next();
      if (to != null && to !== s.cell && setRoute(g, to)) out.trips++;
      else { out.stuck++; arrived = pid >= 0; }
    }
    // A day at most, in quarter days, answering any card as it comes.
    const dayEnd = Math.min(end, Math.floor(s.day) + 1);
    let inner = 0;
    while (s.day < dayEnd - 1e-9 && living(s.caravan).length && inner++ < 50) {
      const before = living(s.caravan).length, moving = s.route.length > 0;
      // On the road a quarter day at a time; staying put, the rest of the day at once.
      advance(g, moving ? Math.min(0.25, dayEnd - s.day) : dayEnd - s.day);
      // Anyone lost outside a card died of hunger or thirst, which the rules say can't happen.
      if (!queue.length && living(s.caravan).length < before) for (let k = living(s.caravan).length; k < before; k++) out.deaths.push({ day: s.day, cause: 'supplies' });
      answer();
      // Arrived: back out, for the bot to see to the place.
      if (moving && !s.route.length) break;
    }
    if (Math.floor(s.day) !== lastDay) { lastDay = Math.floor(s.day); record(); }
  }
  if (!living(s.caravan).length) out.wiped = s.day;
  record();
  let pips = 0, yrs = 0;
  for (const [n, f] of firstSeen) { const l = lastSeen.get(n)!; pips += l.sum - f.sum; yrs += (l.day - f.day) / 365; }
  out.pipsPerYear = yrs > 0 ? pips / yrs : 0;
  out.ms = performance.now() - t0;
  return out;
}

/** Real seconds a span of game days takes at a speed (the game's RATES). */
export const realSeconds = (days: number, speed = 2) => days / RATES[speed];
