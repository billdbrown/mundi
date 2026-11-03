/**
 * More kinds of plant (2026-11-03): sixteen families of low-poly tree and plant, three variants
 * each, built from seeded parameters (crown shape, tiers, trunk, lean), so a biome can mix a
 * dozen distinct shapes. They follow the ten original kinds (flora.ts) as kinds 10 and up.
 *
 * Cost: each kind is one instanced mesh, one draw call, drawn only when some are near; all share
 * the one tree material, so no new shaders. The number of plants on screen is capped as before
 * (lodflora.ts), so more kinds means more variety, not more plants.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { makeRng } from './rng.ts';
import { hash01 } from './rng.ts';

/** The families, in order; each has VARIANTS kinds, starting at FIRST + index * VARIANTS. */
export const FAMILIES = [
  'spruce', 'umbrellaPine', 'cypress', 'oak', 'poplar', 'willow', 'eucalypt', 'emergent',
  'baobab', 'joshua', 'royalPalm', 'roundShrub', 'reeds', 'pricklyPear', 'mangrove', 'treeFern',
] as const;
export type Family = typeof FAMILIES[number];
export const FIRST = 10, VARIANTS = 3;
export const SPECIES_KINDS = FAMILIES.length * VARIANTS;
/** Kind number of family f, variant v (0..2). */
export const sp = (f: Family, v = 0) => FIRST + FAMILIES.indexOf(f) * VARIANTS + v;
/** All three variants of a family. */
export const spAll = (f: Family) => [0, 1, 2].map((v) => sp(f, v));
/** Kinds that change with the seasons (sky.ts TREE_SEASON). */
export const LEAFY_FAMILIES = new Set<Family>(['oak', 'poplar', 'willow', 'roundShrub', 'reeds']);

type R = () => number;
const ni = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
/** A lumpy blob (an icosahedron, subdivided and jittered), centred at (x, y, z). */
function blob(r: number, x: number, y: number, z: number, seed: number, detail = 1) {
  const g = new THREE.IcosahedronGeometry(r, detail);
  const p = g.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const k = 0.84 + 0.3 * hash01(seed * 131 + Math.round((p.getX(i) + 3) * 97) * 7 + Math.round((p.getY(i) + 3) * 89) * 3 + Math.round((p.getZ(i) + 3) * 83));
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
  }
  return ni(g.translate(x, y, z));
}
/** A blob squashed or stretched by (sx, sy, sz) about its own centre, then placed at (x, y, z).
 *  (Scaling after placing also moved it: crowns sank into their trunks.) */
const sblob = (r: number, sx: number, sy: number, sz: number, x: number, y: number, z: number, seed: number, detail = 1) =>
  blob(r, 0, 0, 0, seed, detail).scale(sx, sy, sz).translate(x, y, z);
const trunk = (r0: number, r1: number, h: number, sides = 5) => ni(new THREE.CylinderGeometry(r1, r0, h, sides).translate(0, h / 2, 0));
const cone = (r: number, h: number, y: number, sides = 7) => ni(new THREE.ConeGeometry(r, h, sides).translate(0, y + h / 2, 0));
const merge = (parts: THREE.BufferGeometry[]) => {
  const m = mergeGeometries(parts.map((p) => { const q = ni(p); q.deleteAttribute('uv'); return q; }));
  if (!m) throw new Error('species: merge failed');
  return m;
};
/** A limb: a cylinder from a to b. */
function limb(a: number[], b: number[], r: number) {
  const d = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]), len = d.length();
  const g = new THREE.CylinderGeometry(r * 0.7, r, len, 4).translate(0, len / 2, 0);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  return ni(g.translate(a[0], a[1], a[2]));
}

