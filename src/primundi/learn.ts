/**
 * Getting better on the road (decision 2026-11-08): skills improve with use, deeds leave marks,
 * and people who travel and fight together long enough become road-bonded.
 *
 * - **Experience.** Whoever does a task learns it: everyone, for a fight; the doer of a one-person
 *   task (the caravan's best, or whoever is pinned to it: caravan.ts `pins`), with the next best
 *   learning half by watching. Depth multiplies it (`DEPTH_XP`): a week in the Deep teaches more
 *   than a season on the roads.
 * - **Marks** come from counted deeds, and each carries a stat (a pip on top of the skill, or eating
 *   less in some country).
 * - **Bonds**: two people together `BOND_DAYS` days who've shared `BOND_FIGHTS` fights; worth
 *   `BOND_FIGHT` in a fight while both stand (caravan.ts strength).
 */
import { bestAt, doerOf, living, SKILLS, SKILL_MAX, SKILL_NAMES, type Caravan, type Member, type Skill } from './caravan.ts';

/** Experience to go from a pip to the next (index: the pip now). Tuned with the playtest so a
 * caravan gains a pip or two a person in its first game-year. */
export const XP_NEXT = [0, 12, 28, 55, 100];
/** Experience multiplied by depth band (depth.ts): Settled to Deep. */
export const DEPTH_XP = [1, 1.5, 2, 3];
/** What a use is worth, by kind. */
export const XP = { fight: 8, hunt: 6, slip: 6, parley: 6, hex: 0.08, trade: 0.5, mend: 4 };

/** Give `m` experience at `k`: the level-ups, as lines ("Teska: Hunt 3 → 4"). */
export function gain(m: Member, k: Skill, x: number): string[] {
  const out: string[] = [];
  m.xp ??= {};
  m.xp[k] = (m.xp[k] ?? 0) + x;
  while (m.skills[k] < SKILL_MAX && m.xp[k]! >= XP_NEXT[m.skills[k]]) {
    m.xp[k]! -= XP_NEXT[m.skills[k]];
    m.skills[k]++;
    out.push(`${m.name}: ${SKILL_NAMES[k]} ${m.skills[k] - 1} → ${m.skills[k]}`);
  }
  return out;
}

/** The caravan uses a skill once (a fight, a shot, a haggle): who learns, and the level-ups. */
export function practise(c: Caravan, k: Skill, x: number, band = 0): string[] {
  const amt = x * DEPTH_XP[band];
  if (k === 'fight') return living(c).filter((m) => m.health === 'well').flatMap((m) => gain(m, k, amt));
  const doer = doerOf(c, k);
  if (!doer) return [];
  const out = gain(doer, k, amt);
  // The next best watches and learns half.
  const next = living(c).filter((m) => m !== doer && m.health === 'well').sort((a, b) => b.skills[k] - a.skills[k])[0];
  if (next) out.push(...gain(next, k, amt / 2));
  return out;
}

// --- Marks -------------------------------------------------------------------------------------
export type Deed = 'fights' | 'kills' | 'trades' | 'deepDays' | 'coldDays' | 'heals';
export interface Mark { id: string; name: string; deed: Deed | 'walked'; need: number; skill?: Skill; lands?: string[]; text: string }
export const MARKS: Mark[] = [
  { id: 'fights12', name: 'Twelve fights', deed: 'fights', need: 12, skill: 'fight', text: 'Fight +1' },
  { id: 'kills10', name: 'Ten kills', deed: 'kills', need: 10, skill: 'hunt', text: 'Hunt +1' },
  { id: 'trades60', name: 'Sixty bargains', deed: 'trades', need: 60, skill: 'barter', text: 'Barter +1' },
  { id: 'walked150', name: 'Long roads', deed: 'walked', need: 150, skill: 'scout', text: 'Scout +1' },
  { id: 'deep20', name: 'Deep-walker', deed: 'deepDays', need: 20, skill: 'fight', text: 'Fight +1' },
  { id: 'heals6', name: 'Field mender', deed: 'heals', need: 6, skill: 'mend', text: 'Mend +1' },
  { id: 'cold15', name: 'Crossed the ice', deed: 'coldDays', need: 15, lands: ['tundra', 'taiga'], text: 'Eats −10% in tundra and taiga' },
];
export const markOf = (id: string) => MARKS.find((x) => x.id === id);

/** Count a deed; the marks it earns, as lines. */
export function deed(m: Member, d: Deed, n = 1): string[] {
  m.deeds ??= {};
  m.deeds[d] = (m.deeds[d] ?? 0) + n;
  return checkMarks(m);
}
/** Any marks now earned (walked is counted from `walked`). */
export function checkMarks(m: Member): string[] {
  const out: string[] = [];
  for (const k of MARKS) {
    if (m.marks?.includes(k.id)) continue;
    const have = k.deed === 'walked' ? (m.walked?.length ?? 0) : (m.deeds?.[k.deed] ?? 0);
    if (have < k.need) continue;
    (m.marks ??= []).push(k.id);
    if (k.skill) (m.bonus ??= {})[k.skill] = (m.bonus?.[k.skill] ?? 0) + 1;
    if (k.lands) m.lands = [...new Set([...(m.lands ?? []), ...k.lands])];
    out.push(`${m.name} earns a mark: ${k.name} (${k.text})`);
  }
  return out;
}

// --- Bonds -------------------------------------------------------------------------------------
export const BOND_DAYS = 120, BOND_FIGHTS = 3;
export const pairKey = (a: Member, b: Member) => [a.name, b.name].sort().join('|');
/** A day together for everyone alive: bonds that form, as lines. */
export function dayTogether(c: Caravan): string[] {
  const out: string[] = [], ms = living(c);
  c.bonds ??= {};
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    const k = pairKey(ms[i], ms[j]), b = (c.bonds[k] ??= { days: 0, fights: 0 });
    b.days++;
    if (!b.on && b.days >= BOND_DAYS && b.fights >= BOND_FIGHTS) { b.on = true; out.push(`${ms[i].name} and ${ms[j].name} are road-bonded: Fight +1 together`); }
  }
  return out;
}
/** A fight shared by everyone standing. */
export function foughtTogether(c: Caravan) {
  const ms = living(c).filter((m) => m.health === 'well');
  c.bonds ??= {};
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) (c.bonds[pairKey(ms[i], ms[j])] ??= { days: 0, fights: 0 }).fights++;
}
/** Who `m` is bonded with. */
export const bondedWith = (c: Caravan, m: Member) => Object.entries(c.bonds ?? {}).filter(([k, b]) => b.on && k.split('|').includes(m.name)).map(([k]) => k.split('|').find((n) => n !== m.name)!);

/** Pin someone to a one-person task (or unpin, with null). */
export function pin(c: Caravan, k: Skill, name: string | null) {
  c.pins ??= {};
  if (name == null || c.pins[k] === name) delete c.pins[k];
  else c.pins[k] = name;
}
export { SKILLS, bestAt };
