/**
 * Worlds are named, and the name is the seed: mundi.bill.computer/#seed=zalund.
 *
 * A name hashes to the numeric seed the generator uses. Numbers still work as seeds (old links,
 * the visual tests), and then the planet's name is derived from the number instead.
 */
import { nameMaker } from './gamedata.ts';

/** Numeric seed for a name. Same range as the old random seeds, which the generator is tuned on. */
export function nameSeed(name: string): number {
  let h = 0x811c9dc5;
  for (const ch of name.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  return (h >>> 0) % 1_000_000;
}

/** A fresh pronounceable name, e.g. "Zalund". */
export function randomName(): string {
  return nameMaker(Math.floor(Math.random() * 1e9))();
}

/** Seed text from a URL or the seed box: a name (letters only) or a number. */
export function parseSeed(text: string): { name: string | null; seed: number } | null {
  const t = text.trim();
  if (/^[a-z]{2,24}$/i.test(t)) {
    const name = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    return { name, seed: nameSeed(name) };
  }
  if (/^\d{1,9}$/.test(t)) return { name: null, seed: Number(t) };
  return null;
}
