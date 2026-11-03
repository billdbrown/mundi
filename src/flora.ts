/** Low-poly trees, drawn as one instanced mesh per kind. */
import * as THREE from 'three';
import { hash01 } from './rng.ts';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { B } from './biomes.ts';
import { FIRST, SPECIES_KINDS, speciesGeometry, sp, type Family } from './species.ts';

export const CONIFER = 0, BROADLEAF = 1, SCRUB = 2, PALM = 3, ROCK = 4, CACTUS = 5, ICEBERG = 6;
/** Savanna acacias, birches, low tufts of grass and shrub. */
export const ACACIA = 7, BIRCH = 8, TUFT = 9;
/** A kind of plant or prop: the ten above, then the species families (species.ts) from 10. */
export type TreeKind = number;
export const KINDS = FIRST + SPECIES_KINDS;

export interface TreeSpot {
  x: number; y: number; z: number;
  kind: TreeKind;
  color: number;
  /** World size. */
  s: number;
  spin: number;
  /** Brightness variation. */
  shade: number;
}

/** Trees packed into typed arrays, so they cross from the worker cheaply. */
export interface TreeData {
  pos: Float32Array;    // xyz per tree
  size: Float32Array;
  spin: Float32Array;
  shade: Float32Array;
  kind: Uint8Array;
  color: Uint32Array;
}

export function packTrees(spots: TreeSpot[]): TreeData {
  const n = spots.length;
  const d: TreeData = {
    pos: new Float32Array(n * 3), size: new Float32Array(n), spin: new Float32Array(n),
    shade: new Float32Array(n), kind: new Uint8Array(n), color: new Uint32Array(n),
  };
  spots.forEach((t, i) => {
    d.pos[i * 3] = t.x; d.pos[i * 3 + 1] = t.y; d.pos[i * 3 + 2] = t.z;
    d.size[i] = t.s; d.spin[i] = t.spin; d.shade[i] = t.shade; d.kind[i] = t.kind; d.color[i] = t.color;
  });
  return d;
}

/** Per biome: [kind, colour, expected trees per cell, size multiplier]. */
export const FLORA: Partial<Record<number, [TreeKind, number, number, number?][]>> = {
  [B.TAIGA]: [[CONIFER, 0x2d4a30, 8, 1.1]],
  [B.FOREST]: [[BROADLEAF, 0x3d6b2c, 6], [BROADLEAF, 0x5a7a2c, 1.2], [CONIFER, 0x33553a, 1.5]],
  [B.TEMPERATE_RAIN]: [[CONIFER, 0x2a4c34, 6, 1.25], [BROADLEAF, 0x335f2e, 3]],
  // Palms belong to coasts and dry tropics; in rainforest they read as mushrooms.
  [B.RAINFOREST]: [[BROADLEAF, 0x2a5c24, 11, 1.25], [BROADLEAF, 0x3b6e22, 3, 1.5], [BROADLEAF, 0x1f4a1f, 3, 1.1]],
  [B.BEACH]: [[PALM, 0x4a8a30, 0.5]],
  [B.DRY_FOREST]: [[BROADLEAF, 0x687a35, 4], [SCRUB, 0x7b8440, 1]],
  [B.SAVANNA]: [[SCRUB, 0x7c873d, 1.3], [ROCK, 0x9a8466, 0.2, 0.5]],
  [B.DESERT]: [[CACTUS, 0x5d7d3c, 0.7, 0.75], [ROCK, 0xa58462, 0.7, 0.6]],
  [B.GRASSLAND]: [[BROADLEAF, 0x4b7834, 0.4]],
  [B.TUNDRA]: [[CONIFER, 0x485b43, 0.35], [ROCK, 0x77776f, 1, 0.55]],
  [B.STEPPE]: [[SCRUB, 0x86884e, 0.2], [ROCK, 0x8d8670, 0.4, 0.5]],
  [B.MOUNTAIN]: [[CONIFER, 0x385036, 0.6], [ROCK, 0x6d645a, 2.2, 0.7]],
};

/**
 * Richer planting (locked in 2026-11-02): flat-topped acacias across savanna and dry forest, birches
 * among the conifers and at the forest's edge, tussocks of grass and low shrub over open
 * country and tundra. (Palms on tropical coasts and trees spilling out of forests into open
 * country are placed in lodflora.ts.)
 */
