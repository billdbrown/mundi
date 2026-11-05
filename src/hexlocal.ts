/**
 * One planet hex, opened up as a local map you could walk around (RimWorld-style drill-down).
 *
 * The whole hex is fitted into a map `mag` times smaller than it really is (compressed scale):
 * a 13 km hex at mag 10 becomes a 1.3 km map, while people, trees and houses stay life-size.
 * The planet decides the layout: where the coast is, which way the land slopes, which edges a
 * river enters and leaves by. The options decide how big each feature is drawn. The defaults
 * are "content-aware 10×", picked 2026-11-03 over a plain shrink at 10× and 20×:
 *
 * - `vScale` divides heights. Equal to `mag` is a plain shrink (a 1 km mountain becomes 100 m);
 *   smaller keeps more relief and makes slopes steeper.
 * - `riverMode` 'scaled' shrinks rivers with everything else; 'flow' sizes them from their flow,
 *   life-size, so a big river still needs a bridge.
 * - `crags` adds walking-scale mountain detail (ridges, cliffs) where the planet is mountainous.
 *
 * Colours and plants follow the planet's Earth look: its biome colours, then the same climate
 * patterns its terrain shader draws (sky.ts: mottled grass, dark canopy with clearings, green
 * river strips, an alpine band and snow from its temperature model), and its own plant models in
 * the same per-biome mix (flora.ts FLORA_RICH), at life size.
 *
 * Pure and deterministic for a world, cell and options, so it runs in a worker and under Node.
 * Local coordinates are metres: x east, y north, h up, origin at the cell's centre.
 */
import type { World } from './world.ts';
import { WATER_LAKE, WATER_LAND, WATER_OCEAN } from './world.ts';
import { B, BIOMES } from './biomes.ts';
import { makeSimplex, type Noise3 } from './noise.ts';
import { makeRng, hash01 } from './rng.ts';
import { FLORA_RICH, CONIFER, BROADLEAF, SCRUB, PALM, ROCK as ROCK_KIND, CACTUS, ACACIA, BIRCH, TUFT, type TreeKind } from './flora.ts';
import { FIRST, VARIANTS as SPECIES_VARIANTS, FAMILIES } from './species.ts';
import { climateColour, ECO, OWN_COLOUR, planetGround, SEA, type PlanetGround, type GroundSample } from './surface.ts';
import { Color } from 'three';
import { patchLift, type ValleyField, type ReliefInput } from './relief.ts';
import type { History } from './civ.ts';
import { layoutTowns, HOUSE_STRIDE } from './hextown.ts';
export { HOUSE_STRIDE };

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
  /** Walking-scale ridges and cliffs of the hex view's own where the planet is mountainous. Off:
   * the planet's own relief (relief.ts) now draws its ranges, and these drew different ones. */
  crags: boolean;
  /** Grid samples per side. */
  res: number;
  /** What the planet's radius means in km (main.ts radiusKm). */
  radiusKm: number;
  /** How much ground around the hex, as a multiple of the usual square (1). The backdrop of
   * neighbouring hexes uses about 3. */
  extent: number;
  /** Plants (trees, shrubs, tufts). Off for the backdrop, which is drawn blurred. */
  plants: boolean;
}

/** Heights shrink as much as the ground does (vScale = mag, 2026-11-04): the hex's hills and
 * ranges then have the shapes the planet draws. The 10x content-aware default before it (vScale 2,
 * soft squeeze) turned the same ground into spikes. */
export const LOCAL_DEFAULTS: LocalOptions = { mag: 10, vScale: 10, vSoft: 0, riverMode: 'flow', crags: false, res: 513, radiusKm: 640, extent: 1, plants: true };

export interface LocalRiver {
  /** Per point: x, y, water level, width (local metres). */
  pts: Float32Array;
}

/**
 * Ground layers per sample, so a style can repaint the ground in its own palette without
 * regenerating (hexstyle.ts). Each 0..1 unless noted, LAYERS values per sample.
 */
export const L_GRASS = 0, L_MOTTLE = 1, L_FOREST = 2, L_ROCK = 3, L_SNOW = 4, L_SAND = 5, L_BED = 6,
  L_LUSH = 7, L_ALPINE = 8, L_DEPTH = 9, L_AO = 10, L_CLEARING = 11, L_PATH = 12, L_FIELD = 13, L_FIELDKIND = 14, L_HEDGE = 15, L_ELEV = 16;
/** (L_DEPTH is metres of water over the ground, 0 on land; L_AO how sunken the spot is, a crease;
 * L_FIELDKIND which crop a field grows, 0..1; L_HEDGE how close to a field's edge.) */
/** L_ELEV: how high a sample stands on this map's own land, 0..1, scaled down where the map is
 * nearly flat: for styles that paint mountains their own way (alpine, rock, snow caps). */
export const LAYERS = 17;

/** Plant kinds the hex adds to the planet's own (flora.ts, species.ts): drawn only from the
 * plant pack (hexplants.ts), so they appear once it has loaded. */
export const H_STUMP = 100, H_LOG = 101, H_LILYPAD = 103, H_DEAD = 104, H_FERN = 105;
/** Flowers, a kind per petal colour (H_FLOWERS + 0..FLOWER_COLOURS-1), so a patch is one colour. */
export const H_FLOWERS = 110, FLOWER_COLOURS = 5;
export const isFlower = (k: number) => k >= H_FLOWERS && k < H_FLOWERS + FLOWER_COLOURS;
export const isHexKind = (k: number) => k >= 100;

