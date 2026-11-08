import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, DEFAULT_PARAMS, WATER_LAND } from '../src/world.ts';
import { gameData } from '../src/gamedata.ts';
import { pickStart, harshness } from '../src/primundi/start.ts';

const w = generateWorld({ ...DEFAULT_PARAMS, detail: 30, seed: 77 });
const gd = gameData(w);

test('a start is on habitable land and the same every time for the same seed', () => {
  for (const bias of ['gentle', 'harsh', 'inhospitable', 'any'] as const) {
    const a = pickStart(w, gd, bias, 1234), b = pickStart(w, gd, bias, 1234);
    assert.equal(a, b);
    assert.equal(w.water[a], WATER_LAND);
    assert.ok(gd.score[a] > 0.5);
  }
});

test('starts vary with the seed, and not only among the best sites', () => {
  const seen = new Set<number>();
  for (let s = 0; s < 40; s++) seen.add(pickStart(w, gd, 'any', s));
  assert.ok(seen.size > 15, `only ${seen.size} different starts`);
  const best = new Set(gd.sites.map((x) => x.cell));
  assert.ok([...seen].some((c) => !best.has(c)));
});

test('harsh starts are harsher than gentle ones', () => {
  let g = 0, h = 0;
  for (let s = 0; s < 30; s++) { g += harshness(w, pickStart(w, gd, 'gentle', s)); h += harshness(w, pickStart(w, gd, 'harsh', s)); }
  assert.ok(h > g + 0.3 * 30 / 30, `gentle ${g / 30}, harsh ${h / 30}`);
});

// --- The caravan game (atlas, market, caravan, encounters) ------------------------------------
import { simulateHistory } from '../src/civ.ts';
import { buildAtlas, findPath, stepDays, terrainCost, GOODS, G } from '../src/primundi/atlas.ts';
import { quotes, trade, stockAt } from '../src/primundi/market.ts';
import { newCaravan, passDay, living, strength } from '../src/primundi/caravan.ts';
import { ENCOUNTERS, applyEffect, contextAt } from '../src/primundi/encounters.ts';
import { pickHome } from '../src/primundi/start.ts';
import { makeRng } from '../src/rng.ts';

const hw = generateWorld({ ...DEFAULT_PARAMS, detail: 40, seed: 5 });
const hgd = gameData(hw);
const hist = simulateHistory(hw, hgd);
const atlas = buildAtlas(hw, hgd, hist);

test('the atlas has places on land, and fewer road hexes than the history built', () => {
  assert.ok(atlas.places.length > 20);
  for (const p of atlas.places) { assert.equal(hw.water[p.cell], WATER_LAND); assert.equal(atlas.placeAt[p.cell], p.id); }
  const old = new Set(hist.roads.flatMap((r) => r.cells)).size;
  const now = atlas.road.reduce((a, b) => a + b, 0);
  assert.ok(now > 0 && now < old, `backbone ${now} vs history ${old}`);
});

test('prices differ from place to place (there is something to trade)', () => {
  for (const g of [G.grain, G.fish, G.furs, G.tools]) {
    const ps = atlas.places.map((p) => p.price[g]);
    assert.ok(Math.max(...ps) / Math.min(...ps) > 1.8, `${GOODS[g].id} spread too flat`);
  }
});

test('buying raises the price, and a stock settles back with time', () => {
  const p = atlas.places[0], stocks = {};
  const before = quotes(hw, p, stocks, 0, 100)[G.grain].buy;
  trade(hw, p, stocks, 0, 100, G.grain, 8);
  const after = quotes(hw, p, stocks, 0, 100)[G.grain].buy;
  assert.ok(after >= before, `${before} -> ${after}`);
  const st0 = stockAt(p, stocks, 0)[G.grain], st60 = stockAt(p, stocks, 60)[G.grain];
  assert.ok(Math.abs(st60 - p.stock[G.grain]) < Math.abs(st0 - p.stock[G.grain]) * 0.1);
  // Selling what you just bought loses money: the spread.
  const paid = trade(hw, p, {}, 0, 100, G.tools, 3), got = trade(hw, p, {}, 0, 100, G.tools, -3);
  assert.ok(-got < paid);
});

