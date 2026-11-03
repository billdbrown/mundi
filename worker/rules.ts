/**
 * What a claim may say: plain checks shared by the Worker and the tests. No Cloudflare imports here.
 */

/** A world's key is its seed as it appears in the link: a name (letters) or a number. */
export function worldKey(seed: string): string | null {
  const t = seed.trim().toLowerCase();
  return /^[a-z]{2,24}$/.test(t) || /^\d{1,9}$/.test(t) ? t : null;
}

/** An owner's name as shown in the feed: 1-24 letters, digits, spaces and - _ ' . */
export function cleanOwner(name: string): string | null {
  const t = name.normalize('NFKC').replace(/\s+/g, ' ').trim();
  return /^[\p{L}\p{N}][\p{L}\p{N} '_.-]{0,23}$/u.test(t) ? t : null;
}

/**
 * The link fragment that recreates the world ("seed=nethamol&kind=desert"). Must start with this
 * world's seed and hold only short key=value pairs, so it can't carry anything else into the feed.
 */
export function cleanLink(link: string, world: string): string | null {
  if (link.length > 600) return null;
  const h = new URLSearchParams(link.replace(/^#/, ''));
  if ((h.get('seed') ?? '').toLowerCase() !== world) return null;
  const out = new URLSearchParams();
  for (const [k, v] of h) {
    if (!/^[a-z]{1,16}$/i.test(k) || !/^[a-z0-9._-]{0,24}$/i.test(v)) return null;
    out.set(k, k === 'seed' ? world : v);
  }
  return out.toString();
}

// Strong words only: the feed is public, but a filter that refuses ordinary names (Scunthorpe,
// Essex, torpedo, grape) is worse than one that misses a creative spelling.
const BLOCKED = [
  'fuck', 'shit', 'cunt', 'bitch', 'whore', 'slut', 'pussy', 'penis', 'vagina', 'porn', 'rapist',
  'nazi', 'hitler', 'nigger', 'nigga', 'faggot', 'retard', 'tranny', 'wetback', 'twat', 'wank',
  'bollock', 'jizz', 'semen', 'molest', 'paedo', 'pedophil', 'incest',
];
// Too short or too common to match inside other words: refused only as a whole word.
const WHOLE_ONLY = [
  'fag', 'kkk', 'cum', 'coon', 'spic', 'gook', 'paki', 'dyke', 'anal', 'anus', 'cock', 'dick',
  'rape', 'pedo', 'kike', 'chink',
];

// Ordinary words that contain a blocked one; taken out before matching.
const INNOCENT = /scunthorp|shiitak|penistone|cockburn|matsushita|therapist/g;

/** A word as a pattern: each run of a letter may repeat but not shrink ("fuuuck" yes, "niger" no). */
const pattern = (w: string) => w.replace(/(.)\1*/g, (run, c: string) => `${c}{${run.length},}`);
const INSIDE = new RegExp(BLOCKED.map(pattern).join('|'));
const WHOLE = new RegExp(`^(?:${[...BLOCKED, ...WHOLE_ONLY].map(pattern).join('|')})$`);

/** Lower case, accents dropped, look-alike digits and symbols folded to letters. */
function fold(text: string): string {
  const map: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i', '|': 'i' };
  return text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[0134578@$!|]/g, (c) => map[c]);
}

/** True when the text contains a blocked word. */
export function isRude(text: string): boolean {
  const f = fold(text);
  if (INSIDE.test(f.replace(/[^a-z]/g, '').replace(INNOCENT, ''))) return true;   // also catches "f.u.c.k"
  return f.split(/[^a-z]+/).some((w) => WHOLE.test(w));
}

/** Claims allowed per visitor: a burst limit and a daily one. */
export const RATE = { perHour: 10, perDay: 30 };

/** Thumbnails: a JPEG data URL, at most this many bytes once decoded. */
export const THUMB_MAX = 120_000;
