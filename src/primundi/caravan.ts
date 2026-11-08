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
/** Each origin's ambition: a direction, not a rule. Tuned with the playtest bot so a well-played
 * caravan of either kind gets there in about a game-year (scripts/playtest.ts). */
export const AMBITION_GOAL: Record<Origin, number> = { traders: 5000, cartographers: 1500 };
export const ORIGINS: { id: Origin; label: string; note: string; ambition: string }[] = [
  { id: 'traders', label: 'Traders', note: 'More beasts, more orrels, a nose for a price', ambition: `Earn ${AMBITION_GOAL.traders.toLocaleString('en')} orrels` },
  { id: 'cartographers', label: 'Cartographers', note: 'A scout, a sharp eye for game, charts that sell', ambition: `Chart ${AMBITION_GOAL.cartographers.toLocaleString('en')} hexes` },
];

/** Skills, not roles (decision 2026-11-08): everyone has a stat line, 1 to 5 pips each. A task one
 * person does takes the caravan's best at it (Scout, Hunt, Barter, Mend); fighting is everyone's,
 * summed. */
export type Skill = 'fight' | 'scout' | 'hunt' | 'barter' | 'mend';
export const SKILLS: Skill[] = ['fight', 'scout', 'hunt', 'barter', 'mend'];
export const SKILL_NAMES: Record<Skill, string> = { fight: 'Fight', scout: 'Scout', hunt: 'Hunt', barter: 'Barter', mend: 'Mend' };
export type Skills = Record<Skill, number>;
export const SKILL_MAX = 5;
/** A way about someone, besides their skills. */
export type Trait = 'cheerful' | 'frugal' | 'steady';
export const TRAITS: Record<Trait, string> = {
  cheerful: 'Cheerful: keeps spirits up',
  frugal: 'Frugal: eats little',
  steady: 'Steady: mends faster',
};
export interface Member { name: string; skills: Skills; trait?: Trait; health: 'well' | 'hurt' | 'sick'; alive: boolean; joined: number;
  /** Who the caravan follows (and who takes over when they die: sim.ts appoint). */
  lead?: boolean;
  /** What they want from the road, in their words (opening.ts). Flavour, for now. */
  wish?: string;
  /** Where they're from (crew.ts bornIn): a place, its land, its trade. */
  born?: { pid: number; land: string; trade?: string };
  /** Every hex they've walked with you, in order of first visit (sim.ts enter): their own globe. */
  walked?: number[];
  /** Experience towards the next pip, by skill (learn.ts). */
  xp?: Partial<Record<Skill, number>>;
  /** Deeds counted towards marks, the marks earned (learn.ts MARKS), and what they give: pips on top
   * of the skills, and kinds of country they eat less in. */
  deeds?: Partial<Record<string, number>>;
  marks?: string[];
  bonus?: Partial<Skills>;
  lands?: string[] }

