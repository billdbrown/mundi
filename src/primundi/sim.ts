/**
 * Primundi's rules, without the screen: the save, the clock's days, travel, arriving in a hex, the
 * road's encounters and how a choice plays out, and what you can do in a town. `main.ts` runs the
 * game through these; the playtest bot (scripts/playtest.ts) runs them headless, so the two can't
 * drift apart.
 *
 * Everything that touches the screen goes through `Ui`: toasts, cards, the fog, the camera. The bot
 * gives a Ui that does nothing, or makes its choices.
 */
import * as THREE from 'three';
import { DEFAULT_PARAMS, WATER_LAND, type World, type WorldParams } from '../world.ts';
import { NAME_DECIDES, paramsOf } from '../namedworld.ts';
import { nameSeed, parseSeed } from '../seedname.ts';
import { nameMaker, type GameData, RES_FERTILE, RES_FISH, RES_TIMBER } from '../gamedata.ts';
import { makeRng } from '../rng.ts';
import { pickHome, type StartBias } from './start.ts';
import { findPath, G, GOODS, hasWater, ringCells, seasonalTemp, SNOW_TEMP, stepDays, walkable, type Atlas, type Place } from './atlas.ts';
import { quotes, rationPrice, remember, trade, type Known, type Stocks } from './market.ts';
import { appetite, cargoUsed, living, newCaravan, pace, passDay, sight, thirst, waterCap, TRAITS, ROLE_NAMES, BEASTS, ORIGIN_CAPACITY, SETUP_PURSE, WATER_DAYS, type Beasts, type Caravan, type Origin, type Role } from './caravan.ts';
import { candidates, farGuess, farPlace, SETUP_MAX, type Candidate } from './opening.ts';
import { findReady, findsIn, FINDS, type FindKind } from './finds.ts';
import { ENCOUNTERS, applyEffect, contextAt, drawEncounter, type Choice, type Ctx, type Encounter, type Outcome } from './encounters.ts';
import { MAX_QUESTS, canHandIn, offersAt, questTarget, questTitle, type Quest } from './quests.ts';
import { tradesOf, townsfolk, TRADES, type Trade } from './towns.ts';
import { CAMP_NIGHTS, CAMP_P, folkEncounter, folkIn, gameIn, gameReady, huntEncounter, type AnimalKind, type Folk } from './life.ts';
import { Traffic, trafficId } from './traffic.ts';

/** Days of game time per second of real time, at each speed. Bill will tune these by playing. */
export const RATES = [0, 0.22, 0.6, 1.6];
/** A world's settings from its name, as the launch screen takes it. */
export function worldParams(name: string): WorldParams {
  const p = parseSeed(name);
  const seed = p ? p.seed : nameSeed(name);
  return p?.name && NAME_DECIDES ? { ...paramsOf(p.name), seed } : { ...DEFAULT_PARAMS, seed };
}
/** The calendar day of the year the game starts on (northern spring). */
export const START_DOY = 100;
/** Chance of an encounter on entering a hex off the road (on it, a bit less). */
export const ENCOUNTER_P = 0.07;
/** Days the planner guesses for a hex it hasn't seen: a little worse than average, so it keeps to
 * land it knows unless the storm is a real shortcut. The truth may be a swamp. */
export const UNKNOWN_DAYS = 1;
export const doyOf = (day: number) => (START_DOY + day) % 365;

// --- The save ---------------------------------------------------------------------------------
export interface Save {
  v: 2;
  world: string;
  bias: StartBias;
  home: number;
  caravan: Caravan;
  /** Days since setting out (fractional). */
  day: number;
  cell: number;
  route: number[];
  progress: number;
  revealed: number[];
  /** Hexes revealed by the caravan's own travels (the Cartographers' ambition). */
  charted: number;
  known: Record<number, Known>;
  stocks: Stocks;
  /** Jobs in hand (quests.ts), and the ids of every offer ever taken (so it isn't offered again). */
  jobs: Quest[];
  taken: string[];
  jobsDone: number;
  /** Places whose local map you've bought. */
  maps: number[];
  /** Things found in hexes (finds.ts), by `cell:kind`: the day each was last used. */
  finds: Record<string, number>;
  log: { day: number; text: string }[];
  speed: number;
  draws: number;
  over: boolean;
  /** First-time hints already shown (main.ts), by id. */
  hints?: string[];
  /** Towns you've been to (by place id): how often, and how many of their jobs you've done. */
  met?: Record<number, { visits: number; helped: number }>;
  /** Building the caravan in the home town (opening.ts); gone once it sets out. */
  setup?: { offered: Candidate[]; hired: number[]; beasts?: Beasts; loads: number[] };
  /** The opening's first errand (its job id), and the hex of the first road's meeting: -1 until
   * the caravan is a little way out, then that hex. */
  errand?: string;
  firstRoad?: number;
  /** Word of a place very far away (place id), and where the rumour puts it (a hex near it). */
  far?: { pid: number; guess: number };
}
/** A save as loaded: fields added since it was written get their defaults. Null if unusable. */
export function migrateSave(s: Save | null): Save | null {
  if (!s || s.v !== 2 || typeof s.world !== 'string' || s.over) return null;
  // Saves from before several jobs at once.
  s.jobs ??= []; s.taken ??= []; s.maps ??= []; s.finds ??= {};
  delete (s as unknown as { job?: unknown }).job;
  return s;
}

