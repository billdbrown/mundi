/**
 * How evenly worlds spread their land, over many seeds (default settings):
 *   lopsided  length of the mean of land cells' unit vectors (0: balanced, 1: all in one spot)
 *   masses    landmasses over 3% of the land
 *   biggest   the largest landmass's share of the land
 *   farthest  the greatest distance from any land, degrees (the emptiest ocean)
 *
 *   node scripts/continents.ts [seeds=40]
 */
import { generateWorld, DEFAULT_PARAMS, WATER_LAND } from '../src/world.ts';
const seeds = Number(process.argv[2] ?? 40);
const rows: number[][] = [];
for (let s = 1; s <= seeds; s++) {
  const w = generateWorld({ ...DEFAULT_PARAMS, ...JSON.parse(process.env.P ?? '{}'), seed: s * 7919 });
  const g = w.grid, N = g.count, P = g.centers, land = (c: number) => w.water[c] === WATER_LAND;
  let mx = 0, my = 0, mz = 0, nl = 0;
  for (let c = 0; c < N; c++) if (land(c)) { mx += P[c * 3]; my += P[c * 3 + 1]; mz += P[c * 3 + 2]; nl++; }
  const lop = Math.hypot(mx, my, mz) / nl;
  const seen = new Int32Array(N).fill(-1), sizes: number[] = [];
  for (let c = 0; c < N; c++) {
    if (!land(c) || seen[c] >= 0) continue;
    const q = [c]; seen[c] = sizes.length; let n = 0;
    while (q.length) { const x = q.pop()!; n++; for (const nb of g.neighbors[x]) if (land(nb) && seen[nb] < 0) { seen[nb] = sizes.length; q.push(nb); } }
    sizes.push(n);
  }
  const masses = sizes.filter((n) => n > 0.03 * nl).length, biggest = Math.max(...sizes) / nl;
  // Distance from land: BFS in cells, times cell spacing.
  const d = new Int32Array(N).fill(-1), q: number[] = [];
  for (let c = 0; c < N; c++) if (land(c)) { d[c] = 0; q.push(c); }
  for (let i = 0; i < q.length; i++) for (const nb of g.neighbors[q[i]]) if (d[nb] < 0) { d[nb] = d[q[i]] + 1; q.push(nb); }
  let far = 0; for (let c = 0; c < N; c++) far = Math.max(far, d[c]);
  rows.push([lop, masses, biggest, far * Math.sqrt(4 * Math.PI / N) * 57.3]);
}
const mean = (i: number) => rows.reduce((s, r) => s + r[i], 0) / rows.length;
const share = (f: (r: number[]) => boolean) => (100 * rows.filter(f).length / rows.length).toFixed(0) + '%';
console.log(`lopsided ${mean(0).toFixed(2)}  masses ${mean(1).toFixed(1)}  biggest ${(100 * mean(2)).toFixed(0)}%  farthest ${mean(3).toFixed(0)}°  | one-mass worlds ${share((r) => r[1] <= 1)}, lopsided>0.4 ${share((r) => r[0] > 0.4)}`);