/** What kind of person a recruit is: one or two strong skills, the rest low. */
export type Lean = 'fighter' | 'scout' | 'hunter' | 'trader' | 'mender' | 'hand';
export const LEAN_NAMES: Record<Lean, string> = { fighter: 'A fighter', scout: 'A scout', hunter: 'A hunter', trader: 'A trader', mender: 'A mender', hand: 'A hand' };
const ones = (): Skills => ({ fight: 1, scout: 1, hunt: 1, barter: 1, mend: 1 });
/** Someone new, from their lean and the dice. */
export function makeMember(name: string, lean: Lean, rng: () => number, joined = 0): Member {
  const k = ones(), up = (s: Skill, n: number) => { k[s] = Math.min(SKILL_MAX, Math.max(k[s], n)); };
  const other = (not: Skill) => { const o = SKILLS.filter((x) => x !== not && x !== 'fight'); return o[Math.floor(rng() * o.length)]; };
  if (lean === 'fighter') { up('fight', rng() < 0.25 ? 4 : 3); if (rng() < 0.4) up(other('fight'), 2); }
  else if (lean === 'scout') { up('scout', rng() < 0.2 ? 4 : 3); up('hunt', 2); }
  else if (lean === 'hunter') { up('hunt', rng() < 0.25 ? 4 : 3); up('fight', 2); }
  else if (lean === 'trader') { up('barter', rng() < 0.2 ? 4 : 3); }
  else if (lean === 'mender') { up('mend', rng() < 0.2 ? 4 : 3); }
  else { up(other('fight'), 2); }
  const r = rng(), trait: Trait | undefined = r < 0.17 ? 'cheerful' : r < 0.34 ? 'frugal' : r < 0.5 ? 'steady' : undefined;
  return { name, skills: k, ...(trait ? { trait } : {}), health: 'well', alive: true, joined };
}
/** What someone asks to join: more for what they're good at. */
export const SKILL_WORTH: Skills = { fight: 12, scout: 18, hunt: 8, barter: 10, mend: 5 };
export function hireCost(m: Member): number {
  return 30 + SKILLS.reduce((a, s) => a + SKILL_WORTH[s] * (m.skills[s] - 1), 0) - (m.trait === 'frugal' ? 5 : 0);
}
/** A member from before skills (a role and a trait): what they become. */
export function fromRole(m: Member): Member {
  if (m.skills) return m;
  const old = m as Member & { role?: string }, was = (m as { trait?: string }).trait;
  const k = ones(), stout = was === 'stout', keen = was === 'keen';
  if (old.role === 'leader') { k.fight = 2; k.barter = 2; }
  else if (old.role === 'guard') k.fight = 3;
  else if (old.role === 'scout') { k.scout = 3; k.hunt = 2; }
  if (stout) k.fight += 1;
  if (keen) k.hunt = 4;
  const out: Member & { role?: string } = { ...m, skills: k };
  if (old.role === 'leader') out.lead = true;
  delete out.role;
  if (stout || keen) delete out.trait;
  return out;
}

/** What pulls the caravan, chosen when setting out (opening.ts): how much it carries, how fast. */
export type Beasts = 'mules' | 'oxen' | 'cart';
export const BEASTS: Record<Beasts, { label: string; short: string; note: string; cost: number; capacity: number; pace: number }> = {
  mules: { label: 'A string of mules', short: 'Mules', note: 'Sure-footed and steady: the usual choice', cost: 60, capacity: 16, pace: 1 },
  oxen: { label: 'Oxen and a big wagon', short: 'Oxen', note: 'Half again the load, and slower on the road', cost: 80, capacity: 24, pace: 0.85 },
  cart: { label: 'A light cart and a pony', short: 'Light cart', note: 'Quick on the road, room for little', cost: 35, capacity: 8, pace: 1.15 },
};
/** Room for cargo before the beasts: the Traders bring their own carts. */
export const ORIGIN_CAPACITY: Record<Origin, number> = { traders: 14, cartographers: 0 };
/** What a caravan has to spend when it builds itself in town: about what the old fixed start was
 * worth (its people, beasts and purse), so the playtest's numbers still hold. */
export const SETUP_PURSE: Record<Origin, number> = { traders: 450, cartographers: 335 };

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
  /** What pulls it (older saves: mules). */
  beasts?: Beasts;
  /** One-person tasks pinned to someone (by name) instead of the best: training (learn.ts). */
  pins?: Partial<Record<Skill, string>>;
  /** Pairs (names, sorted, joined by |): days together, fights shared, and bonded (learn.ts). */
  bonds?: Record<string, { days: number; fights: number; on?: boolean }>;
}

