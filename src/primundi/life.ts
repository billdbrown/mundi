/**
 * Who else is out there: other caravans on the road (2026-11-07, overnight loop 2, "life in the
 * hex"). Which hex has someone in it, and who, comes from the seed, the hex and the week, so it's
 * the same on a reload and changes as time passes. Most are on the roads.
 *
 * Passing through a hex with someone in it, a card asks whether to stop; in the hex they walk the
 * road, and walking up to them brings up the meeting's card, which is the same text-and-dice as the
 * road's encounters (encounters.ts).
 */
import type { World } from '../world.ts';
import { WATER_LAND } from '../world.ts';
import { nameMaker } from '../gamedata.ts';
import { makeRng } from '../rng.ts';
import { GOODS, G, type Atlas, type Place } from './atlas.ts';
import { best, cargoUsed, hasKeen, huntOdds, living, someone } from './caravan.ts';
import { B } from '../biomes.ts';
import { baseOf } from '../ecology.ts';
import type { Encounter } from './encounters.ts';

export type FolkKind = 'traders' | 'pilgrims' | 'broken';
export interface Folk {
  /** Stable for the hex and the week: `cell-week-kind`. */
  id: string;
  kind: FolkKind;
  /** Their leader's name. */
  name: string;
  /** The place they come from. */
  from: number;
  /** Where they're bound, if known (the traffic's traders). */
  to?: number;
}
export const FOLK_LABEL: Record<FolkKind, string> = { traders: 'A caravan', pilgrims: 'Pilgrims', broken: 'A broken cart' };
/** The chance someone is in a hex this week: on a road, beside one, out in the country. */
export const FOLK_P = { road: 0.08, near: 0.03, wild: 0.01 };

/** Who is in a hex this week (nobody, mostly). */
export function folkIn(w: World, a: Atlas, cell: number, day: number, seed: number): Folk[] {
  if (w.water[cell] !== WATER_LAND || a.placeAt[cell] >= 0) return [];
  const week = Math.floor(day / 7);
  const rng = makeRng((seed * 2246822519 + cell * 3266489917 + week * 668265263) >>> 0);
  const road = !!a.road[cell], near = !road && w.grid.neighbors[cell].some((n) => a.road[n]);
  if (rng() >= (road ? FOLK_P.road : near ? FOLK_P.near : FOLK_P.wild)) return [];
  const r = rng();
  const kind: FolkKind = r < 0.6 ? 'traders' : r < 0.8 ? 'pilgrims' : 'broken';
  // From one of the few nearest places.
  const P = w.grid.centers;
  const near5 = a.places.map((p) => ({ p, d: -(P[p.cell * 3] * P[cell * 3] + P[p.cell * 3 + 1] * P[cell * 3 + 1] + P[p.cell * 3 + 2] * P[cell * 3 + 2]) }))
    .sort((x, y) => x.d - y.d).slice(0, 5);
  const from = near5[Math.floor(rng() * near5.length)].p.id;
  return [{ id: `${cell}-${week}-${kind}`, kind, name: nameMaker((seed * 7 + cell * 13 + week) >>> 0)(), from }];
}

const pick = <T,>(rng: () => number, a: T[]) => a[Math.floor(rng() * a.length)];

/** The meeting's card. `prices`: what their home market pays and asks today (they carry its goods
 * and want its wants). */
