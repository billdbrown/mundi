/**
 * The name decides the whole planet (a trial, 2026-11-04: ?create=1 in the link).
 *
 * Bill: claimed worlds could still be reshaped with the sliders, which defeats claiming; the name
 * should carry the planet's character (dry, archipelago...). So a name hashes to the four dials
 * (oceans, land, climate, rain), and they set every other setting. New world rolls names; a kind
 * of world (Desert, Archipelago...) rolls names until one lands near that kind; Create a world
 * takes four dials and rolls names until one matches them. The link is just the name.
 *
 * Links that spell settings out (made before, or claimed with them) keep those settings.
 */
import { DEFAULT_PARAMS, type WorldParams } from './world.ts';
import { makeRng } from './rng.ts';
import { randomName } from './seedname.ts';

export const NAME_DECIDES = (() => {
  try { return new URLSearchParams(location.search).get('create') === '1'; } catch { return false; }
})();

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Four plain-language dials, each 0..1, mapped onto the raw parameters. */
export const DIALS = [
  {
    id: 'oceans', label: 'Oceans', lo: 'Dry', hi: 'Water world',
    get: (p: WorldParams) => (p.ocean - 0.3) / 0.6,
    set: (v: number): Partial<WorldParams> => ({ ocean: 0.3 + 0.6 * v }),
  },
  {
    id: 'land', label: 'Land', lo: 'One continent', hi: 'Islands',
    get: (p: WorldParams) => (p.continents - 1) / 7,
    set: (v: number): Partial<WorldParams> => ({ continents: Math.round(1 + 7 * v), plates: Math.round(8 + 22 * v), roughness: 0.3 + 0.55 * v }),
  },
  {
    id: 'climate', label: 'Climate', lo: 'Ice age', hi: 'Hothouse',
    get: (p: WorldParams) => (p.heat + 0.3) / 0.6,
    set: (v: number): Partial<WorldParams> => ({ heat: -0.3 + 0.6 * v }),
  },
  {
    id: 'rain', label: 'Rain', lo: 'Arid', hi: 'Lush',
    get: (p: WorldParams) => (p.wetness + 0.3) / 0.6,
    set: (v: number): Partial<WorldParams> => ({ wetness: -0.3 + 0.6 * v }),
  },
];

/** The dials these settings sit at. */
export const dialsOfParams = (p: WorldParams): number[] => DIALS.map((d) => clamp01(d.get(p)));

const EARTHLIKE = dialsOfParams(DEFAULT_PARAMS);

/**
 * A name's dials. Mostly near Earthlike (a random world is usually an Earth-ish one), sometimes
 * anywhere on the dial, so every corner (bone-dry, all islands, ice age) has names to find.
 * Rounded to hundredths so the settings come out exactly the same everywhere.
 */
export function dialsOf(name: string): number[] {
  let h = 0x9e3779b9;
  for (const ch of name.toLowerCase()) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193);
  const rnd = makeRng(h >>> 0);
  return EARTHLIKE.map((c) => {
    const wide = rnd() < 0.4;
    const u = Math.max(1e-9, rnd()), v = rnd();
    const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    return Math.round(clamp01(wide ? v : c + 0.15 * g) * 100) / 100;
  });
}

/** The settings a name gives (seed aside). */
export function paramsOf(name: string): Omit<WorldParams, 'seed'> {
  const v = dialsOf(name);
  const p = { ...DEFAULT_PARAMS };
  DIALS.forEach((d, i) => Object.assign(p, d.set(v[i])));
  return p;
}

/**
 * A fresh name whose dials sit within tol of target (null dials: anything), or any name for no
 * target. Rolls names until one fits: tens of thousands at the far corners, a few milliseconds.
 */
export function findName(target: (number | null)[] | null, tol = 0.06): string {
  if (!target) return randomName();
  let best = '', bestOff = Infinity;
  for (let i = 0; i < 400_000; i++) {
    const n = randomName(), d = dialsOf(n);
    let off = 0;
    target.forEach((t, k) => { if (t !== null) off = Math.max(off, Math.abs(d[k] - t)); });
    if (off <= tol) return n;
    if (off < bestOff) { bestOff = off; best = n; }
  }
  return best;
}