test('a path between two places walks land, and roads make it quicker', () => {
  const [a, b] = atlas.places.filter((p) => hgd.continent[p.cell] === hgd.continent[atlas.places[0].cell]).slice(0, 2);
  const path = findPath(hw, a.cell, b.cell, (x, y) => stepDays(hw, atlas, x, y, 100), () => true);
  assert.ok(path && path[0] === a.cell && path[path.length - 1] === b.cell);
  for (const c of path!) assert.equal(hw.water[c], WATER_LAND);
  const [x, y] = atlas.roadEdges[0];
  assert.ok(stepDays(hw, atlas, x, y, 100) <= terrainCost(hw, x, y) * 0.5 * 1.5 + 1e-9);
});

test('a hometown is a real place, and the same for the same seed', () => {
  for (const bias of ['gentle', 'harsh', 'inhospitable', 'any'] as const) {
    const id = pickHome(hw, atlas.places, bias, 99);
    assert.equal(id, pickHome(hw, atlas.places, bias, 99));
    assert.ok(atlas.places[id]);
  }
});

test('running out of supplies hurts morale, but kills nobody', () => {
  const c = newCaravan('Test', 'traders', 1);
  c.rations = 0; c.water = 0;
  for (let d = 0; d < 60; d++) passDay(c, false, false);
  assert.equal(living(c).length, c.members.length);
  assert.ok(c.morale < 20);
});

test('every choice of every encounter resolves, in many places', () => {
  const rng = makeRng(3);
  let n = 0;
  for (let i = 0; i < 40; i++) {
    const cell = atlas.places[i % atlas.places.length].cell;
    for (const e of ENCOUNTERS) {
      const choices = e.choices(contextAt(hw, cell, i % 2 === 0, i % 3 === 0, i % 5 === 0, newCaravan('T', i % 2 ? 'traders' : 'cartographers', i), rng, () => 'Name'));
      for (let k = 0; k < choices.length; k++) {
        const c = newCaravan('T', 'traders', i);
        const ctx = contextAt(hw, cell, false, false, false, c, rng, () => 'Name');
        assert.ok(e.text(ctx).length > 10);
        const out = e.choices(ctx)[k].resolve(ctx);
        assert.ok(out.text.length > 5);
        applyEffect(c, out.effect, () => 'Name', 0);
        assert.ok(c.orrels >= 0 && c.rations >= 0 && c.water >= 0 && c.cargo.every((x) => x >= 0));
        n++;
      }
    }
  }
  assert.ok(n > 500);
  assert.ok(strength(newCaravan('T', 'traders', 1)) > strength(newCaravan('T', 'cartographers', 1)));
});

test('roads keep a hex back from the sea, except where they start or end at a coastal place', () => {
  let shore = 0, total = 0;
  for (let c = 0; c < hw.grid.count; c++) {
    if (!atlas.road[c] || atlas.placeAt[c] >= 0) continue;
    total++;
    if (hw.grid.neighbors[c].some((n) => hw.water[n] === 1)) shore++;
  }
  assert.ok(total > 0 && shore / total < 0.05, `${shore} of ${total} road hexes on the shore`);
});

import { offersAt, canHandIn, questTarget, questTitle } from '../src/primundi/quests.ts';
test('notice boards: stable within a month, varied in kind, every job pointing somewhere real', () => {
  const kinds = new Set<string>();
  const none = new Set<number>();
  for (const p of atlas.places.slice(0, 40)) {
    const a = offersAt(hw, atlas, hgd.continent, p, 3, 9, none, (pl, g) => pl.price[g]);
    const b = offersAt(hw, atlas, hgd.continent, p, 3, 9, none, (pl, g) => pl.price[g]);
    assert.deepEqual(a, b);
    for (const q of a) {
      kinds.add(q.kind);
      assert.ok(q.reward > 0 && questTitle(q, atlas).length > 5);
      const t = questTarget(q, atlas);
      assert.ok(t >= 0 && t < hw.grid.count && hw.water[t] === WATER_LAND);
    }
  }
  assert.ok(kinds.size >= 4, [...kinds].join(','));
});

test('a job is handed in where it should be, and only when it is done', () => {
  const cargo = GOODS.map(() => 0);
  assert.ok(canHandIn({ id: 'a', kind: 'deliver', giver: 'X', from: 0, to: 2, reward: 1, taken: 0 }, 2, cargo));
  assert.ok(!canHandIn({ id: 'b', kind: 'procure', giver: 'X', from: 0, good: G.salt, qty: 3, reward: 1, taken: 0 }, 0, cargo));
  cargo[G.salt] = 3;
  assert.ok(canHandIn({ id: 'b', kind: 'procure', giver: 'X', from: 0, good: G.salt, qty: 3, reward: 1, taken: 0 }, 0, cargo));
  assert.ok(!canHandIn({ id: 'c', kind: 'bounty', giver: 'X', from: 0, cell: 5, reward: 1, taken: 0 }, 0, cargo));
  assert.ok(canHandIn({ id: 'c', kind: 'bounty', giver: 'X', from: 0, cell: 5, reward: 1, taken: 0, done: true }, 0, cargo));
});

