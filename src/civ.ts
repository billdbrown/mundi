/**
 * Centuries: a 2,000-year history for a world, simulated up front from its seed.
 *
 * A few peoples settle the best sites; settlements grow toward what their land can feed, send
 * out colonies along cheap routes (by sea too, once they learn to sail), build roads, clear
 * farmland around themselves, and sometimes break away into realms of their own. Famines set
 * them back. Everything is recorded with the year it happened, so the view can show any moment
 * by comparing those years with the current one: playing and scrubbing cost nothing.
 *
 * Pure and deterministic (seeded), so it can be tested and could move to the worker.
 */
import { B } from './biomes.ts';
import { baseOf } from './ecology.ts';
import { WATER_LAND, WATER_LAKE, WATER_OCEAN, type World } from './world.ts';
import { FARMLAND, nameMaker, type GameData } from './gamedata.ts';
import { makeRng } from './rng.ts';

export const HISTORY_YEARS = 2000;
const STEP = 10;
const TICKS = HISTORY_YEARS / STEP + 1;
/** The year sailing begins: colonies may then cross the sea from coastal settlements. */
const SAIL_YEAR = 550;

export interface Settlement {
  id: number;
  cell: number;
  name: string;
  founded: number;
  parent: number;
  /** Population at each tick (every STEP years, from year 0); 0 before founding. */
  pop: Float32Array;
  /** Realm at each tick (−1 before founding). */
  realm: Int16Array;
}
export interface Road { cells: number[]; year: number; years: number }
export interface Realm { id: number; name: string; color: number; founded: number; capital: number }
export interface HistoryEvent { year: number; text: string; cell: number }

export interface History {
  years: number;
  step: number;
  settlements: Settlement[];
  roads: Road[];
  realms: Realm[];
  events: HistoryEvent[];
  /** Realm owning each cell at each century (index = century, 0..20), −1 for nobody. */
  territory: Int16Array[];
}

/** Population at a year, interpolated between ticks. */
export function popAt(s: Settlement, year: number): number {
  const t = Math.max(0, Math.min(TICKS - 1, year / STEP)), i = Math.floor(t), f = t - i;
  return i + 1 < TICKS ? s.pop[i] * (1 - f) + s.pop[i + 1] * f : s.pop[i];
}
export function realmAt(s: Settlement, year: number): number {
  return s.realm[Math.max(0, Math.min(TICKS - 1, Math.floor(year / STEP)))];
}

/** Farmland radius (in cells) for a population, and the built-up radius. */
export const farmRadius = (pop: number) => Math.sqrt(pop) / 30;
export const urbanRadius = (pop: number) => Math.sqrt(pop) / 70;

const REALM_COLOURS = [0xe0b04a, 0xd2643c, 0x5aa0d8, 0x9a6ad0, 0x5cc08a, 0xd85a8c, 0xc8c850, 0x50c0c0, 0xe08a4a, 0x8a9ae0];

