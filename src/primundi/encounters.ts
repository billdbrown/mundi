/**
 * Things that happen on the road. Each encounter says where it can happen (its weight in a
 * context: the hex's land, the road, the season, the caravan), what the player sees, and the
 * choices; a choice resolves against the caravan's numbers and the dice, as text. No battle
 * screen: combat is text and stats for now (decision 2026-11-06).
 *
 * The list is meant to grow long. Add one by adding an entry: nothing else needs to change.
 */
import { B } from '../biomes.ts';
import { baseOf } from '../ecology.ts';
import type { World } from '../world.ts';
import { G, GOODS } from './atlas.ts';
import { BANDS, type Band } from './depth.ts';
import { type Skill, best, cargoUsed, living, makeMember, someone, strength, waterCap, type Caravan, type Lean, type Member } from './caravan.ts';

export interface Ctx {
  w: World;
  cell: number;
  /** Base biome (ecology baseOf). */
  base: number;
  biome: number;
  road: boolean;
  river: boolean;
  cold: boolean;
  snow: boolean;
  dry: boolean;
  high: boolean;
  forest: boolean;
  /** A town within a few hexes. */
  nearTown: boolean;
  caravan: Caravan;
  rng: () => number;
  /** An invented name. */
  name: () => string;
  /** Someone in the caravan the encounter is about, chosen once, so its text and outcome agree. */
  subject: Member | null;
  /** How deep in the wild (depth.ts): bandits fight harder and a lost fight kills more often. */
  band: Band;
}

export interface Effect {
  orrels?: number;
  rations?: number;
  water?: number;
  /** Days lost (the clock moves on). */
  days?: number;
  morale?: number;
  cargo?: [number, number][];
  /** Lose this fraction of every good carried. */
  loseCargo?: number;
  /** Someone is hurt / falls sick / dies (null: nobody that time). */
  hurt?: Member | null;
  sick?: Member | null;
  dies?: Member | null;
  /** Reveal hexes this far around. */
  reveal?: number;
  /** Reveal the hexes around the nearest unknown place: a rumour on the map. */
  rumour?: boolean;
  /** Someone new joins. */
  recruit?: { lean: Lean; name: string };
  /** The job that brought you here is done. */
  questDone?: boolean;
  /** Sell loads to someone met on the road: good, how many, orrels each. */
  sell?: [number, number, number];
  /** Learn a market's prices (a place id): news from someone who was just there. */
  learn?: number;
}
export interface Outcome { text: string; effect: Effect }
export interface Choice { label: string; hint?: string;
  /** The skill this choice exercises: who learns from it (learn.ts). */
  uses?: Skill;
  /** Not open to this caravan: what it would take ("Scout 4"). Shown greyed, can't be chosen. */
  locked?: string;
  resolve(ctx: Ctx): Outcome }
/** A choice that needs the caravan's best at something. */
export const SLIP_SCOUT = 4, PARLEY_BARTER = 3;
export interface Encounter {
  id: string;
  title: string;
  weight(ctx: Ctx): number;
  text(ctx: Ctx): string;
  choices(ctx: Ctx): Choice[];
}

const FOREST = new Set<number>([B.FOREST, B.TEMPERATE_RAIN, B.RAINFOREST, B.TAIGA, B.DRY_FOREST]);
const DRY = new Set<number>([B.DESERT, B.STEPPE, B.SAVANNA]);

/** A fight: the caravan's strength against the enemy's. Returns the margin, about −1..1. */
function fight(ctx: Ctx, enemy: number): number {
  const s = strength(ctx.caravan) * (0.75 + ctx.rng() * 0.5);
  const e = enemy * (0.75 + ctx.rng() * 0.5);
  return (s - e) / Math.max(s, e);
}
const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const pick = <T,>(rng: () => number, a: T[]) => a[Math.floor(rng() * a.length)];
const valueCarried = (c: Caravan) => c.cargo.reduce((a, n, g) => a + n * GOODS[g].base, 0);