import { harshness as hardness } from '../src/primundi/start.ts';
test('hometowns get harder from gentle to harsh to inhospitable', () => {
  const avg = (b: 'gentle' | 'harsh' | 'inhospitable') => { let t = 0; for (let k = 0; k < 20; k++) t += hardness(hw, atlas.places[pickHome(hw, atlas.places, b, k)].cell); return t / 20; };
  const g = avg('gentle'), h = avg('harsh'), i = avg('inhospitable');
  assert.ok(g < h && h < i, `gentle ${g.toFixed(2)}, harsh ${h.toFixed(2)}, inhospitable ${i.toFixed(2)}`);
});

import { Nav } from '../src/primundi/hexcaravan.ts';
test('in the hex, the caravan walks round houses and the sea, keeping to a street where there is one', () => {
  // A square of land 200 m across: the sea to the west (x < -60), a house in the middle, a street
  // along y = 30.
  const hex = Float32Array.of(-100, -100, 100, -100, 100, 100, -100, 100);
  const houses = new Float32Array(10);
  houses.set([0, 0, 1, 0, 30, 30, 4, 0.5, 0, 1]);
  const nav = new Nav({
    houses, props: new Float32Array(0), K: 1, hex,
    inside: (x, y) => Math.abs(x) <= 100 && Math.abs(y) <= 100,
    ground: () => 1,
    water: (x) => (x < -60 ? 2 : 0),
    path: (_x, y) => (Math.abs(y - 30) < 4 ? 1 : 0),
    wood: () => 0,
  });
  assert.ok(!nav.ok(0, 0), 'the house is solid');
  assert.ok(!nav.ok(-80, 0), 'the sea is not walkable');
  const p = nav.find(-40, 0, 40, 0)!;
  assert.ok(p && p.length > 2, 'a way round');
  const along = (f: (x: number, y: number) => boolean) => {
    for (let k = 1; k < p.length; k++) for (let s = 0; s <= 20; s++) {
      const x = p[k - 1][0] + (p[k][0] - p[k - 1][0]) * s / 20, y = p[k - 1][1] + (p[k][1] - p[k - 1][1]) * s / 20;
      if (f(x, y)) return true;
    }
    return false;
  };
  assert.ok(!along((x, y) => Math.abs(x) < 15 && Math.abs(y) < 15), 'not through the house');
  assert.ok(!along((x) => x < -60), 'not into the sea');
  // Tapping the sea: as near as can be stood on.
  const q = nav.find(0, 60, -90, 60)!;
  assert.ok(q[q.length - 1][0] >= -62, 'stops at the shore');
});

import { findsIn, findReady, FINDS, type FindKind } from '../src/primundi/finds.ts';
test('finds in a hex are the same every time, never ruins in a town, and some hexes have each kind', () => {
  const seen = new Set<FindKind>();
  for (let c = 0; c < hw.grid.count; c++) {
    const f = findsIn(hw, atlas, c, 99);
    assert.deepEqual(f, findsIn(hw, atlas, c, 99));
    if (atlas.placeAt[c] >= 0) assert.ok(!f.includes('ruin') && !f.includes('camp'));
    if (hw.water[c] !== WATER_LAND) assert.equal(f.length, 0);
    for (const k of f) seen.add(k);
  }
  for (const k of ['lookout', 'spring', 'forage', 'ruin', 'camp'] as const) assert.ok(seen.has(k), k);
  // A spring fills again; a lookout is once only.
  assert.ok(findReady('spring', undefined, 3) && !findReady('spring', 1, 3) && findReady('spring', 1, 6));
  assert.ok(!findReady('lookout', 0, 400));
  for (const k of Object.keys(FINDS) as FindKind[]) assert.ok(FINDS[k].title);
});

// --- The rules without the screen (sim.ts): what the game and the playtest bot both run. ---------
import { makeGame, newGame as simNewGame, setRoute, advance as simAdvance, buy as simBuy, sell as simSell, buyRations, resolve, type Ui, type Pending } from '../src/primundi/sim.ts';

