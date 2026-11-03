/**
 * Hotspot island chains (hotspots.ts) over 20 worlds: chains, volcanoes, those above water, atolls.
 *   node scripts/hotspots.ts
 */
import { generateWorld, DEFAULT_PARAMS } from '../src/world.ts';
let chains = 0, vol = 0, above = 0, atolls = 0, landAdded = 0, worlds = 0;
const t0 = performance.now();
for (let s = 1; s <= 20; s++) {
  const w = generateWorld({ ...DEFAULT_PARAMS, seed: s * 7919 });
  worlds++;
  const hs = w.hotspots;
  chains += new Set(hs.volcanoes.map((v) => v.chain)).size;
  vol += hs.volcanoes.length;
  above += hs.volcanoes.filter((v) => w.water[v.cell] === 0).length;
  atolls += hs.atolls.length;
}
console.log(`per world: chains ${(chains / worlds).toFixed(1)}, volcanoes ${(vol / worlds).toFixed(1)}, centres on land ${(above / worlds).toFixed(1)}, atolls ${(atolls / worlds).toFixed(1)} (${((performance.now() - t0) / worlds).toFixed(0)} ms a world)`);