export const ENCOUNTERS: Encounter[] = [
  {
    id: 'bandits',
    title: 'Bandits',
    weight: (x) => (x.road ? 1.2 : 0.6) * (valueCarried(x.caravan) > 150 ? 1.5 : 0.8),
    text: (x) => `Riders come down off the ${x.high ? 'ridge' : x.forest ? 'tree line' : 'rise'} and spread across the way. Their leader wants a toll, and names it: a tenth of what you carry, or ${Math.max(15, Math.round(x.caravan.orrels * 0.15))} orrels.`,
    choices: (x) => {
      const toll = Math.max(15, Math.round(x.caravan.orrels * 0.15));
      const [lo, hi] = BANDS[x.band].bandits, enemy = lo + x.rng() * (hi - lo);
      return [
        { label: 'Fight', uses: 'fight', hint: strength(x.caravan) > enemy ? 'They look thinner than you' : 'They look many', resolve: (c) => {
          const m = fight(c, enemy);
          if (m > 0.25) return { text: 'Your guards hold the line and the riders break. One drops a purse as he goes.', effect: { orrels: Math.round(10 + c.rng() * 30), morale: 8 } };
          if (m > -0.1) { const h = someone(c.caravan, c.rng); return { text: `A short, ugly scrap. They ride off, but ${h?.name ?? 'someone'} takes a blade.`, effect: { hurt: h, morale: -4 } }; }
          const d = c.rng() < BANDS[c.band].lethal ? someone(c.caravan, c.rng) : null, h = d ? null : someone(c.caravan, c.rng);
          return { text: d ? `They overrun you. ${d.name} falls, and they take what they like.` : `They overrun you and take what they like. ${h?.name ?? 'Someone'} is hurt.`, effect: { loseCargo: 0.3, orrels: -Math.round(c.caravan.orrels * 0.2), dies: d, hurt: h, morale: -15 } };
        } },
        { label: 'Slip past', uses: 'scout', hint: 'Off the road before they see you', locked: best(x.caravan, 'scout') >= SLIP_SCOUT ? undefined : `Scout ${SLIP_SCOUT}`, resolve: (c) => c.rng() < 0.8
          ? { text: 'Your scout saw them first. You lead the beasts off the road and round, and they never know you were there.', effect: { days: 0.5 } }
          : { text: 'A beast brays at the wrong moment. They come for you, and take more for the trouble.', effect: { loseCargo: 0.15, morale: -6 } } },
        { label: `Talk it down to ${Math.round(toll / 2)}`, uses: 'barter', hint: 'Someone here knows how to haggle', locked: best(x.caravan, 'barter') >= PARLEY_BARTER ? undefined : `Barter ${PARLEY_BARTER}`, resolve: (c) => c.caravan.orrels >= Math.round(toll / 2)
          ? { text: 'A long talk, some laughing, a cup shared. They settle for half and call it a favour.', effect: { orrels: -Math.round(toll / 2) } }
          : { text: 'They like the talk, not the empty purse, and take a tenth of the cargo.', effect: { orrels: -c.caravan.orrels, loseCargo: 0.1, morale: -4 } } },
        { label: `Pay ${toll} orrels`, resolve: (c) => c.caravan.orrels >= toll
          ? { text: 'They count it twice and wave you through.', effect: { orrels: -toll, morale: -3 } }
          : { text: 'You turn out your purse. They take it, and a tenth of the cargo besides.', effect: { orrels: -c.caravan.orrels, loseCargo: 0.1, morale: -6 } } },
        { label: 'Turn and run', resolve: (c) => c.rng() < 0.55
          ? { text: 'You whip the beasts round and lose them in rough ground, a day out of your way.', effect: { days: 1, morale: -2 } }
          : { text: 'Laden beasts do not outrun horses. They catch you, and take more for the trouble.', effect: { loseCargo: 0.2, morale: -8 } } },
      ];
    },
  },
  {
    // The deep's own danger (depth.ts): never in settled country, more often and harder further out.
    id: 'predators',
    title: 'Something hunting you',
    weight: (x) => [0, 0.5, 1.4, 2.4][x.band],
    text: (x) => `${x.cold ? 'Long grey shapes' : x.forest ? 'Eyes in the trees' : x.dry ? 'Big cats' : 'A pack'} ${x.forest ? 'keep pace with you through the trunks' : 'have been following since morning'}. Tonight they mean to try the beasts, or you.`,
    choices: (x) => {
      const [lo, hi] = BANDS[x.band].bandits, enemy = (lo + x.rng() * (hi - lo)) * 0.8;
      return [
        { label: 'Stand and fight', uses: 'fight', hint: strength(x.caravan) > enemy ? 'You have the numbers' : 'They are many, and hungry', resolve: (c) => {
          const m = fight(c, enemy);
          if (m > 0.2) return { text: 'They come at the fire and get the worst of it. By morning there are hides to scrape.', effect: { morale: 6, cargo: [[G.furs, 1 + Math.floor(c.rng() * 2)]] } };
          if (m > -0.1) { const h = someone(c.caravan, c.rng); return { text: `A bad night. They break off, but ${h?.name ?? 'someone'} is mauled.`, effect: { hurt: h, morale: -5 } }; }
          const d = c.rng() < BANDS[c.band].lethal ? someone(c.caravan, c.rng) : null, h = d ? null : someone(c.caravan, c.rng);
          return { text: d ? `They get in among you in the dark. ${d.name} does not see morning.` : `They get in among the beasts. One is lost with its load, and ${h?.name ?? 'someone'} is hurt.`, effect: { dies: d, hurt: h, loseCargo: 0.15, morale: -12 } };
        } },
        { label: 'Keep the fires high and stand watch', resolve: (c) => c.rng() < 0.6
          ? { text: 'A long night, nobody sleeps, and they slink off at dawn.', effect: { morale: -3, days: 0.5 } }
          : { text: 'They try the far side of the picket. A beast goes, and what it carried.', effect: { loseCargo: 0.1, morale: -6 } } },
      ];
    },
  },
  {
    id: 'game',
    title: 'Game on the move',
    weight: (x) => (x.road ? 0.4 : 1) * (x.dry && !x.river ? 0.5 : 1),
    text: (x) => `${x.cold ? 'A herd of shaggy deer' : x.forest ? 'Wild pigs' : 'A herd of grazers'} ${x.cold ? 'paws at the snow' : 'feeds'} downwind of you, not far off.`,
    choices: (x) => [
      { label: 'Hunt them', uses: 'hunt', hint: `Hunt ${best(x.caravan, 'hunt')}`, resolve: (c) => {
        const r = c.rng() + (best(c.caravan, 'hunt') - 1) * 0.08;
        if (r > 0.55) { const meat = Math.round(living(c.caravan).length * (3 + c.rng() * 4)); return { text: `A clean kill. You eat well tonight and smoke the rest: ${meat} days of rations.${c.cold ? ' The hides are worth something too.' : ''}`, effect: { rations: meat, morale: 5, cargo: c.cold ? [[G.furs, 1 + Math.floor(c.rng() * 2)]] : undefined, days: 0.5 } }; }
        if (r > 0.2) return { text: 'They scatter at the first shot. Half a day gone, nothing to show.', effect: { days: 0.5 } };
        const h = someone(c.caravan, c.rng); return { text: `${h?.name ?? 'Someone'} turns an ankle chasing them down a bank.`, effect: { hurt: h, days: 0.5 } };
      } },
      { label: 'Let them be', resolve: () => ({ text: 'You watch them go and press on.', effect: {} }) },
    ],
  },
  {
    id: 'lame',
    title: 'A lame beast',
    weight: (x) => (x.high || x.base === B.MOUNTAIN ? 1.4 : 0.7),
    text: () => 'One of the pack beasts comes up lame on the stony going. It will carry nothing for a while.',
    choices: (x) => [
      { label: 'Rest it a day', resolve: () => ({ text: 'A day of poultices and grumbling, and it walks sound.', effect: { days: 1 } }) },
      { label: 'Spread the load and press on', hint: cargoUsed(x.caravan) > x.caravan.capacity * 0.7 ? 'Something may have to be left' : undefined, resolve: (c) => cargoUsed(c.caravan) > c.caravan.capacity * 0.7
        ? { text: 'There is not room for all of it. You leave a few bundles by the way.', effect: { loseCargo: 0.15, morale: -3 } }
        : { text: 'Everyone carries a little more. Nobody is happy about it.', effect: { morale: -4 } } },
    ],
  },
  {
    id: 'fever',
    title: 'Fever',
    weight: (x) => (x.base === B.RAINFOREST || x.biome === B.SWAMP || x.biome === B.MARSH || x.biome === B.BOG || x.biome === B.MANGROVE ? 2.5 : 0.35),
    text: (x) => `${x.subject?.name ?? 'Someone'} wakes shivering and cannot keep food down.`,
    choices: () => [
      { label: 'Make camp until it breaks', resolve: () => ({ text: 'Two days in camp. The fever breaks on the second night.', effect: { days: 2, rations: -1 } }) },
      { label: 'Carry them and keep going', resolve: (c) => {
        const m = c.subject;
        return c.rng() < 0.08 && m
          ? { text: `It does not break. ${m.name} dies on the third night, and you bury them by the way.`, effect: { dies: m, morale: -15 } }
          : { text: `${m?.name ?? 'They'} rides in the cart, grey and quiet.`, effect: { sick: m, morale: -3 } };
      } },
    ],
  },
  {
    id: 'ruins',
    title: 'Ruins',
    weight: (x) => (x.nearTown ? 0.3 : 1) * (x.road ? 0.5 : 1),
    text: (x) => pick(x.rng, [
      'Tumbled walls stand in the grass, older than anything you know. A stair goes down into the dark.',
      'A ring of carved stones, half buried. Someone dug here once, and stopped.',
      'The shell of a hall, roofless, its doorway carved with signs nobody here can read.',
    ]),
    choices: () => [
      { label: 'Search it', resolve: (c) => {
        const r = c.rng();
        if (r > 0.6) return { text: 'Under a fallen lintel: something old, worked, and whole. A collector would pay well.', effect: { cargo: [[G.relics, 1]], days: 0.5, morale: 6 } };
        if (r > 0.25) return { text: `Potsherds and bones. You come away with ${Math.round(5 + c.rng() * 15)} old coins, a few orrels' worth.`, effect: { orrels: Math.round(5 + c.rng() * 15), days: 0.5 } };
        const h = someone(c.caravan, c.rng, true); return { text: `A floor gives way. ${h?.name ?? 'Someone'} comes up bloodied.`, effect: { hurt: h, days: 0.5 } };
      } },
      { label: 'Leave it to the dead', resolve: () => ({ text: 'You pass it by. Some of the hands look back.', effect: {} }) },
    ],
  },
  {
    id: 'stranger',
    title: 'A lone traveller',
    weight: () => 0.9,
    text: (x) => `A traveller on foot, ${pick(x.rng, ['thin and sunburned', 'wrapped against the wind', 'with a staff and a limp'])}, asks to share your fire.`,
    choices: () => [
      { label: 'Share your food', resolve: (c) => ({ text: 'Over the meal they talk about a place you have not seen, and scratch its way in the dirt for you.', effect: { rations: -2, rumour: true, morale: 2 } }) },
      { label: 'Offer them a place', resolve: (c) => {
        if (c.rng() >= 0.5) return { text: 'They thank you, and are gone before dawn. So is a waterskin.', effect: { water: -living(c.caravan).length } };
        const n = c.name();
        return { text: `They give their name, ${n}, and take up a load in the morning.`, effect: { recruit: { lean: c.rng() < 0.4 ? 'fighter' : 'hand', name: n }, rations: -1 } };
      } },
      { label: 'Send them on', resolve: () => ({ text: 'They walk on without a word.', effect: {} }) },
    ],
  },
  {
    id: 'ridge',
    title: 'A long view',
    weight: (x) => (x.high ? 2 : 0),
    text: () => 'From the top of the ridge the land opens out for a day\'s walk in every direction.',
    choices: () => [
      { label: 'Climb and sketch it', resolve: () => ({ text: 'An afternoon on the top with a board on your knee. The map grows.', effect: { reveal: 3, days: 0.5 } }) },
      { label: 'Keep moving', resolve: () => ({ text: 'You take it in and go on.', effect: { reveal: 2 } }) },
    ],
  },
  {
    id: 'sandstorm',
    title: 'A wall of dust',
    weight: (x) => (x.base === B.DESERT ? 2.5 : x.dry ? 0.6 : 0),
    text: () => 'The sky goes brown to the west, and the wind rises.',
    choices: () => [
      { label: 'Hunker down', resolve: (c) => ({ text: 'A day and a night under the carts, breathing through cloth. The water goes faster than it should.', effect: { days: 1, water: -living(c.caravan).length * 2 } }) },
      { label: 'Push through it', resolve: (c) => c.rng() < 0.5
        ? { text: 'You come out the other side, hoarse and lost for a while.', effect: { days: 0.5, morale: -4 } }
        : { text: 'You lose the way in it, and some of the load with it.', effect: { days: 1, loseCargo: 0.1, morale: -6 } } },
    ],
  },
  {
    id: 'ford',
    title: 'The river is up',
    weight: (x) => (x.river && !x.road ? 2 : 0),
    text: () => 'The ford is running high and brown, fast enough to roll a cart.',
    choices: () => [
      { label: 'Wait for it to drop', resolve: () => ({ text: 'Two days on the bank. It drops.', effect: { days: 2 } }) },
      { label: 'Cross now', resolve: (c) => {
        const r = c.rng();
        if (r > 0.5) return { text: 'Cold, loud, and over. Everyone is across.', effect: { morale: 2 } };
        if (r > 0.12) return { text: 'A cart tips in the current. You save most of it.', effect: { loseCargo: 0.15, morale: -4 } };
        const d = someone(c.caravan, c.rng, true);
        return { text: `The current takes ${d?.name ?? 'someone'} off their feet, and they do not come up.`, effect: { dies: d, morale: -18 } };
      } },
    ],
  },
  {
    id: 'wolves',
    title: 'Wolves',
    weight: (x) => (x.cold || x.forest ? 1 : 0.2) * (x.road ? 0.5 : 1),
    text: () => 'Eyes in the dark beyond the fire, more each hour. The beasts will not settle.',
    choices: () => [
      { label: 'Keep the fires high and stand watch', resolve: (c) => {
        const m = fight(c, 3 + c.rng() * 3);
        if (m > 0) return { text: 'A long night. By dawn they are gone.', effect: { morale: -2 } };
        const h = someone(c.caravan, c.rng); return { text: `They come in at the beasts before dawn. ${h?.name ?? 'Someone'} is bitten driving them off.`, effect: { hurt: h, rations: -living(c.caravan).length * 2, morale: -6 } };
      } },
      { label: 'Break camp and move on', resolve: () => ({ text: 'You walk through the night, and lose a night\'s sleep with it.', effect: { morale: -6 } }) },
    ],
  },
  {
    id: 'nomads',
    title: 'Herders',
    weight: (x) => (x.base === B.STEPPE || x.base === B.SAVANNA || x.base === B.GRASSLAND ? 1.2 : 0.2),
    text: () => 'A herding camp: felt tents, dogs, a great many goats. They watch you come.',
    choices: (x) => [
      { label: 'Trade for food (10 orrels)', resolve: (c) => c.caravan.orrels >= 10
        ? { text: 'Cheese, dried meat and gossip for ten orrels. A good deal.', effect: { orrels: -10, rations: living(c.caravan).length * 6, morale: 3 } }
        : { text: 'You have nothing they want.', effect: {} } },
      { label: 'Ask the way', resolve: () => ({ text: 'The old man points with his whole arm and tells you what lies there.', effect: { rumour: true } }) },
      { label: 'Pass by', resolve: () => ({ text: 'You nod and pass by.', effect: {} }) },
    ],
  },
  {
    id: 'spoiled',
    title: 'Bad water',
    weight: (x) => (x.dry ? 1 : 0.4),
    text: () => 'A skin of water has gone foul, and the next one smells little better.',
    choices: (x) => [
      { label: 'Pour it out', resolve: (c) => ({ text: 'Better thirsty than sick.', effect: { water: -Math.round(waterCap(c.caravan) * 0.4) } }) },
      { label: 'Boil it and drink it', resolve: (c) => {
        const s = c.rng() < 0.35 ? someone(c.caravan, c.rng) : null;
        return s ? { text: `Most of you are fine. ${s.name} is not.`, effect: { sick: s } } : { text: 'It tastes of smoke, and nobody is the worse.', effect: {} };
      } },
    ],
  },
  {
    id: 'cairn',
    title: 'A wayside cairn',
    weight: (x) => (x.road ? 0.8 : 0.4),
    text: () => 'A cairn of stones by the way, each one left by someone passing. Some have marks scratched in them.',
    choices: () => [
      { label: 'Add a stone', resolve: () => ({ text: 'Everyone adds one. It does you good.', effect: { morale: 6 } }) },
      { label: 'Walk on', resolve: () => ({ text: 'You walk on.', effect: {} }) },
    ],
  },
  {
    id: 'snowbound',
    title: 'Snowbound',
    weight: (x) => (x.snow ? 2 : 0),
    text: () => 'The snow comes in sideways and does not stop. You cannot see the lead beast from the last.',
    choices: () => [
      { label: 'Dig in and wait it out', resolve: (c) => ({ text: 'Three days in a snow hole. Cold, cramped, alive.', effect: { days: 3, morale: -5 } }) },
      { label: 'Keep walking', resolve: (c) => {
        const h = c.rng() < 0.4 ? someone(c.caravan, c.rng) : null;
        return h ? { text: `You make ground, and ${h.name} loses the feeling in two toes.`, effect: { hurt: h, days: 1, morale: -6 } } : { text: 'You make ground, slowly, by feel.', effect: { days: 1, morale: -3 } };
      } },
    ],
  },
  {
    id: 'peddler',
    title: 'A peddler',
    weight: (x) => (x.road ? 1 : 0.2),
    text: () => 'A peddler with one mule and too many pots, going the other way. He wants to know where you came from and what things cost there.',
    choices: () => [
      { label: 'Swap news', resolve: () => ({ text: 'He tells you about the road ahead, and you tell him about the road behind.', effect: { rumour: true } }) },
      { label: 'Buy his spare waterskin (8 orrels)', resolve: (c) => c.caravan.orrels >= 8 ? { text: 'Full and sweet.', effect: { orrels: -8, water: living(c.caravan).length * 3 } } : { text: 'You cannot spare it.', effect: {} } },
    ],
  },
];