/** A screen that shows nothing: encounters are answered with their first choice at once. */
function quietUi(): Ui & { queue: Pending[]; arrivals: number } {
  const u = {
    queue: [] as Pending[], arrivals: 0,
    toast() {}, revealed() {}, blocked: () => false, halt() {}, changed() {}, routeChanged() {}, jobsChanged() {},
    encounter(e: Pending['e'], ctx: Pending['ctx'], quest?: string) { u.queue.push({ e, ctx, choices: e.choices(ctx), quest }); },
    arrive() { u.arrivals++; }, questHex() {}, findUsed() {}, jobDone() {}, folk() {}, folkMet() {},
  };
  return u;
}
function playHeadless(seed: number) {
  const ui = quietUi();
  const s = simNewGame(hw, atlas, seed, { name: 'Test', origin: 'traders', bias: 'gentle', world: 'test' });
  const dice = makeRng(seed * 3 + 1);
  const g = makeGame(hw, atlas, hgd, seed, s, ui, dice);
  const home = atlas.places[s.home];
  // Buy the cheapest good at home, take it to the nearest other place, sell, come back; four times.
  const others = atlas.places.filter((p) => p.id !== home.id && findPath(hw, home.cell, p.cell, (a, b) => stepDays(hw, atlas, a, b, 100), () => true))
    .sort((p, q) => Math.hypot(...[0, 1, 2].map((k) => hw.grid.centers[p.cell * 3 + k] - hw.grid.centers[home.cell * 3 + k])) - Math.hypot(...[0, 1, 2].map((k) => hw.grid.centers[q.cell * 3 + k] - hw.grid.centers[home.cell * 3 + k])));
  const away = others[0];
  for (let trip = 0; trip < 4; trip++) {
    for (const [from, to] of [[home, away], [away, home]]) {
      if (s.cell !== from.cell) break;
      const q = quotes(hw, from, s.stocks, s.day, 100);
      const gi = q.map((x, i) => [x.buy || Infinity, i]).sort((a, b) => a[0] - b[0])[0][1];
      simBuy(g, from.id, gi, 5);
      buyRations(g, from.id, 10);
      setRoute(g, to.cell);
      for (let t = 0; t < 400 && s.route.length; t++) {
        simAdvance(g, 0.25);
        while (ui.queue.length) resolve(g, ui.queue.shift()!, 0);
      }
      for (let k = 0; k < s.caravan.cargo.length; k++) simSell(g, to.id, k, 99);
    }
  }
  // (advance takes at most 64 steps a call: a day at a time.)
  while (s.day < 120 - 1e-6) { simAdvance(g, Math.min(1, 120 - s.day)); while (ui.queue.length) resolve(g, ui.queue.shift()!, 0); }
  return { s, ui };
}
test('the rules run headless: the same seed plays the same, and a trader gets there and back', () => {
  const a = playHeadless(11), b = playHeadless(11);
  assert.equal(JSON.stringify(a.s), JSON.stringify(b.s));
  assert.ok(a.ui.arrivals >= 2, `arrived ${a.ui.arrivals} times`);
  assert.ok(a.s.day >= 120 - 1e-6);
  assert.ok(a.s.caravan.earned !== 0, 'traded');
});

import { shortHere, buy as simBuy2 } from '../src/primundi/sim.ts';
test('a supply job cannot be done with goods bought on the spot: the market has none of what its board wants', () => {
  const ui = quietUi();
  let found = 0;
  for (let pid = 0; pid < atlas.places.length && found < 5; pid++) {
    const s = simNewGame(hw, atlas, 3, { name: 'T', origin: 'traders', bias: 'gentle', world: 't' });
    s.cell = atlas.places[pid].cell;
    const g = makeGame(hw, atlas, hgd, 3, s, ui, makeRng(1));
    const short = shortHere(g, pid);
    if (!short.size) continue;
    found++;
    for (const gi of short) assert.equal(simBuy2(g, pid, gi, 3), 0, `bought wanted good ${gi} at ${atlas.places[pid].name}`);
    // Anything else still sells.
    const other = [0, 1, 2, 3, 4, 5].find((gi) => !short.has(gi))!;
    assert.ok(simBuy2(g, pid, other, 1) > 0);
  }
  assert.ok(found > 0, 'some board wants something');
});

