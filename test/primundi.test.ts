import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, DEFAULT_PARAMS, WATER_LAND } from '../src/world.ts';
import { gameData } from '../src/gamedata.ts';
import { pickStart, harshness } from '../src/primundi/start.ts';

const w = generateWorld({ ...DEFAULT_PARAMS, detail: 30, seed: 77 });
const gd = gameData(w);

test('a start is on habitable land and the same every time for the same seed', () => {
  for (const bias of ['gentle', 'any', 'harsh'] as const) {
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
  for (const bias of ['gentle', 'any', 'harsh'] as const) {
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