/** Encounters a job leads you into, on the hex it names (quests.ts). Not in the random draw. */
export const QUEST_ENCOUNTERS: Record<'bounty' | 'relic', Encounter> = {
  bounty: {
    id: 'q-bounty',
    title: 'The band you were sent for',
    weight: () => 0,
    text: (x) => `Smoke from a camp ${x.forest ? 'in the trees' : 'below the rise'}, horses on a line, a lookout who has seen you. These are the ones taking carts on the road.`,
    choices: (x) => {
      const enemy = (6 + x.rng() * 5) * (BANDS[x.band].bandits[1] / BANDS[0].bandits[1]);
      return [
        { label: 'Go in hard', uses: 'fight', hint: strength(x.caravan) > enemy ? 'You think you have the numbers' : 'They may have the numbers', resolve: (c) => {
          const m = fight(c, enemy);
          if (m > 0.15) return { text: 'They scatter into the hills, leaving the camp and what they took.', effect: { questDone: true, orrels: Math.round(15 + c.rng() * 40), morale: 10 } };
          if (m > -0.15) { const h = someone(c.caravan, c.rng); return { text: `A hard fight. They break in the end, but ${h?.name ?? 'someone'} is cut badly.`, effect: { questDone: true, hurt: h, morale: 2 } }; }
          const d = c.rng() < BANDS[c.band].lethal ? someone(c.caravan, c.rng) : null;
          return { text: d ? `They were ready for you. ${d.name} does not come back, and you pull away.` : 'They were ready for you. You pull away with the wounded and nothing to show.', effect: { dies: d, hurt: d ? null : someone(c.caravan, c.rng), morale: -12 } };
        } },
        { label: 'Wait for dark and take them sleeping', resolve: (c) => {
          const m = fight(c, enemy * 0.7);
          return m > 0
            ? { text: 'A long cold wait, and a short night. By morning the band is gone for good.', effect: { questDone: true, days: 1, morale: 6 } }
            : { text: 'A dog barks at the wrong moment. You lose a day and get nothing for it.', effect: { days: 1, morale: -5 } };
        } },
        { label: 'Leave them for now', resolve: () => ({ text: 'You mark the place and go on. They will still be here.', effect: {} }) },
      ];
    },
  },
  relic: {
    id: 'q-relic',
    title: 'The old site',
    weight: () => 0,
    text: () => 'Where you were told: a mound, too regular to be a hill, with a cut stone doorway half buried in its side.',
    choices: () => [
      { label: 'Dig it out carefully', resolve: (c) => c.rng() < 0.8
        ? { text: 'Two days with spades and lamps. At the back of a narrow room, wrapped in rotten cloth: the thing you were sent for, and a second piece besides.', effect: { questDone: true, cargo: [[G.relics, 2]], days: 2, morale: 8 } }
        : { text: 'Two days of digging and the roof comes in. Everyone gets out. Whatever was there is under tons of earth now.', effect: { days: 2, morale: -6 } } },
      { label: 'Break straight in', resolve: (c) => {
        if (c.rng() < 0.6) return { text: 'You are in by noon. It is there, as she said.', effect: { questDone: true, cargo: [[G.relics, 1]], days: 0.5 } };
        const h = someone(c.caravan, c.rng, true);
        return { text: `A step gives way into a pit. ${h?.name ?? 'Someone'} is hurt, and the way in is blocked. Try again another way.`, effect: { hurt: h, days: 0.5 } };
      } },
    ],
  },
};

