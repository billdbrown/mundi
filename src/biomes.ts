export interface Biome { name: string; color: number }

export const B = {
  DEEP: 0, OCEAN: 1, SHALLOWS: 2, SEA_ICE: 3, LAKE: 4,
  ICE: 5, TUNDRA: 6, TAIGA: 7, STEPPE: 8, GRASSLAND: 9,
  FOREST: 10, TEMPERATE_RAIN: 11, DESERT: 12, SAVANNA: 13, DRY_FOREST: 14,
  RAINFOREST: 15, BEACH: 16, MOUNTAIN: 17, PEAK: 18,
} as const;

export const BIOMES: Biome[] = [
  { name: 'Deep ocean', color: 0x0c2a4a },
  { name: 'Ocean', color: 0x1a4f7d },
  { name: 'Shallows', color: 0x3b8fa0 },
  { name: 'Sea ice', color: 0xe6eff4 },
  { name: 'Lake', color: 0x3f7fae },
  { name: 'Ice cap', color: 0xf3f7fa },
  { name: 'Tundra', color: 0x8e9879 },
  { name: 'Taiga', color: 0x46644a },
  { name: 'Cold steppe', color: 0xa8a47c },
  { name: 'Grassland', color: 0x8db458 },
  { name: 'Temperate forest', color: 0x3f7d38 },
  { name: 'Temperate rainforest', color: 0x2e6a4a },
  { name: 'Desert', color: 0xdcb878 },
  { name: 'Savanna', color: 0xbcb15a },
  { name: 'Dry forest', color: 0x74913c },
  { name: 'Rainforest', color: 0x22702c },
  { name: 'Beach', color: 0xe4d4a2 },
  { name: 'Mountain', color: 0x877c70 },
  { name: 'Snowy peak', color: 0xf2f2f2 },
];

/** Whittaker-style lookup on temperature and moisture, both 0..1. */
export function landBiome(temp: number, moist: number, elev: number): number {
  if (temp < 0.14) return B.ICE;
  if (elev > 0.78) return temp < 0.5 ? B.PEAK : B.MOUNTAIN;
  if (elev > 0.58) return temp < 0.28 ? B.PEAK : B.MOUNTAIN;
  if (temp < 0.3) return moist > 0.5 ? B.TAIGA : B.TUNDRA;
  if (temp < 0.45) return moist < 0.3 ? B.STEPPE : moist < 0.5 ? B.TAIGA : B.TAIGA;
  if (temp < 0.7) {
    if (moist < 0.22) return B.DESERT;
    if (moist < 0.42) return B.GRASSLAND;
    if (moist < 0.68) return B.FOREST;
    return B.TEMPERATE_RAIN;
  }
  if (moist < 0.24) return B.DESERT;
  if (moist < 0.42) return B.SAVANNA;
  if (moist < 0.62) return B.DRY_FOREST;
  return B.RAINFOREST;
}