// --- The playtest's tripwire: the economy hasn't come apart. -------------------------------------
import { playRun } from '../scripts/playtest/run.ts';
test('playtest tripwire: a trader bot makes a living in a year, an idle one nothing, and nobody starves', () => {
  const t = playRun({ world: 'zalund', origin: 'traders', bias: 'gentle', bot: 'trader', run: 0, years: 1 });
  const earned = t.days[t.days.length - 1].earned;
  // Wide on purpose (the baseline was about 1,500 on this world): it catches the economy breaking, not tuning.
  assert.ok(earned > 300 && earned < 20000, `trader earned ${Math.round(earned)} in a year`);
  assert.ok(t.trips > 10, `${t.trips} trips`);
  const idle = playRun({ world: 'zalund', origin: 'traders', bias: 'gentle', bot: 'idle', run: 0, years: 1 });
  assert.equal(Math.round(idle.days[idle.days.length - 1].earned), 0);
  for (const r of [t, idle]) assert.equal(r.deaths.filter((d) => d.cause === 'supplies').length, 0);
});

import { folkIn, FOLK_P } from '../src/primundi/life.ts';
test('others on the road: the same for a hex and a week, never in towns or water, mostly on roads', () => {
  let road = 0, roadHit = 0, wild = 0, wildHit = 0, changed = 0;
  for (let c = 0; c < hw.grid.count; c++) {
    const a = folkIn(hw, atlas, c, 10, 5);
    assert.deepEqual(folkIn(hw, atlas, c, 12, 5), a, 'same within the week');
    if (hw.water[c] !== WATER_LAND || atlas.placeAt[c] >= 0) { assert.equal(a.length, 0); continue; }
    if (atlas.road[c]) { road++; if (a.length) roadHit++; } else { wild++; if (a.length) wildHit++; }
    if (JSON.stringify(folkIn(hw, atlas, c, 40, 5)) !== JSON.stringify(a)) changed++;
    for (const f of a) assert.ok(atlas.places[f.from] && f.name.length > 1);
  }
  assert.ok(road > 50, `${road} road hexes`);
  const rr = roadHit / road;
  assert.ok(Math.abs(rr - FOLK_P.road) < 0.04, `road rate ${rr.toFixed(3)}`);
  assert.ok(wildHit / wild < rr, 'fewer off the road');
  assert.ok(changed > 0, 'a new week, new faces');
});

import { gameIn, gameReady, GAME_RETURNS } from '../src/primundi/life.ts';
import { findsIn as findsIn2 } from '../src/primundi/finds.ts';
test('game you can see: only where there is foraging, never in a town, back a while after a hunt', () => {
  const kinds = new Set<string>();
  let with_ = 0;
  for (let c = 0; c < hw.grid.count; c++) {
    const f = findsIn2(hw, atlas, c, 5), k = gameIn(hw, atlas, c, f);
    if (k) { with_++; kinds.add(k); assert.ok(f.includes('forage')); assert.ok(atlas.placeAt[c] < 0); }
  }
  assert.ok(with_ > 20, `${with_} hexes with game`);
  assert.ok(kinds.size >= 3, [...kinds].join(','));
  assert.ok(gameReady(undefined, 0) && !gameReady(10, 10 + GAME_RETURNS - 1) && gameReady(10, 10 + GAME_RETURNS));
});

import { makeCamp } from '../src/primundi/sim.ts';
test('a night in camp: a day passes, a little cheer, and about a third of nights bring something', () => {
  const s = simNewGame(hw, atlas, 9, { name: 'T', origin: 'traders', bias: 'gentle', world: 't' });
  const g = makeGame(hw, atlas, hgd, 9, s, quietUi(), makeRng(4));
  const ids = new Set<string>();
  let cards = 0;
  for (let n = 0; n < 200; n++) {
    const day = s.day, p = makeCamp(g);
    assert.ok(Math.abs(s.day - day - 1) < 1e-9);
    if (p) { cards++; ids.add(p.e.id); assert.ok(p.choices.length >= 2); }
  }
  assert.ok(cards > 40 && cards < 100, `${cards} of 200 nights`);
  assert.ok(ids.size >= 3, [...ids].join(','));
});