const BUILD: Record<Family, (r: R, seed: number) => THREE.BufferGeometry> = {
  // Spruce and fir: a narrow spire of stacked tiers.
  spruce: (r) => {
    const tiers = 4 + Math.floor(r() * 3), h = 1.1 + 0.4 * r(), w = 0.26 + 0.08 * r(), parts = [trunk(0.05, 0.04, 0.25)];
    for (let i = 0; i < tiers; i++) {
      const t = i / tiers;
      parts.push(cone(w * (1 - 0.7 * t), (h / tiers) * 1.25, 0.18 + t * h * 0.85, 7));   // (skirts that step in: tiers, not one cone)
    }
    return merge(parts);
  },
  // Stone pine: a tall bare trunk under a flat, spreading crown.
  umbrellaPine: (r, s) => {
    const th = 0.75 + 0.25 * r(), lean = (r() - 0.5) * 0.15;
    return merge([limb([0, 0, 0], [lean, th, 0], 0.045), sblob(0.42, 1.35, 0.42, 1.25, lean, th + 0.08, 0, s)]);
  },
  // Cypress and juniper: a dark flame, tall and narrow.
  cypress: (r, s) => merge([trunk(0.04, 0.03, 0.15), blob(0.22, 0, 0, 0, s).scale(0.7, 2.6 + r(), 0.7).translate(0, 0.72, 0)]),
  // Oak: a broad, lumpy crown on a short thick trunk.
  oak: (r, s) => {
    const parts = [trunk(0.08, 0.06, 0.38, 6)], n = 4 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r(), d = 0.18 + 0.1 * r();
      parts.push(blob(0.24 + 0.08 * r(), Math.cos(a) * d, 0.55 + 0.15 * r(), Math.sin(a) * d, s + i));
    }
    parts.push(blob(0.3, 0, 0.72, 0, s + 9));
    return merge(parts);
  },
  // Poplar: a tall column, the wind-break along rivers and roads.
  poplar: (r, s) => merge([trunk(0.04, 0.03, 0.3), blob(0.2, 0, 0, 0, s).scale(0.75, 2.4 + 0.6 * r(), 0.75).translate(0, 0.85, 0)]),
  // Willow: a round head with curtains hanging to the ground.
  willow: (r, s) => {
    const parts = [trunk(0.07, 0.05, 0.42, 5), sblob(0.36, 1.15, 0.7, 1.15, 0, 0.62, 0, s)];
    const n = 7 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3 * r();
      parts.push(blob(0.1, 0, 0, 0, s + 20 + i, 0).scale(0.9, 3.2, 0.9).translate(Math.cos(a) * 0.36, 0.38, Math.sin(a) * 0.36));
    }
    return merge(parts);
  },
  // Eucalypt: tall and open, a few clumps of leaves on a pale leaning trunk.
  eucalypt: (r, s) => {
    const lean = (r() - 0.5) * 0.25, top = [lean, 1.05 + 0.2 * r(), 0];
    const parts = [limb([0, 0, 0], top, 0.035)];
    for (let i = 0; i < 4; i++) {
      const a = r() * Math.PI * 2, d = 0.12 + 0.14 * r();
      const tip = [top[0] + Math.cos(a) * d, top[1] - 0.25 + 0.3 * r(), Math.sin(a) * d];
      parts.push(limb([top[0] * 0.7, top[1] * 0.65, 0], tip, 0.018), blob(0.15 + 0.06 * r(), tip[0], tip[1], tip[2], s + i, 0));
    }
    return merge(parts);
  },
  // Rainforest emergent: a giant standing over the canopy, its crown a wide flat platter.
  emergent: (r, s) => merge([
    trunk(0.07, 0.05, 1.25, 5),
    sblob(0.4, 1.5, 0.45, 1.4, 0, 1.33, 0, s),
    sblob(0.22, 1.4, 0.5, 1.3, 0.32 * (r() - 0.5), 1.42, 0.3 * (r() - 0.5), s + 1),
  ]),
  // Baobab: a bottle of a trunk and a few stubby branches.
  baobab: (r, s) => {
    const parts = [ni(new THREE.CylinderGeometry(0.12, 0.2, 0.6, 7).translate(0, 0.3, 0))];
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + r(), tip = [Math.cos(a) * 0.28, 0.82 + 0.1 * r(), Math.sin(a) * 0.28];
      parts.push(limb([0, 0.55, 0], tip, 0.035), sblob(0.11, 1.3, 0.6, 1.3, tip[0], tip[1] + 0.04, tip[2], s + i, 0));
    }
    return merge(parts);
  },
  // Joshua tree and dragon tree: forking arms ending in spiky tufts.
  joshua: (r, s) => {
    const parts = [limb([0, 0, 0], [0, 0.42, 0], 0.045)];
    const n = 3 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, tip = [Math.cos(a) * (0.18 + 0.12 * r()), 0.62 + 0.2 * r(), Math.sin(a) * (0.18 + 0.12 * r())];
      parts.push(limb([0, 0.4, 0], tip, 0.03), cone(0.09, 0.16, tip[1] - 0.04, 6).translate(tip[0], 0, tip[2]));
      void s;
    }
    return merge(parts);
  },
  // Royal and fan palms: straight trunks, a ball or a starburst of fronds.
  royalPalm: (r, s) => {
    const h = 1.05 + 0.3 * r(), lean = (r() - 0.5) * 0.2, parts = [limb([0, 0, 0], [lean, h, 0], 0.04)];
    const n = 7 + Math.floor(r() * 3);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2, tip = [lean + Math.cos(a) * 0.36, h - 0.1 - 0.08 * r(), Math.sin(a) * 0.36];
      parts.push(limb([lean, h, 0], tip, 0.035).scale(1, 1, 1));
    }
    parts.push(blob(0.08, lean, h, 0, s, 0));
    return merge(parts);
  },
  // Shrubs: low, dense mounds (sage, gorse, broom).
  roundShrub: (r, s) => merge([
    sblob(0.3, 1.2, 0.7, 1.1, 0, 0.2, 0, s),
    sblob(0.2, 1.1, 0.7, 1.1, 0.22 * (r() - 0.3), 0.15, 0.2 * (r() - 0.5), s + 1),
  ]),
  // Reeds and rushes: a sheaf of thin blades at the water's edge.
  reeds: (r) => {
    const parts: THREE.BufferGeometry[] = [], n = 7 + Math.floor(r() * 4);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2, d = 0.12 * r(), h = 0.45 + 0.35 * r();
      parts.push(ni(new THREE.ConeGeometry(0.025, h, 3).rotateZ((r() - 0.5) * 0.4).translate(Math.cos(a) * d, h / 2, Math.sin(a) * d)));
    }
    return merge(parts);
  },
  // Prickly pear: paddles stacked at angles.
  pricklyPear: (r) => {
    const parts: THREE.BufferGeometry[] = [];
    const pad = (x: number, y: number, z: number, rot: number, tilt: number) =>
      ni(new THREE.SphereGeometry(0.12, 6, 4).scale(1, 1.3, 0.3).rotateZ(tilt).rotateY(rot).translate(x, y, z));
    parts.push(pad(0, 0.15, 0, r() * 3, 0));
    for (let i = 0; i < 4; i++) parts.push(pad((r() - 0.5) * 0.25, 0.3 + 0.12 * r(), (r() - 0.5) * 0.2, r() * 3, (r() - 0.5) * 1.2));
    return merge(parts);
  },
  // Mangrove: a dome of leaves up on a tangle of arching stilt roots.
  mangrove: (r, s) => {
    const parts = [sblob(0.34, 1.25, 0.65, 1.2, 0, 0.62, 0, s)];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + 0.4 * r();
      parts.push(limb([Math.cos(a) * 0.26, 0, Math.sin(a) * 0.26], [Math.cos(a) * 0.06, 0.5, Math.sin(a) * 0.06], 0.02));
    }
    return merge(parts);
  },
  // Tree fern: a thin trunk under a crown of arching fronds (cloud forest, wet tropics).
  treeFern: (r, s) => {
    const h = 0.6 + 0.25 * r(), parts = [trunk(0.045, 0.04, h, 5)];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + 0.2 * r();
      parts.push(ni(new THREE.ConeGeometry(0.06, 0.42, 3).rotateZ(-Math.PI / 2 + 0.5).rotateY(-a).translate(Math.cos(a) * 0.18, h, Math.sin(a) * 0.18)));
    }
    void s;
    return merge(parts);
  },
};

let built: THREE.BufferGeometry[] | null = null;
/** The geometry for species kind k (FIRST and up). */
export function speciesGeometry(k: number): THREE.BufferGeometry {
  built ??= FAMILIES.flatMap((f, fi) => [0, 1, 2].map((v) => {
    const seed = 7001 + fi * 37 + v * 11;
    const g = BUILD[f](makeRng(seed), seed);
    // Normals for flat shading come from the faces; keep only position.
    for (const name of Object.keys(g.attributes)) if (name !== 'position') g.deleteAttribute(name);
    g.computeVertexNormals();
    return g;
  }));
  return built[k - FIRST];
}