/** A caravan as it sets out from home. */
export function newCaravan(name: string, origin: Origin, seed: number): Caravan {
  const rng = makeRng((seed * 31 + 7) >>> 0), names = nameMaker(seed * 13 + 5);
  const t = origin === 'traders';
  const person = (lean: Lean, fix?: Partial<Skills>): Member => { const m = makeMember(names(), lean, rng); if (fix) Object.assign(m.skills, fix); return m; };
  const lead: Member = { ...person('trader', { fight: 2, barter: 2, ...(t ? {} : { hunt: 4 }) }), lead: true };
  if (t) lead.trait = 'steady'; else delete lead.trait;
  const members = t
    ? [lead, person('fighter', { fight: 4 }), person('fighter', { fight: 3 }), person('hand'), person('hand')]
    : [lead, person('scout', { scout: 3 }), person('fighter', { fight: 4 }), person('hand')];
  return {
    name, origin, members,
    orrels: t ? 220 : 120,
    rations: members.length * 30,
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
export const leader = (c: Caravan) => c.members.find((m) => m.alive && m.lead) ?? null;
export const cargoUsed = (c: Caravan) => c.cargo.reduce((a, b) => a + b, 0);
export const waterCap = (c: Caravan) => living(c).length * WATER_DAYS;
/** Born to a kind of country (crew.ts): eats this share of a ration while the caravan is in it. */
export const BORN_EATS = 0.9;
/** Rations eaten a day (a ration is a person's food for a day; the frugal eat less, and so do those
 * born to the country the caravan is in: crew.ts BORN_EATS). */
export const appetite = (c: Caravan, land?: string) => living(c).reduce((a, m) => a + (m.trait === 'frugal' ? 0.7 : 1) * (land && (m.born?.land === land || m.lands?.includes(land)) ? BORN_EATS : 1), 0);
export const thirst = (c: Caravan) => living(c).length;

/** What a Fight pip counts for in a fight (strength()): a guard of old was Fight 3. */
export const FIGHT_PIP = [0, 1, 1.5, 3, 4, 5.5];
/** A skill as the rules use it: the pips, and what marks add (learn.ts), up to the most there is. */
export const eff = (m: Member, k: Skill) => Math.min(SKILL_MAX, m.skills[k] + (m.bonus?.[k] ?? 0));
export const fightOf = (m: Member) => FIGHT_PIP[Math.max(0, eff(m, 'fight'))];
/** A road-bonded pair, both standing, is worth this much more in a fight (learn.ts). */
export const BOND_FIGHT = 1;
/** Fighting strength, for encounters: everyone's, summed; the hurt and sick at half; bonded pairs. */
export function strength(c: Caravan): number {
  let s = 0;
  const well = new Set<string>();
  for (const m of living(c)) { s += fightOf(m) * (m.health !== 'well' ? 0.5 : 1); if (m.health === 'well') well.add(m.name); }
  for (const [k, b] of Object.entries(c.bonds ?? {})) if (b.on && k.split('|').every((n) => well.has(n))) s += BOND_FIGHT;
  return s;
}
/** Who does a one-person task: whoever is pinned to it (training), if they can, or the best. */
export function doerOf(c: Caravan, k: Skill): Member | null {
  const p = c.pins?.[k];
  if (p) { const m = living(c).find((x) => x.name === p && x.health === 'well'); if (m) return m; }
  return bestAt(c, k);
}
/** The skill a one-person task is done at (1 if nobody can). */
export function best(c: Caravan, k: Skill): number {
  const m = doerOf(c, k);
  return m ? eff(m, k) : 1;
}
/** The caravan's best at it, among the well. */
export function bestAt(c: Caravan, k: Skill): Member | null {
  let w: Member | null = null;
  for (const m of living(c)) if (m.health === 'well' && (!w || eff(m, k) > eff(w, k))) w = m;
  return w;
}
/** One line of a stat sheet: what it's of, the figure, and whether it helps (true), costs (false),
 * or just is (null). */
export interface Stat { k: string; v: string; good: boolean | null }
/** Hunting: the chance a shot brings something down, by the best Hunt (life.ts). Hunt 1 is the old
 * plain odds, Hunt 4 the old keen eye. */
export const HUNT_PIP = [0, 0.65, 0.7, 0.78, 0.85, 0.9];
export const huntOdds = (c: Caravan) => HUNT_PIP[best(c, 'hunt')];
/** A good enough eye that game rarely sees you first (the hex's herds). */
export const KEEN_HUNT = 4;
/** Buying and selling: each Barter pip over 2 is this much off what you pay, on what you get. */
export const BARTER_STEP = 0.02;
export const barterEdge = (c: Caravan) => (best(c, 'barter') - 2) * BARTER_STEP;
/** Sight, by the best Scout: a hex further at Scout 3, another at 5. */
export const SCOUT_SIGHT = [3, 5];
/** What one person is, as the rules apply it: the tavern's and the journal's sheet. */
export function memberStats(m: Member): Stat[] {
  // Only what they're good at: a 1 is everyone's floor, and reads as noise.
  const out: Stat[] = SKILLS.filter((s) => eff(m, s) > 1).map((s) => ({ k: SKILL_NAMES[s], v: String(eff(m, s)), good: eff(m, s) >= 3 ? true : null }));
  if (m.trait === 'cheerful') out.push({ k: 'Spirits', v: '+0.5/day', good: true });
  if (m.trait === 'steady') out.push({ k: 'Mends', v: '×1.5', good: true });
  out.push({ k: 'Eats', v: m.trait === 'frugal' ? '0.7/day' : '1/day', good: false });
  return out;
}
const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`;
/** The whole caravan's sheet (the living): what the tavern shows as you build it. */
export function crewSheet(c: Caravan): Stat[] {
  const fight = strength(c), eats = appetite(c);
  return [
    { k: 'Fight', v: String(+fight.toFixed(1)), good: null },
    { k: 'Sight', v: `${sight(c)} hex${sight(c) === 1 ? '' : 'es'}`, good: null },
    { k: 'Hunt', v: `${Math.round(huntOdds(c) * 100)}%`, good: null },
    { k: 'Barter', v: pct(barterEdge(c)), good: null },
    { k: 'Eats', v: `${+eats.toFixed(1)}/day`, good: null },
  ];
}
/** What taking someone on changes, line by line ("Hunt 65% → 85%"): only the lines that move. */
export function crewDiff(c: Caravan, m: Member): Stat[] {
  const before = crewSheet(c), after = crewSheet({ ...c, members: [...c.members, m] });
  return after.flatMap((x, i) => x.v === before[i].v ? [] : [{ k: x.k, v: `${before[i].v} → ${x.v}`, good: x.k === 'Eats' ? false : true }]);
}
/** Bandits on the road fight at this (encounters.ts): the yardstick for how many guards. */
export const BANDIT_FIGHT = { min: 4, max: 10 };

/** Sight radius in hexes before high ground. */
export function sight(c: Caravan): number {
  const b = best(c, 'scout');
  return 1 + SCOUT_SIGHT.filter((x) => b >= x).length;
}
export const hasKeen = (c: Caravan) => best(c, 'hunt') >= KEEN_HUNT;

/** How fast the caravan goes, as a multiple: hunger, thirst, low spirits and the sick slow it. */
export function pace(c: Caravan): number {
  let k = BEASTS[c.beasts ?? 'mules'].pace;
  if (c.rations <= 0) k *= 0.6;
  if (c.water <= 0) k *= 0.6;
  if (c.morale < 25) k *= 0.85;
  if (living(c).some((m) => m.health === 'sick')) k *= 0.85;
  return k;
}

/** One day passes. Returns notes worth telling the player. */
/** `forage`: the share of the day's food the caravan has to take from its stores; the rest it
 * finds (game, fish, fruit, a farm that sells eggs), more in kind country than in hard. */
export function passDay(c: Caravan, atWater: boolean, resting: boolean, forage = 1, dice: () => number = Math.random, land?: string): string[] {
  const notes: string[] = [];
  const hadR = c.rations > 0, hadW = c.water > 0;
  c.rations = Math.max(0, c.rations - appetite(c, land) * forage);
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
    if (m.trait === 'steady' ? dice() < mend * 1.5 : dice() < mend) {
      m.health = 'well';
      notes.push(`${m.name} is on their feet again.`);
    }
  }
  return notes;
}

/** Someone, chosen at random among the living (the leader less often). */
export function someone(c: Caravan, rng: () => number, notLeader = false): Member | null {
  const pool = living(c).flatMap((m) => (m.lead ? (notLeader ? [] : [m]) : [m, m, m]));
  return pool.length ? pool[Math.floor(rng() * pool.length)] : null;
}
