/**
 * Buying and handing out gear (caravan.ts ITEMS, decision 2026-11-08). A town sells what its trade
 * makes, plus spears and hide coats anywhere: tier 2 only in towns, tier 3 only on the frontier and
 * beyond (depth.ts). Deep ruins sometimes hold tier-3 gear.
 *
 * Gear goes to whoever gains most from it (the one who does a one-person task, or for a fight
 * item the weakest fighter it lifts most), and can be handed to someone else from their papers.
 */
import type { World } from '../world.ts';
import type { Atlas, Place } from './atlas.ts';
import { bandAt } from './depth.ts';
import { tradesOf } from './towns.ts';
import { CARAVAN_GEAR, CART_LOAD, doerOf, eff, fightOf, ITEMS, itemOf, living, SKILLS, type Caravan, type CaravanGear, type Item, type Member } from './caravan.ts';

/** What a place sells. */
export function shopAt(w: World, a: Atlas, p: Place): Item[] {
  const trade = tradesOf(w, a, p)[0], band = bandAt(w, a, p.cell);
  return ITEMS.filter((it) => {
    if (it.tier === 3) return band >= 1 && p.town;
    if (it.tier === 2 && !p.town) return false;
    return !it.trades || it.trades.includes(trade);
  });
}
/** Caravan gear a place sells: carts where there's timber or smiths, lanterns in any town. */
export function caravanShopAt(w: World, a: Atlas, p: Place): CaravanGear[] {
  const trade = tradesOf(w, a, p)[0];
  return [...(['timber', 'smithing'].includes(trade) ? ['cart' as const] : []), ...(p.town ? ['lantern' as const] : [])];
}

/** How much `m` would gain from `it`, over what they have in that slot now. */
export function gainFor(c: Caravan, m: Member, it: Item): number {
  // Fight counts as the rules count it (some pips are worth more than others), the rest by pips.
  const score = () => fightOf(m) + SKILLS.reduce((a, k) => a + (k === 'fight' ? 0 : eff(m, k)), 0);
  const before = score();
  const old = m.gear?.[it.slot];
  (m.gear ??= {})[it.slot] = it.id;
  let after = score();
  // One-person skills only count for whoever does the task.
  for (const k of SKILLS) if (k !== 'fight' && it.adds[k] && doerOf(c, k) !== m) after -= 0.5 * (it.adds[k] ?? 0);
  if (old) m.gear[it.slot] = old; else delete m.gear[it.slot];
  return after - before;
}
/** Who should carry `it`: whoever gains most. */
export function bestHolder(c: Caravan, it: Item): Member | null {
  let w: Member | null = null, wg = 0;
  for (const m of living(c)) { const gn = gainFor(c, m, it); if (gn > wg + 1e-9) { wg = gn; w = m; } }
  return w;
}
/** Put an item on someone; what they had in that slot goes to the stores. */
function put(c: Caravan, m: Member, id: string) {
  const it = itemOf(id)!, old = m.gear?.[it.slot];
  if (old) (c.stores ??= []).push(old);
  (m.gear ??= {})[it.slot] = id;
}
/** Hand someone an item from the stores. False if it isn't there. */
export function equip(c: Caravan, m: Member, id: string): boolean {
  const k = (c.stores ?? []).indexOf(id);
  if (k < 0 || !itemOf(id)) return false;
  c.stores!.splice(k, 1);
  put(c, m, id);
  return true;
}
/** Take something off someone, into the stores. */
export function unequip(c: Caravan, m: Member, slot: Item['slot']) {
  const id = m.gear?.[slot];
  if (!id) return;
  delete m.gear![slot];
  (c.stores ??= []).push(id);
}
/** A new item: to whoever gains most, else to the stores. Who got it. */
export function take(c: Caravan, id: string): Member | null {
  const it = itemOf(id)!, m = bestHolder(c, it);
  if (m) put(c, m, id); else (c.stores ??= []).push(id);
  return m;
}
/** Buy an item; who it went to ('' to the stores), or null if it couldn't be. */
export function buyItem(c: Caravan, id: string): string | null {
  const it = itemOf(id);
  if (!it || c.orrels < it.cost) return null;
  c.orrels -= it.cost;
  return take(c, id)?.name ?? '';
}
export function buyCaravanGear(c: Caravan, k: CaravanGear): boolean {
  const g = CARAVAN_GEAR[k];
  if (c.kit?.includes(k) || c.orrels < g.cost) return false;
  c.orrels -= g.cost;
  (c.kit ??= []).push(k);
  if (k === 'cart') c.capacity += CART_LOAD;
  return true;
}
/** Tier-3 gear a deep ruin might hold. */
export const DEEP_GEAR = ITEMS.filter((x) => x.tier === 3).map((x) => x.id);
export const DEEP_GEAR_CHANCE = 0.3;
