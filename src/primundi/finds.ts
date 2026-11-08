/**
 * Things to find inside a hex, by walking to them (2026-11-06, Bill: give a reason to go into a
 * hex). Which a hex has comes from the seed and the land, so it's the same every visit; the hex
 * view puts each on the ground (a lookout on the high point, a spring in a hollow, foraging in the
 * woods, ruins and old camps further out) and shows it once the caravan comes near (a lookout can be
 * seen from anywhere). Reaching one brings up its card: the same text-and-dice as the road's
 * encounters (encounters.ts).
 *
 * Lookouts, ruins and camps are once only; a spring fills the skins again after a few days, and
 * foraging comes back with the month.
 */
import type { World } from '../world.ts';
import { WATER_LAND } from '../world.ts';
import { B } from '../biomes.ts';
import { baseOf } from '../ecology.ts';
import { makeRng } from '../rng.ts';
import { G } from './atlas.ts';
import type { Atlas } from './atlas.ts';
import { hasWater } from './atlas.ts';
import { living, someone, waterCap } from './caravan.ts';
import { ENCOUNTERS, type Encounter } from './encounters.ts';
import { bandAt } from './depth.ts';
import { landOf } from './crew.ts';

export type FindKind = 'lookout' | 'spring' | 'forage' | 'ruin' | 'camp' | 'wilds';
export const FIND_NAMES: Record<FindKind, string> = { lookout: 'Lookout', spring: 'Spring', forage: 'Foraging', ruin: 'Ruins', camp: 'Old camp', wilds: 'Wild goods' };
/** Wild goods (furs, ore, wool or salt, by the land) lie only in the Wild and the Deep, at this
 * chance a hex by band (depth.ts): the loot that makes going out there pay. */
export const WILDS_CHANCE = [0, 0, 0.35, 0.55];

const pick = <T,>(rng: () => number, a: T[]) => a[Math.floor(rng() * a.length)];
const FOREST = new Set<number>([B.FOREST, B.TEMPERATE_RAIN, B.RAINFOREST, B.TAIGA, B.DRY_FOREST]);
const DRY = new Set<number>([B.DESERT, B.STEPPE, B.SAVANNA]);

/** What there is to find in a hex: none to three things, the same every time for a seed. */
export function findsIn(w: World, atlas: Atlas, cell: number, seed: number): FindKind[] {
  if (w.water[cell] !== WATER_LAND) return [];
  const rng = makeRng((seed * 2654435761 + cell * 40503 + 17) >>> 0);
  const nb = w.grid.neighbors[cell];
  const e = w.elevation[cell];
  const higher = nb.filter((n) => w.elevation[n] > e).length;
  const base = baseOf(w.biome[cell]);
  const town = atlas.placeAt[cell] >= 0;
  const out: FindKind[] = [];
  // A high point with a view: on a hill or a ridge, more likely the fewer neighbours stand above it.
  if (rng() < (e > 0.3 ? 0.55 : 0.2) + (higher === 0 ? 0.35 : higher === 1 ? 0.15 : 0)) out.push('lookout');
  // Water where it's short.
  const spring = rng();
  if (!hasWater(w, atlas, cell) && spring < 0.45) out.push('spring');
  // Food from the land: woods, wet grass, the shore.
  const fertile = FOREST.has(base) || w.moisture[cell] > 0.5 || nb.some((n) => w.water[n] !== WATER_LAND);
  if (rng() < (fertile ? 0.55 : DRY.has(base) ? 0.12 : 0.3)) out.push('forage');
  const band = bandAt(w, atlas, cell);
  if (!town) {
    // Ruins and old camps: more of both further from anyone (depth.ts).
    const r = rng(), k = 1 + band * 0.5;
    if (r < 0.14 * k) out.push('ruin');
    else if (r < 0.24 * k) out.push('camp');
  }
  if (!town && rng() < WILDS_CHANCE[band]) out.push('wilds');
  return out;
}

/** Whether a find can be used again, `used` the day it last was (undefined: never). */
export function findReady(kind: FindKind, used: number | undefined, day: number): boolean {
  if (used === undefined) return true;
  if (kind === 'spring') return day - used >= 4;
  if (kind === 'forage') return day - used >= 25;
  if (kind === 'wilds') return day - used >= 90;
  return false;
}