export function folkEncounter(f: Folk, home: Place, prices: { buy: number; sell: number }[]): Encounter {
  const homeName = home.name;
  if (f.kind === 'traders') {
    // What they'd buy from you: what you carry that fetches most in their home market.
    return {
      id: 'folk-traders', title: 'A caravan on the road', weight: () => 0,
      text: (x) => pick(x.rng, [
        `${f.name}'s caravan, out of ${homeName}: four carts, and a dog that decides you are all right. They stop to talk.`,
        `Dust, then wheels: traders from ${homeName}, ${f.name} at their head. They pull over and wave you in.`,
      ]),
      choices: (x) => {
        const c = x.caravan;
        let best = -1, bp = 0;
        c.cargo.forEach((n, g) => { const p = Math.round(prices[g].sell * 0.9); if (n > 0 && g !== G.relics && p > bp) { bp = p; best = g; } });
        const food = Math.max(1, Math.round(prices[G.grain].buy / 8 * living(c).length * 5 * 1.2));
        return [
          { label: 'Swap news', hint: `They were in ${homeName} lately: its prices`, resolve: () => ({
            text: `${f.name} tells you what everything fetched in ${homeName} when they left, and asks about the road you came by.`, effect: { learn: home.id } }) },
          ...(best >= 0 ? [{ label: `Sell them ${GOODS[best].name.toLowerCase()}`, hint: `${bp} orrels a load, up to three`, resolve: () => ({
            text: `${f.name} looks it over, haggles for form's sake, and pays.`, effect: { sell: [best, 3, bp] as [number, number, number] } }) }] : []),
          { label: `Buy food from them (${food} orrels)`, hint: 'Five days for everyone', resolve: (y) => y.caravan.orrels >= food
            ? { text: 'Sacks of meal and a side of smoked meat change hands.', effect: { orrels: -food, rations: living(y.caravan).length * 5 } }
            : { text: 'You turn out your purse. Not enough; they shrug kindly.', effect: {} } },
          { label: 'Wish them well and go on', resolve: () => ({ text: 'Good roads, they say. And to you.', effect: {} }) },
        ];
      },
    };
  }
  if (f.kind === 'pilgrims') {
    return {
      id: 'folk-pilgrims', title: 'Pilgrims', weight: () => 0,
      text: (x) => pick(x.rng, [
        `A file of pilgrims out of ${homeName}, singing badly, ${f.name} at the front with a staff taller than they are.`,
        `Walkers with bundles and ribbons on their sticks: pilgrims from ${homeName}, going to a shrine none of you has heard of.`,
      ]),
      choices: () => [
        { label: 'Share your food', hint: 'Five rations', resolve: () => ({
          text: 'They eat with you and bless the carts, and one of them draws you the way to a place they passed.', effect: { rations: -5, morale: 8, rumour: true } }) },
        { label: 'Ask about the country', resolve: () => ({ text: 'They have walked it all, slowly, and describe it all, slowly. Some of it is useful.', effect: { reveal: 2 } }) },
        { label: 'Pass them by', resolve: () => ({ text: 'They wave you on with their ribbons.', effect: {} }) },
      ],
    };
  }
  return {
    id: 'folk-broken', title: 'A broken cart', weight: () => 0,
    text: (x) => pick(x.rng, [
      `A cart on its side by the road, an axle snapped clean. ${f.name}, from ${homeName}, sits on a sack and looks at it.`,
      `Traders from ${homeName} with a wheel off and no spare. ${f.name} gets up hopefully as you come near.`,
    ]),
    choices: (x) => {
      const cheap = GOODS.map((g, i) => ({ i, k: prices[i].buy / g.base })).filter((v) => v.i !== G.relics && prices[v.i].buy > 0).sort((p, q) => p.k - q.k)[0].i;
      const room = x.caravan.capacity - cargoUsed(x.caravan);
      const cost = Math.max(2, Math.round(prices[cheap].buy * 2 * 0.6));
      return [
        { label: 'Help them mend it', hint: 'Half a day', resolve: (y) => ({
          text: `You cut a new axle from what's to hand. ${f.name} pays what they can and tells you all about ${homeName}.`, effect: { days: 0.5, orrels: 10 + Math.round(y.rng() * 20), morale: 4, learn: home.id } }) },
        ...(room >= 2 ? [{ label: `Take two ${GOODS[cheap].name.toLowerCase()} off their hands (${cost} orrels)`, hint: 'Cheap: they need the space', resolve: (y: typeof x) => y.caravan.orrels >= cost
          ? { text: 'Lighter, they might get as far as the next town. You are two loads heavier.', effect: { orrels: -cost, cargo: [[cheap, 2]] as [number, number][] } }
          : { text: 'You can\'t afford even that.', effect: {} } }] : []),
        { label: 'Ride on', resolve: () => ({ text: 'You leave them to it. Someone else will come.', effect: { morale: -2 } }) },
      ];
    },
  };
}

// --- Game you can see ---------------------------------------------------------------------------
/** Animals grazing in a wild hex, to stalk and hunt (in place of the foraging card's old "hunt the
 * trail"). Where there is foraging there is game, of a kind that suits the land. */
export type AnimalKind = 'deer' | 'antelope' | 'goats' | 'elk' | 'fowl';
export const ANIMAL_NAMES: Record<AnimalKind, string> = { deer: 'Deer', antelope: 'Antelope', goats: 'Wild goats', elk: 'Elk', fowl: 'Wildfowl' };
/** Days before a hunted hex has game in it again. */
export const GAME_RETURNS = 25;

/** What game there is in a hex (null: none). */
export function gameIn(w: World, a: Atlas, cell: number, finds: string[]): AnimalKind | null {
  if (a.placeAt[cell] >= 0 || !finds.includes('forage')) return null;
  const b = baseOf(w.biome[cell]);
  if (b === B.TUNDRA || b === B.TAIGA || b === B.ICE) return 'elk';
  if (w.elevation[cell] > 0.45 || b === B.MOUNTAIN) return 'goats';
  if (b === B.STEPPE || b === B.GRASSLAND || b === B.SAVANNA || b === B.DESERT) return 'antelope';
  if (w.moisture[cell] > 0.7 || w.grid.neighbors[cell].some((n) => w.water[n] !== WATER_LAND)) return 'fowl';
  return 'deer';
}
/** Ready to hunt again, `used` the day it last was. */
export const gameReady = (used: number | undefined, day: number) => used === undefined || day - used >= GAME_RETURNS;

