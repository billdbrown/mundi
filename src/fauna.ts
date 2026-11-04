/**
 * Animals near the camera (2026-11-03, Bill: "herds, flocks, lone deer and bunnies bouncing
 * around").
 *
 * Scale. Plants are already drawn far larger than life (a tree is ~1/40,000 of the radius, ~1 km
 * on an Earth-sized world, ~100-200 m at the 640 km assumed since 2026-11-03), and from the lowest camera a deer in true proportion to them would
 * be a pixel or two. So animals carry their own size
 * multiplier on top (setSize; the A key, `&fauna=N` in the link): how much bigger than in proportion
 * with the trees. Chosen by comparison, like the plants' 1/6. Between kinds, sizes are drawn
 * closer together than life (square root), so a rabbit shows beside a bison.
 *
 * Who lives where. Each land cell near the camera gets its groups once, from its own seed and
 * biome: herds of grazers on grassland, savanna, steppe and tundra; lone deer and pairs in
 * forest; rabbits on open ground and forest edges; camels in desert; flocks of birds over
 * wetlands, grassland and coasts.
 *
 * Birds (2026-11-04, Bill: "lone eagles around mountains, more flocks, more sizes and
 * varieties"). Five shapes (songbird, raptor, gull, crane, goose) and three ways of flying:
 * flocks that swirl (songbirds, parrots, egrets, flamingos, gulls); soaring, wide slow banked
 * circles, mostly gliding (eagles over mountains and peaks, vultures circling together over
 * savanna and desert, a lone hawk over open country); and skeins, a V that travels, its wingbeat
 * rippling down the line (geese, cranes).
 *
 * Movement is a function of time, not state: a group's centre wanders along a sum of slow sines
 * about its home, and each animal keeps its place in the group, so nothing is simulated and
 * nothing drifts. Herds graze along; deer walk and stop; rabbits hop in bursts; flocks circle
 * and flap. Everything is drawn with the plants' material (instanced, one draw call a body
 * shape): cloud shadows, haze, and the close-up ground's height all come with it.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { B } from './biomes.ts';
import { baseOf } from './ecology.ts';
import { WATER_LAND, WATER_OCEAN, type World } from './world.ts';
import { treeMaterial } from './flora.ts';
import { makeRng, hash01 } from './rng.ts';

/** World units per metre, taking a plant as ~25 m tall (what the trees are drawn as). */
const METRE = 8e-6;
const SEA = 1.0;
/** Cells this far (radians) round the point under the camera are peopled. */
const REACH = 0.05;
const MAX_PER_SHAPE = 3000;

// --- Body shapes: length ~1 along +z (facing), up +y, feet at y = 0 -------------------------
const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
const box = (w: number, h: number, d: number, x: number, y: number, z: number) => ni(new THREE.BoxGeometry(w, h, d).translate(x, y, z));
const egg = (rx: number, ry: number, rz: number, x: number, y: number, z: number, detail = 0) =>
  ni(new THREE.IcosahedronGeometry(1, detail).scale(rx, ry, rz).translate(x, y, z));
