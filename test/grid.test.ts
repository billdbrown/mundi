import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid } from '../src/grid.ts';

for (const n of [1, 4, 17]) {
  test(`grid n=${n}: 10n²+2 cells, exactly 12 pentagons, symmetric neighbours`, () => {
    const g = buildGrid(n);
    assert.equal(g.count, 10 * n * n + 2);

    let pentagons = 0;
    for (let c = 0; c < g.count; c++) {
      const m = g.neighbors[c].length;
      assert.ok(m === 5 || m === 6, `cell ${c} has ${m} sides`);
      if (m === 5) pentagons++;
      for (const nb of g.neighbors[c]) {
        assert.ok(nb >= 0 && nb !== c);
        assert.ok(g.neighbors[nb].includes(c), `${c}→${nb} not reciprocal`);
      }
      assert.equal(new Set(g.neighbors[c]).size, m, `cell ${c} lists a neighbour twice`);
    }
    assert.equal(pentagons, 12);
  });
}
