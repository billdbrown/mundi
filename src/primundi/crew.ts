/**
 * Where someone is from (decision 2026-11-08: the character sheet is a traveller's papers, not a
 * colonist's résumé). A person is born in a town: its trade gives them a knack, one skill pip, at
 * birth; its land lets them eat a little less while the caravan is in that kind of country.
 *
 * Names are generic (chaparral, taiga), never Earth's.
 */
import { B } from '../biomes.ts';
import type { World } from '../world.ts';
import type { Atlas, Place } from './atlas.ts';
import { BORN_EATS, SKILL_MAX, SKILL_NAMES, type Member, type Skill, type Stat } from './caravan.ts';
import { tradesOf, TRADES, type Trade } from './towns.ts';

export type Land = 'tundra' | 'taiga' | 'desert' | 'grassland' | 'forest' | 'chaparral' | 'wetland' | 'highland' | 'coast';
const LAND_OF: Partial<Record<number, Land>> = {
  [B.ICE]: 'tundra', [B.TUNDRA]: 'tundra', [B.POLAR_DESERT]: 'tundra',
  [B.TAIGA]: 'taiga', [B.LARCH]: 'taiga',
  [B.DESERT]: 'desert', [B.DESERT_SCRUB]: 'desert', [B.SALT_FLAT]: 'desert', [B.COLD_DESERT]: 'desert', [B.BADLANDS]: 'desert', [B.CANYONS]: 'desert',
  [B.STEPPE]: 'grassland', [B.GRASSLAND]: 'grassland', [B.PRAIRIE]: 'grassland', [B.SAVANNA]: 'grassland', [B.PALM_SAVANNA]: 'grassland',
  [B.FOREST]: 'forest', [B.TEMPERATE_RAIN]: 'forest', [B.MIXED_FOREST]: 'forest', [B.MONTANE_FOREST]: 'forest', [B.CLOUD_FOREST]: 'forest', [B.RAINFOREST]: 'forest', [B.MONSOON]: 'forest',
  [B.DRY_FOREST]: 'chaparral', [B.CHAPARRAL]: 'chaparral', [B.HEATH]: 'chaparral',
  [B.SWAMP]: 'wetland', [B.MARSH]: 'wetland', [B.BOG]: 'wetland', [B.FLOODPLAIN]: 'wetland', [B.MANGROVE]: 'wetland', [B.SALT_MARSH]: 'wetland',
  [B.MOUNTAIN]: 'highland', [B.PEAK]: 'highland', [B.ALPINE_MEADOW]: 'highland', [B.KARST]: 'highland',
};
/** The kind of country a hex is, for the born-in rule. */
export const landOf = (w: World, cell: number): Land => LAND_OF[w.biome[cell]] ?? 'coast';

/** A town's trade teaches its children one thing (never Fight: that is earned on the road). */
export const KNACK: Record<Trade, Skill> = {
  fishing: 'hunt', trapping: 'hunt', herding: 'hunt',
  market: 'barter', weaving: 'barter', salt: 'barter',
  shrine: 'mend', smithing: 'mend', farming: 'mend',
  mining: 'scout', timber: 'scout',
};

/** Where someone is from: a place, its trade, its land. */
export interface Born { pid: number; land: Land; trade?: Trade }

/** Born in `p`: the papers, and (with `knack`) the trade's pip, once. */
export function bornIn(m: Member, w: World, a: Atlas, p: Place, knack = true): Member {
  const trade = tradesOf(w, a, p)[0];
  m.born = { pid: p.id, land: landOf(w, p.cell), trade };
  if (knack && trade) { const k = KNACK[trade]; m.skills[k] = Math.min(SKILL_MAX, m.skills[k] + 1); }
  return m;
}

/** The papers' Born line, as stats. */
export function bornStats(m: Member): Stat[] {
  const b = m.born;
  if (!b) return [];
  const out: Stat[] = [];
  const t = b.trade as Trade | undefined;
  if (t) out.push({ k: `${SKILL_NAMES[KNACK[t]]} (${TRADES[t].name})`, v: '+1', good: true });
  out.push({ k: `Eats in ${b.land}`, v: `−${Math.round((1 - BORN_EATS) * 100)}%`, good: true });
  return out;
}
