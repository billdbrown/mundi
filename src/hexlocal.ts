/**
 * One planet hex, opened up as a local map you could walk around (RimWorld-style drill-down).
 *
 * The whole hex is fitted into a map `mag` times smaller than it really is (compressed scale):
 * a 13 km hex at mag 10 becomes a 1.3 km map, while people, trees and houses stay life-size.
 * The planet decides the layout: where the coast is, which way the land slopes, which edges a
 * river enters and leaves by. The options decide how big each feature is drawn, so the variants
 * can be compared side by side:
 *
 * - `vScale` divides heights. Equal to `mag` is a plain shrink (a 1 km mountain becomes 100 m);
 *   smaller keeps more relief and makes slopes steeper.
 * - `riverMode` 'scaled' shrinks rivers with everything else; 'flow' sizes them from their flow,
 *   life-size, so a big river still needs a bridge.
 * - `crags` adds walking-scale mountain detail (ridges, cliffs) where the planet is mountainous.
 *
 * Pure and deterministic for a world, cell and options, so it runs in a worker and under Node.
 * Local coordinates are metres: x east, y north, h up, origin at the cell's centre.
 */
import type { World } from './world.ts';
import { WATER_LAKE, WATER_OCEAN } from './world.ts';
import { B, BIOMES } from './biomes.ts';
import { makeSimplex, type Noise3 } from './noise.ts';
import { makeRng } from './rng.ts';

export type RiverMode = 'scaled' | 'flow';

export interface LocalOptions {
  /** How many times smaller than life the hex is drawn. */
  mag: number;
  /** Heights are divided by this. `mag` for a plain shrink. */
  vScale: number;
  /** Soft squeeze, metres: 0 divides every height by vScale alike. Above 0, height differences
   * from the hex's own ground much smaller than this are kept (÷vScale) and bigger ones are
   * squeezed more and more (asinh), so a 300 m hill stays a hill and an 8 km peak still fits. */
  vSoft: number;
  riverMode: RiverMode;
  /** Walking-scale ridges and cliffs where the planet is mountainous. */
  crags: boolean;
  /** Grid samples per side. */
  res: number;
  /** What the planet's radius means in km (main.ts radiusKm). */
  radiusKm: number;
}

export const LOCAL_DEFAULTS: LocalOptions = { mag: 10, vScale: 2, vSoft: 600, riverMode: 'flow', crags: true, res: 513, radiusKm: 640 };

/** The variants offered side by side in the hex view. */
export const VARIANTS: { id: string; label: string; blurb: string; o: Partial<LocalOptions> }[] = [
  { id: 'shrink10', label: 'Shrink 10×', blurb: 'Everything scaled down together', o: { mag: 10, vScale: 10, vSoft: 0, riverMode: 'scaled', crags: false } },
  { id: 'shrink20', label: 'Shrink 20×', blurb: 'Everything scaled down together', o: { mag: 20, vScale: 20, vSoft: 0, riverMode: 'scaled', crags: false } },
  { id: 'aware10', label: 'Content-aware 10×', blurb: 'Soft heights, rivers by flow, crags', o: { mag: 10, vScale: 2, vSoft: 600, riverMode: 'flow', crags: true } },
  { id: 'aware20', label: 'Content-aware 20×', blurb: 'Soft heights, rivers by flow, crags', o: { mag: 20, vScale: 3, vSoft: 450, riverMode: 'flow', crags: true } },
];

export const TREE_CONIFER = 0, TREE_BROAD = 1, TREE_PALM = 2, TREE_SHRUB = 3;

export interface LocalRiver {
  /** Per point: x, y, water level, width (local metres). */
  pts: Float32Array;
}