// --- The screen, as the rules see it ----------------------------------------------------------
export interface Ui {
  toast(text: string, ms?: number): void;
  /** Hexes newly revealed (already in `revealed` and the save): the fog, labels, roads. */
  revealed(fresh: number[], byTravel: boolean): void;
  /** A card that needs an answer is up: the clock waits. */
  blocked(): boolean;
  /** Stop the clock (a warning worth reading). */
  halt(): void;
  /** Something on the readouts changed. */
  changed(): void;
  /** The route changed (re-planned, or ended). */
  routeChanged(): void;
  /** Jobs changed (taken, done, given up): the map's pins. */
  jobsChanged(): void;
  /** An encounter: show it; the player's answer comes back through `resolve`. */
  encounter(e: Encounter, ctx: Ctx, quest?: string): void;
  /** The route ended in `cell` (not a job's hex). */
  arrive(cell: number, pid: number): void;
  /** Reached the hex a bounty's camp or a relic's site is in. */
  questHex(q: Quest): void;
  /** A find has been used (its label goes, in the hex). */
  findUsed(kind: FindKind): void;
  /** A job's camp or site dealt with. */
  jobDone(q: Quest): void;
  /** Passing through a hex with someone else on the road: stop and meet them, or go on. */
  folk(cell: number, f: Folk): void;
  /** Someone met: they go on their way (their label goes, in the hex). */
  folkMet(id: string): void;
}

/** A game in play: the world, the save, and the screen. */
export interface Game {
  w: World;
  a: Atlas;
  game: GameData;
  seed: number;
  s: Save;
  /** The save's revealed hexes, as a set. */
  revealed: Set<number>;
  /** Dice for what the game doesn't seed (who mends, a hire's trait): Math.random in play. */
  dice: () => number;
  ui: Ui;
  /** The hex the caravan last came from. */
  from: number;
  warned: { water: boolean; rations: boolean };
  /** Other traders on the roads (traffic.ts), made when first asked for. */
  traffic?: Traffic;
}
/** The game's traffic: the same traders and journeys for the same seed. */
export function trafficOf(g: Game): Traffic { return (g.traffic ??= new Traffic(g.w, g.a, g.seed)); }

export function makeGame(w: World, a: Atlas, game: GameData, seed: number, s: Save, ui: Ui, dice: () => number = () => Math.random()): Game {
  return { w, a, game, seed, s, revealed: new Set(s.revealed), dice, ui, from: -1, warned: { water: false, rations: false } };
}

/** A new game: a caravan at home, knowing home's market and its two nearest neighbours'. */
export function newGame(w: World, a: Atlas, seed: number, n: { name: string; origin: Origin; bias: StartBias; world: string; setup?: boolean }): Save {
  const home = a.places[pickHome(w, a.places, n.bias, seed)];
  const caravan = newCaravan(n.name, n.origin, seed);
  const s: Save = {
    v: 2, world: n.world, bias: n.bias, home: home.id, caravan, day: 0, cell: home.cell, route: [], progress: 0,
    revealed: [], charted: 0, known: {}, stocks: {}, jobs: [], taken: [], jobsDone: 0, maps: [], finds: {}, log: [], speed: 0, draws: 0, over: false,
  };
  const seen = new Set(ringCells(w, home.cell, 2));
  const near = a.places.filter((p) => p.id !== home.id).map((p) => ({ p, d: angle(w, p.cell, home.cell) })).sort((x, y) => x.d - y.d).slice(0, 2);
  for (const p of [home, ...near.map((x) => x.p)]) {
    remember(s.known, p, quotes(w, p, s.stocks, 0, doyOf(0)), 0);
    for (const c of ringCells(w, p.cell, 1)) seen.add(c);
  }
  s.revealed = [...seen];
  s.log.push({ day: 0, text: `${caravan.name} sets out from ${home.name}. You know the prices here and in ${near.map((x) => x.p.name).join(' and ')}.` });
  // Built in town: the leader alone, and the purse to find the rest.
  if (n.setup) {
    caravan.members = caravan.members.filter((m) => m.role === 'leader');
    caravan.orrels = SETUP_PURSE[n.origin];
    caravan.capacity = ORIGIN_CAPACITY[n.origin];
    caravan.rations = 30; caravan.water = WATER_DAYS;
    s.setup = { offered: candidates(w, a, home, n.origin, seed), hired: [], loads: [] };
    s.log[0].text = `${caravan.name} gathers in ${home.name}. You know the prices here and in ${near.map((x) => x.p.name).join(' and ')}.`;
  }
  return s;
}