export interface LocalMap {
  cell: number;
  res: number;
  /** Side of the square map, local metres. The hex fits inside with a margin of its neighbours. */
  size: number;
  /** Width of the hex across its flats: really (km) and as drawn (local m). */
  trueWidthKm: number;
  localWidth: number;
  heights: Float32Array;
  /** Linear RGB per sample: the planet's Earth look, ready to draw. */
  colors: Float32Array;
  /** Linear RGB per sample: the climate palette alone, before any ground patterns. */
  base: Float32Array;
  /** LAYERS values per sample (L_GRASS...). */
  layers: Float32Array;
  /** Where the hex is on the planet: its centre, east and north, unit vectors (9 values), and the
   * scale it was drawn at, so a view can put the map back in planet coordinates. */
  frame: Float32Array;
  mag: number;
  radiusKm: number;
  /** Placeholder houses where the history put towns (hextown.ts), HOUSE_STRIDE values each. */
  houses: Float32Array;
  townNames: string[];
  /** Sea level is 0 (when the map has sea). */
  sea: boolean;
  /** Lake surface and a 0..1 mask of where it is, or NaN level for none. */
  lakeLevel: number;
  lakeMask: Float32Array;
  rivers: LocalRiver[];
  /** Hex corners, x y pairs. */
  hex: Float32Array;
  /** Per plant: x, y, h, scale (metres per model unit), kind (flora.ts), colour (0xRRGGBB, shade applied). */
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

/** Metres per model unit for each plant kind (models are about one unit tall), so plants are
 * drawn life-size: a conifer ~18 m, a tussock under a metre. */
function plantMetres(kind: TreeKind): number {
  if (kind >= FIRST) {
    const f = FAMILIES[Math.floor((kind - FIRST) / SPECIES_VARIANTS)];
    return ({ spruce: 16, umbrellaPine: 13, cypress: 11, oak: 17, poplar: 17, willow: 12, eucalypt: 19, emergent: 26,
      baobab: 16, joshua: 8, royalPalm: 15, roundShrub: 4, reeds: 2.6, pricklyPear: 3, mangrove: 9, treeFern: 6 } as Record<string, number>)[f] ?? 12;
  }
  return ({ [CONIFER]: 15, [BROADLEAF]: 15, [SCRUB]: 4, [PALM]: 12, [ROCK_KIND]: 3, [CACTUS]: 6, [ACACIA]: 9, [BIRCH]: 13, [TUFT]: 1.6 } as Record<number, number>)[kind] ?? 10;
}
/** Small things (grass tussocks, shrubs, rocks, reeds): they grow on open ground and steeper slopes. */
function isSmall(kind: TreeKind): boolean {
  if (kind >= FIRST) return plantMetres(kind) <= 4;
  return kind === TUFT || kind === SCRUB || kind === ROCK_KIND || kind === CACTUS;
}
/** Per biome: the trees and the small things, each with weights summing to its density. */
const PLANTING = new Map<number, { trees: [TreeKind, number, number, number][]; small: [TreeKind, number, number, number][]; treeD: number; smallD: number }>();
function plantingOf(biome: number) {
  let p = PLANTING.get(biome);
  if (!p) {
    const list = (FLORA_RICH[biome] ?? []).map(([k, c, d, sz]) => [k, c, d, sz ?? 1] as [TreeKind, number, number, number]);
    const trees = list.filter((e) => !isSmall(e[0])), small = list.filter((e) => isSmall(e[0]));
    p = { trees, small, treeD: trees.reduce((a, e) => a + e[2], 0), smallD: small.reduce((a, e) => a + e[2], 0) };
    PLANTING.set(biome, p);
  }
  return p;
}
const pick = (list: [TreeKind, number, number, number][], total: number, r: number) => {
  let acc = 0;
  for (const e of list) { acc += e[2]; if (r * total < acc) return e; }
  return list[list.length - 1];
};

/** Real metres to map metres. Sea level stays 0; see LocalOptions.vSoft. */
export function localHeights(o: LocalOptions, centreTrue: number): (t: number) => number {
  if (!(o.vSoft > 0)) return (t) => t / o.vScale;
  const F = (d: number) => o.vSoft * Math.asinh(d / o.vSoft) / o.vScale;
  const zero = F(-centreTrue);
  return (t) => F(t - centreTrue) - zero;
}

/** Mean of a res x res field over a (2r+1)-square window, by two running-sum passes. */
function boxBlur(f: Float32Array, res: number, r: number): Float32Array {
  const tmp = new Float32Array(f.length), out = new Float32Array(f.length);
  for (let pass = 0; pass < 2; pass++) {
    const src = pass === 0 ? f : tmp, dst = pass === 0 ? tmp : out;
    for (let a = 0; a < res; a++) {
      let sum = 0, cnt = 0;
      const at = (b: number) => (pass === 0 ? a * res + b : b * res + a);
      for (let b = 0; b < Math.min(res, r); b++) { sum += src[at(b)]; cnt++; }
      for (let b = 0; b < res; b++) {
        if (b + r < res) { sum += src[at(b + r)]; cnt++; }
        if (b - r - 1 >= 0) { sum -= src[at(b - r - 1)]; cnt--; }
        dst[at(b)] = sum / cnt;
      }
    }
  }
  return out;
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

/** The planet's ground formula per world (surface.ts planetGround), shared by every hex built on it. */
const grounds = new WeakMap<World, PlanetGround>();
/** Planet radii above the sea where the planet's lowest land starts (surface.ts landH). */
const LAND0 = 0.0012;

/** The planet's densest planting (expected plants per cell), as a full grove. */
const FULL = 15;

/** What placePlants needs from buildLocalMap (the map's grids, its noise and helpers). */
interface PlantInput {
  w: World; size: number; half: number; step: number; res: number;
  rng: () => number; noise: Noise3;
  layers: Float32Array; tempV: Float32Array; moistV: Float32Array; lakeMask: Float32Array; lakeLevel: number;
  riverNear: Float32Array; grow: Float32Array; treeLine: Float32Array; owner: Int16Array; cellList: number[];
  sampleH: (x: number, y: number) => number;
  groveIn: (x: number, y: number, dens: number) => number;
}

/**
 * The plants, six values each: x, y, ground height, metres, kind, colour.
 * (Its own function: inside buildLocalMap, already huge, it made the browser optimise the whole
 * build less well, ~0.6 s slower on a hex though the planting itself took 0.15 s.)
 */
function placePlants(P: PlantInput): Float32Array {
  const { w, size, half, step, res, rng, noise, layers, tempV, moistV, lakeMask, lakeLevel, riverNear, grow, treeLine, owner, cellList, sampleH, groveIn } = P;
  const treeOut: number[] = [];
  const famKind = (f: (typeof FAMILIES)[number]) => FIRST + FAMILIES.indexOf(f) * SPECIES_VARIANTS;
  const REEDS = famKind('reeds'), WILLOW = famKind('willow');
  const at = (x: number, y: number) => {
    const i = Math.max(0, Math.min(res - 1, Math.round((x + half) / step))), j = Math.max(0, Math.min(res - 1, Math.round((y + half) / step)));
    return j * res + i;
  };
  const put = (x: number, y: number, z: number, kind: number, metres: number, colour: number, r: number) => {
    const shade = 0.85 + 0.3 * r;
    const rr = Math.min(255, ((colour >> 16) & 255) * shade), gg = Math.min(255, ((colour >> 8) & 255) * shade), bb = Math.min(255, (colour & 255) * shade);
    treeOut.push(x, y, z, metres, kind, (Math.round(rr) << 16) | (Math.round(gg) << 8) | Math.round(bb));
  };
  /** Several of a kind round (x, y): a patch of flowers, a stand of reeds. One alone is lost. */
  const clump = (x: number, y: number, kind: number, n: number, radius: number, metres: number, colour: number) => {
    for (let k = 0; k < n; k++) {
      const ang = rng() * Math.PI * 2, d = radius * Math.sqrt(rng()), px = x + Math.cos(ang) * d, py = y + Math.sin(ang) * d;
      put(px, py, sampleH(px, py), kind, metres * (0.7 + 0.6 * rng()), colour, rng());
    }
  };
  /** The biome's own colour for a small kind (its grass, its shrubs), else a fallback. */
  const colourOf = (pl: ReturnType<typeof plantingOf>, kind: number, fallback: number) => pl.small.find((e) => e[0] === kind)?.[1] ?? fallback;
  const TS = 7, cnt = Math.floor(size / TS);
  for (let b = 0; b < cnt; b++) {
    for (let a = 0; a < cnt; a++) {
      const x = -half + (a + rng()) * TS, y = -half + (b + rng()) * TS;
      const r1 = rng(), r2 = rng(), r3 = rng(), r4 = rng(), r5 = rng(), r6 = rng(), r7 = rng();
      const v = at(x, y), L0 = v * LAYERS;
      const temp = tempV[v], moist = moistV[v], depth = layers[L0 + L_DEPTH], snow = layers[L0 + L_SNOW];
      // Water lilies in groups near a lake's shore, in warm and temperate country. (By distance
      // to the shore, not depth: the lakes here shelve to 15-40 m within a few metres.)
      if (depth > 0) {
        if (lakeMask[v] > 0.5 && !Number.isNaN(lakeLevel) && temp > 0.3 && r1 < 0.3 * smooth(0.2, 0.45, moist)) {
          let shore = 0;
          for (let k = 0; k < 8 && !shore; k++) {
            const ca = Math.cos(k * 0.785 + r5), sa = Math.sin(k * 0.785 + r5);
            if (layers[at(x + ca * 8, y + sa * 8) * LAYERS + L_DEPTH] === 0) shore = 1;
            else if (layers[at(x + ca * 16, y + sa * 16) * LAYERS + L_DEPTH] === 0) shore = 0.4;
          }
          if (r6 < shore) for (let k = 0, n = 4 + Math.floor(r3 * 6); k < n; k++) {
            const px = x + (rng() - 0.5) * 5, py = y + (rng() - 0.5) * 5;
            if (layers[at(px, py) * LAYERS + L_DEPTH] > 0) put(px, py, lakeLevel + 0.1, H_LILYPAD, 0.6 + 0.9 * rng(), 0x5a8a34, rng());   // (just above the surface, or the water hides the pads)
          }
        }
        continue;
      }
      // The biome a plant belongs to is read a little way off, warped and jittered, so at a
      // border the two biomes' plants interleave over ~100 m.
      const wx = x + 45 * noise(x / 60, y / 60, 131) + 60 * (r5 - 0.5), wy = y + 45 * noise(x / 60, y / 60, 133) + 60 * (r6 - 0.5);
      const pl = plantingOf(w.biome[cellList[owner[at(wx, wy)]]]);
      const z = sampleH(x, y);
      // Banks: reeds in a band along rivers and round lakes, willows behind them.
      const rn = riverNear[v];
      const bank = snow > 0.3 ? 0 : Math.max(rn >= 1.1 && rn < 3.2 ? smooth(3.2, 1.6, rn) : 0, lakeMask[v] > 0.03 ? smooth(0.03, 0.25, lakeMask[v]) : 0);
      if (bank > 0 && temp > 0.2) {
        if (r1 < 0.5 * bank) {
          if (temp > 0.28) clump(x, y, REEDS + Math.floor(r2 * SPECIES_VARIANTS), 3 + Math.floor(r3 * 4), 1.6, 2.4, 0x5d7a36);
          else put(x, y, z, TUFT, 1.6 * (0.7 + 0.5 * r3), 0x6b7038, r4);
          continue;
        }
        if (temp > 0.3 && moist > 0.28 && r1 < 0.58 * bank) { put(x, y, z, WILLOW + Math.floor(r2 * SPECIES_VARIANTS), 12 * (0.7 + 0.5 * r3), 0x467a2e, r4); continue; }
      }
      // Bare rock: boulders, more on the steepest.
      const rock = layers[L0 + L_ROCK];
      if (rock > 0.3 && r7 < 0.05 * rock) { put(x, y, z, ROCK_KIND, (1.6 + 3.5 * r3 * r3), 0x74716c, r4); continue; }
      if (grow[v] <= 0) continue;
      const tl = treeLine[v];                     // 1 below the tree line, 0 above it
      const g = groveIn(x, y, pl.treeD / FULL);   // 1 deep in a grove, 0 in the open
      const pTree = pl.treeD > 0 ? (0.015 + 0.8 * g) * Math.min(1, pl.treeD / 5) * grow[v] * tl : 0;
      if (pl.trees.length && r1 < pTree) {
        let [kind, colour, , sz] = pick(pl.trees, pl.treeD, r2);
        let metres = plantMetres(kind) * sz * (0.75 + 0.5 * r3);
        // Towards the tree line the trees turn to conifers and shrink.
        if (tl < 0.95 && r7 < 1 - tl) { kind = CONIFER; colour = 0x385036; }
        metres *= 0.4 + 0.6 * tl;
        // The odd dead tree: in old groves, near the tree line, in dry country.
        const pDead = 0.02 * g + 0.1 * (1 - tl) + 0.06 * smooth(0.25, 0.12, moist);
        // (Not conifers: the pack has no dead pine, and a bare oak in a pine wood looks wrong.)
        const conifer = kind === CONIFER || (kind >= FIRST && ['spruce', 'umbrellaPine', 'cypress'].includes(FAMILIES[Math.floor((kind - FIRST) / SPECIES_VARIANTS)]));
        if (r6 < pDead && !conifer && kind !== PALM && kind !== CACTUS) kind = H_DEAD;
        put(x, y, z, kind, metres, colour, r4);
        continue;
      }
      // No tree here. What grows in its place depends on where it is.
      const lush = smooth(0.3, 0.55, moist);
      const edge = pl.treeD > 1 ? 4 * g * (1 - g) : 0;                           // a grove's margin
      const clearing = pl.treeD > 2 ? smooth(0.3, 0.05, g) : 0;                  // open ground in a forest
      const grass = layers[L0 + L_GRASS], mottle = layers[L0 + L_MOTTLE];
      const meadow = smooth(0.1, 0.5, noise(x / 38, y / 38, 141) + 0.3 * noise(x / 11, y / 11, 143));
      const above = 1 - tl;                                                      // past the tree line
      const cold = temp < 0.2;
      const extras: [number, number, number, number][] = [   // kind, chance, metres, colour
        [SCRUB, 0.3 * edge * tl + 0.08 * above, (above > 0.5 ? 1.6 : 3) * (0.7 + 0.6 * r3), colourOf(pl, SCRUB, 0x56703a)],
        [H_FLOWERS, cold ? 0 : (0.22 * clearing + 0.14 * grass) * meadow * lush, 0.6, 0x5a7a34],
        [H_FERN, 0.16 * smooth(0.5, 0.9, g) * lush * tl * smooth(0.2, 0.3, temp), 1.1, 0x3f6a2a],
        [H_LOG, 0.012 * g + 0.006 * clearing, 3 + 3 * r3, 0],
        [H_STUMP, 0.004 * g + 0.012 * clearing, 0.5 + 0.4 * r3, 0],
        [TUFT, 0.35 * above * (1 - rock), 1.4 * (0.6 + 0.7 * r3), colourOf(pl, TUFT, 0x6e6a44)],
        [ROCK_KIND, 0.04 * above + 0.02 * smooth(0.22, 0.1, moist) + 0.008 * g, (0.6 + 1.6 * r3 * r3), 0x74716c],
      ];
      let acc = 0, done = false;
      for (const [kind, p, metres, colour] of extras) {
        acc += p;
        if (r7 < acc) {
          if (kind === H_FLOWERS) clump(x, y, H_FLOWERS + Math.floor(r2 * FLOWER_COLOURS), 6 + Math.floor(r3 * 10), 2.2, metres, colour);
          else if (kind === H_FERN) clump(x, y, kind, 2 + Math.floor(r3 * 3), 1.5, metres, colour);
          else put(x, y, z, kind, metres, colour, r4);
          done = true; break;
        }
      }
      if (done) continue;
      // Else the biome's own small things; grass thicker in the mottle's lush patches.
      const pSmall = Math.min(0.6, pl.smallD / (FULL * 1.6)) * grow[v] * (grass > 0.2 ? 0.5 + mottle : 1);
      if (pl.small.length && r1 > 1 - pSmall) {
        const [kind, colour, , sz] = pick(pl.small, pl.smallD, r2);
        put(x, y, z, kind, plantMetres(kind) * sz * (0.75 + 0.5 * r3), colour, r4);
      }
    }
  }
  return new Float32Array(treeOut);
}

export function buildLocalMap(w: World, cell: number, opts: Partial<LocalOptions> = {}, history?: History, valleys: ValleyField | null = null): LocalMap {
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
  // The usual square; the backdrop asks for more ground (extent) but the same terrain, so every
  // scale below is taken from the usual square, not the wider one.
  const baseSize = reach * 2 * 1.3, size = baseSize * o.extent;
  const res = o.res, step = size / (res - 1), half = size / 2;

  // Cells in reach.
  const cellList = ringsOf(w, cell, 3 + Math.ceil((o.extent - 1) * 2.5));
  const M = cellList.length;
  const cellXY = new Float32Array(M * 2);
  for (let i = 0; i < M; i++) {
    const c = cellList[i];
    proj(P[c * 3], P[c * 3 + 1], P[c * 3 + 2], cellXY, i * 2);
  }
  const indexOf = new Map(cellList.map((c, i) => [c, i]));
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
  /** Where water crosses from cell a into b, as the planet's rivers do (render.ts buildRivers):
   * a fixed point along the shared edge, 30-70% of the way from its lower-numbered corner. */
  const edgeCross = (a: number, b: number): [number, number] | null => {
    const nb = g.neighbors[a];
    for (let k = 0; k < nb.length; k++) {
      if (nb[k] !== b) continue;
      let q0 = g.corners[a][k], q1 = g.corners[a][(k + 1) % nb.length];
      if (q0 > q1) [q0, q1] = [q1, q0];
      const t = 0.3 + 0.4 * hash01(q0 * 7919 + q1);
      const tmp = new Float32Array(2);
      proj(K[q0 * 3] + (K[q1 * 3] - K[q0 * 3]) * t, K[q0 * 3 + 1] + (K[q1 * 3 + 1] - K[q0 * 3 + 1]) * t, K[q0 * 3 + 2] + (K[q1 * 3 + 2] - K[q0 * 3 + 2]) * t, tmp, 0);
      return [tmp[0], tmp[1]];
    }
    return null;
  };
  /** Water the planet draws through a cell: rivers, and streams down to 0.35 of a river's flow
   * on unfrozen land (render.ts buildRivers), which it shows up close. */
  const STREAM = 0.35 * w.riverThreshold;
  const flows = (c: number) => w.water[c] !== WATER_OCEAN && (w.river[c] === 1 || (w.water[c] === WATER_LAND && w.temperature[c] > 0.12 && w.flow[c] >= STREAM));
  const spacing = apothem * 2;                     // centre to centre
  const sigma2 = (0.5 * spacing) ** 2;

  const cellTrueH = new Float32Array(M), cellLocalH = new Float32Array(M), cellT = new Float32Array(M);
  const cellMoist = new Float32Array(M), cellTemp = new Float32Array(M);
  const cellCol = new Float32Array(M * 3), cellWater = new Uint8Array(M);
  let lakeLevel = NaN;
  for (let i = 0; i < M; i++) { cellTrueH[i] = trueHeight(w, cellList[i], reliefM); cellT[i] = tempC(w.temperature[cellList[i]]); cellMoist[i] = w.moisture[cellList[i]]; cellTemp[i] = w.temperature[cellList[i]]; }
  const toLocal = localHeights(o, cellTrueH[0]);
  // The ground is the planet's own (surface.ts planetGround): the same formula its terrain mesh is
  // drawn from, so coasts, peninsulas and ranges are the ones the planet shows. Its heights are in
  // planet radii; as real metres, the band just above the sea where it starts its land (beaches)
  // is the first BAND metres, and the sea floor shelves away.
  let G = grounds.get(w);
  if (!G) { G = planetGround(w, 1); grounds.set(w, G); }
  // (The band was the first 15 m once; at true vertical scale that made shores so flat that sea
  // and ground fought for the same pixels and the planet's shoal noise stood up as sandbars.)
  const BAND = 60, radToTrue = (h: number) => h >= SEA + LAND0 ? BAND + (h - SEA - LAND0) * R : h >= SEA ? BAND * (h - SEA) / LAND0 : (h - SEA) * 40000;
  const gs: GroundSample = { h: 0, cell: 0, water: -1, lake: false };
  const mR = o.mag / R;
  const climTmp = new Color(), ecoCol = new Float32Array(M * 3);
  for (let i = 0; i < M; i++) {
    const eco = ECO[w.biome[cellList[i]]];
    if (eco) { const c = new Color(eco[0]); ecoCol[i * 3] = c.r; ecoCol[i * 3 + 1] = c.g; ecoCol[i * 3 + 2] = c.b; }
  }
  for (let i = 0; i < M; i++) {
    const c = cellList[i];
    cellWater[i] = w.water[c] === WATER_OCEAN || w.water[c] === WATER_LAKE ? 1 : 0;
    cellLocalH[i] = toLocal(cellTrueH[i]);
    const hx = BIOMES[w.biome[c]].color;
    for (let k = 0; k < 3; k++) cellCol[i * 3 + k] = Math.pow(((hx >> (16 - 8 * k)) & 255) / 255, 2.2);
    if (w.water[c] === WATER_LAKE && Number.isNaN(lakeLevel) && G.shape.level[c] > 0) lakeLevel = toLocal(radToTrue(G.shape.level[c]));
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
  const heights = new Float32Array(N), baseTrue = new Float32Array(N), baseLocal = new Float32Array(N);
  const moistV = new Float32Array(N), tempV = new Float32Array(N);
  const colors = new Float32Array(N * 3), lakeMask = new Float32Array(N), grow = new Float32Array(N).fill(1);
  const owner = new Int16Array(N);
  const oceanW = new Float32Array(N);
  const groundR = new Float32Array(N), waterR = new Float32Array(N), lakeAt = new Uint8Array(N), iceV = new Float32Array(N);
  /** What snow judges height by, less the ground drawn (radians). The planet (sky.ts) goes by the
   * plain terrain, before the close-up relief, less VALLEY_SNOW (0.45) of the valleys' carving;
   * judged by the relief, ranges lost most of their snow up close. plainAdj: the plain terrain,
   * less the ground drawn (glaciers go by it). meshSlope: the plain terrain's slope. */
  const snowAdj = new Float32Array(N), plainAdj = new Float32Array(N), meshSlope = new Float32Array(N);
  const snowTrue = new Float32Array(N), plainTrue = new Float32Array(N);
  // The planet's ground and relief are worked out every S samples and filled in between: on the
  // hex's fine grid (~36 m real a sample) every other one is plenty for its finest gullies (~100 m)
  // and takes a quarter of the time.
  const S = (res - 1) % 2 === 0 && step * o.mag < 60 ? 2 : 1;
  let hiTrue = -Infinity, loTrue = Infinity;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = -half + i * step, y = -half + j * step, v = j * res + i;
      blendAt(x, y);
      let h = 0, ht = 0, mo = 0, tp = 0, r = 0, gr = 0, b = 0, lake = 0, sea = 0, best = 0, bestW = 0;
      let lr = 0, lg = 0, lb = 0, lw = 0, landH = 0, seaH = 0, lmo = 0, ltp = 0, own = 0, tr = 0, tg = 0, tb = 0, tk = 0;
      for (let m = 0; m < M; m++) {
        const wt = weights[m];
        if (wt === 0) continue;
        const c = cellList[m];
        h += wt * cellLocalH[m]; ht += wt * cellTrueH[m]; mo += wt * cellMoist[m]; tp += wt * cellTemp[m];
        r += wt * cellCol[m * 3]; gr += wt * cellCol[m * 3 + 1]; b += wt * cellCol[m * 3 + 2];
        if (!cellWater[m]) {
          lr += wt * cellCol[m * 3]; lg += wt * cellCol[m * 3 + 1]; lb += wt * cellCol[m * 3 + 2]; lw += wt;
          lmo += wt * cellMoist[m]; ltp += wt * cellTemp[m];
          if (OWN_COLOUR.has(w.biome[c])) own += wt;
          const eco = ECO[w.biome[c]];
          if (eco) { const k = eco[1] * wt; tr += ecoCol[m * 3] * k; tg += ecoCol[m * 3 + 1] * k; tb += ecoCol[m * 3 + 2] * k; tk += k; }
        }
        if (w.water[c] === WATER_LAKE) lake += wt;
        if (w.water[c] === WATER_OCEAN) { sea += wt; seaH += wt * cellLocalH[m]; } else landH += wt * cellLocalH[m];
        if (wt > bestW && !cellWater[m]) { bestW = wt; best = m; }
      }
      // The ground and its water, as the planet draws them here (gnomonic, so back out along the
      // tangent plane to the sphere). The blend above still gives climate, colour and plants.
      if (i % S === 0 && j % S === 0) {
        G.at(cx + (x * ex + y * nx) * mR, cy + (x * ey + y * ny) * mR, cz + (x * ez + y * nz) * mR, gs);
        groundR[v] = gs.h; waterR[v] = gs.water; lakeAt[v] = gs.lake ? 1 : 0;
      }
      iceV[v] = lw > 0.02 ? own / lw : 0;
      moistV[v] = mo; tempV[v] = tp; owner[v] = best;
      void h; void ht; void sea; void lake;
      // Land takes its colour from land cells only (or a lagoon's turquoise tints the beach), and
      // in the planet's Earth look: the climate palette by moisture and temperature, ice keeping
      // its own colour, then the finer biomes' tints (surface.ts colourAt).
      if (lw > 0.02) {
        climateColour(lmo / lw, ltp / lw, climTmp);
        const k = 1 - own / lw;
        r = lr / lw + (climTmp.r - lr / lw) * k; gr = lg / lw + (climTmp.g - lg / lw) * k; b = lb / lw + (climTmp.b - lb / lw) * k;
        const t = tk / lw;
        if (t > 0) { r += (tr / tk - r) * t; gr += (tg / tk - gr) * t; b += (tb / tk - b) * t; }
      }
      colors[v * 3] = r; colors[v * 3 + 1] = gr; colors[v * 3 + 2] = b;
    }
  }

  // The planet's close-up relief on its ground (relief.ts): the hills, gullies and carved valleys
  // its ground patch raises near the camera. The gullies are steered by the slope of the planet's
  // mesh, which is smooth over its vertex spacing, so the slope is taken over that distance.
  {
    const vSpacingLocal = G.shape.spacing / G.shape.k * R / o.mag;
    const radPerLocal = o.mag / R;
    const sp = step * radPerLocal;
    // The slope on a coarse grid of its own, centred on the cell (so every map of this hex, wide
    // or not, measures it at the same points), a node every half vertex spacing, one node past
    // the map's edge; central differences there, bilinear in between.
    const Q = vSpacingLocal * 0.5, nq = Math.ceil(half / Q) + 2, side = 2 * nq + 1;
    const coarse = new Float32Array(side * side), gE = new Float32Array(side * side), gN = new Float32Array(side * side);
    const at = (x: number, y: number) => G.at(cx + (x * ex + y * nx) * mR, cy + (x * ey + y * ny) * mR, cz + (x * ez + y * nz) * mR, gs).h;
    for (let b = 0; b < side; b++) for (let a = 0; a < side; a++) coarse[b * side + a] = at((a - nq) * Q, (b - nq) * Q);
    for (let b = 0; b < side; b++) for (let a = 0; a < side; a++) {
      const a0 = Math.max(0, a - 1), a1 = Math.min(side - 1, a + 1), b0 = Math.max(0, b - 1), b1 = Math.min(side - 1, b + 1);
      gE[b * side + a] = (coarse[b * side + a1] - coarse[b * side + a0]) / ((a1 - a0) * Q * radPerLocal);
      gN[b * side + a] = (coarse[b1 * side + a] - coarse[b0 * side + a]) / ((b1 - b0) * Q * radPerLocal);
    }
    const slopeAt = (x: number, y: number, f: Float32Array) => {
      const fx = x / Q + nq, fy = y / Q + nq;
      const a = Math.min(side - 2, Math.max(0, Math.floor(fx))), b = Math.min(side - 2, Math.max(0, Math.floor(fy)));
      const tx = fx - a, ty = fy - b;
      return (f[b * side + a] * (1 - tx) + f[b * side + a + 1] * tx) * (1 - ty) + (f[(b + 1) * side + a] * (1 - tx) + f[(b + 1) * side + a + 1] * tx) * ty;
    };
    // Planet rivers and streams as the planet runs them (centre, edge crossing, next centre): its
    // relief keeps off them, so they flow on flat floors.
    const segs: number[] = [];
    for (const c of cellList) {
      const d = w.downstream[c];
      if (!flows(c) || d < 0 || !indexOf.has(d)) continue;
      const mid = edgeCross(c, d);
      if (!mid) continue;
      const a = indexOf.get(c)!, b2 = indexOf.get(d)!;
      segs.push(cellXY[a * 2], cellXY[a * 2 + 1], mid[0], mid[1], mid[0], mid[1], cellXY[b2 * 2], cellXY[b2 * 2 + 1]);
    }
    const riverD = (x: number, y: number) => {
      let best = Infinity;
      for (let k = 0; k < segs.length; k += 4) {
        const x0 = segs[k], y0 = segs[k + 1], sx = segs[k + 2] - x0, sy = segs[k + 3] - y0;
        const t = Math.max(0, Math.min(1, ((x - x0) * sx + (y - y0) * sy) / (sx * sx + sy * sy || 1)));
        best = Math.min(best, Math.hypot(x - x0 - sx * t, y - y0 - sy * t));
      }
      return best;
    };
    const tmp = [0, 0, 0, 0, 0];
    const ri: ReliefInput = { x: 0, y: 0, z: 0, hAbove: 0, mx: 0, my: 0, mz: 0, sand: 0, ice: 0, river: 0, sp };
    for (let j = 0; j < res; j += S) {
      for (let i = 0; i < res; i += S) {
        const x = -half + i * step, y = -half + j * step, v = j * res + i;
        const gh = groundR[v];
        if (gh > SEA) {
          // Direction of the point, and the mesh's uphill slope there, tangent (east, north).
          let px = cx + (x * ex + y * nx) * mR, py = cy + (x * ey + y * ny) * mR, pz = cz + (x * ez + y * nz) * mR;
          const pl = Math.hypot(px, py, pz); px /= pl; py /= pl; pz /= pl;
          const ge = slopeAt(x, y, gE), gn = slopeAt(x, y, gN);
          ri.x = px; ri.y = py; ri.z = pz; ri.hAbove = gh - SEA;
          ri.mx = ge * ex + gn * nx; ri.my = ge * ey + gn * ny; ri.mz = ge * ez + gn * nz;
          ri.sand = smooth(0.24, 0.12, moistV[v]) * smooth(0.4, 0.55, tempV[v]);
          ri.ice = iceV[v];
          ri.river = segs.length ? riverD(x, y) * radPerLocal : Infinity;
          const lift = patchLift(ri, valleys, tmp), carve = tmp[4];
          groundR[v] = gh + lift;
          snowAdj[v] = -lift - 0.45 * carve;
          plainAdj[v] = -lift;
          meshSlope[v] = Math.hypot(ge, gn);
        }
      }
    }
    // In between: ground and water level bilinear, which water it is from the nearest node.
    if (S > 1) {
      for (let j = 0; j < res; j++) {
        const j0 = Math.min(res - 1 - S, j - (j % S)), ty = (j - j0) / S;
        for (let i = 0; i < res; i++) {
          if (i % S === 0 && j % S === 0) continue;
          const i0 = Math.min(res - 1 - S, i - (i % S)), tx = (i - i0) / S, v = j * res + i;
          const a = j0 * res + i0, b2 = a + S, c2 = a + S * res, d2 = c2 + S;
          groundR[v] = (groundR[a] * (1 - tx) + groundR[b2] * tx) * (1 - ty) + (groundR[c2] * (1 - tx) + groundR[d2] * tx) * ty;
          waterR[v] = (waterR[a] * (1 - tx) + waterR[b2] * tx) * (1 - ty) + (waterR[c2] * (1 - tx) + waterR[d2] * tx) * ty;
          for (const f of [snowAdj, plainAdj, meshSlope]) f[v] = (f[a] * (1 - tx) + f[b2] * tx) * (1 - ty) + (f[c2] * (1 - tx) + f[d2] * tx) * ty;
          lakeAt[v] = lakeAt[(tx < 0.5 ? (ty < 0.5 ? a : c2) : (ty < 0.5 ? b2 : d2))];
        }
      }
    }
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = -half + i * step, y = -half + j * step, v = j * res + i;
        const ht = radToTrue(groundR[v]);
        snowTrue[v] = radToTrue(groundR[v] + snowAdj[v]);
        plainTrue[v] = radToTrue(groundR[v] + plainAdj[v]);
        let h = toLocal(ht);
        const sea = waterR[v] > 0 && !lakeAt[v] ? 1 : 0;
        // Ground below the sea with no water drawn over it on the planet stays dry here.
        if (!sea && h < 0.3) h = 0.3;
        heights[v] = h; baseLocal[v] = h; baseTrue[v] = ht; oceanW[v] = sea;
        lakeMask[v] = lakeAt[v] ? smooth(-3, 3, radToTrue(waterR[v]) - ht) : 0;
        if (Math.hypot(x, y) < reach) { hiTrue = Math.max(hiTrue, ht); loTrue = Math.min(loTrue, ht); }
      }
    }
  }

  // Walking-scale detail on top of the planet's shape, in local metres. Rolling ground everywhere,
  // in proportion to the hex's relief; crags (ridged noise, cliffs) only where it is mountainous.
  const reliefLocal = (hiTrue - loTrue) / o.vScale;
  // Rolling ground is capped: scaled with relief it turned an 8 km peak into a field of needles.
  const hasSea = cellList.some((c) => w.water[c] === WATER_OCEAN);
  // (Sized in real metres, as it was at the old vScale 2, so true scale doesn't make it 5x rougher.)
  const rollA = (1.5 + 0.02 * Math.min(reliefLocal * o.vScale / 2, 300)) * 2 / o.vScale, rollL = 140;
  const cragL = Math.max(150, baseSize * 0.32), cragA = baseSize * 0.06;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const x = -half + i * step, y = -half + j * step, v = j * res + i;
      let d = 0, a = 1, f = 1 / rollL, nn = 0;
      for (let k = 0; k < 5; k++) { d += a * noise(x * f, y * f, 21 + k); nn += a; a *= 0.5; f *= 2.1; }
      // Not on low ground by the water: there it punched puddles through the shore.
      heights[v] += rollA * d / nn * (hasSea || !Number.isNaN(lakeLevel) ? smooth(0.3, 1.5 + rollA, heights[v] - Math.max(0, Number.isNaN(lakeLevel) ? 0 : lakeLevel)) : 1);
      // Sand seas: dunes, long crests across the wind with a steep slip face (a sawtooth across
      // the crest line, wandering along it), only on sand desert.
      const ob = w.biome[cellList[owner[v]]];
      if (ob === B.DESERT) {
        const wob = noise(x / 300, y / 300, 131) * 60;
        const u = (x * 0.8 + y * 0.6 + wob) / 150, ph = u - Math.floor(u);
        const saw = ph < 0.75 ? ph / 0.75 : (1 - ph) / 0.25;
        const amp = 16 * smooth(-0.3, 0.3, noise(x / 260, y / 260, 133) + 0.25);
        heights[v] += amp * (saw * saw - 0.4);
      }
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
      // A lake is a basin: its bed below the surface inside (mask > 0.5), and a rim at least at
      // the surface around it, or a lake higher than the ground beside it spills over the forest.
      if (!Number.isNaN(lakeLevel)) {
        const lm = lakeMask[v];
        if (lm > 0.5) heights[v] = Math.min(heights[v], lakeLevel - (lm - 0.5) * 12);
        else if (lm > 0.2) heights[v] = Math.max(heights[v], lakeLevel + 0.3 + (heights[v] - lakeLevel - 0.3) * smooth(0.5, 0.2, lm));
      }
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
  const widthOf = (c: number) => {
    const wt = trueRiverWidth(w, c);
    return o.riverMode === 'scaled' ? wt / o.mag : Math.min(Math.max(6, wt * 0.8), baseSize * 0.05);
  };

  const riverCells = cellList.filter(flows);
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
    const mid = edgeCross(c, d);
    if (!mid) continue;
    if (c === cell || d === cell) { riversHere++; if (c === cell) riverWidthsM.push(Math.round(trueRiverWidth(w, c))); }
    const ax = cellXY[i0 * 2], ay = cellXY[i0 * 2 + 1], bx = cellXY[i1 * 2], by = cellXY[i1 * 2 + 1];
    // Quadratic through centre, edge crossing, next centre (control point solved so it passes it).
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
  const treeLine = new Float32Array(N).fill(1);
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

  // Crease shading (ambient occlusion, baked): how far a sample sits below the ground around it,
  // from a box blur of the heights about 20 m across.
  const aoBlur = boxBlur(heights, res, Math.max(2, Math.round(10 / step)));
  const base = colors.slice();
  const layers = new Float32Array(N * LAYERS);
  const lay = (v: number, k: number, val: number) => { layers[v * LAYERS + k] = val; };

  // --- Colour: the planet's Earth look, ported from its terrain shader (sky.ts) and per-vertex
  // shading (surface.ts naturalShading). Its noise scales are in planet radii; here they are
  // converted to map metres, so patterns keep their real size divided by mag like the ground.
  const lin = (hx: number) => [0, 1, 2].map((k) => Math.pow(((hx >> (16 - 8 * k)) & 255) / 255, 2.2));
  const ROCK = lin(0x776b5f), ALPINE = lin(0x6e6858), SAND = lin(0xc8b48a), BED = lin(0x3a3226);
  const SEABED_SAND = lin(0x8a8064), SEABED_DEEP = lin(0x26323a), LAKEBED = lin(0x2c3a30);
  const SNOW = [0.93, 0.95, 0.98], LUSH = [0.075, 0.14, 0.035];
  const mix = (v: number, c: number[], t: number) => {
    if (t <= 0) return;
    for (let k = 0; k < 3; k++) colors[v * 3 + k] += (c[k] - colors[v * 3 + k]) * t;
  };
  const mul = (v: number, a: number, b2 = a, c = a) => { colors[v * 3] *= a; colors[v * 3 + 1] *= b2; colors[v * 3 + 2] *= c; };
  /** A planet noise frequency (per radius) as a wavelength in map metres: R / f real metres, / mag. */
  const L = (f: number) => Math.max(2, R / f / o.mag);
  const n01 = (x: number, y: number, l: number, z: number) => 0.5 + 0.5 * noise(x / l, y / l, z);
  const lat = Math.abs(Math.asin(Math.max(-1, Math.min(1, cy)))) / (Math.PI / 2);
  const latT = 1 - 1.1 * Math.pow(lat, 1.25) + w.params.heat;
  /**
   * Groves, shared by the canopy colour and the trees so the two agree: solid stands with ragged
   * edges and real clearings between, so forest and open ground read as distinct regions (2026-11-04:
   * evenly scattered trees read as green fuzz). The denser the biome's planting, the more of the
   * ground is grove: a forest has clearings, grassland the odd copse.
   */
  const groveRaw = (x: number, y: number) => noise(x / 150, y / 150, 91) + 0.35 * noise(x / 45, y / 45, 93) + 0.15 * noise(x / 14, y / 14, 95);
  const groveIn = (x: number, y: number, dens: number) => {
    const th = 0.32 - 0.8 * Math.min(1, dens);
    return smooth(th - 0.06, th + 0.06, groveRaw(x, y));
  };
  const densAt = (v: number) => plantingOf(w.biome[cellList[owner[v]]]).treeD / FULL;
  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const v = j * res + i, x = -half + i * step, y = -half + j * step;
      const hL = heights[j * res + Math.max(0, i - 1)], hR = heights[j * res + Math.min(res - 1, i + 1)];
      const hD = heights[Math.max(0, j - 1) * res + i], hU = heights[Math.min(res - 1, j + 1) * res + i];
      const slope = Math.hypot(hR - hL, hU - hD) / (2 * step);         // rise over run
      const slopeP = 1 - 1 / Math.sqrt(1 + slope * slope);            // the shader's 1 - cos
      const h = heights[v], moist = moistV[v], temp = tempV[v];
      // Height above the sea as a share of the planet's relief, as the shader's hAbove / uRelief.
      const e = Math.max(0, baseTrue[v] + (h - baseLocal[v]) * o.vScale) / reliefM + 0.09;
      const lowland = 1 - smooth(0.35, 0.6, e);
      lay(v, L_AO, smooth(0, 4, aoBlur[v] - h));
      if (h < 0 && oceanW[v] > 0.3) {
        lay(v, L_DEPTH, -h);                                  // sea floor
        mix(v, SEABED_SAND.map((a, k) => a + (SEABED_DEEP[k] - a) * smooth(0, 25, -h)), 1);
        grow[v] = 0;
        continue;
      }
      if (!Number.isNaN(lakeLevel) && lakeMask[v] > 0.5 && h < lakeLevel) { mix(v, LAKEBED, 0.8); lay(v, L_DEPTH, lakeLevel - h); grow[v] = 0; continue; }
      lay(v, L_GRASS, smooth(0.12, 0.25, moist) * smooth(0.62, 0.42, moist) * smooth(0.25, 0.4, temp) * lowland);
      // Grass and steppe: mottled, sun-bleached patches.
      const grassW = smooth(0.12, 0.25, moist) * smooth(0.62, 0.42, moist) * smooth(0.25, 0.4, temp) * lowland;
      if (grassW > 0) {
        const m = n01(x, y, L(900), 101) * 0.55 + n01(x, y, L(2600), 103) * 0.3 + n01(x, y, L(7000), 105) * 0.15;
        lay(v, L_MOTTLE, m);
        mul(v, 1 + (0.76 + 0.48 * m - 1) * grassW);
        const bl = smooth(0.55, 0.8, m) * grassW * 0.6;
        mul(v, 1 + 0.12 * bl, 1 + 0.04 * bl, 1 - 0.2 * bl);
      }
      // Forest: dark canopy in the groves (the trees' own colours, bluer in the north), paler
      // clearings between.
      const forestW = smooth(0.3, 0.45, moist) * smooth(0.17, 0.24, temp) * lowland;
      if (forestW > 0) {
        const closed = smooth(0.6, 0.72, moist) * (0.35 + 0.15 * smooth(0.65, 0.75, temp));
        const inGrove = Math.min(1, groveIn(x, y, densAt(v)) + closed * 0.3);
        lay(v, L_FOREST, forestW * inGrove); lay(v, L_CLEARING, forestW * (1 - inGrove));
        const tw = smooth(0.3, 0.7, temp);
        mix(v, [0.026 + 0.014 * tw, 0.066 + 0.054 * tw, 0.03 - 0.005 * tw], forestW * inGrove * 0.6);
        mul(v, 1 - 0.15 * forestW * inGrove);
        const gt = smooth(0.35, 0.55, temp), k = forestW * (1 - inGrove) * 0.55;
        mul(v, 1 + (0.82 + 0.36 * gt - 1) * k, 1 + (0.98 + 0.14 * gt - 1) * k, 1 + (0.8 + 0.02 * gt - 1) * k);
      }
      // Rivers green the land along them, most in dry country: a lush strip and a valley floor.
      if (riverNear[v] < 6) {
        const dryR = smooth(0.5, 0.18, moist) * smooth(0.15, 0.3, temp);
        const a = 0.3 + 0.7 * dryR;
        const rag = noise(x / 9, y / 9, 107) * 0.5;
        if (riverNear[v] < 1) { mix(v, BED, 0.85); lay(v, L_BED, 1); }
        else {
          lay(v, L_LUSH, smooth(3.2, 2.2, riverNear[v] + rag) * a);
          const valley = [0, 1, 2].map((k) => colors[v * 3 + k] + ([0.2, 0.22, 0.1][k] - colors[v * 3 + k]) * 0.5);
          mix(v, valley, smooth(6, 3, riverNear[v]) * 0.5 * a);
          mix(v, LUSH, smooth(3.2, 2.2, riverNear[v] + rag) * 0.92 * a);
        }
      }
      // Rock on steep ground (steeper than on the planet: this map's slopes are steeper too).
      const cn = noise(x / 23, y / 23, 77) * 0.6 + noise(x / 7, y / 7, 79) * 0.4;
      const rock = smooth(0.8, 1.5, slope + 0.2 * cn);
      mix(v, ROCK, rock * 0.85);
      lay(v, L_ROCK, rock);
      // Above the tree line, alpine scrub; the line follows temperature (high in the tropics).
      const tv = latT - 0.55 * e;
      const an = noise(x / L(90), y / L(90), 109) * 0.5 + noise(x / L(260), y / L(260), 111) * 0.25;
      mix(v, ALPINE, smooth(0.3, 0.18, tv + an * 0.05) * 0.7);
      lay(v, L_ALPINE, smooth(0.3, 0.18, tv + an * 0.05));
      // Beach: sand right at the sea's edge, in all but cold climates.
      if (sea && h < 2.5 && oceanW[v] > 0.05 && temp > 0.25) { mix(v, SAND, smooth(2.5, 0.6, h + cn)); lay(v, L_SAND, smooth(2.5, 0.6, h + cn)); }
      // Snow, by the shader's model: a line from latitude and height, peaks colder still, shed
      // off steep faces and lying in streaks.
      const edge = noise(x / L(25), y / L(25), 113) * 0.06 + noise(x / L(110), y / L(110), 115) * 0.03 + noise(x / L(420), y / L(420), 117) * 0.015;
      // (Judged by the planet's snow height: the valleys' carving mostly taken back off.)
      const eS = Math.max(0, snowTrue[v] + (h - baseLocal[v]) * o.vScale) / reliefM + 0.09;
      let snow = smooth(0.19, 0.09, latT - 0.5 * eS + edge);
      snow = Math.max(snow, smooth(0.6, 0.75, eS) * smooth(0.21, -0.05, latT - 0.62 * eS + edge));
      const streak = 0.5 + 0.5 * (noise(x / 40, y / 40, 119) * 0.6 + noise(x / 13, y / 13, 121) * 0.4);
      // (Mostly the plain terrain's slope, as the planet's patch: its relief is steep nearly
      // everywhere and snow shed off all but flat tops.)
      const slopeS = (1 - 1 / Math.sqrt(1 + meshSlope[v] * meshSlope[v])) * 0.45 + slopeP * 0.55;
      const lie = (1 - 0.9 * smooth(0.08, 0.3, slopeS)) * smooth(0.25, 0.65, streak + snow * 0.35);
      // Glaciers (sky.ts): ice fills the high valleys where it is cold, down past the snow line.
      // A valley is ground lower than the ring around it, ~1 km and ~3 km out (real metres).
      let glacier = 0;
      // (By the plain terrain, before the close-up relief, as the planet's patch.)
      const stG = latT - 0.5 * eS, eG = plainTrue[v] / reliefM + 0.09;
      if (stG < 0.28 && eG > 0.15) {
        const ringAt = (rTrue: number) => {
          const rr = rTrue / o.mag / step;
          let sum = 0;
          for (let k = 0; k < 6; k++) {
            const ii = Math.max(0, Math.min(res - 1, Math.round(i + Math.cos(k * 1.0472) * rr)));
            const jj = Math.max(0, Math.min(res - 1, Math.round(j + Math.sin(k * 1.0472) * rr)));
            sum += plainTrue[jj * res + ii];
          }
          return sum / 6 - plainTrue[v];
        };
        const valleyG = Math.max(smooth(60, 300, ringAt(960)), smooth(190, 960, ringAt(2900)));
        const iceZone = smooth(0.28, 0.18, stG + edge * 0.5);
        glacier = smooth(0.05, 0.4, valleyG * iceZone * smooth(0.15, 0.3, eG)) * 0.92;
      }
      const white = Math.max(Math.min(1, snow * lie), glacier);
      mix(v, SNOW, white * 0.95);
      lay(v, L_SNOW, white);
      // Where plants grow: not on rock, snow, the water's edge, or (trees) above the tree line.
      grow[v] = (1 - rock) * (1 - Math.min(1, white * 1.5)) * (riverNear[v] < 1.3 ? 0 : 1) * (h < 0.3 ? 0 : 1);
      treeLine[v] = smooth(0.2, 0.3, tv + an * 0.05);
    }
  }

  // Height on this map's own land, for styles that draw their own mountain bands.
  {
    let lo = Infinity, hi = -Infinity;
    for (let v = 0; v < N; v++) if (heights[v] > 0.3 && layers[v * LAYERS + L_DEPTH] === 0) { lo = Math.min(lo, heights[v]); hi = Math.max(hi, heights[v]); }
    // (In real metres as at vScale 2, where it was tuned: at true scale the map's own heights are
    // 5x smaller and no range counted as one, so Golden Earth's peaks lost their snow caps.)
    const mtn = smooth(120, 500, (hi - lo) * o.vScale / 2);
    // By rank, not by height: 0.9 means higher than 90% of the land, so a style's snow caps cover
    // the top tenth of a range rather than everything above the lowest valley.
    const sample: number[] = [];
    for (let v = 0; v < N; v += 7) if (heights[v] > 0.3 && layers[v * LAYERS + L_DEPTH] === 0) sample.push(heights[v]);
    sample.sort((a, b) => a - b);
    const rank = (hv: number) => {
      let a = 0, b = sample.length;
      while (a < b) { const mid = (a + b) >> 1; if (sample[mid] < hv) a = mid + 1; else b = mid; }
      return a / Math.max(1, sample.length);
    };
    if (hi > lo && sample.length) for (let v = 0; v < N; v++) layers[v * LAYERS + L_ELEV] = heights[v] > 0.3 ? rank(heights[v]) * mtn : 0;
  }

  // --- Towns (placeholders) where the history put them: roads, houses, fields. Before the plants,
  // which they clear.
  let houses: Float32Array = new Float32Array(0), townNames: string[] = [];
  if (history) {
    const t = layoutTowns({
      w, history, cellList, indexOf, cellXY, res, size, step, half, heights, grow, riverNear, layers, LAYERS,
      L_PATH, L_FIELD, L_FIELDKIND, L_HEDGE, edgeMid, noise, rng, sea,
      arable: (v) => tempV[v] > 0.25 && moistV[v] > 0.12 && layers[v * LAYERS + L_SNOW] < 0.2 && layers[v * LAYERS + L_ROCK] < 0.3,
    });
    houses = t.houses; townNames = t.names;
    // The Earth look gets them too: dirt paths, crops, hedges.
    const DIRT = lin(0x8a7458), HEDGE = lin(0x34502a);
    const CROPS = [lin(0xc9a654), lin(0x8a9a46), lin(0x7a6248), lin(0xa8b060)];
    for (let v = 0; v < N; v++) {
      const L0 = v * LAYERS;
      if (layers[L0 + L_FIELD] > 0) {
        mix(v, CROPS[Math.min(3, Math.floor(layers[L0 + L_FIELDKIND] * 4))], 0.75);
        mix(v, HEDGE, layers[L0 + L_HEDGE] * 0.8);
      }
      mix(v, DIRT, layers[L0 + L_PATH] * 0.85);
    }
  }

  // --- Plants: the planet's per-biome mix (flora.ts), life-size, on a jittered grid, trees
  // clumped into groves (the canopy colour's pattern). Then shaped by the ground each one stands
  // on (2026-11-05): reeds and willows on the banks, lilies on still shallows, boulders on rock,
  // the forest thinning to stunted pines and scrub at the tree line, bushes along grove edges,
  // flowers, stumps and logs in clearings, ferns under the trees, the odd dead tree, and
  // neighbouring biomes interleaving across their border instead of meeting on a line.
  const treeOut = o.plants ? placePlants({
    w, size, half, step, res, rng, noise, layers, tempV, moistV, lakeMask, lakeLevel, riverNear, grow, treeLine,
    owner, cellList, sampleH, groveIn,
  }) : new Float32Array(0);

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
    if (!flows(c) || d < 0 || !indexOf.has(d)) continue;
    const mid = edgeCross(c, d);
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
    frame: Float32Array.of(cx, cy, cz, ex, ey, ez, nx, ny, nz), mag: o.mag, radiusKm: o.radiusKm,
    heights, colors, base, layers, houses, townNames, sea, lakeLevel, lakeMask, rivers, hex,
    trees: treeOut,
    cells: Int32Array.from(cellList), cellXY,
    info: {
      biome: BIOMES[w.biome[cell]].name,
      trueHeightM: Math.round(cellTrueH[ci]),
      tempC: Math.round(cellT[ci]),
      riverWidthsM, rivers: riversHere,
    },
  };
}

/** Where a river piece crosses the hex edge: its point at t = 0.5 (tests check it is the planet's crossing). */
export function riverCrossings(m: LocalMap): [number, number][] {
  return m.rivers.map((r) => {
    const s = (r.pts.length / 4 - 1) / 2;
    return [r.pts[s * 4], r.pts[s * 4 + 1]];
  });
}
