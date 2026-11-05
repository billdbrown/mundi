import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateWorld, DEFAULT_PARAMS } from '../src/world.ts';
import { buildSurfaceData, planetGround } from '../src/surface.ts';

test("planetGround is the planet's terrain mesh: every vertex the same height", () => {
  const w = generateWorld({ ...DEFAULT_PARAMS, seed: 1 });
  const d = buildSurfaceData(w, { mode: 'biome', style: 'smooth', relief: 1, blend: true, trees: true } as never);
  const G = planetGround(w, 1), p = d.terrain.position;
  let n = 0, exact = 0, worst = 0;
  for (let i = 0; i < p.length / 3; i += 53) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2], r = Math.hypot(x, y, z);
    const e = Math.abs(G.at(x, y, z).h - r);
    n++; worst = Math.max(worst, e);
    if (e < 1e-6) exact++;
  }
  // (Before 2026-11-05 this read the formula point by point, and stepped at some cell edges.)
  assert.ok(exact / n > 0.995, `${exact} of ${n} vertices match; worst ${(worst * 640000).toFixed(1)} m off`);
});

test('the ground has no steps across cell edges', () => {
  const w = generateWorld({ ...DEFAULT_PARAMS, seed: 1 });
  const G = planetGround(w, 1), g = w.grid, K = g.cornerPos, P = g.centers;
  let worst = 0;
  for (let c = 0; c < g.count; c += 3) {
    const ks = g.corners[c];
    for (let i = 0; i < ks.length; i++) {
      const nb = g.neighbors[c][i], a = ks[i], b = ks[(i + 1) % ks.length];
      const mx = (K[a * 3] + K[b * 3]) / 2, my = (K[a * 3 + 1] + K[b * 3 + 1]) / 2, mz = (K[a * 3 + 2] + K[b * 3 + 2]) / 2;
      const side = (cc: number) => {
        const dx = P[cc * 3] - mx, dy = P[cc * 3 + 1] - my, dz = P[cc * 3 + 2] - mz, l = Math.hypot(dx, dy, dz);
        return G.at(mx + dx / l * 1e-6, my + dy / l * 1e-6, mz + dz / l * 1e-6).h;
      };
      worst = Math.max(worst, Math.abs(side(c) - side(nb)));
    }
  }
  assert.ok(worst * 640000 < 5, `steps of up to ${(worst * 640000).toFixed(0)} m`);
});
