export interface Biome { name: string; color: number }

export const B = {
  DEEP: 0, OCEAN: 1, SHALLOWS: 2, SEA_ICE: 3, LAKE: 4,
  ICE: 5, TUNDRA: 6, TAIGA: 7, STEPPE: 8, GRASSLAND: 9,
  FOREST: 10, TEMPERATE_RAIN: 11, DESERT: 12, SAVANNA: 13, DRY_FOREST: 14,
  RAINFOREST: 15, BEACH: 16, MOUNTAIN: 17, PEAK: 18,
} as const;

export const BIOMES: Biome[] = [
  { name: 'Deep ocean', color: 0x1c2e3a },
  { name: 'Ocean', color: 0x3a5a62 },
  { name: 'Shallows', color: 0xb9a979 },
  { name: 'Sea ice', color: 0xe9f0f4 },
  { name: 'Lake', color: 0x3f7fae },
  { name: 'Ice cap', color: 0xf1f5f8 },
  { name: 'Tundra', color: 0x8b8e76 },
  { name: 'Taiga', color: 0x56694a },
  { name: 'Cold steppe', color: 0xaea578 },
  { name: 'Grassland', color: 0x8ba657 },
  { name: 'Temperate forest', color: 0x55803d },
  { name: 'Temperate rainforest', color: 0x47714a },
  { name: 'Desert', color: 0xd9be8b },
  { name: 'Savanna', color: 0xbbae68 },
  { name: 'Dry forest', color: 0x8c9b50 },
  { name: 'Rainforest', color: 0x3f7034 },
  { name: 'Beach', color: 0xe3d3a5 },
  { name: 'Mountain', color: 0x7e7266 },
  { name: 'Snowy peak', color: 0xf4f4f6 },
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
