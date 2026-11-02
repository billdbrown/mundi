export interface Biome { name: string; color: number }

export const B = {
  DEEP: 0, OCEAN: 1, SHALLOWS: 2, SEA_ICE: 3, LAKE: 4,
  ICE: 5, TUNDRA: 6, TAIGA: 7, STEPPE: 8, GRASSLAND: 9,
  FOREST: 10, TEMPERATE_RAIN: 11, DESERT: 12, SAVANNA: 13, DRY_FOREST: 14,
  RAINFOREST: 15, BEACH: 16, MOUNTAIN: 17, PEAK: 18,
  // Finer biomes (ecology.ts, the B switch).
  SWAMP: 19, MARSH: 20, BOG: 21, FLOODPLAIN: 22, MANGROVE: 23, SALT_MARSH: 24,
  SALT_FLAT: 25, COLD_DESERT: 26, BADLANDS: 27, CHAPARRAL: 28, DESERT_SCRUB: 29,
  POLAR_DESERT: 30, ALPINE_MEADOW: 31, MONTANE_FOREST: 32, LARCH: 33, CLOUD_FOREST: 34,
  MIXED_FOREST: 35, HEATH: 36, PRAIRIE: 37, MONSOON: 38, PALM_SAVANNA: 39,
  REEF: 40, KELP: 41, LAGOON: 42, KARST: 43, CANYONS: 44,
} as const;

export const BIOMES: Biome[] = [
  { name: 'Deep ocean', color: 0x1c2e3a },
  { name: 'Ocean', color: 0x3a5a62 },
  { name: 'Shallows', color: 0xb9a979 },
  { name: 'Sea ice', color: 0xe4eaee },
  { name: 'Lake', color: 0x3f7fae },
  { name: 'Ice cap', color: 0xeef2f5 },
  { name: 'Tundra', color: 0x837f6c },
  { name: 'Taiga', color: 0x3f4f36 },
  { name: 'Steppe', color: 0x9b9171 },
  { name: 'Grassland', color: 0x7b8a4e },
  { name: 'Temperate forest', color: 0x46602f },
  { name: 'Temperate rainforest', color: 0x3a5534 },
  { name: 'Desert', color: 0xcfa27a },
  { name: 'Savanna', color: 0xa69a63 },
  { name: 'Dry forest', color: 0x6c7440 },
  { name: 'Rainforest', color: 0x34552a },
  { name: 'Beach', color: 0xd8c59a },
  { name: 'Mountain', color: 0x7a6c5f },
  // Rock, not white: per-vertex shading puts snow only where it is cold enough (summits, ridges).
  { name: 'Snowy peak', color: 0x857b72 },
  { name: 'Swamp', color: 0x2f4a2e },
  { name: 'Marsh', color: 0x5f7346 },
  { name: 'Bog', color: 0x6a6447 },
  { name: 'Floodplain', color: 0x5e7e3c },
  { name: 'Mangrove', color: 0x2d4f34 },
  { name: 'Salt marsh', color: 0x7d8758 },
  { name: 'Salt flats', color: 0xe6e1d4 },
  { name: 'Cold desert', color: 0xb5a586 },
  { name: 'Badlands', color: 0xb07a5a },
  { name: 'Chaparral', color: 0x8a8a52 },
  { name: 'Desert scrub', color: 0xbea170 },
  { name: 'Polar desert', color: 0x9c968a },
  { name: 'Alpine meadow', color: 0x7f8f55 },
  { name: 'Montane forest', color: 0x3c5636 },
  { name: 'Larch forest', color: 0x6f7340 },
  { name: 'Cloud forest', color: 0x2f5a3a },
  { name: 'Mixed forest', color: 0x4a5f34 },
  { name: 'Heath', color: 0x7a6a5c },
  { name: 'Tallgrass prairie', color: 0x93984f },
  { name: 'Monsoon forest', color: 0x4c6a2c },
  { name: 'Palm savanna', color: 0x8f9a55 },
  { name: 'Coral reef', color: 0x46b3b0 },
  { name: 'Kelp forest', color: 0x2f5550 },
  { name: 'Lagoon', color: 0x6cc2c0 },
  { name: 'Karst', color: 0x557a44 },
  { name: 'Canyonlands', color: 0xa86a48 },
];

/**
 * Whittaker-style lookup on temperature and moisture, both 0..1.
 *
 * Temperature maps roughly to mean annual °C as 50·t − 17 (equator ~30 °C, 45° ~10 °C, 60° ~0 °C,
 * 70° ~−7 °C), and the bands follow Earth's: ice caps below about −13 °C, tundra to −7 °C (the
 * tree line, whatever the rain), boreal forest to +4 °C, temperate to +19 °C, tropical above.
 * Moisture splits each band into desert, semi-arid steppe, grass or savanna, and forest, with
 * the semi-arid fringe that rings Earth's deserts (Sahel, Great Plains, Kazakh steppe).
 * Checked against Köppen-Geiger land shares with scripts/climate-stats.ts.
 */
export function landBiome(temp: number, moist: number, elev: number): number {
  // Ice sheets are a polar thing: cold at sea level, not just cold because the land is high.
  // High ground that is only cold from altitude is rock, and per-vertex snow picks out the
  // crests; otherwise every mid-latitude range became one white glacier blob.
  if (temp < 0.07 && (elev < 0.5 || temp + 0.55 * elev < 0.3)) return B.ICE;
  if (elev > 0.78) return temp < 0.5 ? B.PEAK : B.MOUNTAIN;
  if (elev > 0.58) return temp < 0.28 ? B.PEAK : B.MOUNTAIN;
  if (temp < 0.18) return B.TUNDRA;
  if (temp < 0.42) return moist < 0.14 ? B.STEPPE : B.TAIGA;   // boreal forest tolerates little rain
  if (temp < 0.72) {
    if (moist < 0.2) return B.DESERT;
    if (moist < 0.3) return B.STEPPE;
    if (moist < 0.44) return B.GRASSLAND;
    if (moist < 0.68) return B.FOREST;
    return B.TEMPERATE_RAIN;
  }
  if (moist < 0.22) return B.DESERT;
  if (moist < 0.3) return B.STEPPE;
  if (moist < 0.47) return B.SAVANNA;
  if (moist < 0.64) return B.DRY_FOREST;
  return B.RAINFOREST;
}
