import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, DEFAULT_PARAMS, WATER_OCEAN, WATER_LAND } from '../src/world.ts';
import { B } from '../src/biomes.ts';

test('same seed, same world', () => {
  const a = generateWorld({ ...DEFAULT_PARAMS, detail: 20, seed: 42 });
  const b = generateWorld({ ...DEFAULT_PARAMS, detail: 20, seed: 42 });
  assert.deepEqual(a.biome, b.biome);
  assert.deepEqual(a.elevation, b.elevation);
});

test('ocean fraction lands near the request', () => {
  for (const ocean of [0.3, 0.62, 0.85]) {
    const w = generateWorld({ ...DEFAULT_PARAMS, detail: 24, seed: 7, ocean });
    let n = 0;
    for (const x of w.water) if (x === WATER_OCEAN) n++;
    const share = n / w.grid.count;
    assert.ok(Math.abs(share - ocean) < 0.03, `asked ${ocean}, got ${share.toFixed(3)}`);
  }
});

test('every land cell drains to the sea without going uphill or looping', () => {
  const w = generateWorld({ ...DEFAULT_PARAMS, detail: 24, seed: 3 });
  for (let c = 0; c < w.grid.count; c++) {
    if (w.water[c] === WATER_OCEAN) continue;
    let cur = c, steps = 0;
    while (w.water[cur] !== WATER_OCEAN) {
      cur = w.downstream[cur];
      assert.ok(cur >= 0, `cell ${c} has no outlet`);
      assert.ok(++steps < w.grid.count, `cell ${c} loops`);
    }
  }
});

test('poles freeze and the equator has warm biomes', () => {
  const w = generateWorld({ ...DEFAULT_PARAMS, detail: 30, seed: 11 });
  const P = w.grid.centers;
  let polar = 0, polarIce = 0, warm = 0;
  for (let c = 0; c < w.grid.count; c++) {
    const y = P[c * 3 + 1];
    if (Math.abs(y) > 0.98) { polar++; if (w.biome[c] === B.ICE || w.biome[c] === B.SEA_ICE) polarIce++; }
    if (Math.abs(y) < 0.2 && w.water[c] === WATER_LAND &&
      [B.RAINFOREST, B.SAVANNA, B.DRY_FOREST, B.DESERT, B.BEACH].includes(w.biome[c] as never)) warm++;
  }
  assert.ok(polarIce / polar > 0.9, `only ${polarIce}/${polar} polar cells frozen`);
  assert.ok(warm > 0);
});