// --- Setting out (opening.ts) -----------------------------------------------------------------
/** Take someone on from the tavern, or let them go again before setting out. */
export function setupHire(g: Game, i: number): boolean {
  const s = g.s, st = s.setup, c = s.caravan;
  if (!st || !st.offered[i]) return false;
  const k = st.hired.indexOf(i), cand = st.offered[i];
  if (k >= 0) {
    st.hired.splice(k, 1);
    c.members = c.members.filter((m) => m.name !== cand.m.name);
    c.orrels += cand.cost;
    return true;
  }
  if (st.hired.length >= SETUP_MAX || c.orrels < cand.cost) return false;
  st.hired.push(i);
  c.members.push({ ...cand.m });
  c.orrels -= cand.cost;
  return true;
}
/** Choose what pulls the caravan (the old choice's cost back). */
export function setupBeasts(g: Game, b: Beasts): boolean {
  const s = g.s, st = s.setup, c = s.caravan;
  if (!st) return false;
  const back = st.beasts ? BEASTS[st.beasts].cost : 0;
  if (c.orrels + back < BEASTS[b].cost) return false;
  const cap = ORIGIN_CAPACITY[c.origin] + BEASTS[b].capacity;
  if (cargoUsed(c) > cap) return false;
  c.orrels += back - BEASTS[b].cost;
  st.beasts = b; c.beasts = b; c.capacity = cap;
  return true;
}
/** A first load: a good home makes cheaply and a neighbour you know pays more for. */
export interface Load { gi: number; n: number; cost: number; at: number; each: number }
export function firstLoads(g: Game): Load[] {
  const s = g.s, home = g.a.places[s.home], q = quotes(g.w, home, s.stocks, s.day, doyOf(s.day));
  const out: (Load & { k: number })[] = [];
  for (let gi = 0; gi < GOODS.length; gi++) {
    if (!q[gi].buy || q[gi].stock < 6) continue;
    let best: { at: number; each: number } | null = null;
    for (const [pid, kn] of Object.entries(s.known)) {
      if (Number(pid) === home.id) continue;
      const sell = kn.sell[gi] ?? 0;
      if (sell > (best?.each ?? 0)) best = { at: Number(pid), each: sell };
    }
    if (!best || best.each <= q[gi].buy * 1.15) continue;
    const n = Math.min(8, Math.floor(q[gi].stock / 2));
    out.push({ gi, n, cost: q[gi].buy * n, at: best.at, each: best.each, k: best.each / q[gi].buy });
  }
  return out.sort((x, y) => y.k - x.k).slice(0, 3);
}
/** Buy a first load (it moves the price as any buying does). The number bought. */
export function setupLoad(g: Game, gi: number, n: number): number {
  const st = g.s.setup;
  if (!st) return 0;
  const got = buy(g, g.s.home, gi, n);
  if (got && !st.loads.includes(gi)) st.loads.push(gi);
  return got;
}
export const setupReady = (s: Save) => !!s.setup && s.setup.hired.length > 0 && !!s.setup.beasts;
/** Done in town: food and water for everyone, and someone at home has an errand before you go. */
export function finishSetup(g: Game): Quest | null {
  const s = g.s, c = s.caravan;
  if (!setupReady(s)) return null;
  delete s.setup;
  c.rations = Math.max(c.rations, living(c).length * 30);
  c.water = waterCap(c);
  log(g, `${c.name} sets out from ${g.a.places[s.home].name}: ${living(c).map((m) => m.name).join(', ')}.`);
  return giveErrand(g);
}
/** The first errand: a letter to the nearest place you know, paid on delivery. */
function giveErrand(g: Game): Quest | null {
  const s = g.s, home = g.a.places[s.home];
  const to = Object.keys(s.known).map(Number).filter((pid) => pid !== home.id)
    .map((pid) => ({ pid, p: plan(g, g.a.places[pid].cell) })).filter((x) => x.p).sort((x, y) => x.p!.days - y.p!.days)[0];
  if (!to) return null;
  const giver = townsfolk(home, g.seed, nameMaker(g.seed * 101 + home.id * 7)).work?.name ?? 'Someone at home';
  const q: Quest = { id: `first-${home.id}`, kind: 'deliver', giver, from: home.id, to: to.pid, item: 'sealed letter', reward: Math.round(30 + to.p!.days * 8), taken: s.day };
  s.jobs.push(q); s.taken.push(q.id);
  s.errand = q.id;
  s.firstRoad = -1;
  log(g, `Took on: ${questTitle(q, g.a)}, for ${giver} of ${home.name}.`);
  g.ui.jobsChanged();
  return q;
}
/** A sensible caravan, chosen for you: the usual people for your kind, mules, the best load. */
export function quickSetup(g: Game): Quest | null {
  const s = g.s, st = s.setup;
  if (!st) return null;
  const want: Role[] = s.caravan.origin === 'traders' ? ['guard', 'guard', 'hand', 'hand'] : ['scout', 'guard', 'hand'];
  for (const r of want) {
    const i = st.offered.findIndex((x, k) => x.m.role === r && !st.hired.includes(k));
    if (i >= 0) setupHire(g, i);
  }
  if (!st.beasts) setupBeasts(g, 'mules');
  if (s.caravan.origin === 'traders' && !st.loads.length) { const l = firstLoads(g)[0]; if (l) setupLoad(g, l.gi, l.n); }
  return finishSetup(g);
}

// --- Geometry ---------------------------------------------------------------------------------
export function angle(w: World, a: number, b: number) {
  const P = w.grid.centers;
  return Math.acos(Math.min(1, P[a * 3] * P[b * 3] + P[a * 3 + 1] * P[b * 3 + 1] + P[a * 3 + 2] * P[b * 3 + 2]));
}
export const cellAngleOf = (w: World) => Math.sqrt((4 * Math.PI) / w.grid.count);
export function bearing(w: World, from: number, to: number): string {
  const P = w.grid.centers;
  const a = new THREE.Vector3(P[from * 3], P[from * 3 + 1], P[from * 3 + 2]);
  const b = new THREE.Vector3(P[to * 3], P[to * 3 + 1], P[to * 3 + 2]);
  const north = new THREE.Vector3(0, 1, 0).sub(a.clone().multiplyScalar(a.y)).normalize();
  // The generator's east is +longitude (atan2(x, z)): north × up.
  const east = new THREE.Vector3().crossVectors(north, a).normalize();
  const d = b.clone().sub(a);
  const ang = Math.atan2(d.dot(east), d.dot(north));
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
}

export function log(g: Game, text: string) {
  const s = g.s;
  s.log.push({ day: s.day, text });
  if (s.log.length > 200) s.log.splice(0, s.log.length - 200);
}

// --- Revealing --------------------------------------------------------------------------------
/** Reveal hexes; by travel, they count as charted. The number newly revealed. */
export function reveal(g: Game, cells: number[], byTravel = false): number {
  const fresh = cells.filter((c) => !g.revealed.has(c) && c >= 0 && c < g.w.grid.count);
  if (!fresh.length) return 0;
  for (const c of fresh) g.revealed.add(c);
  g.s.revealed = [...g.revealed];
  if (byTravel) { g.s.charted += fresh.length; g.s.caravan.unsoldCharts += fresh.length; }
  g.ui.revealed(fresh, byTravel);
  return fresh.length;
}
/** What the caravan sees from a cell: further from high ground, further with a scout. */
export function lookAround(g: Game, c: number) {
  const high = g.w.elevation[c] > 0.32;
  reveal(g, ringCells(g.w, c, sight(g.s.caravan) + (high ? 1 : 0)), true);
}
/** A rumour: the nearest place you don't know of yet, roughly located. */
export function rumour(g: Game): string {
  const w = g.w, at = g.s.cell;
  let best: Place | null = null, bd = Infinity;
  for (const p of g.a.places) {
    if (g.revealed.has(p.cell)) continue;
    const d = angle(w, at, p.cell);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best || bd > cellAngleOf(w) * 30) return 'Nothing you can use.';
  reveal(g, ringCells(w, best.cell, 1));
  const days = Math.max(1, Math.round((bd / cellAngleOf(w)) * 0.6));
  const line = `Word of ${best.name}, ${best.town ? 'a town' : 'a village'} about ${days} days ${bearing(w, at, best.cell)}. It's on your map now.`;
  log(g, line);
  return line;
}

