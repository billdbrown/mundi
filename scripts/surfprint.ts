/** Fingerprint of the planet's terrain mesh for a world, to prove a refactor changed nothing.
 * Usage: node scripts/surfprint.ts [seed] */
import { createHash } from 'node:crypto';
import { generateWorld, DEFAULT_PARAMS } from '../src/world.ts';
import { buildSurfaceData } from '../src/surface.ts';
const seed = Number(process.argv[2] ?? 1);
const w = generateWorld({ ...DEFAULT_PARAMS, seed });
const d = buildSurfaceData(w, { mode: 'biome', style: 'smooth', relief: 1, blend: true, trees: true } as never);
const h = createHash('sha256');
for (const a of [d.terrain.position, d.terrain.color, d.terrain.climate, d.terrain.eco, d.water?.position, d.water?.depth, d.cellTop, d.cornerH, d.grid])
  if (a) h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
console.log(seed, h.digest('hex').slice(0, 16), d.terrain.position.length / 3);