/** The context for an encounter at a cell. */
export function contextAt(w: World, cell: number, road: boolean, snow: boolean, nearTown: boolean, caravan: Caravan, rng: () => number, name: () => string, band: Band = 0): Ctx {
  const b = w.biome[cell], base = baseOf(b);
  return {
    w, cell, base, biome: b, road, snow, nearTown, caravan, rng, name, subject: someone(caravan, rng), band,
    river: !!w.river[cell],
    cold: w.temperature[cell] < 0.35 || snow,
    dry: DRY.has(base) || w.moisture[cell] < 0.25,
    high: w.elevation[cell] > 0.32 || base === B.MOUNTAIN,
    forest: FOREST.has(base),
  };
}

/** Draw an encounter for a context, weighted. */
export function drawEncounter(ctx: Ctx): Encounter | null {
  let total = 0;
  const ws = ENCOUNTERS.map((e) => { const x = Math.max(0, e.weight(ctx)); total += x; return x; });
  if (total <= 0) return null;
  let r = ctx.rng() * total;
  for (let i = 0; i < ENCOUNTERS.length; i++) { r -= ws[i]; if (r <= 0) return ENCOUNTERS[i]; }
  return ENCOUNTERS[ENCOUNTERS.length - 1];
}

/** Apply an outcome's effect to the caravan (all but days, reveal and rumour, which the game
 * handles). Returns short lines saying what changed. */
