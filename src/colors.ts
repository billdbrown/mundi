/** Cell colours for each view mode. Pure, so it runs in the worker. */
import * as THREE from 'three';
import { BIOMES } from './biomes.ts';
import { WATER_LAKE, WATER_OCEAN, type World } from './world.ts';
import { hash01 } from './rng.ts';

export type ViewMode = 'biome' | 'elevation' | 'temperature' | 'moisture' | 'plates';
export type TerrainStyle = 'smooth' | 'tiles';

export function colorFor(w: World, c: number, mode: ViewMode, out: THREE.Color): THREE.Color {
  switch (mode) {
    case 'biome':
      return out.setHex(BIOMES[w.biome[c]].color);
    case 'elevation': {
      const e = w.water[c] === WATER_LAKE ? w.surface[c] : w.elevation[c];
      if (w.water[c] === WATER_OCEAN) return out.setHSL(0.6, 0.6, 0.15 + 0.3 * (1 + e));
      return out.setHSL(0.33 - 0.33 * e, 0.45, 0.3 + 0.45 * e);
    }
    case 'temperature':
      return out.setHSL(0.66 - 0.66 * w.temperature[c], 0.75, 0.5);
    case 'moisture':
      return out.setHSL(0.1 + 0.5 * w.moisture[c], 0.6, 0.6 - 0.25 * w.moisture[c]);
    case 'plates':
      return out.setHSL(hash01(w.plate[c] + 1), 0.55, w.water[c] === WATER_OCEAN ? 0.35 : 0.6);
  }
}

/** Linear RGB per cell. */
export function cellColors(w: World, mode: ViewMode): Float32Array {
  const N = w.grid.count, out = new Float32Array(N * 3), tmp = new THREE.Color();
  for (let c = 0; c < N; c++) {
    colorFor(w, c, mode, tmp);
    out[c * 3] = tmp.r; out[c * 3 + 1] = tmp.g; out[c * 3 + 2] = tmp.b;
  }
  return out;
}