import { tradesOf, townLine, TRADES } from '../src/primundi/towns.ts';
test('every place has a trade, and they are not all one kind', () => {
  const count: Record<string, number> = {};
  for (const p of atlas.places) {
    const t = tradesOf(hw, atlas, p);
    assert.ok(t.length >= 1 && t.length <= 2 && t.every((x) => x in TRADES));
    count[t[0]] = (count[t[0]] ?? 0) + 1;
    if (t[0] === 'fishing') assert.ok(hw.grid.neighbors[p.cell].some((n) => hw.water[n] !== 0), `${p.name} fishes inland`);
    assert.ok(townLine(hw, atlas, p).length > 20);
  }
  const kinds = Object.keys(count).length, top = Math.max(...Object.values(count)) / atlas.places.length;
  assert.ok(kinds >= 5, JSON.stringify(count));
  assert.ok(top < 0.5, `one trade is ${Math.round(top * 100)}% of places: ${JSON.stringify(count)}`);
});

import { localOffer, takeLocal } from '../src/primundi/sim.ts';
test("a town's own offer: once a month, and it does what it says", () => {
  const s = simNewGame(hw, atlas, 21, { name: 'T', origin: 'traders', bias: 'gentle', world: 't' });
  const g = makeGame(hw, atlas, hgd, 21, s, quietUi(), makeRng(2));
  let took = 0;
  for (const p of atlas.places.slice(0, 40)) {
    const o = localOffer(g, p.id);
    if (!o) continue;
    s.caravan.orrels = 500; s.caravan.cargo.fill(0); s.caravan.basis.fill(0);
    const text = takeLocal(g, p.id);
    assert.ok(text.length > 0, `${p.name}: ${o.label}`);
    assert.equal(localOffer(g, p.id), null, 'once a month');
    took++;
  }
  assert.ok(took > 5, `${took} offers taken`);
  s.day += 31;
  assert.ok(atlas.places.slice(0, 40).some((p) => localOffer(g, p.id)), 'back next month');
});

import { townsfolk } from '../src/primundi/towns.ts';
import { metAt, rationCost, restCost } from '../src/primundi/sim.ts';
import { nameMaker as nameMaker2 } from '../src/gamedata.ts';
test('townspeople: the same names every visit, and a town you have helped is kinder on prices', () => {
  const p = atlas.places[3];
  const a = townsfolk(p, 5, nameMaker2(5 * 101 + p.id * 7)), b = townsfolk(p, 5, nameMaker2(5 * 101 + p.id * 7));
  assert.deepEqual(a, b);
  assert.equal(Object.keys(a).length, 5);
  const s = simNewGame(hw, atlas, 5, { name: 'T', origin: 'traders', bias: 'gentle', world: 't' });
  const g = makeGame(hw, atlas, hgd, 5, s, quietUi(), makeRng(1));
  const pid = atlas.places.findIndex((x) => x.id !== s.home);
  const r0 = rationCost(g, pid, 20), b0 = restCost(g, pid, 3);
  metAt(g, pid).helped = 1;
  assert.ok(rationCost(g, pid, 20) < r0 && restCost(g, pid, 3) < b0, `${r0}->${rationCost(g, pid, 20)}, ${b0}->${restCost(g, pid, 3)}`);
});