export function applyEffect(c: Caravan, e: Effect, name: () => string, day: number, dice: () => number = Math.random): string[] {
  const out: string[] = [];
  if (e.orrels) { const d = Math.max(-c.orrels, e.orrels); c.orrels += d; if (d) out.push(`${d > 0 ? '+' : '−'}${Math.abs(d)} orrels`); if (d > 0) c.earned += d; }
  if (e.rations) { const d = Math.max(-c.rations, e.rations); c.rations += d; if (Math.round(d)) out.push(`${d > 0 ? '+' : '−'}${Math.abs(Math.round(d))} rations`); }
  if (e.water) { const before = c.water; c.water = Math.max(0, Math.min(waterCap(c), c.water + e.water)); const d = Math.round(c.water - before); if (d) out.push(`${d > 0 ? '+' : '−'}${Math.abs(d)} water`); }
  if (e.morale) { c.morale = Math.max(0, Math.min(100, c.morale + e.morale)); out.push(`morale ${e.morale > 0 ? 'up' : 'down'}`); }
  if (e.cargo) for (const [g, n] of e.cargo) { const room = Math.max(0, c.capacity - cargoUsed(c)); const k = Math.min(n, room); c.cargo[g] += k; if (k) out.push(`+${plural(k, GOODS[g].name.toLowerCase(), GOODS[g].name.toLowerCase())}`); }
  if (e.sell) {
    const [g, want, price] = e.sell, n = Math.min(want, c.cargo[g]);
    if (n > 0) {
      const paid = (c.basis[g] / c.cargo[g]) * n;
      c.cargo[g] -= n; c.basis[g] -= paid; c.orrels += n * price; c.earned += n * price - paid;
      out.push(`−${plural(n, GOODS[g].name.toLowerCase(), GOODS[g].name.toLowerCase())}`, `+${n * price} orrels`);
    }
  }
  if (e.loseCargo) { let lost = 0; c.cargo = c.cargo.map((n, g) => { const l = Math.round(n * e.loseCargo!); lost += l; if (n) c.basis[g] *= (n - l) / n; return n - l; }); if (lost) out.push(`−${plural(lost, 'load')} of cargo`); }
  if (e.hurt && e.hurt.alive) { e.hurt.health = 'hurt'; out.push(`${e.hurt.name} hurt`); }
  if (e.sick && e.sick.alive) { e.sick.health = 'sick'; out.push(`${e.sick.name} sick`); }
  if (e.dies && e.dies.alive) { e.dies.alive = false; out.push(`${e.dies.name} dead`); }
  if (e.recruit) { const m: Member = makeMember(e.recruit.name || name(), e.recruit.lean, dice, day); c.members.push(m); out.push(`${m.name} joins`); }
  if (e.days) out.push(`${plural(e.days, 'day')} lost`);
  return out;
}