export const FLORA_RICH: Partial<Record<number, [TreeKind, number, number, number?][]>> = {
  ...FLORA,
  [B.TAIGA]: [[CONIFER, 0x2d4a30, 8, 1.1], [BIRCH, 0x5a7432, 1.6, 0.95]],
  [B.FOREST]: [[BROADLEAF, 0x3d6b2c, 6], [BROADLEAF, 0x5a7a2c, 1.2], [CONIFER, 0x33553a, 1.5], [BIRCH, 0x60793a, 0.8]],
  [B.DRY_FOREST]: [[BROADLEAF, 0x687a35, 3], [ACACIA, 0x6a7a35, 1.4], [SCRUB, 0x7b8440, 1], [TUFT, 0x7a7640, 4, 0.8]],
  [B.SAVANNA]: [[ACACIA, 0x6f7a34, 1.3], [SCRUB, 0x7c873d, 0.9], [TUFT, 0x847c3e, 7, 0.8], [ROCK, 0x9a8466, 0.2, 0.5]],
  [B.GRASSLAND]: [[BROADLEAF, 0x4b7834, 0.4], [TUFT, 0x52663a, 8, 0.8]],
  [B.STEPPE]: [[SCRUB, 0x86884e, 0.2], [TUFT, 0x7c7a4c, 6, 0.8], [ROCK, 0x8d8670, 0.4, 0.5]],
  [B.TUNDRA]: [[CONIFER, 0x485b43, 0.35], [TUFT, 0x5a5c3e, 5, 0.7], [ROCK, 0x77776f, 1, 0.55]],
  // Finer biomes (ecology.ts, the B switch).
  [B.SWAMP]: [[BROADLEAF, 0x284626, 9, 1.1], [BROADLEAF, 0x34502a, 3], [TUFT, 0x4d5a2c, 4, 0.8]],
  [B.MARSH]: [[TUFT, 0x6b7038, 10, 0.9], [SCRUB, 0x5a6a34, 0.6, 0.8]],
  [B.BOG]: [[CONIFER, 0x3e4f38, 1.5, 0.7], [TUFT, 0x6e6440, 7, 0.7], [BIRCH, 0x6a7a3c, 0.4, 0.7]],
  [B.FLOODPLAIN]: [[BROADLEAF, 0x467a2e, 4, 1.2], [TUFT, 0x5d7a36, 6, 0.8]],
  [B.MANGROVE]: [[BROADLEAF, 0x2b4f2a, 14, 0.75]],
  [B.SALT_MARSH]: [[TUFT, 0x7d8046, 9, 0.7]],
  [B.SALT_FLAT]: [],
  [B.COLD_DESERT]: [[ROCK, 0x9a907c, 1, 0.55], [SCRUB, 0x8a8456, 0.3, 0.6], [TUFT, 0x8e8a5e, 1.5, 0.6]],
  [B.BADLANDS]: [[ROCK, 0x9c6c50, 1.5, 0.6], [SCRUB, 0x86884e, 0.2, 0.6]],
  [B.CHAPARRAL]: [[SCRUB, 0x5e6a34, 7, 0.9], [SCRUB, 0x6f7440, 3], [BROADLEAF, 0x55663a, 0.6]],
  [B.DESERT_SCRUB]: [[SCRUB, 0x8a8a50, 1.5, 0.8], [CACTUS, 0x5d7d3c, 0.4, 0.7], [TUFT, 0x9a9258, 2, 0.6], [ROCK, 0xa58462, 0.4, 0.55]],
  [B.POLAR_DESERT]: [[ROCK, 0x8c8a84, 1.5, 0.5]],
  [B.ALPINE_MEADOW]: [[TUFT, 0x5f7a3a, 9, 0.7], [ROCK, 0x7a746a, 1.2, 0.6], [CONIFER, 0x3a5236, 0.3, 0.8]],
  [B.MONTANE_FOREST]: [[CONIFER, 0x2f4c34, 8, 1.15], [BROADLEAF, 0x3f5f30, 1.5]],
  [B.LARCH]: [[CONIFER, 0x7a7a36, 7], [BIRCH, 0x6a7a3c, 0.8]],
  [B.CLOUD_FOREST]: [[BROADLEAF, 0x2a5a32, 12], [BROADLEAF, 0x3a6a3a, 3, 0.8], [PALM, 0x3f7a3a, 1.5, 0.6]],
  [B.MIXED_FOREST]: [[CONIFER, 0x2f4e34, 4, 1.1], [BROADLEAF, 0x416a2e, 4], [BIRCH, 0x5f7838, 1]],
  [B.HEATH]: [[TUFT, 0x6a5a4c, 9, 0.6], [SCRUB, 0x58603a, 0.6, 0.7], [ROCK, 0x77776f, 0.5, 0.5]],
  [B.PRAIRIE]: [[TUFT, 0x7d8a40, 12, 0.9], [BROADLEAF, 0x4b7834, 0.2]],
  [B.MONSOON]: [[BROADLEAF, 0x4f7030, 8, 1.2], [BROADLEAF, 0x6a7a34, 2], [PALM, 0x4a8a30, 0.3]],
  [B.PALM_SAVANNA]: [[PALM, 0x4f8a34, 2.5, 0.9], [TUFT, 0x857e40, 6, 0.8], [ACACIA, 0x6f7a34, 0.4]],
  [B.KARST]: [[BROADLEAF, 0x356a2c, 8], [ROCK, 0x9a9a8c, 1.5, 0.8]],
  [B.CANYONS]: [[ROCK, 0xa06a48, 1.2, 0.6], [SCRUB, 0x86884e, 0.2, 0.6]],
};

