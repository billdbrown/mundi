import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, DEFAULT_PARAMS } from '../src/world.ts';
import { buildLocalMap, riverCrossings, type LocalOptions } from '../src/hexlocal.ts';
import { findSpot } from '../src/debug.ts';

const world = generateWorld({ ...DEFAULT_PARAMS, seed: 7, detail: 30 });
const riverCell = findSpot(world, 'river');

test('a hex map is the same every time', () => {
  const a = buildLocalMap(world, riverCell, { res: 65 });
  const b = buildLocalMap(world, riverCell, { res: 65 });
  assert.deepEqual(a.heights, b.heights);
  assert.deepEqual(a.trees, b.trees);
  assert.ok(a.heights.every(Number.isFinite));
});

test('rivers cross each hex edge at the middle of the edge the planet says', () => {
  const settings: [string, Partial<LocalOptions>][] = [['default', {}], ['plain shrink 20x', { mag: 20, vScale: 20, vSoft: 0, riverMode: 'scaled', crags: false }]];
  for (const [name, o] of settings) {
    const v = { id: name };
    const m = buildLocalMap(world, riverCell, { res: 65, ...o });
    assert.ok(m.rivers.length > 0, 'the river cell has river pieces');
    // Every crossing sits on the boundary between two cells: on this hex's outline when the
    // piece leaves or enters it, which is the case we can check from the hex's own corners.
    const H = m.hex, n = H.length / 2;
    const onEdge = ([x, y]: [number, number]) => {
      for (let k = 0; k < n; k++) {
        const ax = H[k * 2], ay = H[k * 2 + 1], bx = H[((k + 1) % n) * 2], by = H[((k + 1) % n) * 2 + 1];
        if (Math.hypot(x - (ax + bx) / 2, y - (ay + by) / 2) < 1e-3 * m.size) return true;
      }
      return false;
    };
    const touching = m.rivers.filter((_, i) => {
      const p = m.rivers[i].pts, last = p.length / 4 - 1;
      const atCentre = (x: number, y: number) => Math.hypot(x, y) < 1e-6 * m.size;
      return atCentre(p[0], p[1]) || atCentre(p[last * 4], p[last * 4 + 1]);
    });
    assert.ok(touching.length > 0);
    for (const r of touching) assert.ok(onEdge(riverCrossings({ ...m, rivers: [r] })[0]), `${v.id}: crossing on an edge middle`);
  }
});

test('river water never runs uphill', () => {
  const m = buildLocalMap(world, riverCell, { res: 65 });
  for (const r of m.rivers) {
    for (let s = 1; s < r.pts.length / 4; s++) assert.ok(r.pts[s * 4 + 2] <= r.pts[(s - 1) * 4 + 2] + 1e-4);
  }
});

test('the hex is drawn mag times smaller than it is', () => {
  const a = buildLocalMap(world, riverCell, { res: 33, mag: 10 });
  const b = buildLocalMap(world, riverCell, { res: 33, mag: 20 });
  assert.ok(Math.abs(a.localWidth / b.localWidth - 2) < 1e-6);
  assert.ok(Math.abs(a.trueWidthKm - b.trueWidthKm) < 1e-6);
});
