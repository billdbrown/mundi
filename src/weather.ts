/**
 * Weather on the clock: storms that form, travel and die, on a schedule fixed by the seed.
 *
 * Mid-latitude cyclones are born in the storm tracks (35–55°), ride the westerlies east and
 * drift poleward over about five days. Tropical cyclones form over warm sea at 8–20°, travel
 * west, curve poleward and then east, and weaken over land. The shader (sky.ts) draws each as
 * spiral cloud bands round its centre; the wind bands that carry ordinary cloud live there too.
 *
 * Longitude here is atan2(x, z), the renderer's convention, in which the sun moves toward +lon
 * over a day; so east is −lon.
 */
import * as THREE from 'three';
import { WATER_OCEAN, type World } from './world.ts';
import { hash01 } from './rng.ts';

export const MAX_STORMS = 8;
/** A storm is born every this many days, alternating kinds by hash. */
const SPACING = 1.1;

interface Storm { t0: number; life: number; lon0: number; lat0: number; tropical: boolean; size: number }

export class Weather {
  private world: World;
  private seed: number;
  private warmSea: number[] = [];
  private cache = new Map<number, Storm | null>();
  private cell = 0;

  constructor(world: World) {
    this.world = world;
    this.seed = world.params.seed;
    const g = world.grid, P = g.centers;
    for (let c = 0; c < g.count; c++) {
      if (world.water[c] !== WATER_OCEAN || world.temperature[c] < 0.6) continue;
      const lat = Math.abs(Math.asin(P[c * 3 + 1]));
      if (lat > 0.14 && lat < 0.35) this.warmSea.push(c);
    }
  }

  private storm(k: number): Storm | null {
    if (this.cache.has(k)) return this.cache.get(k)!;
    const h = (i: number) => hash01(this.seed * 7919 + k * 131 + i);
    const tropical = h(1) < 0.35 && this.warmSea.length > 0;
    let s: Storm;
    if (tropical) {
      const c = this.warmSea[Math.floor(h(2) * this.warmSea.length)], P = this.world.grid.centers;
      s = {
        t0: k * SPACING + h(3) * 0.6, life: 4 + h(4) * 3, tropical,
        lon0: Math.atan2(P[c * 3], P[c * 3 + 2]), lat0: Math.asin(P[c * 3 + 1]), size: 0.1 + h(5) * 0.05,
      };
    } else {
      const north = h(2) < 0.5 ? 1 : -1;
      s = {
        t0: k * SPACING + h(3) * 0.6, life: 3.5 + h(4) * 2.5, tropical,
        lon0: h(6) * Math.PI * 2 - Math.PI, lat0: north * (0.6 + h(5) * 0.3), size: 0.14 + h(7) * 0.08,
      };
    }
    this.cache.set(k, s);
    return s;
  }

  /** Fill `out` (MAX_STORMS vec4s: lon, lat, ±radius, strength; negative radius = tropical) for day `t`. */
  update(t: number, out: THREE.Vector4[]) {
    let n = 0;
    const first = Math.max(0, Math.floor((t - 8) / SPACING));
    for (let k = first; k <= Math.floor(t / SPACING) && n < MAX_STORMS; k++) {
      const s = this.storm(k);
      if (!s) continue;
      const a = t - s.t0;
      if (a < 0 || a > s.life) continue;
      const sg = Math.sign(s.lat0);
      let lon: number, lat: number;
      if (s.tropical) {
        // West at first, slowing, then recurving poleward and east.
        lon = s.lon0 + 0.3 * a - 0.035 * a * a * a;
        lat = s.lat0 + sg * (0.04 * a + 0.012 * a * a);
      } else {
        lon = s.lon0 - 0.38 * a;                     // with the westerlies, toward the east
        lat = s.lat0 + sg * 0.03 * a;
      }
      // Grow fast, fade slowly. Tropical storms die over land.
      let strength = Math.min(1, a / (s.life * 0.25)) * Math.min(1, (s.life - a) / (s.life * 0.45));
      if (s.tropical && this.overLand(lon, lat)) strength *= 0.45;
      out[n++].set(lon, lat, s.tropical ? -s.size : s.size, Math.max(0, strength));
    }
    for (; n < MAX_STORMS; n++) out[n].set(0, 0, 0, 0);
  }

  private overLand(lon: number, lat: number) {
    const g = this.world.grid, P = g.centers;
    const x = Math.cos(lat) * Math.sin(lon), y = Math.sin(lat), z = Math.cos(lat) * Math.cos(lon);
    let c = this.cell;
    for (;;) {
      let best = c, bd = P[c * 3] * x + P[c * 3 + 1] * y + P[c * 3 + 2] * z;
      for (const nb of g.neighbors[c]) {
        const d = P[nb * 3] * x + P[nb * 3 + 1] * y + P[nb * 3 + 2] * z;
        if (d > bd) { bd = d; best = nb; }
      }
      if (best === c) break;
      c = best;
    }
    this.cell = c;
    return this.world.water[c] !== WATER_OCEAN;
  }
}
