/**
 * Trees and props near the camera.
 *
 * At planet scale a tree is far too small to see, so from orbit forests are just colour, as in
 * satellite imagery. Zoom in and the ground around the view fills with small, dense trees,
 * rocks, cacti and icebergs. Plants are generated per terrain triangle (several to a cell) from
 * that triangle's own seed, placed exactly on it, and cached; generation is spread over frames,
 * nearest first, so moving never stalls; only triangles within a radius that shrinks as you
 * descend are drawn, and far ones are forgotten.
 *
 * The plant scale (setScale) sets their size; density rises with the square of the shrink so
 * forests stay closed, and the radius shrinks with it, so about as many are drawn at any scale.
 */
import * as THREE from 'three';
import { B, landBiome } from './biomes.ts';
import { WATER_LAND, WATER_OCEAN, type World } from './world.ts';
import type { SurfaceData } from './surface.ts';
import { FLORA, ICEBERG, CACTUS, ROCK, PALM, BROADLEAF, treeGeometry, treeMaterial } from './flora.ts';
import { groveField, groveFreq, forestMask, openMask, REF_SPACING } from './groves.ts';
import { makeRng } from './rng.ts';
import { makeSimplex, type Noise3 } from './noise.ts';

/** Biomes that are forest (trees with clearings) and open country (trees only in groves). */
const FOREST = new Set<number>([B.TAIGA, B.FOREST, B.TEMPERATE_RAIN, B.RAINFOREST, B.DRY_FOREST]);
const OPEN = new Set<number>([B.SAVANNA, B.GRASSLAND]);
/** Dry biomes, where trees crowd along rivers (gallery forest, date palms on the Nile). */
const DRY = new Set<number>([B.DESERT, B.STEPPE, B.SAVANNA, B.DRY_FOREST, B.GRASSLAND]);
/** Riverside band, radians past the bank (a few km on an Earth-sized world). */
const RIVERSIDE = 0.0011;

const SEA = 1.0;
/** At scale 1, plants are full size within FADE_NEAR of the camera and gone at FADE_FAR. */
export const FADE_NEAR = 0.15, FADE_FAR = 0.26;
/** Plants per cell-sized area relative to the FLORA table's numbers, at scale 1. */
const DENSITY = 36;
const KINDS = 7;
/** Floats per plant: x, y, z, size, spin, shade, kind, colour, cut year (0 = never). */
const STRIDE = 9;
const MAX_INSTANCES = 320000;
/** Main-thread time per frame for generating plants, ms. */
const BUDGET_MS = 5;

/** A triangle's plants as instance data, by kind: count, matrices (16 each), colours (3), clearing year. */
interface Baked { n: Int32Array; mat: Float32Array[]; col: Float32Array[]; cut: Float32Array[] }

export class LodFlora {
  private group = new THREE.Group();
  private meshes: (THREE.InstancedMesh | null)[] = new Array(KINDS).fill(null);
  private world?: World;
  private pos?: Float32Array;
  private index?: Uint32Array;
  private faces?: Int32Array;
  /** Triangle centroid directions (unit), for the radius test. */
  private centroid = new Float32Array(0);
  private triStart = new Int32Array(0);
  private triCount = new Int32Array(0);
  /** Per triangle, its plants ready to copy into the instance buffers. */
  private baked = new Map<number, Baked>();
  private clump?: Noise3;
  private lastCenter = 0;
  private lastKey = '';
  /** Triangles that should be drawn now, nearest first; reselected when the view moves. */
  private wanted: number[] = [];
  private dirty = false;
  private lastRebuild = 0;
  private relief = 0.035;
  private scale = 1;
  /** Fade distances for the plants' shader (applyCloudShadow), following the scale. */
  readonly fade = { uFadeNear: { value: FADE_NEAR }, uFadeFar: { value: FADE_FAR } };
  /** Centuries: the year each spot is cleared for farming (0 = never), or none. */
  private clearing: ((x: number, y: number, z: number, cell: number) => number) | null = null;