// --- Travel -----------------------------------------------------------------------------------
/** A route from the caravan to a cell. Over known land it knows the going; into the storm it
 * guesses, and the route is thought again as the caravan sees more (enter). */
export function plan(g: Game, to: number): { path: number[]; days: number; guess: boolean } | null {
  const w = g.w, a = g.a, s = g.s, doy = doyOf(s.day), revealed = g.revealed;
  // Water you can see stops you; water in the storm you only find by walking up to it.
  if (revealed.has(to) && !walkable(w, to)) return null;
  const cost = (x: number, y: number) => (revealed.has(y) ? stepDays(w, a, x, y, doy) : UNKNOWN_DAYS);
  const path = findPath(w, s.cell, to, cost, (c) => revealed.has(c) || walkable(w, c));
  if (!path) return null;
  let days = 0, guess = false;
  for (let i = 1; i < path.length; i++) { days += cost(path[i - 1], path[i]); if (!revealed.has(path[i])) guess = true; }
  return { path, days: days / pace(s.caravan), guess };
}
/** Set out for a cell. False if there's no way. */
export function setRoute(g: Game, to: number): boolean {
  const p = plan(g, to);
  if (!p || p.path.length < 2) return false;
  g.s.route = p.path.slice(1);
  g.s.progress = 0;
  g.ui.routeChanged();
  return true;
}

/** Move the game on by `dd` days: travel, the days' needs, and whatever the road brings. Stops
 * early when a card comes up. */
export function advance(g: Game, dd: number) {
  const w = g.w, a = g.a, s = g.s, c = s.caravan;
  let guard = 0;
  while (dd > 1e-6 && !g.ui.blocked() && guard++ < 64) {
    const toMidnight = Math.floor(s.day) + 1 - s.day;
    if (s.route.length) {
      const next = s.route[0];
      const cost = stepDays(w, a, s.cell, next, doyOf(s.day)) / pace(c);
      const left = (1 - s.progress) * cost;
      const take = Math.min(dd, left, toMidnight);
      s.progress += take / cost;
      s.day += take; dd -= take;
      if (take >= toMidnight - 1e-9) newDay(g, false);
      if (s.progress >= 1 - 1e-6 && !g.ui.blocked()) enter(g, next);
    } else {
      const take = Math.min(dd, toMidnight);
      s.day += take; dd -= take;
      if (take >= toMidnight - 1e-9) newDay(g, true);
    }
  }
}

/** A fresh roll of the game's seeded dice (each draw a new stream). */
export function draw(g: Game): () => number {
  return makeRng((g.seed * 7919 + ++g.s.draws * 104729) >>> 0);
}
/** The context an encounter reads, here and now. */
export function ctxHere(g: Game, rng: () => number, snow: boolean, nearTown = false): Ctx {
  const s = g.s;
  return contextAt(g.w, s.cell, !!g.a.road[s.cell], snow, nearTown, s.caravan, rng, nameMaker(g.seed * 31 + s.draws));
}
export const snowAt = (g: Game, cell: number) => seasonalTemp(g.w, cell, doyOf(g.s.day)) < SNOW_TEMP;

/** The caravan steps into a hex. */
export function enter(g: Game, cell: number) {
  const w = g.w, a = g.a, s = g.s;
  g.from = s.cell;
  s.cell = cell;
  s.route.shift();
  s.progress = 0;
  // A route through the storm was a guess. When what's just been seen of it turns out worse than
  // guessed, think again; otherwise keep going, so the caravan doesn't wander between guesses.
  const unseen = s.route.filter((c) => !g.revealed.has(c));
  lookAround(g, cell);
  if (unseen.length && s.route.length && unseen.some((c) => g.revealed.has(c))) {
    let guessed = 0, found = 0, prev = s.cell;
    for (const c of s.route) {
      if (unseen.includes(c) && g.revealed.has(c)) { guessed += UNKNOWN_DAYS; found += stepDays(w, a, prev, c, doyOf(s.day)); }
      prev = c;
    }
    if (found > guessed * 1.15) {
      const p = plan(g, s.route[s.route.length - 1]);
      if (p && p.path.length > 1) s.route = p.path.slice(1);
    }
  }
  g.ui.routeChanged();
  const pid = a.placeAt[cell];
  if (hasWater(w, a, cell)) s.caravan.water = waterCap(s.caravan);
  if (pid >= 0) {
    const p = a.places[pid];
    metAt(g, pid).visits++;
    remember(s.known, p, quotes(w, p, s.stocks, s.day, doyOf(s.day)), Math.floor(s.day));
    if (s.route.length) { g.ui.toast(`Through ${p.name}. You note the prices.`); log(g, `Passed through ${p.name}.`); }
  }
  if (!s.route.length) {
    g.ui.halt();
    // A job's hex is usually where the route ends.
    if (questsAt(g, cell)) { g.ui.changed(); return; }
    g.ui.arrive(cell, pid);
    return;
  }
  // A job's hex.
  if (questsAt(g, cell)) return;
  // The opening's first road: the first open hex out of town (on a later trip, if the first was
  // town to town with nothing between).
  if (s.firstRoad === -1 && pid < 0 && w.water[cell] === WATER_LAND) s.firstRoad = cell;
  // The road: someone else on it, or what the road brings.
  if (pid < 0) {
    const f = folkHere(g, cell)[0];
    if (f) { g.ui.folk(cell, f); return; }
    const rng = draw(g);
    if (rng() < ENCOUNTER_P * (a.road[cell] ? 0.7 : 1)) {
      const nearTown = ringCells(w, cell, 3).some((x) => a.placeAt[x] >= 0);
      const ctx = ctxHere(g, rng, snowAt(g, cell), nearTown);
      const e = drawEncounter(ctx);
      if (e) g.ui.encounter(e, ctx);
    }
  }
}