/** Close enough, unseen: the shot. */
export function huntEncounter(kind: AnimalKind): Encounter {
  const name = ANIMAL_NAMES[kind].toLowerCase();
  const big = kind === 'elk' || kind === 'deer';
  return {
    id: 'hunt', title: `Within reach: ${name}`, weight: () => 0,
    text: (x) => pick(x.rng, [
      `Downwind, on your bellies in the grass: the ${name} haven't seen you. ${hasKeen(x.caravan) ? 'Your keenest eye has the bow.' : 'Someone nocks an arrow.'}`,
      `The ${name} graze on, a stone's throw off. Nobody breathes.`,
    ]),
    choices: (x) => [
      { label: 'Take the shot', hint: `Hunt ${best(x.caravan, 'hunt')}: ${Math.round(huntOdds(x.caravan) * 100)}%`, resolve: (c) => {
        const n = living(c.caravan).length;
        if (c.rng() < huntOdds(c.caravan)) {
          const fur = big && c.rng() < 0.5;
          return { text: kind === 'fowl' ? 'A brace, and another, before the rest take wing. Feathers everywhere, and supper.' : `A clean kill. You eat well tonight and smoke the rest${fur ? ', and the hide is worth keeping' : ''}.`,
            effect: { rations: Math.round(n * (kind === 'fowl' ? 3 : big ? 6 : 5) * (0.8 + c.rng() * 0.4)), morale: 5, ...(fur ? { cargo: [[G.furs, 1]] as [number, number][] } : {}) } };
        }
        if (kind === 'goats' && c.rng() < 0.3) { const h = someone(c.caravan, c.rng, true); return { text: `A miss, and ${h?.name ?? 'someone'} slips on the scree going after them.`, effect: { hurt: h } }; }
        return { text: 'The shot goes wide. They are gone in a heartbeat.', effect: { morale: -2 } };
      } },
      { label: 'Let them be', resolve: () => ({ text: 'You watch them a while, and leave them to it.', effect: { morale: 2 } }) },
    ],
  };
}

// --- A night in camp ------------------------------------------------------------------------------
/** Chance a night in camp brings something. */
export const CAMP_P = 0.35;
/** What a night out in the country can bring (with the road's wolves). */
export const CAMP_NIGHTS: Encounter[] = [
  {
    id: 'camp-sky', title: 'A clear night', weight: (x) => (x.high ? 2 : 1),
    text: () => 'The cloud tears open after dark and the whole sky comes out. From the rise behind the camp you can see a long way by starlight.',
    choices: () => [
      { label: 'Climb up and sketch it', hint: 'Maps the country round', resolve: () => ({ text: 'Cold hands and a stub of charcoal. By dawn the map has grown.', effect: { reveal: 2, morale: 2 } }) },
      { label: 'Sleep while you can', resolve: () => ({ text: 'The best night\'s sleep in weeks.', effect: { morale: 5 } }) },
    ],
  },
  {
    id: 'camp-visitor', title: 'Someone at the fire', weight: (x) => (x.road ? 2 : 1),
    text: (x) => `A traveller comes out of the dark with their hands open, and asks to sit by your fire. ${x.name()}, they say, walking home.`,
    choices: () => [
      { label: 'Share your fire and food', hint: 'Two rations', resolve: () => ({ text: 'They talk half the night about a place you haven\'t been, and draw it for you in the ashes.', effect: { rations: -2, rumour: true, morale: 2 } }) },
      { label: 'Send them on', resolve: (c) => c.rng() < 0.2
        ? { text: 'They go. In the morning a waterskin has gone with them.', effect: { water: -6 } }
        : { text: 'They go without a word.', effect: {} } },
    ],
  },
  {
    id: 'camp-storm', title: 'Rain in the night', weight: (x) => (x.dry ? 0.3 : 1.5),
    text: () => 'The rain comes in sideways an hour before dawn and finds every gap in every cover.',
    choices: () => [
      { label: 'Ride it out under the carts', resolve: () => ({ text: 'A wet, cold, miserable night. But the skins are full.', effect: { morale: -4, water: 99 } }) },
      { label: 'Pack up and walk through it', resolve: (c) => ({ text: 'Moving keeps you warm. Some of the food doesn\'t keep dry.', effect: { rations: -living(c.caravan).length * 2, morale: -2 } }) },
    ],
  },
];