/**
 * Many kinds of plant per biome (2026-11-03, Bill: "10-15 unique models for each biome"): the
 * species families (species.ts), each in its three variants, mixed into every land biome at
 * roughly the old total density, so the look varies without more plants on screen.
 */
/** A family's three variants, sharing density d between them, colours a little apart. */
const fam = (f: Family, col: number, d: number, size = 1): [TreeKind, number, number, number][] => {
  const shift = (c: number, k: number) => {
    const r = Math.min(255, Math.max(0, ((c >> 16) & 255) + k)), g = Math.min(255, Math.max(0, ((c >> 8) & 255) + k * 1.2)), b = Math.min(255, Math.max(0, (c & 255) + k * 0.6));
    return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  };
  return [0, 1, 2].map((v) => [sp(f, v), shift(col, (v - 1) * 7), d / 3, size * (0.9 + 0.1 * v)]);
};
const MIX: Partial<Record<number, [TreeKind, number, number, number?][]>> = {
  [B.TAIGA]: [[CONIFER, 0x2d4a30, 4, 1.1], ...fam('spruce', 0x2a4430, 4, 1.1), [BIRCH, 0x5a7432, 1.2, 0.95], ...fam('roundShrub', 0x4a5a34, 1, 0.6), [TUFT, 0x5a5c3e, 2, 0.7]],
  [B.FOREST]: [[BROADLEAF, 0x3d6b2c, 3], ...fam('oak', 0x3f6a2c, 3), [CONIFER, 0x33553a, 1], ...fam('spruce', 0x30503a, 0.8), [BIRCH, 0x60793a, 0.7], ...fam('roundShrub', 0x4f6c32, 0.8, 0.6)],
  [B.TEMPERATE_RAIN]: [[CONIFER, 0x2a4c34, 3, 1.25], ...fam('spruce', 0x284a32, 3, 1.3), [BROADLEAF, 0x335f2e, 1.5], ...fam('treeFern', 0x3a6a34, 1, 0.8), ...fam('oak', 0x355f2c, 1)],
  [B.RAINFOREST]: [[BROADLEAF, 0x2a5c24, 8, 1.25], ...fam('emergent', 0x2f6026, 2.5, 1.3), [BROADLEAF, 0x1f4a1f, 3, 1.1], ...fam('treeFern', 0x2e5e2a, 1.5, 0.8), ...fam('royalPalm', 0x3b6e2a, 0.8, 1.1)],
  [B.DRY_FOREST]: [[BROADLEAF, 0x687a35, 2], [ACACIA, 0x6a7a35, 1.2], ...fam('baobab', 0x6c7a3a, 0.5, 1.1), ...fam('eucalypt', 0x6a7a44, 1), ...fam('roundShrub', 0x7b8440, 1, 0.7), [TUFT, 0x7a7640, 3, 0.8]],
  [B.SAVANNA]: [[ACACIA, 0x6f7a34, 1], ...fam('baobab', 0x6f7a38, 0.25, 1.15), ...fam('umbrellaPine', 0x6a7634, 0.3, 0.9), [SCRUB, 0x7c873d, 0.6], ...fam('roundShrub', 0x80843e, 0.5, 0.6), [TUFT, 0x847c3e, 6, 0.8], [ROCK, 0x9a8466, 0.2, 0.5]],
  [B.GRASSLAND]: [[BROADLEAF, 0x4b7834, 0.2], ...fam('oak', 0x4b7432, 0.25), ...fam('poplar', 0x507a34, 0.15), ...fam('roundShrub', 0x587a36, 0.4, 0.6), [TUFT, 0x52663a, 7, 0.8]],
  [B.STEPPE]: [[SCRUB, 0x86884e, 0.15], ...fam('roundShrub', 0x8a8a52, 0.4, 0.55), [TUFT, 0x7c7a4c, 6, 0.8], [ROCK, 0x8d8670, 0.4, 0.5]],
  [B.TUNDRA]: [[CONIFER, 0x485b43, 0.2], ...fam('spruce', 0x485a42, 0.2, 0.7), ...fam('roundShrub', 0x5a5c3e, 0.6, 0.45), [TUFT, 0x5a5c3e, 4, 0.7], [ROCK, 0x77776f, 1, 0.55]],
  [B.DESERT]: [[CACTUS, 0x5d7d3c, 0.4, 0.75], ...fam('pricklyPear', 0x5f7d40, 0.25, 0.7), ...fam('joshua', 0x6a7a44, 0.15, 0.9), [ROCK, 0xa58462, 0.7, 0.6]],
  [B.SWAMP]: [[BROADLEAF, 0x284626, 5, 1.1], ...fam('willow', 0x2e4c2a, 2.5), ...fam('mangrove', 0x2a4a28, 1, 0.9), ...fam('reeds', 0x4d5a2c, 3, 0.8)],
  [B.MARSH]: [...fam('reeds', 0x6b7038, 9, 0.9), [TUFT, 0x6b7038, 3, 0.9], ...fam('willow', 0x4f6a34, 0.4, 0.8), [SCRUB, 0x5a6a34, 0.3, 0.8]],
  [B.BOG]: [[CONIFER, 0x3e4f38, 0.8, 0.7], ...fam('spruce', 0x3c4e36, 0.7, 0.6), ...fam('reeds', 0x6e6440, 2, 0.6), [TUFT, 0x6e6440, 5, 0.7], [BIRCH, 0x6a7a3c, 0.4, 0.7]],
  [B.FLOODPLAIN]: [...fam('willow', 0x467a2e, 1.5, 1.1), ...fam('poplar', 0x4a7c30, 1.2, 1.1), [BROADLEAF, 0x467a2e, 1.5, 1.2], ...fam('reeds', 0x5d7a36, 2, 0.8), [TUFT, 0x5d7a36, 4, 0.8]],
  [B.MANGROVE]: [...fam('mangrove', 0x2b4f2a, 10, 0.85), [BROADLEAF, 0x2b4f2a, 3, 0.75]],
  [B.SALT_MARSH]: [...fam('reeds', 0x7d8046, 4, 0.6), [TUFT, 0x7d8046, 6, 0.7]],
  [B.CHAPARRAL]: [...fam('roundShrub', 0x5e6a34, 5, 0.9), [SCRUB, 0x6f7440, 2], ...fam('oak', 0x55663a, 0.6, 0.8), ...fam('cypress', 0x3f5230, 0.3, 0.8), ...fam('umbrellaPine', 0x4f6234, 0.3)],
  [B.DESERT_SCRUB]: [...fam('roundShrub', 0x8a8a50, 1.2, 0.6), [SCRUB, 0x8a8a50, 0.5, 0.8], [CACTUS, 0x5d7d3c, 0.25, 0.7], ...fam('pricklyPear', 0x63803f, 0.3, 0.7), ...fam('joshua', 0x6e7c46, 0.3, 0.9), [TUFT, 0x9a9258, 2, 0.6], [ROCK, 0xa58462, 0.4, 0.55]],
  [B.COLD_DESERT]: [[ROCK, 0x9a907c, 1, 0.55], ...fam('roundShrub', 0x8a8456, 0.5, 0.5), ...fam('cypress', 0x5a6444, 0.08, 0.6), [TUFT, 0x8e8a5e, 1.5, 0.6]],
  [B.ALPINE_MEADOW]: [[TUFT, 0x5f7a3a, 8, 0.7], ...fam('roundShrub', 0x587436, 0.8, 0.45), [ROCK, 0x7a746a, 1.2, 0.6], [CONIFER, 0x3a5236, 0.15, 0.8], ...fam('spruce', 0x385034, 0.2, 0.75)],
  [B.MONTANE_FOREST]: [[CONIFER, 0x2f4c34, 4, 1.15], ...fam('spruce', 0x2d4a32, 3.5, 1.2), [BROADLEAF, 0x3f5f30, 0.8], ...fam('cypress', 0x2f4a30, 0.6), ...fam('oak', 0x3f5f30, 0.6)],
  [B.LARCH]: [[CONIFER, 0x7a7a36, 4], ...fam('spruce', 0x7a7834, 3), [BIRCH, 0x6a7a3c, 0.8], ...fam('roundShrub', 0x6a6a38, 0.6, 0.5)],
  [B.CLOUD_FOREST]: [[BROADLEAF, 0x2a5a32, 7], ...fam('treeFern', 0x2e6034, 3, 0.9), ...fam('emergent', 0x2a5a30, 1), [BROADLEAF, 0x3a6a3a, 2, 0.8], [PALM, 0x3f7a3a, 0.8, 0.6]],
  [B.MIXED_FOREST]: [[CONIFER, 0x2f4e34, 2, 1.1], ...fam('spruce', 0x2e4c34, 2, 1.1), [BROADLEAF, 0x416a2e, 2], ...fam('oak', 0x416a2e, 2), [BIRCH, 0x5f7838, 0.8], ...fam('poplar', 0x4a7030, 0.4)],
  [B.HEATH]: [[TUFT, 0x6a5a4c, 7, 0.6], ...fam('roundShrub', 0x6a5a4c, 2, 0.45), [SCRUB, 0x58603a, 0.4, 0.7], ...fam('cypress', 0x3e4a34, 0.1, 0.7), [ROCK, 0x77776f, 0.5, 0.5]],
  [B.PRAIRIE]: [[TUFT, 0x7d8a40, 11, 0.9], ...fam('roundShrub', 0x748440, 0.5, 0.5), ...fam('poplar', 0x4b7834, 0.1), ...fam('oak', 0x4b7834, 0.1)],
  [B.MONSOON]: [[BROADLEAF, 0x4f7030, 5, 1.2], ...fam('emergent', 0x4c6e2e, 1.2, 1.1), [BROADLEAF, 0x6a7a34, 1.5], ...fam('royalPalm', 0x4a8a30, 0.5), ...fam('roundShrub', 0x5a7432, 0.8, 0.6)],
  [B.PALM_SAVANNA]: [[PALM, 0x4f8a34, 1.2, 0.9], ...fam('royalPalm', 0x4c8632, 1.2, 0.9), [TUFT, 0x857e40, 5, 0.8], [ACACIA, 0x6f7a34, 0.3], ...fam('roundShrub', 0x7a8040, 0.4, 0.5)],
  [B.KARST]: [[BROADLEAF, 0x356a2c, 4], ...fam('oak', 0x356a2c, 2), ...fam('cypress', 0x2e5a2c, 1), ...fam('treeFern', 0x3a6a32, 0.6, 0.8), [ROCK, 0x9a9a8c, 1.5, 0.8]],
  [B.CANYONS]: [[ROCK, 0xa06a48, 1.2, 0.6], [SCRUB, 0x86884e, 0.15, 0.6], ...fam('roundShrub', 0x8a8650, 0.3, 0.5), ...fam('joshua', 0x6e7c46, 0.08, 0.8)],
  [B.BADLANDS]: [[ROCK, 0x9c6c50, 1.5, 0.6], ...fam('roundShrub', 0x86884e, 0.25, 0.5)],
  [B.MOUNTAIN]: [[CONIFER, 0x385036, 0.3], ...fam('spruce', 0x385036, 0.3), [ROCK, 0x6d645a, 2.2, 0.7]],
};
Object.assign(FLORA_RICH, MIX);