function limb(a: number[], b: number[], r: number) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length();
  const g = new THREE.CylinderGeometry(r * 0.8, r, len, 4).translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  return ni(g.translate(a[0], a[1], a[2]));
}
function merge(parts: THREE.BufferGeometry[]) {
  const g = mergeGeometries(parts.map((p) => { for (const n of Object.keys(p.attributes)) if (n !== 'position') p.deleteAttribute(n); return p; }));
  if (!g) throw new Error('fauna: merge failed');
  g.computeVertexNormals();
  return g;
}
/** A flat polygon (a fan from its first point), seen from both sides. */
function plate(pts: number[][]) {
  const v: number[] = [];
  for (let i = 1; i < pts.length - 1; i++) for (const k of [0, i, i + 1, 0, i + 1, i]) v.push(...pts[k]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  return g;
}
/** A wing (outline on the +x side) and its mirror. */
const wings = (pts: number[][]) => [plate(pts), plate(pts.map(([x, y, z]) => [-x, y, z]))];
/** A four-legged animal. */
function quadruped(o: { leg: number; girth: number; neck: number; neckUp: number; hump?: number; antlers?: number; horns?: boolean; long?: number }) {
  const L = o.long ?? 1, top = o.leg + 0.12 * o.girth;   // (the body's middle: its belly just above the legs)
  const parts = [egg(0.17 * o.girth, 0.16 * o.girth, 0.42 * L, 0, top, 0, 1)];
  for (const [x, z] of [[-0.09, 0.27], [0.09, 0.27], [-0.09, -0.27], [0.09, -0.27]]) parts.push(limb([x * o.girth, 0, z * L], [x * o.girth, top - 0.05, z * L * 0.9], 0.035));
  const shoulder = [0, top + 0.04, 0.32 * L], head = [0, top + 0.04 + o.neck * o.neckUp, 0.32 * L + o.neck * (1 - o.neckUp * 0.6)];
  parts.push(limb(shoulder, head, 0.06 * Math.sqrt(o.girth)));
  parts.push(egg(0.055, 0.06, 0.13, head[0], head[1], head[2] + 0.06));
  if (o.hump) parts.push(egg(0.13 * o.hump, 0.12 * o.hump, 0.16, 0, top + 0.13 * o.girth, 0.15 * L));
  if (o.antlers) {
    for (const s of [-1, 1]) {
      const base = [s * 0.03, head[1] + 0.05, head[2] + 0.02], tip = [s * 0.16 * o.antlers, head[1] + 0.32 * o.antlers, head[2] - 0.08];
      parts.push(limb(base, tip, 0.012), limb([(base[0] + tip[0]) / 2, (base[1] + tip[1]) / 2, base[2]], [s * 0.2 * o.antlers, head[1] + 0.18 * o.antlers, head[2] + 0.08], 0.01));
    }
  }
  if (o.horns) for (const s of [-1, 1]) parts.push(limb([s * 0.04, head[1] + 0.04, head[2] + 0.02], [s * 0.1, head[1] + 0.08, head[2] - 0.02], 0.014));
  parts.push(limb([0, top + 0.02, -0.4 * L], [0, top - 0.12, -0.46 * L], 0.015));   // tail
  return merge(parts);
}
const SHAPES = {
  deer: () => quadruped({ leg: 0.42, girth: 0.9, neck: 0.3, neckUp: 0.7 }),
  buck: () => quadruped({ leg: 0.42, girth: 0.95, neck: 0.3, neckUp: 0.7, antlers: 1 }),
  grazer: () => quadruped({ leg: 0.28, girth: 1.35, neck: 0.18, neckUp: 0.1, hump: 1.2, horns: true }),
  caribou: () => quadruped({ leg: 0.38, girth: 1.05, neck: 0.25, neckUp: 0.55, antlers: 1.3 }),
  camel: () => quadruped({ leg: 0.5, girth: 1.05, neck: 0.36, neckUp: 0.55, hump: 1.4, long: 1.05 }),
  // A rabbit: a round body, big hind end, tall ears.
  rabbit: () => merge([
    egg(0.2, 0.2, 0.3, 0, 0.2, -0.05, 1), egg(0.12, 0.12, 0.14, 0, 0.34, 0.22, 1),
    box(0.05, 0.34, 0.06, -0.055, 0.6, 0.17), box(0.05, 0.34, 0.06, 0.055, 0.6, 0.17),
    egg(0.07, 0.07, 0.07, 0, 0.24, -0.36),
  ]),
  // Birds: a body and wings raised in a shallow V (flapping scales the V's height, see update).
  bird: () => merge([egg(0.05, 0.05, 0.2, 0, 0, 0), ...wings([[0, 0, 0.15], [0.5, 0.18, -0.05], [0, 0, -0.12]])]),
  songbird: () => merge([egg(0.05, 0.05, 0.14, 0, 0, 0.02), ...wings([[0, 0, 0.07], [0.3, 0.1, 0.0], [0.28, 0.1, -0.06], [0, 0, -0.07]]), plate([[0, 0, -0.08], [0.05, 0, -0.22], [-0.05, 0, -0.22]])]),
  // Broad wings with fingered tips and a fan tail: eagles, vultures, hawks.
  raptor: () => merge([
    egg(0.065, 0.055, 0.2, 0, 0, 0), egg(0.035, 0.035, 0.055, 0, 0.01, 0.21),
    ...wings([[0, 0, 0.1], [0.42, 0.06, 0.08], [0.52, 0.07, 0.04], [0.54, 0.07, -0.06], [0.46, 0.06, -0.11], [0, 0, -0.1]]),
    ...wings([[0.52, 0.07, 0.04], [0.66, 0.08, 0.04], [0.54, 0.07, 0.0]]),
    ...wings([[0.54, 0.07, 0.0], [0.67, 0.08, -0.03], [0.54, 0.07, -0.04]]),
    ...wings([[0.54, 0.07, -0.04], [0.63, 0.08, -0.08], [0.53, 0.07, -0.07]]),
    plate([[0, 0, -0.12], [0.1, 0, -0.32], [-0.1, 0, -0.32]]),
  ]),
  // Long narrow wings bent in an M.
  gull: () => merge([
    egg(0.045, 0.045, 0.18, 0, 0, 0.02),
    ...wings([[0, 0, 0.07], [0.24, 0.1, 0.05], [0.24, 0.1, -0.05], [0, 0, -0.07]]),
    ...wings([[0.24, 0.1, 0.05], [0.62, 0.0, -0.1], [0.24, 0.1, -0.05]]),
    plate([[0, 0, -0.1], [0.05, 0, -0.2], [-0.05, 0, -0.2]]),
  ]),
  // Neck out, legs trailing: cranes, egrets, flamingos.
  heron: () => merge([
    egg(0.06, 0.055, 0.17, 0, 0, 0),
    limb([0, 0, 0.14], [0, 0.02, 0.42], 0.016), egg(0.028, 0.028, 0.05, 0, 0.02, 0.45), limb([0, 0.02, 0.48], [0, 0.015, 0.58], 0.008),
    limb([-0.02, -0.01, -0.12], [-0.02, -0.02, -0.5], 0.009), limb([0.02, -0.01, -0.12], [0.02, -0.02, -0.5], 0.009),
    ...wings([[0, 0, 0.1], [0.5, 0.06, 0.06], [0.6, 0.06, -0.03], [0.5, 0.06, -0.1], [0, 0, -0.1]]),
  ]),
  goose: () => merge([
    egg(0.07, 0.06, 0.2, 0, 0, 0), limb([0, 0, 0.16], [0, 0.01, 0.36], 0.022), egg(0.032, 0.03, 0.06, 0, 0.01, 0.39),
    ...wings([[0, 0, 0.09], [0.45, 0.07, 0.01], [0.48, 0.07, -0.05], [0, 0, -0.09]]),
    plate([[0, 0, -0.14], [0.06, 0, -0.24], [-0.06, 0, -0.24]]),
  ]),
} as const;
type Shape = keyof typeof SHAPES;

type Behaviour = 'herd' | 'wander' | 'hop' | 'flock' | 'soar' | 'skein';
interface Species {
  shape: Shape | Shape[]; metres: number; act: Behaviour; group: [number, number];
  /** One colour, or several: a group takes one (or, mixed, each bird its own). */
  colour: number | number[]; mixed?: boolean;
  /** Fliers: height over the ground, in body lengths. */
  alt?: number;
  /** Fliers: drawn this much bigger again (the big birds; height and range keep to the plain size). */
  scale?: number;
}
const SPECIES = {
  deer:       { shape: ['deer', 'buck'], colour: 0x8a5a35, metres: 1.8, act: 'wander', group: [1, 3] },
  antelope:   { shape: ['deer', 'buck'], colour: 0xc29563, metres: 1.5, act: 'herd', group: [8, 24] },
  bison:      { shape: 'grazer', colour: 0x4a3426, metres: 3.0, act: 'herd', group: [10, 36] },
  wildebeest: { shape: 'grazer', colour: 0x5c5853, metres: 2.3, act: 'herd', group: [16, 44] },
  caribou:    { shape: 'caribou', colour: 0x8c8274, metres: 2.0, act: 'herd', group: [10, 32] },
  camel:      { shape: 'camel', colour: 0xb08a5a, metres: 3.0, act: 'wander', group: [2, 6] },
  // (Rabbits and hares drawn bigger than the square root gives: at life size they read as stones.)
  rabbit:     { shape: 'rabbit', colour: 0xa3825c, metres: 0.8, act: 'hop', group: [2, 5] },
  hare:       { shape: 'rabbit', colour: 0xe6e6e2, metres: 0.9, act: 'hop', group: [1, 3] },
  bird:       { shape: 'bird', colour: 0x7a6e60, metres: 1.2, act: 'flock', group: [14, 40] },
  gull:       { shape: 'gull', colour: [0xeeeeea, 0xd8dade], metres: 1.4, act: 'flock', group: [8, 24] },
  songbird:   { shape: 'songbird', colour: [0x5a4a3a, 0x3a3836, 0x7a6244, 0x4a4a52], metres: 0.8, act: 'flock', group: [16, 44], alt: 14, scale: 1.2 },
  parrot:     { shape: 'songbird', colour: [0xc8302a, 0x2f9a3e, 0x2a6fc0, 0xe2b020], mixed: true, metres: 1.4, act: 'flock', group: [5, 16], alt: 14, scale: 1.4 },
  egret:      { shape: 'heron', colour: 0xf2f2ee, metres: 1.6, act: 'flock', group: [3, 10], alt: 10 },
  flamingo:   { shape: 'heron', colour: [0xf08c8c, 0xf2a0a0], metres: 2.0, act: 'flock', group: [16, 44], alt: 9, scale: 1.3 },
  eagle:      { shape: 'raptor', colour: [0x3f3126, 0x4d3c2c], metres: 3.6, act: 'soar', group: [1, 2], alt: 13, scale: 2 },
  vulture:    { shape: 'raptor', colour: [0x2e2a27, 0x5a4a3c], metres: 3.2, act: 'soar', group: [3, 9], alt: 13, scale: 1.7 },
  hawk:       { shape: 'raptor', colour: [0xa88a66, 0xbfa27c, 0x8e6c4a], metres: 1.6, act: 'soar', group: [1, 1], alt: 16, scale: 1.7 },
  goose:      { shape: 'goose', colour: [0x6b655c, 0x8a8578], metres: 2.2, act: 'skein', group: [9, 25], alt: 14, scale: 1.4 },
  crane:      { shape: 'heron', colour: [0x9c9c9a, 0xb8b8b4], metres: 2.6, act: 'skein', group: [5, 13], alt: 13, scale: 1.6 },
} satisfies Record<string, Species>;
type Kind = keyof typeof SPECIES;

/** Groups a cell of this (base) biome may hold: [species, groups per cell (mean)]. */
function residents(raw: number, coast: boolean, warm: boolean): [Kind, number][] {
  const out: [Kind, number][] = [], b = baseOf(raw);
  switch (b) {
    case B.GRASSLAND: case B.PRAIRIE: out.push(['bison', 1.6], ['rabbit', 5], ['bird', 0.8], ['deer', 1]); break;
    case B.STEPPE: out.push(['bison', 0.8], ['antelope', 1], ['rabbit', 3], ['bird', 0.4]); break;
    case B.SAVANNA: case B.PALM_SAVANNA: out.push(['wildebeest', 1.8], ['antelope', 1.4], ['bird', 0.6]); break;
    case B.TUNDRA: case B.HEATH: case B.ALPINE_MEADOW: out.push(['caribou', 1.4], ['hare', 3], ['bird', 0.3]); break;
    case B.TAIGA: case B.LARCH: out.push(['caribou', 0.6], ['deer', 3]); break;
    case B.FOREST: case B.MIXED_FOREST: case B.TEMPERATE_RAIN: case B.MONTANE_FOREST: case B.CHAPARRAL:
      out.push(['deer', 5], ['bird', 0.4]); break;   // (rabbits under trees can't be seen: open ground only)
    case B.DRY_FOREST: case B.MONSOON: out.push(['deer', 3], ['antelope', 0.6], ['bird', 0.5]); break;
    case B.RAINFOREST: case B.CLOUD_FOREST: out.push(['bird', 1.2], ['deer', 1]); break;
    case B.DESERT: case B.DESERT_SCRUB: case B.COLD_DESERT: out.push(['camel', 0.5], ['rabbit', 0.8]); break;
    case B.SWAMP: case B.MARSH: case B.BOG: case B.FLOODPLAIN: case B.SALT_MARSH: case B.MANGROVE:
      out.push(['bird', 2], ['deer', 1.5]); break;
  }
  // Birds, by the broad biome...
  switch (b) {
    case B.GRASSLAND: out.push(['songbird', 0.8], ['hawk', 0.4], ['goose', 0.15]); break;
    case B.STEPPE: out.push(['songbird', 0.4], ['hawk', 0.4], ['eagle', 0.12]); break;
    case B.SAVANNA: out.push(['songbird', 0.6], ['vulture', 0.5], ['hawk', 0.2]); break;
    case B.TUNDRA: out.push(['goose', 0.5], ['crane', 0.2]); break;
    case B.TAIGA: out.push(['songbird', 0.3], ['eagle', 0.08]); break;
    case B.FOREST: case B.TEMPERATE_RAIN: out.push(['songbird', 0.6], ['hawk', 0.2]); break;
    case B.DRY_FOREST: out.push(['songbird', 0.5], ['hawk', 0.3]); break;
    case B.RAINFOREST: out.push(['parrot', 1.2], ['songbird', 0.5], ['hawk', 0.12]); break;
    case B.DESERT: out.push(['vulture', 0.3], ['hawk', 0.2]); break;
    case B.MOUNTAIN: out.push(['eagle', 0.5], ['vulture', 0.12]); break;
    case B.PEAK: case B.ICE: out.push(['eagle', 0.3]); break;
  }
  // ...and the finer ones.
  switch (raw) {
    case B.SWAMP: case B.MARSH: case B.FLOODPLAIN: out.push(['egret', 1], ['crane', 0.4], ['goose', 0.5]); break;
    case B.BOG: case B.SALT_MARSH: out.push(['goose', 0.6], ['crane', 0.3]); break;
    case B.MANGROVE: out.push(['egret', 1], ['parrot', 0.5]); break;
    case B.CANYONS: case B.BADLANDS: out.push(['vulture', 0.4], ['eagle', 0.2]); break;
    case B.MONTANE_FOREST: out.push(['eagle', 0.25]); break;
  }
  if (warm && (raw === B.SALT_FLAT || raw === B.SALT_MARSH || raw === B.MANGROVE)) out.push(['flamingo', 0.5]);
  if (coast) out.push(['gull', 1.2]);

  return out;
}

interface Group {
  kind: Kind; shapes: Shape[]; n: number; size: number; colour: THREE.Color;
  /** Fliers: the size their height and range go by (size less the species scale). */
  lift: number;
  home: THREE.Vector3; e: THREE.Vector3; nth: THREE.Vector3;
  /** Wander: amplitudes and rates of the path's sines, phases. */
  amp: number; w1: number; w2: number; p: number[];
  /** Per animal: place in the group (x, z in body lengths), phase, size, shade, shape index. */
  members: { x: number; z: number; ph: number; s: number; shade: number; shape: number; col?: THREE.Color; rank: number }[];
  /** Where its middle was last drawn (for tests and tools). */
  at?: THREE.Vector3;
}

export class Fauna {
  readonly group = new THREE.Group();
  private world?: World;
  private heightAt: ((x: number, y: number, z: number) => number) | null = null;
  private meshes = new Map<Shape, THREE.InstancedMesh>();
  private cells = new Map<number, Group[]>();
  private near: number[] = [];
  private nearKey = -1;
  private size = 6;   // times their proportion with the trees (Bill picked 6x, 2026-11-03)

  constructor() {
    for (const s of Object.keys(SHAPES) as Shape[]) {
      const geo = SHAPES[s]();
      geo.setAttribute('cut', new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_SHAPE), 1));
      geo.setAttribute('leafy', new THREE.BufferAttribute(new Float32Array(geo.getAttribute('position').count), 1));
      const m = new THREE.InstancedMesh(geo, treeMaterial, MAX_PER_SHAPE);
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_PER_SHAPE * 3), 3);
      m.count = 0;
      m.frustumCulled = false;
      this.meshes.set(s, m);
      this.group.add(m);
    }
  }

  setWorld(w: World | undefined, heightAt: ((x: number, y: number, z: number) => number) | null) {
    this.world = w;
    this.heightAt = heightAt;
    this.cells.clear();
    this.nearKey = -1;
  }

  /** How much bigger than in proportion with the trees (see the top). */
  setSize(s: number) { this.size = s; this.cells.clear(); this.nearKey = -1; }   // (0: none)
  getSize() { return this.size; }

  /** The groups living in cell c, made once from the cell's seed. */
  private groupsOf(c: number): Group[] {
    const hit = this.cells.get(c);
    if (hit) return hit;
    const w = this.world!, g = w.grid, P = g.centers, out: Group[] = [];
    this.cells.set(c, out);
    if (w.water[c] !== WATER_LAND) return out;
    const bare = w.biome[c] === B.ICE || w.biome[c] === B.PEAK;   // (only birds, over ice and peaks)
    const rng = makeRng(w.params.seed * 977 + c * 131 + 5);
    const coast = g.neighbors[c].some((n) => w.water[n] === WATER_OCEAN);
    const spacing = Math.sqrt((4 * Math.PI) / g.count);
    const centre = new THREE.Vector3(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]);
    let e = new THREE.Vector3(centre.z, 0, -centre.x);
    if (e.lengthSq() < 1e-8) e.set(1, 0, 0);
    e.normalize();
    const nth = new THREE.Vector3().crossVectors(centre, e);
    for (const [kind, mean] of residents(w.biome[c], coast, w.temperature[c] > 0.55)) {
      const sp: Species = SPECIES[kind];
      if (bare && sp.act !== 'soar') continue;
      if (coast && (kind === 'songbird' || kind === 'parrot')) continue;   // (land birds: their flocks would wander out to sea)
      const groups = Math.floor(mean + rng());
      for (let k = 0; k < groups; k++) {
        const shapes = Array.isArray(sp.shape) ? sp.shape : [sp.shape];
        const home = centre.clone().addScaledVector(e, (rng() - 0.5) * spacing * 0.9).addScaledVector(nth, (rng() - 0.5) * spacing * 0.9).normalize();
        const n = sp.group[0] + Math.floor(rng() * (sp.group[1] - sp.group[0] + 1));
        // Sizes drawn closer together than life (as the square root, about a deer's 1.8 m), so
        // rabbits can be seen and bison aren't giants beside them.
        const size = Math.sqrt(sp.metres * 1.8) * METRE * this.size;
        const spread = sp.act === 'flock' ? 2.2 : sp.act === 'herd' ? 1.4 : 3;
        const cols = Array.isArray(sp.colour) ? sp.colour : [sp.colour];
        const groupCol = cols[Math.floor(rng() * cols.length)];
        const members = Array.from({ length: n }, (_, i) => {
          // Herds and flocks: packed round the middle; others: scattered a little. A skein flies
          // in a V behind its leader.
          const r = Math.sqrt(rng()) * Math.sqrt(n) * spread, a = rng() * Math.PI * 2, k = Math.ceil(i / 2);
          const [x, z] = sp.act === 'skein' ? [(i % 2 ? -1 : 1) * k * 1.2, -k * 1.0] : [r * Math.cos(a), r * Math.sin(a)];
          return {
            x, z, ph: rng() * 100, s: 0.85 + 0.3 * rng(), shade: 0.8 + 0.35 * rng(), shape: i === 0 || rng() < 0.3 ? shapes.length - 1 : 0,
            col: sp.mixed ? new THREE.Color(cols[Math.floor(rng() * cols.length)]) : undefined, rank: k,
          };
        });
        out.push({
          kind, shapes: [...shapes], n, size: size * (sp.scale ?? 1), lift: size, colour: new THREE.Color(groupCol), home, e, nth,
          // Range: herds and deer ~30 body lengths; flocks circle wider, higher up; skeins travel.
          amp: (sp.act === 'flock' ? 40 : sp.act === 'hop' ? 12 : sp.act === 'skein' ? 90 : sp.act === 'soar' ? 25 : 30) * size,
          w1: 0.004 + 0.006 * rng(), w2: 0.011 + 0.01 * rng(), p: [rng() * 6.3, rng() * 6.3, rng() * 6.3, rng() * 6.3],
          members,
        });
      }
    }
    return out;
  }

  /** The cells within REACH of the direction d, from the cell under it. */
  private cellsNear(d: THREE.Vector3, start: number): number[] {
    const g = this.world!.grid, P = g.centers, cosR = Math.cos(REACH), seen = new Set([start]), list = [start];
    for (let i = 0; i < list.length; i++) {
      for (const n of g.neighbors[list[i]]) {
        if (seen.has(n)) continue;
        seen.add(n);
        if (P[n * 3] * d.x + P[n * 3 + 1] * d.y + P[n * 3 + 2] * d.z > cosR) list.push(n);
      }
    }
    return list;
  }

  /**
   * Each frame. ground: the direction under the middle of the view, and the cell under it;
   * t: seconds; visible: animals wanted at all.
   */
  update(ground: THREE.Vector3, cell: number, t: number, visible: boolean) {
    this.group.visible = visible && this.size > 0 && !!this.world && !!this.heightAt;
    if (!this.group.visible) return;
    if (cell !== this.nearKey) {
      this.nearKey = cell;
      this.near = this.cellsNear(ground, cell);
      // Forget far cells' groups (they are made again, the same, if you come back).
      if (this.cells.size > 400) for (const k of [...this.cells.keys()]) if (!this.near.includes(k)) this.cells.delete(k);
    }
    const counts = new Map<Shape, number>();
    const m = new THREE.Matrix4(), up = new THREE.Vector3(), fwd = new THREE.Vector3(), side = new THREE.Vector3(),
      pos = new THREE.Vector3(), c = new THREE.Color(), centre = new THREE.Vector3(), vel = new THREE.Vector3();
    const h = this.heightAt!;
    const cosView = Math.cos(REACH * 1.1);
    for (const cellId of this.near) {
      for (const g of this.groupsOf(cellId)) {
        if (g.home.dot(ground) < cosView) continue;
        const sp: Species = SPECIES[g.kind], act = sp.act, flier = act === 'flock' || act === 'soar' || act === 'skein';
        // The group's path: where its middle is at time s, and which way it is going.
        const path = (s: number, out: THREE.Vector3) => {
          const a = g.amp, x = a * (Math.sin(g.w1 * s + g.p[0]) + 0.6 * Math.sin(g.w2 * s + g.p[1])),
            z = a * (Math.cos(g.w1 * 1.3 * s + g.p[2]) + 0.6 * Math.sin(g.w2 * 0.8 * s + g.p[3]));
          return out.copy(g.home).addScaledVector(g.e, x).addScaledVector(g.nth, z);
        };
        // Deer and camels walk and stop; others keep going (flocks fly faster).
        const pace = act === 'flock' ? 12 : act === 'skein' ? 18 : act === 'soar' ? 3 : act === 'wander' ? 2.5 : 1.6;
        let s = t * pace;
        if (act === 'wander') { const T = 40, k = Math.floor(t / T), f = (t / T) - k; s = (k + smooth(0.55, 1, f)) * T * pace; }
        path(s, centre);
        (g.at ??= new THREE.Vector3()).copy(centre).normalize();
        path(s + 1, vel).sub(centre);
        for (const [i, a] of g.members.entries()) {
          const shape = g.shapes[a.shape];
          const mesh = this.meshes.get(shape)!;
          const j = counts.get(shape) ?? 0;
          if (j >= MAX_PER_SHAPE) continue;
          const L = g.size * a.s;
          let ms = s, hop = 0, flap = 1;
          if (act === 'hop') {
            // Each rabbit on its own: bursts of three hops, then a sit.
            const T = 2.6, tt = t + a.ph, k = Math.floor(tt / T), f = tt / T - k;
            const moving = hash01(k * 31 + i * 7 + g.p[0] * 1000) < 0.7;
            const hopF = Math.min(1, f / 0.6) * 3, hk = Math.floor(hopF);
            ms = (k * 3 + (moving ? Math.min(3, hk + smooth(0, 1, hopF - hk)) : 0)) * 1.4;
            hop = moving && f < 0.6 ? Math.abs(Math.sin(Math.PI * (hopF - hk))) * 0.55 : 0;
          }
          // Where this one is: the group's middle plus its place, turned to the heading.
          let mid = act === 'hop' ? path(ms + a.ph * 7, pos).clone() : centre;
          let heading = act === 'hop' ? path(ms + a.ph * 7 + 0.5, fwd).sub(mid) : vel.clone();
          let ring: THREE.Vector3 | null = null;
          if (act === 'soar') {
            // Its own circle round the group's drifting middle: wide, slow, the same way round.
            const R = 9 + 7 * hash01(a.ph * 13.1), ang = (t * 2.2) / R + a.ph;
            ring = centre;
            mid = centre.clone().addScaledVector(g.e, Math.cos(ang) * R * g.lift).addScaledVector(g.nth, Math.sin(ang) * R * g.lift);
            heading = g.e.clone().multiplyScalar(-Math.sin(ang)).addScaledVector(g.nth, Math.cos(ang));
          }
          up.copy(mid).normalize();
          heading.addScaledVector(up, -heading.dot(up));
          if (heading.lengthSq() < 1e-24) heading.copy(g.e);
          heading.normalize();
          side.crossVectors(up, heading);
          // Each animal's own small drift and heading wobble (grazing animals face every way).
          const wob = act === 'flock' ? 0.15 : act === 'herd' ? 0.6 : act === 'soar' ? 0 : act === 'skein' ? 0.04 : 0.25;
          const yaw = wob * Math.sin(t * 0.05 + a.ph);
          const own = act === 'hop' || act === 'soar' ? 0 : 1;
          const drift = act === 'skein' ? 0.15 : 0.6;
          let dx = own * a.x + drift * Math.sin(t * 0.1 + a.ph), dz = own * a.z + drift * Math.cos(t * 0.08 + a.ph * 1.3);
          // Flocks swirl and stretch about their middle (songbirds the most: a murmuration).
          if (act === 'flock') {
            const sw = g.kind === 'songbird' ? 2.5 : 1.2;
            dx += sw * Math.sin(t * 0.6 + a.ph + a.z * 0.15);
            dz += sw * Math.cos(t * 0.5 + a.ph * 1.7 + a.x * 0.15);
          }
          pos.copy(mid).addScaledVector(side, dx * g.size).addScaledVector(heading, dz * g.size).normalize();
          fwd.copy(heading).multiplyScalar(Math.cos(yaw)).addScaledVector(side, Math.sin(yaw));
          side.crossVectors(up.copy(pos), fwd).normalize();
          fwd.crossVectors(side, up).normalize();
          let r = h(pos.x, pos.y, pos.z);
          if (r <= SEA + 1e-5 && !flier) continue;     // nothing walks on water
          if (flier) {
            const alt = sp.alt ?? 26;
            // (A skein rises and falls together, so the V holds.)
            r = Math.max(r, SEA) + g.lift * alt * (1 + 0.2 * Math.sin(t * (act === 'soar' ? 0.08 : 0.3) + (act === 'skein' ? g.p[0] : a.ph)));
            if (act === 'soar') {
              // Mostly gliding, wings set; now and then a few slow beats.
              const T = 9, k = Math.floor((t + a.ph) / T), f = (t + a.ph) / T - k;
              flap = hash01(k * 17 + a.ph) < 0.3 && f < 0.25 ? Math.cos((f / 0.25) * Math.PI * 6) : 1;
              // Banked into the turn.
              if (ring) {
                const inward = ring.clone().sub(pos);
                inward.addScaledVector(up, -inward.dot(up)).normalize();
                up.addScaledVector(inward, 0.4).normalize();
                side.crossVectors(up, fwd).normalize();
                fwd.crossVectors(side, up).normalize();
              }
            } else if (act === 'skein') flap = Math.cos(t * 4.5 - a.rank * 0.7);   // the beat runs down the V
            else flap = Math.cos(t * ((g.kind === 'songbird' || g.kind === 'parrot' ? 15 : 9) + 4 * hash01(i)) + a.ph);
          } else r += hop * L;
          pos.multiplyScalar(r);
          m.makeBasis(side.multiplyScalar(L), up.multiplyScalar(L * flap), fwd.multiplyScalar(L));
          m.setPosition(pos);
          mesh.setMatrixAt(j, m);
          // (Birds keep their colour nearer: a flamingo or parrot shaded 0.8 turns muddy.)
          c.copy(a.col ?? g.colour).multiplyScalar(flier && g.kind !== 'bird' ? 0.9 + 0.3 * (a.shade - 0.8) : a.shade);
          mesh.setColorAt(j, c);
          counts.set(shape, j + 1);
        }
      }
    }
    for (const [shape, mesh] of this.meshes) {
      mesh.count = counts.get(shape) ?? 0;
      mesh.visible = mesh.count > 0;
      if (mesh.count) { mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor!.needsUpdate = true; }
    }
  }
}

function smooth(e0: number, e1: number, x: number) { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