/** The cards for each find, as encounters (weight unused: they aren't drawn, they're walked to). */
export const FINDS: Record<FindKind, Encounter> = {
  lookout: {
    id: 'find-lookout',
    title: 'A lookout',
    weight: () => 0,
    text: (x) => pick(x.rng, [
      'The ground falls away on every side. Someone has piled a cairn here before you, and from beside it the country lies open for days.',
      'A bare crown of rock above the trees. From the top you can follow the rivers a long way out.',
      'The wind is hard up here, and the view is wider than any map you carry.',
    ]),
    choices: (x) => [
      { label: 'Draw what you see', hint: x.caravan.origin === 'cartographers' ? 'Every hex you draw sells' : 'Maps the country round', resolve: (c) => ({
        text: pick(c.rng, ['You sit with the board on your knees until the light goes, and come down with the country in ink.', 'Valleys, a far lake, the line of a road: all of it goes down on the chart.']),
        effect: { reveal: 3, morale: 3 },
      }) },
      { label: 'Add a stone to the cairn', resolve: (c) => ({ text: 'You add a stone, as travellers do. The view is still there to draw, another day.', effect: { morale: 5 + Math.round(c.rng() * 3) } }) },
    ],
  },
  spring: {
    id: 'find-spring',
    title: 'A spring',
    weight: () => 0,
    text: (x) => pick(x.rng, [
      'Clear water wells up between mossy stones and runs off into the grass. The beasts smell it before you see it.',
      'A cold spring under an overhang, ringed with stones by whoever found it first.',
    ]),
    choices: (x) => [
      { label: 'Fill the skins', hint: `Water for ${Math.floor(waterCap(x.caravan) / Math.max(1, living(x.caravan).length))} days`, resolve: (c) => ({ text: 'You drink, water the beasts, and fill every skin you have.', effect: { water: waterCap(c.caravan), morale: 2 } }) },
    ],
  },
  forage: {
    id: 'find-forage',
    title: 'Something to eat',
    weight: () => 0,
    text: (x) => x.forest
      ? pick(x.rng, ['Berry thickets along a game trail, and mushrooms in the leaf litter under them.', 'Hazel and brambles heavy with fruit, and the tracks of deer going down to water.'])
      : x.dry ? 'Wild seed heads standing in a hollow out of the wind, and roots a hand knows to dig.'
      : pick(x.rng, ['Wild greens and roots in a wet hollow, and birds nesting in the reeds.', 'A slope of wild herbs and seed heads, buzzing with bees.']),
    choices: (x) => [
      { label: 'Gather for half a day', hint: `For ${living(x.caravan).length} people`, resolve: (c) => {
        const n = living(c.caravan).length, k = Math.round(n * (2 + c.rng() * 3));
        return { text: c.rng() < 0.5 ? 'Everyone comes back with full hands.' : 'Slow work, but the sacks are fuller for it.', effect: { rations: k, days: 0.5 } };
      } },
      // (Hunting is the game you can see in the hex now: life.ts.)
      { label: 'Leave it for now', resolve: () => ({ text: 'You note the place and walk on.', effect: {} }) },
    ],
  },
  ruin: ENCOUNTERS.find((e) => e.id === 'ruins')!,
  wilds: {
    id: 'find-wilds',
    title: 'Wild goods',
    weight: () => 0,
    text: (x) => {
      const [, what] = wildGood(x.w, x.cell);
      return `Nobody has worked this country in a long time, maybe ever. ${what}`;
    },
    choices: (x) => [
      { label: 'Spend a day gathering', hint: 'Worth more the deeper you are', resolve: (c) => {
        const [gi] = wildGood(c.w, c.cell), n = 3 + Math.floor(c.rng() * 4);
        // The deep bites back now and then.
        if (c.band >= 3 && c.rng() < 0.15) { const h = someone(c.caravan, c.rng, true); return { text: `A long day's work, and ${h?.name ?? 'someone'} is hurt getting it.`, effect: { cargo: [[gi, n]], hurt: h, days: 1 } }; }
        return { text: 'A long day, and loads worth carrying home.', effect: { cargo: [[gi, n]], days: 1 } };
      } },
      { label: 'Leave it', resolve: () => ({ text: 'You mark it and go on.', effect: {} }) },
    ],
  },
  camp: {
    id: 'find-camp',
    title: 'An old camp',
    weight: () => 0,
    text: (x) => pick(x.rng, [
      'A ring of blackened stones, a collapsed lean-to, a crate half under the leaves. Whoever camped here left in a hurry, or didn\'t leave.',
      'The bones of a camp: tent pegs still in the ground, a cold hearth, and a cache dug in under a rock.',
    ]),
    choices: () => [
      { label: 'Go through it', resolve: (c) => {
        const r = c.rng();
        if (r > 0.65) return { text: 'Wrapped in oilcloth under the rock: trade goods, still dry.', effect: { cargo: [[pick(c.rng, [G.cloth, G.salt, G.tools]), 1 + Math.floor(c.rng() * 2)]] } };
        if (r > 0.3) return { text: 'Hard bread in a tin, a skin of oil, a few coins in a boot.', effect: { rations: 6 + Math.round(c.rng() * 6), orrels: Math.round(4 + c.rng() * 10) } };
        const h = someone(c.caravan, c.rng, true);
        return { text: `Snakes have the cache. ${h?.name ?? 'Someone'} is bitten, and the day goes on poultices.`, effect: { sick: h, days: 0.5 } };
      } },
      { label: 'Leave it be', resolve: () => ({ text: 'Whatever happened here, it isn\'t yours.', effect: {} }) },
    ],
  },
};

/** What the wild has to give, by the land: furs in the cold and the woods, ore in the heights, wool
 * on the grass, salt in the desert. */
export function wildGood(w: World, cell: number): [number, string] {
  const l = landOf(w, cell);
  if (l === 'highland') return [G.ore, 'A seam of ore shows in a cut bank, rust-red, easy to break out.'];
  if (l === 'grassland') return [G.wool, 'Wild sheep have shed on every thornbush for a mile: good wool, for the gathering.'];
  if (l === 'desert') return [G.salt, 'A dry lake bed, white with salt a hand deep.'];
  return [G.furs, 'Trap lines would fill fast here: the tracks are everywhere, and nobody hunts them.'];
}