export interface LocalMap {
  cell: number;
  res: number;
  /** Side of the square map, local metres. The hex fits inside with a margin of its neighbours. */
  size: number;
  /** Width of the hex across its flats: really (km) and as drawn (local m). */
  trueWidthKm: number;
  localWidth: number;
  heights: Float32Array;
  /** Linear RGB per sample. */
  colors: Float32Array;
  /** Sea level is 0 (when the map has sea). */
  sea: boolean;
  /** Lake surface and a 0..1 mask of where it is, or NaN level for none. */
  lakeLevel: number;
  lakeMask: Float32Array;
  rivers: LocalRiver[];
  /** Hex corners, x y pairs. */
  hex: Float32Array;
  /** Per tree: x, y, h, height (m), kind. */
  trees: Float32Array;
  /** Cells within reach and their centres (local), for the inset map. */
  cells: Int32Array;
  cellXY: Float32Array;
  /** The planet's own picture of the same ground: each cell's polygon (polyXY from polyStart[i]
   * to polyStart[i+1]), its biome colour, and rivers as centre → edge middle → centre lines. */
  polyStart: Int32Array;
  polyXY: Float32Array;
  cellRGB: Int32Array;
  planetRivers: Float32Array;
  /** Planet facts about the cell, for the panel. */
  info: { biome: string; trueHeightM: number; tempC: number; riverWidthsM: number[]; rivers: number };
}

const RELIEF_RADII = 0.013;          // surface.ts RELIEF: highest land, in planet radii
const tempC = (t: number) => 50 * t - 17;  // biomes.ts: temperature 0..1 to mean annual °C

/** How wooded each biome is (0..1 of the densest forest) and with what. */
const WOOD: Partial<Record<number, [number, number]>> = {
  [B.TAIGA]: [0.95, TREE_CONIFER], [B.LARCH]: [0.7, TREE_CONIFER], [B.MONTANE_FOREST]: [0.85, TREE_CONIFER],
  [B.TEMPERATE_RAIN]: [1, TREE_CONIFER], [B.BOG]: [0.06, TREE_CONIFER], [B.ALPINE_MEADOW]: [0.03, TREE_CONIFER],
  [B.FOREST]: [0.85, TREE_BROAD], [B.MIXED_FOREST]: [0.85, -1], [B.RAINFOREST]: [1, TREE_BROAD],
  [B.CLOUD_FOREST]: [1, TREE_BROAD], [B.MONSOON]: [0.85, TREE_BROAD], [B.DRY_FOREST]: [0.45, TREE_BROAD],
  [B.SWAMP]: [0.6, TREE_BROAD], [B.MANGROVE]: [0.75, TREE_BROAD], [B.FLOODPLAIN]: [0.3, TREE_BROAD],
  [B.KARST]: [0.55, TREE_BROAD], [B.SAVANNA]: [0.06, TREE_BROAD], [B.GRASSLAND]: [0.04, TREE_BROAD],
  [B.PRAIRIE]: [0.015, TREE_BROAD], [B.STEPPE]: [0.01, TREE_SHRUB], [B.PALM_SAVANNA]: [0.08, TREE_PALM],
  [B.CHAPARRAL]: [0.18, TREE_SHRUB], [B.DESERT_SCRUB]: [0.05, TREE_SHRUB], [B.HEATH]: [0.08, TREE_SHRUB],
  [B.TUNDRA]: [0.03, TREE_SHRUB], [B.MARSH]: [0.03, TREE_SHRUB], [B.CANYONS]: [0.02, TREE_SHRUB],
  [B.BADLANDS]: [0.01, TREE_SHRUB], [B.SALT_MARSH]: [0.01, TREE_SHRUB],
};

/** How snow-capped each biome's high ground is, 0..1. */
const SNOWY: Partial<Record<number, number>> = {
  [B.PEAK]: 0.45, [B.ICE]: 1, [B.MOUNTAIN]: 0.15, [B.POLAR_DESERT]: 0.5, [B.TUNDRA]: 0.15, [B.ALPINE_MEADOW]: 0.1,
};

