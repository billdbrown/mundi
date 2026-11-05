import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, DEFAULT_PARAMS } from '../src/world.ts';
import { buildSurfaceData, planetGround } from '../src/surface.ts';

test("planetGround is the formula the planet's terrain mesh is drawn from", () => {
  const w = generateWorld({ ...DEFAULT_PARAMS, seed: 1 });
  const d = buildSurfaceData(w, { mode: 'biome', style: 'smooth', relief: 1, blend: true, trees: true } as never);
  const G = planetGround(w, 1), p = d.terrain.position, P = w.grid.centers, K = w.grid.cornerPos;
  let n = 0, exact = 0;
  for (let i = 0; i < p.length / 3; i += 53) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2], r = Math.hypot(x, y, z);
    const q = G.at(x, y, z), c = q.cell;
    // The mesh pins cell centres and corners to the smoothed heights, without the noise.
    if (Math.abs(P[c * 3] * x + P[c * 3 + 1] * y + P[c * 3 + 2] * z - r) < 1e-9 * r) continue;
    if (w.grid.corners[c].some((k) => Math.abs(K[k * 3] * x + K[k * 3 + 1] * y + K[k * 3 + 2] * z - r * Math.hypot(K[k * 3], K[k * 3 + 1], K[k * 3 + 2])) < 1e-9 * r)) continue;
    n++;
    if (Math.abs(q.h - r) < 1e-6) exact++;
  }
  // The rest lie on cell edges, where the mesh's own height depends on which cell built the point.
  assert.ok(exact / n > 0.8, `${exact} of ${n} vertices match`);
});