/** The caravan reached a job's hex: survey done, or the band or the old site found. True if a card
 * came up (which stops the clock). */
export function questsAt(g: Game, cell: number): boolean {
  const near = new Set([cell, ...g.w.grid.neighbors[cell]]);
  for (const q of g.s.jobs) {
    if (q.done || q.cell == null) continue;
    if (q.kind === 'survey' && near.has(q.cell)) {
      q.done = true;
      reveal(g, ringCells(g.w, q.cell, 2), true);
      g.ui.toast(`Charted. Back to ${g.a.places[q.from].name} with it.`, 5000);
      log(g, `Charted the hex ${q.giver} asked about.`);
      g.ui.jobsChanged();
      continue;
    }
    // The band's camp or the old site is somewhere in the hex: into it, to find it on foot.
    if ((q.kind === 'bounty' || q.kind === 'relic') && q.cell === cell) {
      g.ui.questHex(q);
      return true;
    }
  }
  return false;
}

/** How much of the day's food comes from the stores: kind country feeds you a little. */
export function forageAt(g: Game, c: number): number {
  const r = g.game.resources[c];
  if (r & (RES_FERTILE | RES_FISH)) return 0.6;
  if (r & RES_TIMBER || g.w.moisture[c] > 0.5) return 0.75;
  return 1;
}

export function newDay(g: Game, resting: boolean) {
  const s = g.s, c = s.caravan;
  const atWater = hasWater(g.w, g.a, s.cell);
  // In a town you eat what you buy; on the road the land helps.
  const forage = g.a.placeAt[s.cell] >= 0 ? 1 : forageAt(g, s.cell);
  for (const n of passDay(c, atWater, resting, forage, g.dice)) { g.ui.toast(n); log(g, n); }
  const wd = c.water / Math.max(1, thirst(c)), rd = c.rations / Math.max(1, appetite(c));
  const warned = g.warned;
  if (wd <= 2 && !atWater && !warned.water && c.water > 0) { warned.water = true; g.ui.halt(); g.ui.toast(`Water for ${Math.floor(wd)} more days.`, 5000); }
  if (wd > 3) warned.water = false;
  if (rd <= 3 && !warned.rations && c.rations > 0) { warned.rations = true; g.ui.halt(); g.ui.toast(`Rations for ${Math.floor(rd)} more days.`, 5000); }
  if (rd > 4) warned.rations = false;
  g.ui.changed();
}
/** Whole days spent in place (a storm, a fever, a rest). */
export function passDays(g: Game, n: number, resting = true) {
  const s = g.s;
  for (let i = 0; i < Math.round(n * 2); i++) {
    const before = Math.floor(s.day);
    s.day += 0.5;
    if (Math.floor(s.day) > before) newDay(g, resting);
  }
}

// --- Encounters and finds ---------------------------------------------------------------------
/** An encounter waiting for an answer. */
export interface Pending { e: Encounter; ctx: Ctx; choices: Choice[]; quest?: string; find?: FindKind; folk?: string; hunt?: boolean }
export function pending(e: Encounter, ctx: Ctx, quest?: string, find?: FindKind): Pending {
  return { e, ctx, choices: e.choices(ctx), quest, find };
}
/** A find in the caravan's hex, walked to: its encounter, or null if it isn't ready. */
export function findHere(g: Game, kind: FindKind): Pending | null {
  const s = g.s;
  if (!findReady(kind, s.finds[`${s.cell}:${kind}`], s.day)) return null;
  const rng = draw(g);
  return pending(FINDS[kind], ctxHere(g, rng, snowAt(g, s.cell)), undefined, kind);
}
/** The finds in a hex. */
export const findsAt = (g: Game, cell: number) => findsIn(g.w, g.a, cell, g.seed);
/** A job's camp or site, walked to: its encounter. */
export function jobHere(g: Game, q: Quest, encounters: Record<'bounty' | 'relic', Encounter>): Pending {
  const rng = draw(g);
  return pending(encounters[q.kind as 'bounty' | 'relic'], ctxHere(g, rng, false), q.id);
}
/** Others on the road in a hex this week, not yet met or passed by. */
export function folkHere(g: Game, cell: number): Folk[] {
  const s = g.s;
  // The first road always has someone on it: a caravan out of the errand's town.
  if (cell === s.firstRoad && s.finds['folk:first'] === undefined) {
    const q = s.jobs.find((x) => x.id === s.errand);
    return [{ id: 'first', kind: 'traders', name: nameMaker((g.seed * 7 + 5) >>> 0)(), from: q?.to ?? s.home }];
  }
  // Traders on the road are the traffic's (traffic.ts): whoever is really in the hex today. The
  // seeded draw still brings pilgrims and broken carts, and traders out in the country.
  const real: Folk[] = trafficOf(g).inCell(cell, s.day).map((r) => ({ id: trafficId(r), kind: 'traders', name: r.trader.name, from: r.leg.from, to: r.leg.to }));
  const drawn = folkIn(g.w, g.a, cell, s.day, g.seed).filter((f) => !(f.kind === 'traders' && g.a.road[cell]));
  return [...real, ...drawn].filter((f) => s.finds[`folk:${f.id}`] === undefined);
}
/** Meeting someone on the road: its card. */
export function meetFolk(g: Game, f: Folk): Pending {
  const s = g.s, home = g.a.places[f.from];
  const rng = draw(g);
  const p = pending(folkEncounter(f, home, quotes(g.w, home, s.stocks, s.day, doyOf(s.day))), ctxHere(g, rng, snowAt(g, s.cell)));
  p.folk = f.id;
  return p;
}
/** Game in a hex you could hunt now (null: none, or hunted lately). */
export function gameHere(g: Game, cell: number): AnimalKind | null {
  const k = gameIn(g.w, g.a, cell, findsAt(g, cell));
  return k && gameReady(g.s.finds[`${cell}:hunt`], g.s.day) ? k : null;
}
/** Stalked game to within reach: the shot. */
export function huntHere(g: Game, kind: AnimalKind): Pending {
  const rng = draw(g);
  const p = pending(huntEncounter(kind), ctxHere(g, rng, snowAt(g, g.s.cell)));
  p.hunt = true;
  return p;
}
/** A night in camp where the caravan stands, out in the country: free, but it mends less than an
 * inn (the day passes as on the road, with a little cheer from the fire). Sometimes the night brings
 * something: its card, or null for a quiet night. */