// --- The opening (opening.ts): the caravan built in town, the errand, the first road. ----------
import { setupHire, setupBeasts, firstLoads, setupLoad, setupReady, finishSetup, quickSetup, folkHere, enter, handIn } from '../src/primundi/sim.ts';
import { candidates } from '../src/primundi/opening.ts';
import { SETUP_PURSE } from '../src/primundi/caravan.ts';
test('the opening: six people to choose from, each with their own wish, and a purse to spend', () => {
  const s = simNewGame(hw, atlas, 8, { name: 'T', origin: 'traders', bias: 'gentle', world: 't', setup: true });
  assert.equal(s.caravan.members.length, 1);
  assert.equal(s.caravan.orrels, SETUP_PURSE.traders);
  const cs = candidates(hw, atlas, atlas.places[s.home], 'traders', 8);
  assert.equal(cs.length, 6);
  assert.equal(new Set(cs.map((x) => x.m.wish)).size, 6);
  const g = makeGame(hw, atlas, hgd, 8, s, quietUi(), makeRng(1));
  assert.ok(!setupReady(s));
  assert.ok(setupHire(g, 0) && setupHire(g, 1));
  const after2 = s.caravan.orrels;
  assert.ok(setupHire(g, 1));
  assert.equal(s.caravan.orrels, after2 + s.setup!.offered[1].cost, 'letting someone go gives their cost back');
  assert.ok(setupBeasts(g, 'oxen') && setupBeasts(g, 'mules'));
  assert.equal(s.caravan.capacity, 30);
  assert.ok(setupReady(s));
  const l = firstLoads(g)[0];
  if (l) assert.ok(setupLoad(g, l.gi, l.n) > 0);
  const q = finishSetup(g);
  assert.ok(q && q.kind === 'deliver' && s.jobs.length === 1 && !s.setup);
  assert.equal(s.caravan.rations, s.caravan.members.length * 30);
});
test('the opening: every quick start can set out, and the first road has someone on it', () => {
  for (const origin of ['traders', 'cartographers'] as const) for (let seed = 1; seed <= 6; seed++) {
    const s = simNewGame(hw, atlas, seed, { name: 'T', origin, bias: 'gentle', world: 't', setup: true });
    const g = makeGame(hw, atlas, hgd, seed, s, quietUi(), makeRng(seed));
    const q = quickSetup(g);
    assert.ok(q, `${origin} ${seed}: no errand`);
    assert.ok(s.caravan.orrels > 0 && s.caravan.members.length >= 3);
    assert.equal(s.firstRoad, -1);
    // Walk the route out: the first open hex a little way from home gets the meeting.
    assert.ok(setRoute(g, atlas.places[q!.to!].cell));
    while (s.route.length && s.firstRoad === -1) enter(g, s.route[0]);
    if (s.firstRoad !== -1) assert.equal(folkHere(g, s.firstRoad!)[0]?.id, 'first');
    // Delivered: word of somewhere far.
    while (s.route.length) enter(g, s.route[0]);
    assert.ok(handIn(g, q!.to!, q!.id));
    assert.ok(s.far && s.far.pid !== s.home, `${origin} ${seed}: no far place`);
  }
});

import { memberStats, crewSheet, ROLE_FIGHT } from '../src/primundi/caravan.ts';
test("the tavern's stat sheet says what the rules do", () => {
  const c = newCaravan('Test', 'traders', 5);
  // Each person's Fight is what strength() counts for them.
  for (const m of living(c)) {
    const f = +memberStats(m).find((x) => x.k === 'Fight')!.v;
    assert.equal(f, ROLE_FIGHT[m.role] + (m.trait === 'stout' ? 1 : 0));
  }
  const sheet = Object.fromEntries(crewSheet(c).map((x) => [x.k, x.v]));
  assert.equal(+sheet.Fight, +strength(c).toFixed(1));
  // A scout shows; frugal eats less.
  assert.ok(memberStats({ ...living(c)[0], role: 'scout' }).some((x) => x.k === 'Sight'));
  assert.equal(memberStats({ ...living(c)[0], trait: 'frugal' }).find((x) => x.k === 'Eats')!.v, '0.7/day');
});

import { Traffic } from '../src/primundi/traffic.ts';
test('traders keep to the roads, go town to town, and are the same on a reload', () => {
  const t1 = new Traffic(hw, atlas, 5), t2 = new Traffic(hw, atlas, 5);
  assert.ok(t1.traders.length >= 6, `${t1.traders.length} traders`);
  // Asked in a different order (as a reload would), the same answers.
  const late = t2.onRoad(120).map((r) => `${r.trader.i}:${r.cell}`).join(',');
  const visited = t1.traders.map(() => new Set<number>());
  let onRoad = 0;
  for (let d = 0; d <= 120; d += 0.5) {
    for (const r of t1.onRoad(d)) {
      onRoad++;
      assert.equal(atlas.road[r.cell], 1, 'off the road');
      assert.ok(r.frac >= 0 && r.frac < 1);
      visited[r.trader.i].add(r.leg.to);
      assert.ok(atlas.places[r.leg.to].town && atlas.places[r.leg.from].town);
    }
  }
  assert.equal(t1.onRoad(120).map((r) => `${r.trader.i}:${r.cell}`).join(','), late);
  // Most are moving about: on the road a fair share of the time, and to more than one town.
  assert.ok(onRoad > t1.traders.length * 241 * 0.2, `on the road ${onRoad}`);
  assert.ok(visited.filter((v) => v.size >= 2).length > t1.traders.length / 2);
  // Someone in a hex is someone on the road there.
  const r = t1.onRoad(30)[0];
  assert.ok(t1.inCell(r.cell, 30).some((x) => x.trader.i === r.trader.i));
});
