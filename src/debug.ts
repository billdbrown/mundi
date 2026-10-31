/**
 * Camera placement for screenshots and visual tests: named spots worth looking at, and plain
 * orbit positions. Exposed on window.worldgen by main.ts.
 */
import type { World } from './world.ts';
import type { PlanetView } from './render.ts';
import { WATER_LAND, WATER_LAKE, WATER_OCEAN } from './world.ts';
import { B } from './biomes.ts';

export type Spot = 'coast' | 'river' | 'mountain' | 'lake' | 'desert' | 'mouth';

/** A cell that shows off the named feature, chosen deterministically. */
export function findSpot(w: World, spot: Spot): number {
  const g = w.grid, P = g.centers;
  let best = -1, bestScore = -Infinity;
  for (let c = 0; c < g.count; c++) {
    const lat = Math.abs(P[c * 3 + 1]);
    let score = -Infinity;
    if (spot === 'mouth') {
      // Where the biggest river meets the sea.
      if (w.river[c] && w.water[w.downstream[c]] === WATER_OCEAN && lat < 0.7) score = w.flow[c];
    } else if (spot === 'river') {
      // The biggest river away from the poles.
      if (w.river[c] && lat < 0.6) score = w.flow[c];
    } else if (spot === 'lake') {
      // The middle of the biggest open (unfrozen) lake.
      if (w.water[c] === WATER_LAKE && w.biome[c] !== B.ICE && lat < 0.75) {
        score = g.neighbors[c].filter((n) => w.water[n] === WATER_LAKE).length;
      }
    } else if (spot === 'desert') {
      // Deep in the biggest desert: the desert cell with the most desert around it.
      if (w.biome[c] === B.DESERT && lat < 0.6) {
        score = g.neighbors[c].filter((n) => w.biome[n] === B.DESERT).length + c * 1e-9;
      }
    } else if (spot === 'mountain') {
      if (w.water[c] === WATER_LAND && lat < 0.7) score = w.elevation[c];
    } else if (w.water[c] === WATER_OCEAN) {
      // Sea cell hugging the most land, preferring low latitudes and river mouths.
      const landNbrs = g.neighbors[c].filter((n) => w.water[n] === WATER_LAND);
      score = landNbrs.length * (lat < 0.5 ? 1 : 0.2) + (landNbrs.some((n) => w.river[n]) ? 3 : 0);
    }
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/** Looks at a cell obliquely from altitude `alt` (planet radius 1). */
export function flyTo(view: PlanetView, w: World, spot: Spot, alt: number): number {
  const c = findSpot(w, spot);
  if (c < 0) return c;
  const P = w.grid.centers;
  const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
  let tx = -z, tz = x;
  const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
  view.camera.position.set(x * alt + tx * 0.06, y * alt, z * alt + tz * 0.06);
  view.controls.update();
  return c;
}

/** Orbit position: longitude and latitude in degrees, distance from the centre. */
export function orbit(view: PlanetView, lonDeg: number, latDeg: number, dist: number) {
  const lon = (lonDeg * Math.PI) / 180, lat = (latDeg * Math.PI) / 180;
  view.camera.position.set(Math.cos(lat) * Math.sin(lon) * dist, Math.sin(lat) * dist, Math.cos(lat) * Math.cos(lon) * dist);
  view.controls.update();
}