export function makeCamp(g: Game): Pending | null {
  const s = g.s, c = s.caravan;
  passDays(g, 1, false);
  c.morale = Math.min(100, c.morale + 2);
  log(g, 'Made camp for the night.');
  const rng = draw(g);
  if (rng() >= CAMP_P) return null;
  const ctx = ctxHere(g, rng, snowAt(g, s.cell));
  const table = [...CAMP_NIGHTS, ENCOUNTERS.find((e) => e.id === 'wolves')!];
  const ws = table.map((e) => Math.max(0, e.weight(ctx)));
  let r = rng() * ws.reduce((a, b) => a + b, 0);
  const e = table.find((_, i) => (r -= ws[i]) < 0) ?? table[0];
  return pending(e, ctx);
}
/** Went on without stopping: they're gone. */
export function passFolk(g: Game, id: string) { g.s.finds[`folk:${id}`] = g.s.day; }

/** The player answers: what came of it, the changes as lines, and anything more to say. */
export function resolve(g: Game, p: Pending, i: number): { out: Outcome; lines: string[]; extra: string } {
  const s = g.s;
  const out = p.choices[i].resolve(p.ctx);
  // A find is used once something comes of it (walking away leaves it for later).
  if (p.find && Object.keys(out.effect).length) {
    s.finds[`${s.cell}:${p.find}`] = s.day;
    g.ui.findUsed(p.find);
  }
  if (p.folk) { s.finds[`folk:${p.folk}`] = s.day; g.ui.folkMet(p.folk); }
  // Hunted (or let be): the game moves off for a while.
  if (p.hunt) s.finds[`${s.cell}:hunt`] = s.day;
  const lines = applyEffect(s.caravan, out.effect, p.ctx.name, s.day, g.dice);
  if (out.effect.learn != null) {
    const pl = g.a.places[out.effect.learn];
    remember(s.known, pl, quotes(g.w, pl, s.stocks, s.day, doyOf(s.day)), Math.floor(s.day));
    lines.push(`${pl.name}'s prices`);
  }
  const q = p.quest ? s.jobs.find((x) => x.id === p.quest) : undefined;
  if (q && out.effect.questDone) { q.done = true; lines.push(`job done: back to ${g.a.places[q.from].name}`); g.ui.jobsChanged(); g.ui.jobDone(q); }
  let extra = '';
  if (out.effect.reveal) { const n = reveal(g, ringCells(g.w, s.cell, out.effect.reveal), true); if (n) lines.push(`${n} hexes mapped`); }
  if (out.effect.rumour) extra = rumour(g);
  if (out.effect.days) passDays(g, out.effect.days);
  log(g, `${p.e.title}: ${out.text}`);
  return { out, lines, extra };
}

// --- In a town --------------------------------------------------------------------------------
/** This month's notice board at a place, less what you've taken. */
export function jobsOffered(g: Game, p: Place): Quest[] {
  const w = g.w, s = g.s, month = Math.floor(s.day / 30);
  const price = (pl: Place, gi: number) => quotes(w, pl, s.stocks, s.day, doyOf(s.day))[gi].buy || pl.price[gi];
  return offersAt(w, g.a, g.game.continent, p, month, g.seed, g.revealed, price).filter((q) => !s.taken.includes(q.id));
}
/** Goods a place is short of: what its notice board wants brought this month, and what you've
 * taken a job to bring it. Its market has none of them to sell, or the job could be done with
 * goods bought on the spot. */
export function shortHere(g: Game, pid: number): Set<number> {
  const s = g.s, w = g.w, p = g.a.places[pid], month = Math.floor(s.day / 30);
  const price = (pl: Place, gi: number) => quotes(w, pl, s.stocks, s.day, doyOf(s.day))[gi].buy || pl.price[gi];
  const out = new Set<number>();
  for (const q of offersAt(w, g.a, g.game.continent, p, month, g.seed, g.revealed, price)) if (q.kind === 'procure') out.add(q.good!);
  for (const q of s.jobs) if (q.kind === 'procure' && q.from === pid) out.add(q.good!);
  return out;
}
export function chartRate(g: Game, p: Place) { return (g.s.caravan.origin === 'cartographers' ? 1.5 : 0.6) * (p.town ? 1 : 0.5); }