function trunk(): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(0.05, 0.07, 0.3, 4).translate(0, 0.15, 0).toNonIndexed();
}

function treeGeometries(): THREE.BufferGeometry[] {
  const conifer = mergeGeometries([
    new THREE.ConeGeometry(0.34, 0.7, 6).translate(0, 0.55, 0).toNonIndexed(),
    new THREE.ConeGeometry(0.24, 0.5, 6).translate(0, 0.95, 0).toNonIndexed(),
    trunk(),
  ]);
  // A crown of three lumpy blobs (subdivided and jittered), not one faceted ball.
  const blob = (r: number, x: number, y: number, z: number, seed: number) => {
    const g = new THREE.IcosahedronGeometry(r, 1);
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const k = 0.86 + 0.28 * hash01(seed * 131 + Math.round((p.getX(i) + 3) * 97) * 7 + Math.round((p.getY(i) + 3) * 89) * 3 + Math.round((p.getZ(i) + 3) * 83));
      p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
    }
    return g.translate(x, y, z).toNonIndexed();
  };
  const broadleaf = mergeGeometries([
    blob(0.34, 0, 0.72, 0, 1), blob(0.26, 0.2, 0.58, 0.08, 2), blob(0.25, -0.16, 0.6, -0.12, 3),
    trunk(),
  ]);
  const scrub = mergeGeometries([
    blob(0.36, 0, 0, 0, 4).scale(1.35, 0.55, 1.35).translate(0, 0.42, 0),
    trunk(),
  ]);
  // Palm: a tall thin trunk with a flat, drooping crown.
  const palm = mergeGeometries([
    new THREE.CylinderGeometry(0.035, 0.06, 1.0, 4).translate(0, 0.5, 0).toNonIndexed(),
    new THREE.ConeGeometry(0.42, 0.22, 7).rotateX(Math.PI).translate(0, 1.0, 0).toNonIndexed(),
  ]);
  // Props: a squat boulder, a saguaro-ish cactus, an iceberg that sits low in the water.
  const rock = new THREE.IcosahedronGeometry(0.5, 0).scale(1, 0.55, 0.8).translate(0, 0.12, 0);
  const cactus = mergeGeometries([
    new THREE.CylinderGeometry(0.08, 0.09, 0.9, 6).translate(0, 0.45, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.05, 0.05, 0.3, 5).translate(0.17, 0.6, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.04, 0.04, 0.18, 4).rotateZ(Math.PI / 2).translate(0.09, 0.45, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.05, 0.05, 0.22, 5).translate(-0.16, 0.48, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.04, 0.04, 0.16, 4).rotateZ(Math.PI / 2).translate(-0.08, 0.38, 0).toNonIndexed(),
  ]);
  const iceberg = new THREE.IcosahedronGeometry(0.5, 0).scale(1.4, 0.75, 1.1).translate(0, 0.02, 0);
  // Acacia: a thin trunk forking into a wide, flat umbrella of a crown.
  const acacia = mergeGeometries([
    new THREE.CylinderGeometry(0.03, 0.05, 0.62, 4).translate(0, 0.31, 0).toNonIndexed(),
    new THREE.CylinderGeometry(0.02, 0.03, 0.3, 4).rotateZ(0.5).translate(0.08, 0.68, 0).toNonIndexed(),
    blob(0.36, 0, 0, 0, 5).scale(1.7, 0.3, 1.5).translate(0.05, 0.84, 0),
  ]);
  // Birch: slender, a tall narrow crown.
  const birch = mergeGeometries([
    new THREE.CylinderGeometry(0.025, 0.035, 0.5, 4).translate(0, 0.25, 0).toNonIndexed(),
    blob(0.24, 0, 0, 0, 6).scale(0.75, 1.7, 0.75).translate(0, 0.78, 0),
  ]);
  // Tuft: a tussock of grass or a low shrub, a few low blades.
  const tuft = mergeGeometries([
    new THREE.ConeGeometry(0.16, 0.42, 5).translate(0, 0.21, 0).toNonIndexed(),
    new THREE.ConeGeometry(0.12, 0.32, 5).rotateZ(0.35).translate(0.13, 0.15, 0.03).toNonIndexed(),
    new THREE.ConeGeometry(0.12, 0.3, 5).rotateZ(-0.3).translate(-0.11, 0.14, -0.06).toNonIndexed(),
  ]);
  return [conifer, broadleaf, scrub, palm, rock, cactus, iceberg, acacia, birch, tuft];
}