/** Real metres to map metres. Sea level stays 0; see LocalOptions.vSoft. */
export function localHeights(o: LocalOptions, centreTrue: number): (t: number) => number {
  if (!(o.vSoft > 0)) return (t) => t / o.vScale;
  const F = (d: number) => o.vSoft * Math.asinh(d / o.vSoft) / o.vScale;
  const zero = F(-centreTrue);
  return (t) => F(t - centreTrue) - zero;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** The cells within `rings` steps of c, nearest first. */
function ringsOf(w: World, c: number, rings: number): number[] {
  const seen = new Set([c]);
  let front = [c];
  const out = [c];
  for (let r = 0; r < rings; r++) {
    const next: number[] = [];
    for (const a of front) for (const n of w.grid.neighbors[a]) if (!seen.has(n)) { seen.add(n); next.push(n); out.push(n); }
    front = next;
  }
  return out;
}

/** Real height in metres a cell stands at (its water surface for a lake's level). */
function trueHeight(w: World, c: number, reliefM: number): number {
  const land = (e: number) => 15 + Math.pow(Math.max(0, e), 1.35) * reliefM;
  if (w.water[c] === WATER_OCEAN) return Math.min(-20, w.elevation[c] * 3000);
  if (w.water[c] === WATER_LAKE) return land(w.surface[c]) - 25;
  return land(w.elevation[c]);
}

/** A river's real width in metres from its flow: width grows with the square root of discharge. */
export function trueRiverWidth(w: World, c: number): number {
  return Math.max(8, Math.min(600, 12 * Math.sqrt(w.flow[c] / w.riverThreshold)));
}

export function buildLocalMap(w: World, cell: number, opts: Partial<LocalOptions> = {}): LocalMap {
  const o = { ...LOCAL_DEFAULTS, ...opts };
  const g = w.grid, P = g.centers, K = g.cornerPos;
  const R = o.radiusKm * 1000, reliefM = RELIEF_RADII * R;
  const seed = (w.params.seed * 7919 + cell * 104729) >>> 0;
  const noise: Noise3 = makeSimplex(seed);
  const rng = makeRng(seed ^ 0x5bd1e995);

  // Tangent frame at the cell: east, north, up. Gnomonic projection, then shrink by mag.
  const cx = P[cell * 3], cy = P[cell * 3 + 1], cz = P[cell * 3 + 2];
  let ex = cz, ey = 0, ez = -cx;                  // up (0,1,0) × centre
  let el = Math.hypot(ex, ey, ez);
  if (el < 1e-6) { ex = 1; ey = 0; ez = 0; el = 1; }
  ex /= el; ey /= el; ez /= el;
  const nx = cy * ez - cz * ey, ny = cz * ex - cx * ez, nz = cx * ey - cy * ex;
  const proj = (x: number, y: number, z: number, out: Float32Array, i: number) => {
    const d = x * cx + y * cy + z * cz;
    out[i] = (x * ex + y * ey + z * ez) / d * R / o.mag;
    out[i + 1] = (x * nx + y * ny + z * nz) / d * R / o.mag;
  };

  // The hex itself.
  const cc = g.corners[cell], hex = new Float32Array(cc.length * 2);
  let reach = 0;
  for (let k = 0; k < cc.length; k++) {
    const q = cc[k];
    proj(K[q * 3], K[q * 3 + 1], K[q * 3 + 2], hex, k * 2);
    reach = Math.max(reach, Math.hypot(hex[k * 2], hex[k * 2 + 1]));
  }
  let apothem = Infinity;                          // centre to the nearest edge
  for (let k = 0; k < cc.length; k++) {
    const ax = hex[k * 2], ay = hex[k * 2 + 1];
    const bx = hex[((k + 1) % cc.length) * 2], by = hex[((k + 1) % cc.length) * 2 + 1];
    apothem = Math.min(apothem, Math.abs(ax * by - ay * bx) / Math.hypot(bx - ax, by - ay));
  }
  const size = reach * 2 * 1.3;
  const res = o.res, step = size / (res - 1), half = size / 2;

  // Cells in reach.
  const cellList = ringsOf(w, cell, 3);
  const M = cellList.length;
  const cellXY = new Float32Array(M * 2);
  for (let i = 0; i < M; i++) {
    const c = cellList[i];
    proj(P[c * 3], P[c * 3 + 1], P[c * 3 + 2], cellXY, i * 2);
  }
  const indexOf = new Map(cellList.map((c, i) => [c, i]));
  const spacing = apothem * 2;                     // centre to centre
  const sigma2 = (0.5 * spacing) ** 2;

  const cellTrueH = new Float32Array(M), cellLocalH = new Float32Array(M), cellT = new Float32Array(M);
  const cellCol = new Float32Array(M * 3), cellWater = new Uint8Array(M);
  let lakeLevel = NaN;
  for (let i = 0; i < M; i++) cellTrueH[i] = trueHeight(w, cellList[i], reliefM);
  const toLocal = localHeights(o, cellTrueH[0]);
  for (let i = 0; i < M; i++) {
    const c = cellList[i];
    cellWater[i] = w.water[c] === WATER_OCEAN || w.water[c] === WATER_LAKE ? 1 : 0;
    cellLocalH[i] = toLocal(cellTrueH[i]);
    cellT[i] = tempC(w.temperature[c]);
    const hx = BIOMES[w.biome[c]].color;
    for (let k = 0; k < 3; k++) cellCol[i * 3 + k] = Math.pow(((hx >> (16 - 8 * k)) & 255) / 255, 2.2);
    if (w.water[c] === WATER_LAKE && Number.isNaN(lakeLevel)) lakeLevel = toLocal(cellTrueH[i] + 25 - 1);
  }

  // Blending the cells' values over the map: normalised Gaussian weights around each centre,
  // looked up at a noise-warped position so coasts and biome edges wander instead of tracing
  // circles. Weights are reused by every field.
  const warpL = spacing * 0.7, warpA = spacing * 0.28;
  const weights = new Float32Array(M);
  const blendAt = (x: number, y: number): number => {
    const wx = x + warpA * (noise(x / warpL, y / warpL, 3.1) + 0.5 * noise(x * 2.3 / warpL, y * 2.3 / warpL, 5.7));
    const wy = y + warpA * (noise(x / warpL, y / warpL, 9.4) + 0.5 * noise(x * 2.3 / warpL, y * 2.3 / warpL, 13.2));
    let sum = 0;
    for (let i = 0; i < M; i++) {
      const dx = wx - cellXY[i * 2], dy = wy - cellXY[i * 2 + 1];
      const d2 = dx * dx + dy * dy;
      const v = d2 > 9 * sigma2 ? 0 : Math.exp(-d2 / sigma2);
      weights[i] = v; sum += v;
    }
    if (sum < 1e-12) {                             // past every cell: take the nearest
      let best = 0, bd = Infinity;
      for (let i = 0; i < M; i++) {
        const d = (wx - cellXY[i * 2]) ** 2 + (wy - cellXY[i * 2 + 1]) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      weights.fill(0); weights[best] = 1; sum = 1;
    }
    for (let i = 0; i < M; i++) weights[i] /= sum;
    return sum;
  };

  const N = res * res;
  const heights = new Float32Array(N), baseTrue = new Float32Array(N), baseLocal = new Float32Array(N), tBase = new Float32Array(N);
  const snowW = new Float32Array(N);
  const colors = new Float32Array(N * 3), lakeMask = new Float32Array(N), wood = new Float32Array(N);
  const woodKind = new Int8Array(N).fill(-2);
  const oceanW = new Float32Array(N);
  let hiTrue = -Infinity, loTrue = Infinity;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = -half + i * step, y = -half + j * step, v = j * res + i;
      blendAt(x, y);
      let h = 0, ht = 0, t = 0, r = 0, gr = 0, b = 0, lake = 0, sea = 0, wd = 0, best = 0, bestW = 0, snow = 0;
      let lr = 0, lg = 0, lb = 0, lw = 0;
      for (let m = 0; m < M; m++) {
        const wt = weights[m];
        if (wt === 0) continue;
        const c = cellList[m];
        h += wt * cellLocalH[m]; ht += wt * cellTrueH[m]; t += wt * cellT[m];
        r += wt * cellCol[m * 3]; gr += wt * cellCol[m * 3 + 1]; b += wt * cellCol[m * 3 + 2];
        if (!cellWater[m]) { lr += wt * cellCol[m * 3]; lg += wt * cellCol[m * 3 + 1]; lb += wt * cellCol[m * 3 + 2]; lw += wt; }
        snow += wt * (SNOWY[w.biome[c]] ?? 0);
        if (w.water[c] === WATER_LAKE) lake += wt;
        if (w.water[c] === WATER_OCEAN) sea += wt;
        const wo = WOOD[w.biome[c]];
        if (wo) wd += wt * wo[0];
        if (wt > bestW) { bestW = wt; best = m; }
      }
      heights[v] = h; baseLocal[v] = h; baseTrue[v] = ht; tBase[v] = t; lakeMask[v] = lake; oceanW[v] = sea; wood[v] = wd; snowW[v] = snow;
      // Land takes its colour from land cells only, or a lagoon's turquoise tints the beach.
      if (lw > 0.02) { r = lr / lw; gr = lg / lw; b = lb / lw; }
      const wo = WOOD[w.biome[cellList[best]]];
      if (wo) woodKind[v] = wo[1];
      colors[v * 3] = r; colors[v * 3 + 1] = gr; colors[v * 3 + 2] = b;
      if (Math.hypot(x, y) < reach) { hiTrue = Math.max(hiTrue, ht); loTrue = Math.min(loTrue, ht); }
    }
  }

  // Walking-scale detail on top of the planet's shape, in local metres. Rolling ground everywhere,
  // in proportion to the hex's relief; crags (ridged noise, cliffs) only where it is mountainous.
  const reliefLocal = (hiTrue - loTrue) / o.vScale;
  // Rolling ground is capped: scaled with relief it turned an 8 km peak into a field of needles.
  const rollA = 1.5 + 0.02 * Math.min(reliefLocal, 300), rollL = 140;
  const cragL = Math.max(150, size * 0.32), cragA = size * 0.06;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = -half + i * step, y = -half + j * step, v = j * res + i;
      let d = 0, a = 1, f = 1 / rollL, nn = 0;
      for (let k = 0; k < 5; k++) { d += a * noise(x * f, y * f, 21 + k); nn += a; a *= 0.5; f *= 2.1; }
      heights[v] += rollA * d / nn;
      if (o.crags) {
        const mtn = smooth(1200, 4500, baseTrue[v]);
        if (mtn > 0) {
          // Ridged multifractal: sharp crests, each octave weighted by the one above it.
          let s = 0, amp = 1, fr = 1 / cragL, wgt = 1, norm = 0;
          for (let k = 0; k < 5; k++) {
            let n = 1 - Math.abs(noise(x * fr, y * fr, 41 + k * 3.3));
            n *= n * wgt;
            wgt = Math.min(1, n * 2);
            s += n * amp; norm += amp; amp *= 0.45; fr *= 2.05;
          }
          heights[v] += mtn * cragA * (s / norm - 0.25);
        }
      }
      // Lake beds sit below the lake's surface; the sea floor below the sea.
      if (lakeMask[v] > 0.5 && !Number.isNaN(lakeLevel)) heights[v] = Math.min(heights[v], lakeLevel - (lakeMask[v] - 0.5) * 12);
    }
  }

  // --- Rivers. Each river cell sends a piece from its centre, through the middle of the edge it
  // shares with the cell downstream, to that cell's centre: so a river crosses the hex boundary
  // exactly where the planet says. Pieces meander between those fixed points.
  const sampleH = (x: number, y: number): number => {
    const fi = Math.max(0, Math.min(res - 1.001, (x + half) / step));
    const fj = Math.max(0, Math.min(res - 1.001, (y + half) / step));
    const i0 = Math.floor(fi), j0 = Math.floor(fj), tx = fi - i0, ty = fj - j0;
    const a = heights[j0 * res + i0], b = heights[j0 * res + i0 + 1];
    const c2 = heights[(j0 + 1) * res + i0], d = heights[(j0 + 1) * res + i0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c2 * (1 - tx) + d * tx) * ty;
  };
  const edgeMid = (a: number, b: number): [number, number] | null => {
    const nb = g.neighbors[a];
    for (let k = 0; k < nb.length; k++) {
      if (nb[k] !== b) continue;
      const q0 = g.corners[a][k], q1 = g.corners[a][(k + 1) % nb.length];
      const tmp = new Float32Array(4);
      proj(K[q0 * 3], K[q0 * 3 + 1], K[q0 * 3 + 2], tmp, 0);
      proj(K[q1 * 3], K[q1 * 3 + 1], K[q1 * 3 + 2], tmp, 2);
      return [(tmp[0] + tmp[2]) / 2, (tmp[1] + tmp[3]) / 2];
    }
    return null;
  };
  const widthOf = (c: number) => {
    const wt = trueRiverWidth(w, c);
    return o.riverMode === 'scaled' ? wt / o.mag : Math.min(Math.max(6, wt * 0.8), size * 0.05);
  };

  const riverCells = cellList.filter((c) => w.river[c] && w.water[c] !== WATER_OCEAN);
  riverCells.sort((a, b) => w.flow[a] - w.flow[b]);         // upstream before downstream
  const levelIn = new Map<number, number>();
  const rivers: LocalRiver[] = [];
  const riverWidthsM: number[] = [];
  let riversHere = 0;
  for (const c of riverCells) {
    const d = w.downstream[c];
    if (d < 0 || !indexOf.has(d)) continue;
    if (w.water[c] === WATER_LAKE && w.water[d] === WATER_LAKE) continue;
    const i0 = indexOf.get(c)!, i1 = indexOf.get(d)!;
    const mid = edgeMid(c, d);
    if (!mid) continue;
    if (c === cell || d === cell) { riversHere++; if (c === cell) riverWidthsM.push(Math.round(trueRiverWidth(w, c))); }
    const ax = cellXY[i0 * 2], ay = cellXY[i0 * 2 + 1], bx = cellXY[i1 * 2], by = cellXY[i1 * 2 + 1];
    // Quadratic through centre, edge middle, next centre (control point solved so it passes mid).
    const qx = 2 * mid[0] - (ax + bx) / 2, qy = 2 * mid[1] - (ay + by) / 2;
    const len = Math.hypot(mid[0] - ax, mid[1] - ay) + Math.hypot(bx - mid[0], by - mid[1]);
    const n = 2 * Math.max(4, Math.ceil(len / Math.max(3, step * 2) / 2));   // even: t = 0.5 is a point
    const width = widthOf(c);
    const meander = Math.min(spacing * 0.12, 30 + width * 6);
    const pts = new Float32Array((n + 1) * 4);
    const isLake = w.water[c] === WATER_LAKE;
    let level = isLake ? lakeLevel : Math.min(levelIn.get(c) ?? Infinity, sampleH(ax, ay) - 0.5);
    for (let s = 0; s <= n; s++) {
      const t = s / n, u = 1 - t;
      let x = u * u * ax + 2 * u * t * qx + t * t * bx;
      let y = u * u * ay + 2 * u * t * qy + t * t * by;
      // Sideways wander, pinned to zero at the centres and at the edge crossing (t = 0.5).
      const tx = 2 * u * (qx - ax) + 2 * t * (bx - qx), ty = 2 * u * (qy - ay) + 2 * t * (by - qy);
      const tl = Math.hypot(tx, ty) || 1;
      const pin = Math.sin(t * Math.PI * 2) ** 2;
      const m = meander * pin * noise(x / (meander * 4 + 40), y / (meander * 4 + 40), 61 + (c % 97));
      x += (-ty / tl) * m; y += (tx / tl) * m;
      if (s > 0 && !isLake) level = Math.min(level, sampleH(x, y) - 0.5);
      pts[s * 4] = x; pts[s * 4 + 1] = y; pts[s * 4 + 2] = level; pts[s * 4 + 3] = width;
    }
    if (w.water[d] === WATER_OCEAN) for (let s = 0; s <= n; s++) pts[s * 4 + 2] = Math.max(pts[s * 4 + 2], -0.3);
    levelIn.set(d, Math.min(levelIn.get(d) ?? Infinity, level));
    rivers.push({ pts });
  }

  // Carve each river: a channel under the water and a valley floor easing out to the land.
  const riverNear = new Float32Array(N).fill(Infinity);   // distance to water, in widths
  for (const rv of rivers) {
    const p = rv.pts, n = p.length / 4;
    for (let s = 0; s < n - 1; s++) {
      const x0 = p[s * 4], y0 = p[s * 4 + 1], l0 = p[s * 4 + 2], w0 = p[s * 4 + 3];
      const x1 = p[s * 4 + 4], y1 = p[s * 4 + 5], l1 = p[s * 4 + 6];
      const depth = Math.max(1, 0.12 * w0);
      const valley = w0 * 2.5 + 25;
      const reachR = w0 / 2 + valley;
      const iA = Math.max(0, Math.floor((Math.min(x0, x1) - reachR + half) / step));
      const iB = Math.min(res - 1, Math.ceil((Math.max(x0, x1) + reachR + half) / step));
      const jA = Math.max(0, Math.floor((Math.min(y0, y1) - reachR + half) / step));
      const jB = Math.min(res - 1, Math.ceil((Math.max(y0, y1) + reachR + half) / step));
      const sx = x1 - x0, sy = y1 - y0, sl2 = sx * sx + sy * sy || 1;
      for (let j = jA; j <= jB; j++) {
        for (let i = iA; i <= iB; i++) {
          const x = -half + i * step, y = -half + j * step, v = j * res + i;
          const t = Math.max(0, Math.min(1, ((x - x0) * sx + (y - y0) * sy) / sl2));
          const dist = Math.hypot(x - x0 - sx * t, y - y0 - sy * t);
          if (dist > reachR) continue;
          const lv = l0 + (l1 - l0) * t;
          const h = heights[v];
          let target: number;
          if (dist < w0 / 2) target = lv - depth * (1 - (2 * dist / w0) ** 2);
          else target = h > lv ? lv + 0.4 + (h - lv - 0.4) * smooth(w0 / 2, reachR, dist) : h;
          if (target < h) heights[v] = target;
          riverNear[v] = Math.min(riverNear[v], dist / Math.max(1, w0 / 2));
        }
      }
    }
  }
  const sea = cellList.some((c) => w.water[c] === WATER_OCEAN);

  // --- Colour: the planet's biome blend, then rock on steep ground, snow where it is cold enough
  // at this height, sand by the sea, mud and wet grass along rivers.
  let loH = Infinity, hiH = -Infinity;
  for (let v = 0; v < N; v++) { loH = Math.min(loH, heights[v]); hiH = Math.max(hiH, heights[v]); }
  const ROCK = [0.17, 0.15, 0.13], SNOW = [0.85, 0.87, 0.9], SAND = [0.62, 0.54, 0.38], MUD = [0.12, 0.1, 0.07];
  const mix = (v: number, c: number[], t: number) => {
    for (let k = 0; k < 3; k++) colors[v * 3 + k] += (c[k] - colors[v * 3 + k]) * t;
  };
  const colourNoise = (x: number, y: number) => noise(x / 23, y / 23, 77) * 0.6 + noise(x / 7, y / 7, 79) * 0.4;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const v = j * res + i, x = -half + i * step, y = -half + j * step;
      const hL = heights[(j) * res + Math.max(0, i - 1)], hR = heights[j * res + Math.min(res - 1, i + 1)];
      const hD = heights[Math.max(0, j - 1) * res + i], hU = heights[Math.min(res - 1, j + 1) * res + i];
      const slope = Math.hypot(hR - hL, hU - hD) / (2 * step);
      const h = heights[v];
      const cn = colourNoise(x, y);
      // Real altitude here, for temperature: local height back to true metres.
      const T = tBase[v] - 0.0065 * (h - baseLocal[v]) * o.vScale;
      const jit = 1 + 0.08 * cn;
      for (let k = 0; k < 3; k++) colors[v * 3 + k] *= jit;
      if (sea && h < 2.5 && oceanW[v] > 0.05 && T > -2) mix(v, SAND, smooth(2.5, 0.8, h));
      if (riverNear[v] < 1) mix(v, MUD, 0.8);
      else if (riverNear[v] < 4) for (let k = 0; k < 3; k++) colors[v * 3 + k] *= 0.88;
      mix(v, ROCK, smooth(0.55, 1.1, slope + 0.15 * cn));
      // Snow: cold enough here, or a snowy biome's upper ground (Mundi's temperatures run warm on
      // peaks; its own renderer also snows by biome and height).
      const above = (h - loH) / Math.max(1, hiH - loH);
      const snow = Math.max(smooth(-1, -6, T + 2 * cn), smooth(1 - snowW[v], 1.2 - snowW[v], above + 0.05 * cn)) * (1 - smooth(0.9, 1.4, slope));
      mix(v, SNOW, snow);
      if (h < 0) for (let k = 0; k < 3; k++) colors[v * 3 + k] *= 0.6;
      // Warmth-limited trees: the tree line follows temperature, so it climbs with the variant's heights.
      wood[v] *= smooth(-3, 1, T) * (1 - smooth(0.6, 0.9, slope)) * (riverNear[v] < 1.6 ? 0 : 1);
      if (h < 0.3 || (lakeMask[v] > 0.45 && h < lakeLevel + 0.2)) wood[v] = 0;
    }
  }

  // --- Trees, life-size, on a jittered 7 m grid, clumped into groves by noise.
  const treeOut: number[] = [];
  const TS = 7, cnt = Math.floor(size / TS);
  for (let b = 0; b < cnt; b++) {
    for (let a = 0; a < cnt; a++) {
      const x = -half + (a + rng()) * TS, y = -half + (b + rng()) * TS;
      const r1 = rng(), r2 = rng(), r3 = rng();
      const i = Math.round((x + half) / step), j = Math.round((y + half) / step);
      const v = j * res + i;
      const clump = smooth(-0.35, 0.45, noise(x / 60, y / 60, 91) + 0.4 * noise(x / 17, y / 17, 93));
      const p = wood[v] * (0.25 + 1.1 * clump);
      if (r1 >= p) continue;
      let kind = woodKind[v];
      if (kind === -2) continue;
      if (kind === -1) kind = r2 < 0.5 ? TREE_CONIFER : TREE_BROAD;
      const T = tBase[v];
      if (kind === TREE_BROAD && T < 2 && r2 < 0.7) kind = TREE_CONIFER;
      const tall = kind === TREE_CONIFER ? 14 + 12 * r3 : kind === TREE_BROAD ? 11 + 10 * r3 : kind === TREE_PALM ? 9 + 7 * r3 : 1.2 + 2 * r3;
      treeOut.push(x, y, sampleH(x, y), tall * (0.6 + 0.4 * wood[v] / 1), kind);
    }
  }

  // The planet's picture, for the inset.
  const polyStart = new Int32Array(M + 1), polyArr: number[] = [], tmp2 = new Float32Array(2);
  for (let i = 0; i < M; i++) {
    polyStart[i] = polyArr.length / 2;
    for (const q of g.corners[cellList[i]]) { proj(K[q * 3], K[q * 3 + 1], K[q * 3 + 2], tmp2, 0); polyArr.push(tmp2[0], tmp2[1]); }
  }
  polyStart[M] = polyArr.length / 2;
  const planetRivers: number[] = [];
  for (const c of cellList) {
    const d = w.downstream[c];
    if (!w.river[c] || d < 0 || !indexOf.has(d) || w.water[c] === WATER_OCEAN) continue;
    const mid = edgeMid(c, d);
    if (!mid) continue;
    const a = indexOf.get(c)!, b = indexOf.get(d)!;
    planetRivers.push(cellXY[a * 2], cellXY[a * 2 + 1], mid[0], mid[1], cellXY[b * 2], cellXY[b * 2 + 1]);
  }

  const ci = indexOf.get(cell)!;
  return {
    polyStart, polyXY: new Float32Array(polyArr), planetRivers: new Float32Array(planetRivers),
    cellRGB: Int32Array.from(cellList, (c) => BIOMES[w.biome[c]].color),
    cell, res, size,
    trueWidthKm: apothem * 2 * o.mag / 1000,
    localWidth: apothem * 2,
    heights, colors, sea, lakeLevel, lakeMask, rivers, hex,
    trees: new Float32Array(treeOut),
    cells: Int32Array.from(cellList), cellXY,
    info: {
      biome: BIOMES[w.biome[cell]].name,
      trueHeightM: Math.round(cellTrueH[ci]),
      tempC: Math.round(cellT[ci]),
      riverWidthsM, rivers: riversHere,
    },
  };
}

/** Where a river piece crosses the hex edge: its point at t = 0.5 (tests check it is the edge middle). */
export function riverCrossings(m: LocalMap): [number, number][] {
  return m.rivers.map((r) => {
    const s = (r.pts.length / 4 - 1) / 2;
    return [r.pts[s * 4], r.pts[s * 4 + 1]];
  });
}