/** Buy up to `many` of a good, as many as the purse and the pack allow. The number bought. */
export function buy(g: Game, pid: number, gi: number, many: number): number {
  const s = g.s, c = s.caravan, p = g.a.places[pid];
  let n = Math.min(many, c.capacity - cargoUsed(c));
  if (n <= 0 || shortHere(g, pid).has(gi)) return 0;
  // No more than the purse allows.
  while (n > 0) { const st = JSON.parse(JSON.stringify(s.stocks)) as Stocks; if (trade(g.w, p, st, s.day, doyOf(s.day), gi, n) <= c.orrels) break; n--; }
  if (n <= 0) return 0;
  const cost = trade(g.w, p, s.stocks, s.day, doyOf(s.day), gi, n);
  c.orrels -= cost;
  c.basis[gi] += cost; c.cargo[gi] += n;
  return n;
}
/** Sell up to `many` of a good. The orrels it fetched. */
export function sell(g: Game, pid: number, gi: number, many: number): number {
  const s = g.s, c = s.caravan, p = g.a.places[pid];
  const n = Math.min(many, c.cargo[gi]);
  if (n <= 0) return 0;
  const cost = trade(g.w, p, s.stocks, s.day, doyOf(s.day), gi, -n);
  c.orrels -= cost;
  // The Traders' ambition counts profit: what it sold for, less what it cost.
  const paid = c.cargo[gi] ? (c.basis[gi] / c.cargo[gi]) * n : 0;
  c.basis[gi] -= paid; c.cargo[gi] -= n;
  c.earned += -cost - paid;
  return -cost;
}
/** What a town remembers of you. */
export function metAt(g: Game, pid: number) {
  g.s.met ??= {};
  return (g.s.met[pid] ??= { visits: 0, helped: 0 });
}
/** A town you've done a job for takes a little off food and beds. */
export const FRIEND_DISCOUNT = 0.9;
const friendly = (g: Game, pid: number) => (g.s.met?.[pid]?.helped ?? 0) > 0;
export function rationCost(g: Game, pid: number, days: number) {
  const s = g.s;
  return Math.ceil(rationPrice(g.w, g.a.places[pid], s.stocks, s.day, doyOf(s.day)) * appetite(s.caravan) * days * (friendly(g, pid) ? FRIEND_DISCOUNT : 1));
}
export function buyRations(g: Game, pid: number, days: number): boolean {
  const c = g.s.caravan, cost = rationCost(g, pid, days);
  if (c.orrels < cost) return false;
  c.orrels -= cost;
  c.rations += appetite(c) * days;
  return true;
}
export function sellCharts(g: Game, pid: number): number {
  const c = g.s.caravan, p = g.a.places[pid], pay = Math.round(c.unsoldCharts * chartRate(g, p));
  c.orrels += pay; c.earned += pay; c.unsoldCharts = 0;
  log(g, `Sold charts in ${p.name} for ${pay} orrels.`);
  return pay;
}
export function takeJob(g: Game, pid: number, id: string): Quest | null {
  const s = g.s, q = jobsOffered(g, g.a.places[pid]).find((x) => x.id === id);
  if (!q || s.jobs.length >= MAX_QUESTS) return null;
  q.taken = s.day;
  s.jobs.push(q); s.taken.push(q.id);
  // The giver shows you on your map where it is.
  reveal(g, ringCells(g.w, questTarget(q, g.a), 1));
  log(g, `Took on: ${questTitle(q, g.a)}, for ${q.giver} of ${g.a.places[q.from].name}.`);
  g.ui.jobsChanged();
  return q;
}
export function handIn(g: Game, pid: number, id: string): Quest | null {
  const s = g.s, c = s.caravan, q = s.jobs.find((x) => x.id === id);
  if (!q || !canHandIn(q, pid, c.cargo)) return null;
  if (q.kind === 'procure') { const gi = q.good!, n = q.qty!; c.basis[gi] -= c.cargo[gi] ? (c.basis[gi] / c.cargo[gi]) * n : 0; c.cargo[gi] -= n; }
  if (q.kind === 'relic' && c.cargo[G.relics] > 0) { c.basis[G.relics] = 0; c.cargo[G.relics]--; }
  c.orrels += q.reward; c.earned += q.reward;
  s.jobsDone++;
  metAt(g, q.from).helped++;
  s.jobs = s.jobs.filter((x) => x !== q);
  log(g, `${questTitle(q, g.a)}: done, ${q.reward} orrels.`);
  // The first errand done: someone here has heard of a place very far away.
  if (q.id === s.errand && !s.far) {
    const f = farPlace(g.w, g.a, g.game.continent, g.a.places[s.home]);
    if (f) { s.far = { pid: f.id, guess: farGuess(g.w, f, g.seed) }; log(g, `Word of ${f.name}, far to the ${bearing(g.w, g.a.places[pid].cell, f.cell)}.`); }
  }
  g.ui.toast(`${q.reward} orrels. ${q.giver} is pleased.`);
  g.ui.jobsChanged();
  return q;
}
export function giveUp(g: Game, id: string): boolean {
  const s = g.s, q = s.jobs.find((x) => x.id === id);
  if (!q) return false;
  s.jobs = s.jobs.filter((x) => x !== q);
  log(g, `Gave up: ${questTitle(q, g.a)}.`);
  g.ui.jobsChanged();
  return true;
}
export const ROUND_COST = 8;
/** Stand a round in the tavern: a rumour, or '' if you can't pay. */
export function standRound(g: Game): string {
  const c = g.s.caravan;
  if (c.orrels < ROUND_COST) return '';
  c.orrels -= ROUND_COST;
  return rumour(g);
}
export const mapCost = (p: Place) => (p.town ? 40 : 25);
/** Buy the map of the country round a place: the hexes it showed, or -1 if you can't. */
export function buyMap(g: Game, pid: number): number {
  const s = g.s, c = s.caravan, p = g.a.places[pid], n = mapCost(p);
  if (c.orrels < n || s.maps.includes(pid)) return -1;
  c.orrels -= n;
  s.maps.push(pid);
  const got = reveal(g, ringCells(g.w, p.cell, 6));
  log(g, `Bought a map of the country round ${p.name}.`);
  return got;
}
export const restCost = (g: Game, pid: number, days: number) => (pid === g.s.home ? 0 : Math.ceil(living(g.s.caravan).length * days * (friendly(g, pid) ? FRIEND_DISCOUNT : 1)));
export function rest(g: Game, pid: number, days: number): boolean {
  const c = g.s.caravan, cost = restCost(g, pid, days);
  if (c.orrels < cost) return false;
  c.orrels -= cost;
  passDays(g, days, true);
  c.water = waterCap(c);
  return true;
}
export const HIRES: [Role, number, string][] = [['hand', 30, 'Carries, cooks, keeps watch'], ['guard', 55, 'Fights when it comes to it'], ['scout', 70, 'Sees a hex further']];
export function hire(g: Game, pid: number, role: Role, cost: number): boolean {
  const s = g.s, c = s.caravan;
  if (c.orrels < cost) return false;
  c.orrels -= cost;
  const nm = nameMaker(g.seed * 17 + s.day * 3 + c.members.length)();
  const traits = Object.keys(TRAITS) as (keyof typeof TRAITS)[];
  c.members.push({ name: nm, role, trait: traits[Math.floor(g.dice() * traits.length)], health: 'well', alive: true, joined: s.day });
  log(g, `${nm} joined as a ${ROLE_NAMES[role].toLowerCase()}, in ${g.a.places[pid].name}.`);
  return true;
}
/** A town's own offer, by its trade, once a month: goods straight from where they're made, cheap;
 * or, where nothing is made, a boat down the coast, the news from every road, a blessing. */