let shared: THREE.BufferGeometry[] | null = null;

/** The shared low-poly geometry for one kind of plant or prop. */
export function treeGeometry(kind: number): THREE.BufferGeometry {
  if (kind >= FIRST) return speciesGeometry(kind);
  shared ??= treeGeometries();
  return shared[kind];
}
export const treeMaterial = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.9 });

/**
 * A plant's stand-in for the distance (the Fast quality, lodflora.ts): its bounding shape in a
 * couple of dozen corners, against a few hundred for the full model. Tall, narrow plants (spruce,
 * cypress, poplar) a five-sided spire; everything else an eight-faced crown over the lower part
 * of the trunk's height. At a few pixels tall the two can't be told apart.
 */
const lite = new Map<number, THREE.BufferGeometry>();
export function liteGeometry(kind: number): THREE.BufferGeometry {
  const hit = lite.get(kind);
  if (hit) return hit;
  const full = treeGeometry(kind);
  full.computeBoundingBox();
  const b = full.boundingBox!, w = Math.max(b.max.x - b.min.x, 1e-3), d = Math.max(b.max.z - b.min.z, 1e-3), h = Math.max(b.max.y - b.min.y, 1e-3);
  const cx = (b.max.x + b.min.x) / 2, cz = (b.max.z + b.min.z) / 2;
  let g: THREE.BufferGeometry;
  if (h > 2.2 * Math.max(w, d)) {
    g = new THREE.ConeGeometry(Math.max(w, d) / 2, h * 0.92, 5, 1).translate(cx, b.min.y + h * 0.08 + h * 0.46, cz);
  } else {
    // The crown: the upper part for anything with a trunk under it, the whole of low things.
    const tall = h > 0.7 * Math.max(w, d), y0 = tall ? b.min.y + h * 0.3 : b.min.y, ch = b.max.y - y0;
    g = new THREE.OctahedronGeometry(0.5, 0).scale(w, ch, d).translate(cx, y0 + ch / 2, cz);
  }
  g = g.toNonIndexed();
  for (const n of Object.keys(g.attributes)) if (n !== 'position') g.deleteAttribute(n);
  g.computeVertexNormals();
  lite.set(kind, g);
  return g;
}

