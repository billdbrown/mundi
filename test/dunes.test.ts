import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateDunes } from '../src/dunesim.ts';

const opts = { size: 48, sand: 3, winds: [0], sweeps: 40, hop: 3, seed: 5 };

test('dune simulation is deterministic', () => {
  assert.deepEqual(simulateDunes(opts), simulateDunes(opts));
});

test('dune simulation neither makes nor loses sand', () => {
  const h = simulateDunes(opts);
  const total = h.reduce((s, v) => s + v, 0);
  // 3 slabs a cell, a slab a third of a cell thick; the blur moves sand, it doesn't make it.
  assert.ok(Math.abs(total - 48 * 48 * 3 / 3) < 1e-2, `total ${total}`);
});

test('dunes grow out of the flat start', () => {
  const h = simulateDunes(opts);
  assert.ok(Math.max(...h) > 2.5, 'some sand piles up well above the mean of 1 cell');
});