  /** Rivers: true where a point is in a drawn channel, so nothing grows there. */
  private inWater: ((x: number, y: number, z: number, cell: number) => boolean) | null = null;
  setWater(f: ((x: number, y: number, z: number, cell: number) => boolean) | null) {
    this.inWater = f;
    this.forget();
  }

  /** Riverside trees: distance from a point to the nearest river past its bank, and which cells have one near. */
  private riverDist: ((x: number, y: number, z: number, cell: number) => number) | null = null;
  private riverNear: ((cell: number) => boolean) | null = null;
  setRiverside(dist: ((x: number, y: number, z: number, cell: number) => number) | null, near: ((cell: number) => boolean) | null) {
    this.riverDist = dist;
    this.riverNear = near;
    this.forget();
  }

  setClearing(f: ((x: number, y: number, z: number, cell: number) => number) | null) {
    this.clearing = f;
    this.forget();
  }

  /** Plant size relative to the original (1); density and radius follow (see the top). */
  setScale(s: number) {
    this.scale = s;
    this.fade.uFadeNear.value = FADE_NEAR * s;
    this.fade.uFadeFar.value = FADE_FAR * s;
    this.forget();
  }
  getScale() { return this.scale; }

  private forget() {
    this.baked.clear();
    this.lastKey = '';
  }

  constructor(parent: THREE.Object3D) {
    parent.add(this.group);
  }

  /** New world or new surface: forget everything cached. */
  setSurface(world: World, data: SurfaceData, relief: number) {
    this.world = world;
    this.relief = relief;
    this.pos = data.terrain.position;
    this.index = data.terrain.index;
    this.faces = data.faces;
    const N = world.grid.count, T = data.faces.length;
    this.triStart = new Int32Array(N).fill(-1);
    this.triCount = new Int32Array(N);
    data.faces.forEach((c, t) => {          // the builders emit each cell's triangles together
      if (this.triStart[c] < 0) this.triStart[c] = t;
      this.triCount[c]++;
    });
    this.centroid = new Float32Array(T * 3);
    this.clump = makeSimplex(world.params.seed * 5 + 17);
    this.forget();
    // (The tile style's mesh has no index: no plants there, as before.)
    const p = data.terrain.position, ix = data.terrain.index;
    if (!ix) { this.index = undefined; return; }
    for (let t = 0; t < T; t++) {
      const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
      const x = p[a] + p[b] + p[c], y = p[a + 1] + p[b + 1] + p[c + 1], z = p[a + 2] + p[b + 2] + p[c + 2];
      const l = Math.hypot(x, y, z) || 1;
      this.centroid[t * 3] = x / l; this.centroid[t * 3 + 1] = y / l; this.centroid[t * 3 + 2] = z / l;
    }
  }

