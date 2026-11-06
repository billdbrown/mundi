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