export function simulateHistory(w: World, gd: GameData): History {
  const g = w.grid, N = g.count, nb = g.neighbors;
  const rng = makeRng(w.params.seed * 4241 + 7);
  const names = nameMaker(w.params.seed * 31 + 0xc1);
  const score = gd.score;

  // Movement cost per cell: flat land is cheap, hills and forest dearer, mountains dearest.
  const cost = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    if (w.water[c] === WATER_OCEAN) { cost[c] = Infinity; continue; }
    if (w.water[c] === WATER_LAKE) { cost[c] = 2.5; continue; }
    const b = baseOf(w.biome[c]);
    cost[c] = 1 + Math.max(0, w.elevation[c] - 0.25) * 4 + (b === B.MOUNTAIN || b === B.PEAK || b === B.ICE ? 3 : 0)
      + (b === B.RAINFOREST || b === B.TAIGA ? 0.5 : 0);
  }
  const coastal = (c: number) => nb[c].some((n) => w.water[n] === WATER_OCEAN);

  const distBuf = new Float64Array(N), prevBuf = new Int32Array(N), stampBuf = new Int32Array(N);
  let stampNow = 0;
  /** Dijkstra from a cell out to a cost limit. With `sail`, ocean steps cost 0.35 each. */
  const reach = (from: number, limit: number, sail: boolean) => {
    // Shared buffers, reset by bumping a stamp rather than clearing; results are valid until the
    // next call (callers that keep one copy it).
    const cur = ++stampNow;
    const seen = (c: number) => stampBuf[c] === cur;
    const cells = [from];
    stampBuf[from] = cur; distBuf[from] = 0; prevBuf[from] = -1;
    const dist = {
      get: (c: number) => (seen(c) ? distBuf[c] : undefined),
      has: seen,
      cells,
    };
    const prev = { get: (c: number) => (seen(c) && prevBuf[c] >= 0 ? prevBuf[c] : undefined) };
    // Binary heap of (distance, cell).
    const hd: number[] = [0], hc: number[] = [from];
    const push = (d: number, c: number) => {
      let i = hd.length; hd.push(d); hc.push(c);
      while (i > 0) { const p = (i - 1) >> 1; if (hd[p] <= d) break; hd[i] = hd[p]; hc[i] = hc[p]; i = p; }
      hd[i] = d; hc[i] = c;
    };
    const pop = () => {
      const d = hd[0], c = hc[0], ld = hd.pop()!, lc = hc.pop()!;
      if (hd.length) {
        let i = 0;
        for (;;) {
          const l = 2 * i + 1, r = l + 1;
          let m = i, md = ld;
          if (l < hd.length && hd[l] < md) { m = l; md = hd[l]; }
          if (r < hd.length && hd[r] < md) { m = r; md = hd[r]; }
          if (m === i) break;
          hd[i] = hd[m]; hc[i] = hc[m]; i = m;
        }
        hd[i] = ld; hc[i] = lc;
      }
      return [d, c];
    };
    while (hd.length) {
      const [d, c] = pop();
      if (d > distBuf[c]) continue;
      for (const n of nb[c]) {
        const step = w.water[n] === WATER_OCEAN ? (sail ? 0.35 : Infinity) : cost[n];
        const nd = d + step;
        if (nd > limit || (seen(n) && nd >= distBuf[n])) continue;
        if (!seen(n)) { stampBuf[n] = cur; cells.push(n); }
        distBuf[n] = nd; prevBuf[n] = c;
        push(nd, n);
      }
    }
    return { dist, prev };
  };
  const pathTo = (prev: { get(c: number): number | undefined }, from: number, to: number) => {
    const p = [to];
    while (p[p.length - 1] !== from) {
      const q = prev.get(p[p.length - 1]);
      if (q === undefined) break;
      p.push(q);
    }
    return p.reverse();
  };

  const settlements: Settlement[] = [];
  const realms: Realm[] = [];
  const roads: Road[] = [];
  const events: HistoryEvent[] = [];
  const taken = new Uint8Array(N);                    // cells too close to an existing settlement
  const cap = (c: number) => 400 + 2600 * Math.max(0.2, score[c]);
  const continentName = (c: number) => {
    const k = gd.continent[c];
    return k >= 0 ? gd.continents[k].name : 'the sea';
  };
  const blockAround = (c: number, r: number) => {
    let ring = [c]; taken[c] = 1;
    for (let d = 0; d < r; d++) {
      const next: number[] = [];
      for (const x of ring) for (const n of nb[x]) if (!taken[n]) { taken[n] = 1; next.push(n); }
      ring = next;
    }
  };
  const found = (cell: number, year: number, parent: number, realm: number) => {
    const s: Settlement = {
      id: settlements.length, cell, name: names(), founded: year, parent,
      pop: new Float32Array(TICKS), realm: new Int16Array(TICKS).fill(-1),
    };
    settlements.push(s);
    blockAround(cell, 3);
    return s;
  };
  const newRealm = (year: number, capital: Settlement) => {
    const r: Realm = { id: realms.length, name: names(), color: REALM_COLOURS[realms.length % REALM_COLOURS.length], founded: year, capital: capital.id };
    realms.push(r);
    return r;
  };

  // Hearths: the best site on each of the biggest continents, founded a few generations apart.
  const hearths: number[] = [];
  for (const site of gd.sites) {
    const k = gd.continent[site.cell];
    if (hearths.some((h) => gd.continent[h] === k)) continue;
    if (gd.continents[k].cells < 40) continue;
    hearths.push(site.cell);
    if (hearths.length >= 3) break;
  }
  if (!hearths.length && gd.sites.length) hearths.push(gd.sites[0].cell);
  const hearthYear = hearths.map((_, i) => i * 70);

  // State per settlement while simulating.
  const lastColony: number[] = [];
  const grade: number[] = [];                         // 0 village, 1 town, 2 city
  const famineAt = new Set<number>();
  const lastSplit = new Map<number, number>();
  const linked = new Set<number>(), tradeCount = new Map<number, number>();
  let lastRoadNews = -1;
  for (let y = 300; y < HISTORY_YEARS; y += 250 + Math.floor(rng() * 300)) famineAt.add(Math.round(y / STEP) * STEP);

  for (let t = 0; t < TICKS; t++) {
    const year = t * STEP;
    // Founding peoples.
    hearths.forEach((cell, i) => {
      if (hearthYear[i] !== year) return;
      const s = found(cell, year, -1, -1);
      const r = newRealm(year, s);
      s.realm[t] = r.id;
      s.pop[t] = 120;
      lastColony.push(year); grade.push(0);
      events.push({ year, cell, text: `A people settles ${s.name}, on ${continentName(cell)}. The realm of ${r.name} begins.` });
    });

    for (const s of settlements) {
      if (s.founded > year) continue;
      const i = s.id;
      if (t > 0 && s.founded < year) {
        // Grow toward what the land can feed.
        const p = s.pop[t - 1], k = cap(s.cell);
        s.pop[t] = p + 0.16 * p * (1 - p / k);
        if (s.realm[t] < 0) s.realm[t] = s.realm[t - 1];
      }
      // Grades.
      if (grade[i] < 1 && s.pop[t] > 1000) {
        grade[i] = 1;
        events.push({ year, cell: s.cell, text: `${s.name} grows into a market town.` });
      } else if (grade[i] < 2 && s.pop[t] > 2400) {
        grade[i] = 2;
        const first = !settlements.some((o) => o !== s && grade[o.id] === 2 && o.realm[t] === s.realm[t]);
        events.push({ year, cell: s.cell, text: first ? `${s.name} becomes the first city of ${realms[s.realm[t]].name}.` : `${s.name} becomes a city.` });
      }
    }

    // Famine: a realm loses a third of its people.
    if (famineAt.has(year) && realms.length) {
      const live = realms.filter((r) => settlements.some((s) => s.founded <= year && s.realm[t] === r.id));
      if (live.length) {
        const r = live[Math.floor(rng() * live.length)];
        for (const s of settlements) if (s.founded < year && s.realm[t] === r.id) s.pop[t] *= 0.66;
        const kind = rng() < 0.5 ? 'A famine' : 'A plague';
        events.push({ year, cell: settlements[r.capital].cell, text: `${kind} sweeps through ${r.name}.` });
      }
    }

    // Colonies: a settlement near its limit sends people to the best free land it can reach.
    const n0 = settlements.length;
    for (let i = 0; i < n0; i++) {
      const s = settlements[i];
      if (s.founded >= year || year - lastColony[i] < 60 || s.pop[t] < 0.45 * cap(s.cell)) continue;
      if (rng() > 0.4) continue;
      const sail = year >= SAIL_YEAR && coastal(s.cell);
      const { dist, prev } = reach(s.cell, 7 + Math.sqrt(s.pop[t]) / 10, sail);
      let best = -1, bv = 0.6;
      for (const c of dist.cells) {
        const d = dist.get(c)!;
        if (taken[c] || w.water[c] !== WATER_LAND || score[c] <= 0) continue;
        // Landing from the sea needs a coast.
        const v = score[c] - d * 0.06 + rng() * 0.15;
        if (v > bv) { bv = v; best = c; }
      }
      if (best < 0) continue;
      lastColony[i] = year;
      const path = pathTo(prev, s.cell, best);
      const child = found(best, year, s.id, s.realm[t]);
      child.realm[t] = s.realm[t];
      child.pop[t] = 40;
      lastColony.push(year); grade.push(0);
      const overSea = path.some((c) => w.water[c] === WATER_OCEAN);
      const newLand = gd.continent[best] !== gd.continent[s.cell];
      if (newLand && overSea) {
        events.push({ year, cell: best, text: `Ships from ${s.name} reach ${continentName(best)}, and found ${child.name}.` });
      } else {
        const how = ['Settlers from ${a} found ${b}.', 'Families from ${a} clear land and found ${b}.', '${a} sends people out to found ${b}.', 'A new village, ${b}, is founded from ${a}.'][Math.floor(rng() * 4)];
        events.push({ year, cell: best, text: how.replace('${a}', s.name).replace('${b}', child.name) });
      }
      // A road along the land part of the route (none across water).
      let run: number[] = [];
      const flush = () => { if (run.length > 1) roads.push({ cells: run, year, years: 20 + run.length * 6 }); run = []; };
      for (const c of path) { if (w.water[c] === WATER_OCEAN || w.water[c] === WATER_LAKE) flush(); else run.push(c); }
      flush();
    }

    // Independence: a big settlement far from its capital breaks away, taking its daughters.
    if (year >= 400 && year % 50 === 0) {
      const fromCapital = new Map<number, Map<number, number>>();
      const split = new Set<number>();
      for (const s of settlements) {
        const r = s.realm[t];
        if (r < 0 || split.has(r) || s.founded > year - 150 || realms[r].capital === s.id || s.pop[t] < 900) continue;
        // Only sizeable realms fracture, and not again for a few centuries.
        if (year - (lastSplit.get(r) ?? realms[r].founded) < 300) continue;
        if (settlements.filter((o) => o.founded <= year && o.realm[t] === r).length < 8) continue;
        if (!fromCapital.has(r)) {
          const rd = reach(settlements[realms[r].capital].cell, 30, true).dist;
          fromCapital.set(r, new Map(rd.cells.map((c) => [c, rd.get(c)!])));
        }
        const d = fromCapital.get(r)!.get(s.cell) ?? Infinity;
        if (d < 12 || rng() > 0.3) continue;
        split.add(r);
        lastSplit.set(r, year);
        const nr = newRealm(year, s);
        const moved = new Set([s.id]);
        for (const o of settlements) if (o.founded <= year && o.realm[t] === r && moved.has(o.parent)) moved.add(o.id);
        for (const id of moved) settlements[id].realm[t] = nr.id;
        events.push({ year, cell: s.cell, text: `${s.name} breaks from ${realms[r].name}: the realm of ${nr.name} is born.` });
      }
    }

    // Trade roads between neighbouring towns, once both have grown: each town to its nearest
    // few, each pair once.
    if (year % 100 === 0) {
      const towns = settlements.filter((s) => s.founded < year && s.pop[t] > 900);
      for (const a of towns) {
        if ((tradeCount.get(a.id) ?? 0) >= 3) continue;
        const { dist, prev } = reach(a.cell, 10, false);
        const near = towns.filter((b) => b.id !== a.id && dist.has(b.cell)).sort((x, y) => dist.get(x.cell)! - dist.get(y.cell)!);
        for (const b of near) {
          const key = Math.min(a.id, b.id) * 100000 + Math.max(a.id, b.id);
          if (linked.has(key) || (tradeCount.get(a.id) ?? 0) >= 3 || (tradeCount.get(b.id) ?? 0) >= 3) continue;
          linked.add(key);
          tradeCount.set(a.id, (tradeCount.get(a.id) ?? 0) + 1);
          tradeCount.set(b.id, (tradeCount.get(b.id) ?? 0) + 1);
          const cells = pathTo(prev, a.cell, b.cell);
          if (cells.some((c) => w.water[c] !== WATER_LAND)) continue;
          roads.push({ cells, year, years: 30 + cells.length * 5 });
          // Only the great roads, between cities, make the chronicle (one a century at most).
          if (a.pop[t] > 2000 && b.pop[t] > 2000 && lastRoadNews !== year) {
            lastRoadNews = year;
            events.push({ year, cell: a.cell, text: `A great road is built between ${a.name} and ${b.name}.` });
          }
        }
      }
    }
  }

  // Territory each century: every land cell within reach of a settlement belongs to the realm of
  // the nearest one; reach grows with population.
  const territory: Int16Array[] = [];
  for (let century = 0; century <= HISTORY_YEARS / 100; century++) {
    const year = century * 100, t = year / STEP;
    const own = new Int16Array(N).fill(-1), best = new Float32Array(N).fill(Infinity);
    for (const s of settlements) {
      if (s.founded > year) continue;
      const lim = 2.5 + Math.sqrt(s.pop[t]) / 9;
      const { dist } = reach(s.cell, lim, false);
      for (const c of dist.cells) {
        const d = dist.get(c)!;
        if (w.water[c] !== WATER_LAND) continue;
        const v = d - Math.sqrt(s.pop[t]) / 30;          // bigger places pull the border outward
        if (v < best[c]) { best[c] = v; own[c] = s.realm[t]; }
      }
    }
    territory.push(own);
  }

  events.sort((a, b) => a.year - b.year);
  return { years: HISTORY_YEARS, step: STEP, settlements, roads, realms, events, territory };
}

/** Whether a cell can be farmed (for drawing fields). */
export function arable(w: World, c: number): boolean {
  if (w.water[c] !== WATER_LAND) return false;
  return (FARMLAND[baseOf(w.biome[c])] ?? 0) >= 0.3 && w.temperature[c] > 0.25;
}
