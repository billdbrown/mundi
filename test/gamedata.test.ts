import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, DEFAULT_PARAMS, WATER_LAND, WATER_OCEAN } from '../src/world.ts';
import { gameData, exportJSON, nameMaker } from '../src/gamedata.ts';

const w = generateWorld({ ...DEFAULT_PARAMS, detail: 30, seed: 77 });
const gd = gameData(w);

test('every land and lake cell belongs to a continent, no ocean cell does', () => {
  for (let c = 0; c < w.grid.count; c++) {
    if (w.water[c] === WATER_OCEAN) assert.equal(gd.continent[c], -1);
    else assert.ok(gd.continent[c] >= 0);
  }
  const total = gd.continents.reduce((s, k) => s + k.cells, 0);
  assert.equal(total, [...w.water].filter((x) => x !== WATER_OCEAN).length);
  for (let i = 1; i < gd.continents.length; i++) assert.ok(gd.continents[i - 1].cells >= gd.continents[i].cells);
});

test('sites are on land, spread apart, and deterministic', () => {
  assert.ok(gd.sites.length >= 3);
  const gap = Math.max(2, Math.round(w.params.detail / 6));
  for (const s of gd.sites) assert.equal(w.water[s.cell], WATER_LAND);
  // Graph distance between any two sites is more than `gap`.
  for (const s of gd.sites) {
    const dist = new Map([[s.cell, 0]]);
    let ring = [s.cell];
    for (let d = 1; d <= gap; d++) {
      const next: number[] = [];
      for (const r of ring) for (const n of w.grid.neighbors[r]) if (!dist.has(n)) { dist.set(n, d); next.push(n); }
      ring = next;
    }
    for (const o of gd.sites) if (o !== s) assert.ok(!dist.has(o.cell), `sites ${s.cell} and ${o.cell} too close`);
  }
  assert.deepEqual(gameData(w).sites, gd.sites);
});

test('names are unique and pronounceable-ish', () => {
  const next = nameMaker(5), seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const n = next();
    assert.match(n, /^[A-Z][a-z]{3,}$/);
    assert.ok(!seen.has(n));
    seen.add(n);
  }
});

test('JSON export round-trips with one entry per cell', () => {
  const data = JSON.parse(exportJSON(w, gd));
  assert.equal(data.cells.length, w.grid.count);
  assert.equal(data.sites.length, gd.sites.length);
  assert.ok(data.cells.every((c: { neighbors: number[] }) => c.neighbors.length === 5 || c.neighbors.length === 6));
});