export interface LocalOffer { label: string; note: string; cost: number }
const LOCAL_GOODS: Partial<Record<Trade, [string, number]>> = {
  fishing: ['', 0], mining: ['Buy ore at the pit head', 4], salt: ['Buy salt at the pans', 4], trapping: ['Buy furs from the trappers', 2],
  herding: ['Buy wool off the shearing', 5], farming: ['Buy grain at the threshing floor', 6], timber: ['Buy timber at the sawpit', 5],
  weaving: ['Buy cloth from the looms', 3], smithing: ['Buy tools from the forge', 2],
};
export const LOCAL_DISCOUNT = 0.6;
const localKey = (g: Game, pid: number) => `local:${pid}:${Math.floor(g.s.day / 30)}`;
export function localOffer(g: Game, pid: number): LocalOffer | null {
  const s = g.s, p = g.a.places[pid], t = tradesOf(g.w, g.a, p)[0];
  if (s.finds[localKey(g, pid)] !== undefined) return null;
  if (t === 'fishing') return { label: 'Hire a boat down the coast', note: 'A day at sea: the shore mapped both ways', cost: 20 };
  if (t === 'market') return { label: 'Hear the news from every road', note: 'Prices from the two nearest markets you don\'t know', cost: 10 };
  if (t === 'shrine') return { label: 'Ask a blessing at the shrine', note: 'Spirits lifted, the hurt mended', cost: 10 };
  const lg = LOCAL_GOODS[t], gi = TRADES[t].good;
  if (!lg || gi == null) return null;
  const n = lg[1], q = quotes(g.w, p, s.stocks, s.day, doyOf(s.day))[gi];
  return { label: lg[0], note: `${n} ${GOODS[gi].name.toLowerCase()} at ${Math.round(LOCAL_DISCOUNT * 100)}% of the market price`, cost: Math.max(1, Math.round(q.buy * n * LOCAL_DISCOUNT)) };
}
/** Take the town's offer: what came of it, or '' if it couldn't be done. */
export function takeLocal(g: Game, pid: number): string {
  const o = localOffer(g, pid), s = g.s, c = s.caravan, p = g.a.places[pid];
  if (!o || c.orrels < o.cost) return '';
  const t = tradesOf(g.w, g.a, p)[0];
  let text = '';
  if (t === 'fishing') {
    // The coast both ways: land hexes on the water within a few days' sail.
    const coast = ringCells(g.w, p.cell, 6).filter((x) => g.w.water[x] === 0 && g.w.grid.neighbors[x].some((n) => g.w.water[n] === 1));
    passDays(g, 1, false);
    text = `A day at sea in a fishing boat. You draw ${reveal(g, coast, true)} hexes of coast.`;
  } else if (t === 'market') {
    const near = g.a.places.filter((x) => x.id !== pid && !s.known[x.id]).map((x) => ({ x, d: angle(g.w, x.cell, p.cell) })).sort((a, b) => a.d - b.d).slice(0, 2);
    for (const { x } of near) remember(s.known, x, quotes(g.w, x, s.stocks, s.day, doyOf(s.day)), Math.floor(s.day));
    text = near.length ? `Carters from every road, all talking. You learn what things fetch in ${near.map(({ x }) => x.name).join(' and ')}.` : 'You know every market they talk about.';
  } else if (t === 'shrine') {
    c.morale = Math.min(100, c.morale + 15);
    for (const m of living(c)) if (m.health !== 'well') m.health = 'well';
    text = 'The keepers of the shrine bless the carts and tend the hurt. Everyone stands a little straighter.';
  } else {
    const gi = TRADES[t].good!, n = LOCAL_GOODS[t]![1];
    if (cargoUsed(c) + n > c.capacity) return '';
    c.cargo[gi] += n; c.basis[gi] += o.cost;
    text = `${n} ${GOODS[gi].name.toLowerCase()}, straight from where it's made.`;
  }
  c.orrels -= o.cost;
  s.finds[localKey(g, pid)] = s.day;
  log(g, `${p.name}: ${text}`);
  return text;
}
export const BEAST_COST = 45;
export function buyBeast(g: Game): boolean {
  const c = g.s.caravan;
  if (c.orrels < BEAST_COST) return false;
  c.orrels -= BEAST_COST; c.capacity += 4;
  return true;
}
/** Someone new leads (the leader is dead). */
export function appoint(g: Game, i: number) {
  const c = g.s.caravan, m = c.members[i];
  for (const x of c.members) if (x.alive && x.role === 'leader') x.role = 'hand';
  m.role = 'leader';
  log(g, `${m.name} leads the caravan now.`);
}