  /** all: generate everything needed now, not over frames (for screenshots, which can't wait). */
  update(camera: THREE.Vector3, visible: boolean, all = false) {
    const d = camera.length();
    const far = FADE_FAR * this.scale;
    if (!visible || !this.world || !this.index || d > 1 + far + 0.005) { this.group.visible = false; return; }
    this.group.visible = true;
    const g = this.world.grid, P = g.centers;
    const dx = camera.x / d, dy = camera.y / d, dz = camera.z / d;
    const dot = (c: number) => P[c * 3] * dx + P[c * 3 + 1] * dy + P[c * 3 + 2] * dz;
    // Greedy walk to the cell under the camera (the view looks at the planet's centre).
    let cur = this.lastCenter < g.count ? this.lastCenter : 0;
    for (;;) {
      let best = cur;
      for (const n of g.neighbors[cur]) if (dot(n) > dot(best)) best = n;
      if (best === cur) break;
      cur = best;
    }
    this.lastCenter = cur;
    // Cover every triangle that could hold a visible plant, plus a margin, so they join while
    // their plants are still at zero size.
    const alt = Math.max(0, d - 1);
    const radius = Math.sqrt(Math.max(0, far * far - alt * alt)) + 0.03 * this.scale + 0.004;
    const key = `${cur}:${Math.round(radius * 600)}`;
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.selectTriangles(cur, radius, dx, dy, dz);
    }
    // Generate what's missing, nearest first, within the frame budget.
    const t0 = performance.now();
    let added = false, missing = false;
    for (const t of this.wanted) {
      if (this.baked.has(t)) continue;
      if (!all && performance.now() - t0 > BUDGET_MS) { missing = true; break; }
      this.baked.set(t, this.bake(t));
      added = true;
    }
    if (added) this.dirty = true;
    // Rebuild the instance buffers when the set changed; while plants are still coming in, at
    // most a few times a second (each rebuild copies every plant).
    const now = performance.now();
    if (this.dirty && (!missing || now - this.lastRebuild > 150)) {
      this.dirty = false;
      this.lastRebuild = now;
      this.rebuild();
    }
  }

  /** The triangles within the radius, nearest first; forget baked ones well outside it. */
  private selectTriangles(cur: number, radius: number, dx: number, dy: number, dz: number) {
    const g = this.world!.grid, P = g.centers, C = this.centroid;
    const cellReach = Math.cos(Math.min(Math.PI, radius + 1.2 * Math.sqrt((4 * Math.PI) / g.count)));
    const dot = (c: number) => P[c * 3] * dx + P[c * 3 + 1] * dy + P[c * 3 + 2] * dz;
    const seen = new Set([cur]), cells = [cur];
    for (let i = 0; i < cells.length; i++) {
      for (const n of g.neighbors[cells[i]]) {
        if (!seen.has(n) && dot(n) > cellReach) { seen.add(n); cells.push(n); }
      }
    }
    const cosR = Math.cos(radius), list: [number, number][] = [];
    for (const c of cells) {
      for (let t = this.triStart[c]; t < this.triStart[c] + this.triCount[c]; t++) {
        const k = C[t * 3] * dx + C[t * 3 + 1] * dy + C[t * 3 + 2] * dz;
        if (k > cosR) list.push([t, k]);
      }
    }
    list.sort((a, b) => b[1] - a[1]);
    this.wanted = list.map(([t]) => t);
    this.dirty = true;
    // Memory: drop triangles far outside the radius.
    const cosKeep = Math.cos(Math.min(Math.PI, radius * 2.5 + 0.01));
    for (const t of this.baked.keys()) {
      if (C[t * 3] * dx + C[t * 3 + 1] * dy + C[t * 3 + 2] * dz < cosKeep) this.baked.delete(t);
    }
  }

  private rebuild() {
    const parts: Baked[] = [];
    for (const t of this.wanted) { const b = this.baked.get(t); if (b) parts.push(b); }
    const counts = new Array(KINDS).fill(0);
    for (const b of parts) for (let k = 0; k < KINDS; k++) counts[k] += b.n[k];
    const total = counts.reduce((s, n) => s + n, 0);
    const keep = total > MAX_INSTANCES ? MAX_INSTANCES / total : 1;

    for (let k = 0; k < KINDS; k++) {
      const need = Math.ceil(counts[k] * keep);
      let mesh = this.meshes[k];
      if (!mesh || mesh.instanceMatrix.count < need) {
        if (mesh) { this.group.remove(mesh); mesh.dispose(); }
        const cap = Math.max(16, Math.ceil(need * 1.3));
        // Own geometry per mesh, for the per-instance 'cut' attribute.
        const geo = treeGeometry(k).clone();
        geo.setAttribute('cut', new THREE.InstancedBufferAttribute(new Float32Array(cap), 1));
        mesh = new THREE.InstancedMesh(geo, treeMaterial, cap);
        mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
        mesh.frustumCulled = false;
        this.meshes[k] = mesh;
        this.group.add(mesh);
      }
    }
    // Copy each triangle's ready-made blocks; when over budget, every triangle gives up the same
    // share (its plants are in random order, so taking the first ones thins evenly).
    const fill = new Array(KINDS).fill(0);
    for (const b of parts) {
      for (let k = 0; k < KINDS; k++) {
        const mesh = this.meshes[k]!, cap = mesh.instanceMatrix.count;
        const take = Math.min(keep < 1 ? Math.round(b.n[k] * keep) : b.n[k], cap - fill[k]);
        if (take <= 0) continue;
        const j = fill[k];
        (mesh.instanceMatrix.array as Float32Array).set(b.mat[k].subarray(0, take * 16), j * 16);
        (mesh.instanceColor!.array as Float32Array).set(b.col[k].subarray(0, take * 3), j * 3);
        ((mesh.geometry.getAttribute('cut') as THREE.InstancedBufferAttribute).array as Float32Array).set(b.cut[k].subarray(0, take), j);
        fill[k] += take;
      }
    }
    // Upload only the part in use.
    this.meshes.forEach((mesh, k) => {
      if (!mesh) return;
      mesh.count = Math.min(fill[k], mesh.instanceMatrix.count);
      const attrs: [THREE.BufferAttribute, number][] = [[mesh.instanceMatrix, 16], [mesh.instanceColor!, 3], [mesh.geometry.getAttribute('cut') as THREE.BufferAttribute, 1]];
      for (const [a, size] of attrs) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, Math.max(1, mesh.count) * size);
        a.needsUpdate = true;
      }
    });
  }

  /** One triangle's plants as instance data: a matrix, colour and clearing year each, by kind. */
  private bake(t: number): Baked {
    const a = this.plants(t);
    const n = new Int32Array(KINDS);
    for (let i = 0; i < a.length; i += STRIDE) n[a[i + 6]]++;
    const b: Baked = {
      n,
      mat: Array.from(n, (m) => new Float32Array(m * 16)),
      col: Array.from(n, (m) => new Float32Array(m * 3)),
      cut: Array.from(n, (m) => new Float32Array(m)),
    };
    const fill = new Int32Array(KINDS);
    const { up, n: nn, q, spin, m, p, sc, color } = this.tmp;
    for (let i = 0; i < a.length; i += STRIDE) {
      const k = a[i + 6], j = fill[k]++;
      const s = a[i + 3];
      nn.set(a[i], a[i + 1], a[i + 2]).normalize();
      q.setFromUnitVectors(up, nn);
      spin.setFromAxisAngle(nn, a[i + 4]);
      q.premultiply(spin);
      p.set(a[i], a[i + 1], a[i + 2]).addScaledVector(nn, -0.05 * s);
      sc.setScalar(s);
      m.compose(p, q, sc);
      m.toArray(b.mat[k], j * 16);
      color.setHex(a[i + 7]).multiplyScalar(a[i + 5]);
      color.toArray(b.col[k], j * 3);
      b.cut[k][j] = a[i + 8];
    }
    return b;
  }
  private tmp = {
    up: new THREE.Vector3(0, 1, 0), n: new THREE.Vector3(), q: new THREE.Quaternion(), spin: new THREE.Quaternion(),
    m: new THREE.Matrix4(), p: new THREE.Vector3(), sc: new THREE.Vector3(), color: new THREE.Color(),
  };

  /** Area of triangle t, in units of REF_SPACING squared (a cell-sized area at detail 40). */
  private triArea(t: number): number {
    const p = this.pos!, ix = this.index!;
    const a = ix[t * 3] * 3, b = ix[t * 3 + 1] * 3, c = ix[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / (REF_SPACING * REF_SPACING);
  }

  /** One triangle's plants, generated once from the triangle's own seed. */
  private plants(t: number): Float32Array {
    const w = this.world!, g = w.grid, P = g.centers, c = this.faces![t];
    // Plants are sized and spaced in fixed ground units, times the scale; density rises with the
    // square of the shrink so canopy cover stays the same.
    const s = this.scale, spacing = REF_SPACING * s;
    const area = this.triArea(t) / (s * s);
    const rng = makeRng(w.params.seed * 7919 + t * 31 + 7);
    const count = (x: number) => Math.floor(x + rng());     // random rounding: small counts average right
    const out: number[] = [];

    if (w.water[c] === WATER_OCEAN) {
      // Icebergs on cold open sea near the ice.
      if (w.biome[c] !== B.SEA_ICE && w.temperature[c] < 0.2) {
        const n = count(rng() * 4 * area);
        for (let i = 0; i < n; i++) {
          const pt = this.randomPoint(t, rng, true);
          if (!pt) continue;
          const r = rng();
          out.push(pt[0], pt[1], pt[2], spacing * (0.02 + 0.05 * r * r), rng() * Math.PI * 2, 0.92 + 0.08 * rng(), ICEBERG, 0xeef5fa, 0);
        }
      }
    } else if (w.water[c] === WATER_LAND) {
      // Mountain cells grow what their climate grows lower down, thinned (the snow line and the
      // slope test in randomPoint keep trees off peaks and cliffs); the rocks stay.
      const mountain = w.biome[c] === B.MOUNTAIN || w.biome[c] === B.PEAK;
      const b = mountain ? landBiome(w.temperature[c], w.moisture[c], 0) : w.biome[c];
      type Spec = NonNullable<(typeof FLORA)[number]>;
      const spec: Spec | undefined = mountain
        ? [...(FLORA[b] ?? []).map(([k, col, d, sz]): Spec[number] => [k, col, d * 0.6, sz]), ...(FLORA[B.MOUNTAIN] ?? []).filter(([k]) => k === ROCK)]
        : FLORA[b];
      if (spec) {
        const f = 0.45 / REF_SPACING, clump = this.clump!;
        const cn = 0.5 + 0.5 * clump(P[c * 3] * f, P[c * 3 + 1] * f, P[c * 3 + 2] * f);
        // Forest and open country take their shape from the grove pattern (shared with the ground
        // shader's canopy); elsewhere the old cell-scale clumping still varies density.
        const forest = FOREST.has(b), open = OPEN.has(b);
        const groves = forest ? 3.2 : open ? 2.6 : Math.max(0.05, 1.9 * cn * cn);
        const gf = groveFreq(g.count);
        const riverThin = w.river[c] ? 0.85 : 1;   // the channel itself is kept clear (inWater)
        const nearRiver = !!w.river[c] || g.neighbors[c].some((nb) => w.river[nb]);
        for (const [kind, col, density, size = 1] of spec) {
          const n = count(density * DENSITY * groves * riverThin * area * (0.85 + 0.3 * rng()));
          const shaped = (forest || open) && kind !== ROCK && kind !== CACTUS;
          for (let i = 0; i < n; i++) {
            const pt = this.randomPoint(t, rng, false);
            if (!pt) continue;
            if (nearRiver && this.inWater?.(pt[0], pt[1], pt[2], c)) continue;
            if (shaped) {
              const gv = groveField(pt[0], pt[1], pt[2], gf);
              // Rainforest canopy is nearly closed; temperate forest has glades; taiga has bogs.
              const off = b === B.RAINFOREST ? 0.5 : b === B.TEMPERATE_RAIN ? 0.35 : b === B.TAIGA ? 0.1 : 0;
              if (rng() > (forest ? forestMask(gv + off) : openMask(gv))) continue;
            }
            // Sizes skew small: plenty of young trees, a few big ones.
            const r = rng();
            // Most trees go when the land is farmed; a few stay as hedgerow and field trees.
            const cut = this.clearing && kind !== ROCK && kind !== CACTUS && rng() < 0.88 ? this.clearing(pt[0], pt[1], pt[2], c) : 0;
            out.push(pt[0], pt[1], pt[2], spacing * size * (0.022 + 0.032 * r * r), rng() * Math.PI * 2, 0.8 + 0.32 * rng(), kind, col, cut);
          }
        }
      }
      // Along rivers through dry country, a dense band of trees: date palms in hot desert,
      // poplar and willow elsewhere. Thick at the bank, thinning outward.
      const dryHere = DRY.has(b) || (mountain && w.moisture[c] < 0.35);
      if (dryHere && this.riverDist && this.riverNear?.(c)) {
        const hot = w.temperature[c] > 0.62 && w.moisture[c] < 0.2;
        const kind = hot ? PALM : BROADLEAF, col = hot ? 0x4c7d2c : 0x3f6b2a;
        const n = count(26 * DENSITY * area * (b === B.DESERT ? 1 : 0.6));
        for (let i = 0; i < n; i++) {
          const pt = this.randomPoint(t, rng, false);
          if (!pt) continue;
          const d = this.riverDist(pt[0], pt[1], pt[2], c);
          if (d < 0 || d > RIVERSIDE * (0.6 + 0.8 * rng()) || rng() > 1 - d / (RIVERSIDE * 1.4)) continue;
          const r = rng();
          const cut = this.clearing && rng() < 0.88 ? this.clearing(pt[0], pt[1], pt[2], c) : 0;
          out.push(pt[0], pt[1], pt[2], spacing * (0.022 + 0.032 * r * r), rng() * Math.PI * 2, 0.8 + 0.32 * rng(), kind, col, cut);
        }
      }
    }
    return Float32Array.from(out);
  }

  /**
   * A random point on terrain triangle t. Land: skip steep slopes, snow and anything at or below
   * the waterline. Sea: the point is lifted onto the water surface.
   */
  private randomPoint(t: number, rng: () => number, onWater: boolean): number[] | null {
    if (!this.pos || !this.index) return null;
    const ia = this.index[t * 3] * 3, ib = this.index[t * 3 + 1] * 3, ic = this.index[t * 3 + 2] * 3, p = this.pos;
    let u = rng(), v = rng();
    if (u + v > 1) { u = 1 - u; v = 1 - v; }
    const x = p[ia] + (p[ib] - p[ia]) * u + (p[ic] - p[ia]) * v;
    const y = p[ia + 1] + (p[ib + 1] - p[ia + 1]) * u + (p[ic + 1] - p[ia + 1]) * v;
    const z = p[ia + 2] + (p[ib + 2] - p[ia + 2]) * u + (p[ic + 2] - p[ia + 2]) * v;
    const l = Math.hypot(x, y, z);
    if (onWater) return [(x / l) * SEA, (y / l) * SEA, (z / l) * SEA];
    if (l < SEA + 0.0006) return null;
    // Flatness: the triangle's normal against straight up.
    const e1x = p[ib] - p[ia], e1y = p[ib + 1] - p[ia + 1], e1z = p[ib + 2] - p[ia + 2];
    const e2x = p[ic] - p[ia], e2y = p[ic + 1] - p[ia + 1], e2z = p[ic + 2] - p[ia + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nl = Math.hypot(nx, ny, nz) || 1;
    if ((nx * x + ny * y + nz * z) / (nl * l) < 0.9) return null;
    // Snow line: the same formula the vertex shading uses.
    const w = this.world!;
    const lat = Math.abs(Math.asin(Math.max(-1, Math.min(1, y / l)))) / (Math.PI / 2);
    const temp = 1 - 1.1 * Math.pow(lat, 1.25) - 0.55 * Math.max(0, (l - SEA) / this.relief) + w.params.heat;
    if (temp < 0.2) return null;
    return [x, y, z];
  }
}
