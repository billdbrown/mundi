/**
 * How Earth-like is the climate? Generates several Earthlike worlds and compares the share of
 * land in each broad climate group with Earth's (Köppen-Geiger, Peel et al. 2007), and prints
 * where deserts and forests sit by latitude.
 *
 *   node scripts/climate-stats.ts [seeds=12] [detail]
 */
import { generateWorld, DEFAULT_PARAMS, WATER_LAND } from '../src/world.ts';
import { B } from '../src/biomes.ts';

const nSeeds = Number(process.argv[2] ?? 12);
const detail = process.argv[3] ? Number(process.argv[3]) : DEFAULT_PARAMS.detail;

/** Earth: share of land by Köppen group (Peel, Finlayson & McMahon 2007, HESS 11:1633). */
const EARTH = { A: 19.0, B: 30.2, C: 13.4, D: 24.6, E: 12.8 };

/** Our biomes to Köppen groups, roughly. Mountains and beaches go by temperature. */
function group(b: number, t: number): keyof typeof EARTH {
  switch (b) {
    case B.RAINFOREST: case B.SAVANNA: case B.DRY_FOREST: return 'A';
    case B.DESERT: case B.STEPPE: return 'B';
    case B.FOREST: case B.TEMPERATE_RAIN: case B.GRASSLAND: return 'C';
    case B.TAIGA: return 'D';
    case B.TUNDRA: case B.ICE: case B.PEAK: return 'E';
    default: return t > 0.7 ? 'A' : t > 0.45 ? 'C' : t > 0.25 ? 'D' : 'E';
  }
}

const tot = { A: 0, B: 0, C: 0, D: 0, E: 0 };
const bands = Array.from({ length: 9 }, () => ({ land: 0, desert: 0, forest: 0, ice: 0, grass: 0 }));
const biomeCount = new Map<number, number>();
let land = 0;
const FOREST = new Set<number>([B.FOREST, B.TEMPERATE_RAIN, B.RAINFOREST, B.TAIGA, B.DRY_FOREST]);
for (let s = 1; s <= nSeeds; s++) {
  const w = generateWorld({ ...DEFAULT_PARAMS, seed: s * 101, detail });
  const P = w.grid.centers;
  for (let c = 0; c < w.grid.count; c++) {
    if (w.water[c] !== WATER_LAND) continue;
    land++;
    const b = w.biome[c];
    tot[group(b, w.temperature[c])]++;
    biomeCount.set(b, (biomeCount.get(b) ?? 0) + 1);
    const lat = Math.abs(Math.asin(P[c * 3 + 1])) * 180 / Math.PI;
    const k = bands[Math.min(8, Math.floor(lat / 10))];
    k.land++;
    if (b === B.DESERT || b === B.STEPPE) k.desert++;
    if (FOREST.has(b)) k.forest++;
    if (b === B.ICE || b === B.TUNDRA) k.ice++;
    if (b === B.GRASSLAND || b === B.SAVANNA) k.grass++;
  }
}
const pct = (n: number, d = land) => (100 * n / Math.max(1, d)).toFixed(1).padStart(5);
console.log(`${nSeeds} Earthlike worlds, detail ${detail}\n\ngroup   ours  earth`);
for (const g of Object.keys(EARTH) as (keyof typeof EARTH)[]) console.log(`  ${g}   ${pct(tot[g])}  ${EARTH[g].toFixed(1).padStart(5)}`);
console.log('\nlatitude  land%  arid  forest  grass  polar   (share of the band\'s land)');
bands.forEach((k, i) => console.log(`  ${String(i * 10).padStart(2)}-${String(i * 10 + 10).padStart(2)}°  ${pct(k.land)}  ${pct(k.desert, k.land)} ${pct(k.forest, k.land)}  ${pct(k.grass, k.land)}  ${pct(k.ice, k.land)}`));
const names = Object.entries(B).reduce((m, [k, v]) => m.set(v as number, k), new Map<number, string>());
console.log('\nbiomes: ' + [...biomeCount.entries()].sort((a, b) => b[1] - a[1]).map(([b, n]) => `${names.get(b)} ${pct(n).trim()}%`).join(', '));
