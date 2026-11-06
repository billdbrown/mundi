/**
 * The caravan: its people, purse, supplies and cargo, and what a day on the road does to them.
 * The player is the caravan, not one person in it (decision 2026-11-06): the leader is whoever
 * you appoint, and anyone can die, the leader included.
 *
 * Supplies are gentle on purpose: running out slows the caravan and wears down morale, and never
 * kills anyone by itself.
 */
import { makeRng } from '../rng.ts';
import { nameMaker } from '../gamedata.ts';
import { GOODS } from './atlas.ts';

export type Origin = 'traders' | 'cartographers';
export const ORIGINS: { id: Origin; label: string; note: string; ambition: string }[] = [
  { id: 'traders', label: 'Traders', note: 'More beasts, more orrels, a nose for a price', ambition: 'Earn 2,000 orrels' },
  { id: 'cartographers', label: 'Cartographers', note: 'A scout, sharp eyes, charts that sell', ambition: 'Chart 1,500 hexes' },
];
export const AMBITION_GOAL: Record<Origin, number> = { traders: 2000, cartographers: 1500 };

export type Role = 'leader' | 'guard' | 'scout' | 'hand';
export const ROLE_NAMES: Record<Role, string> = { leader: 'Leader', guard: 'Guard', scout: 'Scout', hand: 'Hand' };
export type Trait = 'stout' | 'keen' | 'cheerful' | 'frugal' | 'steady';
export const TRAITS: Record<Trait, string> = {
  stout: 'Stout: a better fighter',
  keen: 'Keen-eyed: sees further, hunts better',
  cheerful: 'Cheerful: keeps spirits up',
  frugal: 'Frugal: eats little',
  steady: 'Steady: hard to shake',
};
export interface Member { name: string; role: Role; trait: Trait; health: 'well' | 'hurt' | 'sick'; alive: boolean; joined: number }

export interface Caravan {
  name: string;
  origin: Origin;
  members: Member[];
  orrels: number;
  /** Person-days of each. Water refills free at rivers, lakes and towns. */
  rations: number;
  water: number;
  /** Units of each good (atlas GOODS order). */
  cargo: number[];
  /** Orrels paid for the cargo of each good now carried (so a sale knows its profit). */
  basis: number[];
  capacity: number;
  /** 0..100. */
  morale: number;
  /** Orrels earned: profit on sales, charts, rewards (the Traders' ambition). */
  earned: number;
  /** Hexes revealed and not yet sold as charts. */
  unsoldCharts: number;
}

/** A caravan as it sets out from home. */
export function newCaravan(name: string, origin: Origin, seed: number): Caravan {
  const rng = makeRng((seed * 31 + 7) >>> 0), names = nameMaker(seed * 13 + 5);
  const traitList = Object.keys(TRAITS) as Trait[];
  const person = (role: Role, trait?: Trait): Member => ({ name: names(), role, trait: trait ?? traitList[Math.floor(rng() * traitList.length)], health: 'well', alive: true, joined: 0 });
  const t = origin === 'traders';
  const members = t
    ? [person('leader', 'steady'), person('guard', 'stout'), person('guard'), person('hand'), person('hand')]
    : [person('leader', 'keen'), person('scout'), person('guard', 'stout'), person('hand')];
  return {
    name, origin, members,
    orrels: t ? 220 : 120,
    rations: members.length * 20,
    water: members.length * WATER_DAYS,
    cargo: GOODS.map(() => 0),
    basis: GOODS.map(() => 0),
    capacity: t ? 30 : 16,
    morale: 70,
    earned: 0,
    unsoldCharts: 0,
  };
}

/** How many days of water a caravan can carry. */
export const WATER_DAYS = 12;
export const living = (c: Caravan) => c.members.filter((m) => m.alive);
export const leader = (c: Caravan) => c.members.find((m) => m.alive && m.role === 'leader') ?? null;
export const cargoUsed = (c: Caravan) => c.cargo.reduce((a, b) => a + b, 0);
export const waterCap = (c: Caravan) => living(c).length * WATER_DAYS;
/** Rations eaten a day. */
export const appetite = (c: Caravan) => living(c).reduce((a, m) => a + (m.trait === 'frugal' ? 0.7 : 1), 0);
export const thirst = (c: Caravan) => living(c).length;

/** Fighting strength, for encounters. */
export function strength(c: Caravan): number {
  let s = 0;
  for (const m of living(c)) {
    let x = m.role === 'guard' ? 3 : m.role === 'leader' ? 1.5 : 1;
    if (m.trait === 'stout') x += 1;
    if (m.health !== 'well') x *= 0.5;
    s += x;
  }
  return s;
}
/** Sight radius in hexes before high ground. */
export function sight(c: Caravan): number {
  const eyes = living(c).some((m) => m.role === 'scout' && m.health === 'well');
  return 1 + (eyes ? 1 : 0);
}
export const hasKeen = (c: Caravan) => living(c).some((m) => m.trait === 'keen' && m.health === 'well');

/** How fast the caravan goes, as a multiple: hunger, thirst, low spirits and the sick slow it. */
export function pace(c: Caravan): number {
  let k = 1;
  if (c.rations <= 0) k *= 0.6;
  if (c.water <= 0) k *= 0.6;
  if (c.morale < 25) k *= 0.85;
  if (living(c).some((m) => m.health === 'sick')) k *= 0.85;
  return k;
}

/** One day passes. Returns notes worth telling the player. */
export function passDay(c: Caravan, atWater: boolean, resting: boolean): string[] {
  const notes: string[] = [];
  const hadR = c.rations > 0, hadW = c.water > 0;
  c.rations = Math.max(0, c.rations - appetite(c));
  if (atWater) c.water = waterCap(c);
  else c.water = Math.max(0, c.water - thirst(c));
  let dm = resting ? 3 : 0.3;
  if (c.rations <= 0) dm -= 4;
  if (c.water <= 0) dm -= 5;
  if (living(c).some((m) => m.trait === 'cheerful')) dm += 0.5;
  c.morale = Math.max(0, Math.min(100, c.morale + dm));
  if (hadR && c.rations <= 0) notes.push('The rations have run out. The caravan goes hungry and slow.');
  if (hadW && c.water <= 0) notes.push('The water is gone. Find a river or a lake.');
  // The hurt mend, slowly; faster at rest.
  for (const m of living(c)) {
    if (m.health === 'well') continue;
    const mend = resting ? 0.25 : 0.06;
    if (m.trait === 'steady' ? Math.random() < mend * 1.5 : Math.random() < mend) {
      m.health = 'well';
      notes.push(`${m.name} is on their feet again.`);
    }
  }
  return notes;
}

/** Someone, chosen at random among the living (the leader less often). */
export function someone(c: Caravan, rng: () => number, notLeader = false): Member | null {
  const pool = living(c).flatMap((m) => (m.role === 'leader' ? (notLeader ? [] : [m]) : [m, m, m]));
  return pool.length ? pool[Math.floor(rng() * pool.length)] : null;
}
