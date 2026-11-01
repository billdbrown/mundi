import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, DEFAULT_PARAMS, WATER_LAND } from '../src/world.ts';
import { gameData } from '../src/gamedata.ts';
import { simulateHistory, popAt, HISTORY_YEARS } from '../src/civ.ts';

const w = generateWorld({ ...DEFAULT_PARAMS, seed: 77 });
const gd = gameData(w);
const t0 = performance.now();
const h = simulateHistory(w, gd);
const ms = performance.now() - t0;

test('history: settlements spread, grow, and stay on land', () => {
  console.log(`  ${h.settlements.length} settlements, ${h.roads.length} roads, ${h.realms.length} realms, ${h.events.length} events, ${ms.toFixed(0)} ms`);
  assert.ok(h.settlements.length > 5);
  for (const s of h.settlements) assert.equal(w.water[s.cell], WATER_LAND);
  assert.ok(h.settlements.some((s) => popAt(s, HISTORY_YEARS) > 1000));
  assert.ok(h.events.length > 5);
  for (let i = 1; i < h.events.length; i++) assert.ok(h.events[i].year >= h.events[i - 1].year);
});

test('history is deterministic', () => {
  const h2 = simulateHistory(w, gd);
  assert.deepEqual(h2.events, h.events);
});

test('print the chronicle', () => {
  for (const e of h.events.slice(0, 40)) console.log(`  ${e.year}: ${e.text}`);
});