export function buildForest(t: TreeData): THREE.InstancedMesh[] {
  shared ??= treeGeometries();
  const byKind: number[][] = Array.from({ length: KINDS }, () => []);
  for (let i = 0; i < t.kind.length; i++) byKind[t.kind[i]].push(i);
  const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), q = new THREE.Quaternion(),
    spin = new THREE.Quaternion(), m = new THREE.Matrix4(), p = new THREE.Vector3(), sc = new THREE.Vector3(),
    color = new THREE.Color();
  // (Only kinds with some plants: there are ~60 kinds now, most absent from any one world part.)
  return byKind.flatMap((list, kind) => list.length ? [{ list, kind }] : []).map(({ list, kind }) => {
    const mesh = new THREE.InstancedMesh(treeGeometry(kind), treeMaterial, Math.max(1, list.length));
    mesh.count = list.length;
    list.forEach((j, i) => {
      const x = t.pos[j * 3], y = t.pos[j * 3 + 1], z = t.pos[j * 3 + 2], s = t.size[j];
      n.set(x, y, z).normalize();
      q.setFromUnitVectors(up, n);
      spin.setFromAxisAngle(n, t.spin[j]);
      q.premultiply(spin);
      p.set(x, y, z).addScaledVector(n, -0.04 * s);
      sc.setScalar(s);
      m.compose(p, q, sc);
      mesh.setMatrixAt(i, m);
      color.setHex(t.color[j]).multiplyScalar(t.shade[j]);
      mesh.setColorAt(i, color);
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    return mesh;
  });
}
