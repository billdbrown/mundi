/**
 * Trees and props near the camera, at a believable size and density.
 *
 * At planet scale a tree is far too small to see, so from orbit forests are just colour, as in
 * satellite imagery. Zoom in and the cells around the view fill with small, dense trees, rocks,
 * cacti and icebergs. Each cell's plants are generated on demand from its own seed, placed
 * exactly on the terrain triangles, and cached; only the cells within a radius that shrinks as
 * you descend are drawn.
 */
import * as THREE from 'three';
import { B, landBiome } from './biomes.ts';
import { WATER_LAND, WATER_OCEAN, type World } from './world.ts';
import type { SurfaceData } from './surface.ts';
import { FLORA, ICEBERG, CACTUS, ROCK, treeGeometry, treeMaterial } from './flora.ts';
import { groveField, groveFreq, forestMask, openMask, REF_SPACING } from './groves.ts';

/** Biomes that are forest (trees with clearings) and open country (trees only in groves). */
const FOREST = new Set<number>([B.TAIGA, B.FOREST, B.TEMPERATE_RAIN, B.RAINFOREST, B.DRY_FOREST]);
const OPEN = new Set<number>([B.SAVANNA, B.GRASSLAND]);
import { makeRng } from './rng.ts';
import { makeSimplex, type Noise3 } from './noise.ts';

const SEA = 1.0;
/** Plants are full size within FADE_NEAR of the camera and shrink to nothing at FADE_FAR. */
export const FADE_NEAR = 0.15, FADE_FAR = 0.26;
/** Camera distance (planet radius 1) below which plants are generated at all. */
export const LOD_DIST = 1 + FADE_FAR + 0.005;
/** Plants per cell relative to the FLORA table's numbers. */
const DENSITY = 36;
const KINDS = 7;
/** Floats per plant: x, y, z, size, spin, shade, kind, colour, cut year (0 = never). */
const STRIDE = 9;
const MAX_INSTANCES = 320000;

export class LodFlora {
  private group = new THREE.Group();
  private meshes: (THREE.InstancedMesh | null)[] = new Array(KINDS).fill(null);
  private world?: World;
  private pos?: Float32Array;
  private index?: Uint32Array;
  private triStart = new Int32Array(0);
  private triCount = new Int32Array(0);
  private cache = new Map<number, Float32Array>();
  private clump?: Noise3;
  private lastCenter = 0;
  private lastKey = '';
  private relief = 0.035;
  /** Centuries: the year each spot is cleared for farming (0 = never), or none. */
  private clearing: ((x: number, y: number, z: number, cell: number) => number) | null = null;

  /** Rivers: true where a point is in a drawn channel, so nothing grows there. */
  private inWater: ((x: number, y: number, z: number, cell: number) => boolean) | null = null;
  setWater(f: ((x: number, y: number, z: number, cell: number) => boolean) | null) {
    this.inWater = f;
    this.cache.clear();
    this.lastKey = '';
  }

  setClearing(f: ((x: number, y: number, z: number, cell: number) => number) | null) {
    this.clearing = f;
    this.cache.clear();
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
    const N = world.grid.count;
    this.triStart = new Int32Array(N).fill(-1);
    this.triCount = new Int32Array(N);
    data.faces.forEach((c, t) => {          // the builders emit each cell's triangles together
      if (this.triStart[c] < 0) this.triStart[c] = t;
      this.triCount[c]++;
    });
    this.cache.clear();
    this.clump = makeSimplex(world.params.seed * 5 + 17);
    this.lastKey = '';
  }

  update(camera: THREE.Vector3, visible: boolean) {
    const d = camera.length();
    if (!visible || !this.world || d > LOD_DIST) { this.group.visible = false; return; }
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
    // Cover every cell that could hold a visible plant, plus a margin, so cells join the set
    // while their plants are still at zero size.
    const alt = Math.max(0, d - 1);
    const radius = Math.sqrt(Math.max(0, FADE_FAR * FADE_FAR - alt * alt)) + 0.03;
    const key = `${cur}:${Math.round(radius * 60)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;

    // Cells within the radius, by flood fill from the centre.
    const cosR = Math.cos(radius), seen = new Set([cur]), cells = [cur];
    for (let i = 0; i < cells.length; i++) {
      for (const n of g.neighbors[cells[i]]) {
        if (!seen.has(n) && dot(n) > cosR) { seen.add(n); cells.push(n); }
      }
    }
    const parts = cells.map((c) => this.cell(c));
    const counts = new Array(KINDS).fill(0);
    for (const a of parts) for (let i = 0; i < a.length; i += STRIDE) counts[a[i + 6]]++;
    const total = counts.reduce((s, n) => s + n, 0);
    const keep = total > MAX_INSTANCES ? MAX_INSTANCES / total : 1;

    const up = new THREE.Vector3(0, 1, 0), n = new THREE.Vector3(), q = new THREE.Quaternion(), spin = new THREE.Quaternion();
    const m = new THREE.Matrix4(), p = new THREE.Vector3(), sc = new THREE.Vector3(), color = new THREE.Color();
    const fill = new Array(KINDS).fill(0);
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
        mesh.frustumCulled = false;
        this.meshes[k] = mesh;
        this.group.add(mesh);
      }
    }
    let skip = 0;
    for (const a of parts) {
      for (let i = 0; i < a.length; i += STRIDE) {
        if (keep < 1 && (skip++ % 1000) / 1000 >= keep) continue;
        const k = a[i + 6], mesh = this.meshes[k]!, j = fill[k]++;
        if (j >= mesh.instanceMatrix.count) continue;
        const s = a[i + 3];
        n.set(a[i], a[i + 1], a[i + 2]).normalize();
        q.setFromUnitVectors(up, n);
        spin.setFromAxisAngle(n, a[i + 4]);
        q.premultiply(spin);
        p.set(a[i], a[i + 1], a[i + 2]).addScaledVector(n, -0.05 * s);
        sc.setScalar(s);
        m.compose(p, q, sc);
        mesh.setMatrixAt(j, m);
        color.setHex(a[i + 7]).multiplyScalar(a[i + 5]);
        mesh.setColorAt(j, color);
        (mesh.geometry.getAttribute('cut') as THREE.InstancedBufferAttribute).setX(j, a[i + 8]);
      }
    }
    this.meshes.forEach((mesh, k) => {
      if (!mesh) return;
      mesh.count = Math.min(fill[k], mesh.instanceMatrix.count);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.geometry.getAttribute('cut').needsUpdate = true;
    });
  }

  /** One cell's plants, generated once from the cell's own seed. */
  private cell(c: number): Float32Array {
    const hit = this.cache.get(c);
    if (hit) return hit;
    const w = this.world!, g = w.grid, P = g.centers;
    // Plants are sized and spaced in fixed ground units; a cell's share scales with its area.
    const spacing = REF_SPACING;
    const area = (4 * Math.PI) / g.count / (REF_SPACING * REF_SPACING);
    const rng = makeRng(w.params.seed * 7919 + c * 31 + 1);
    const out: number[] = [];

    if (w.water[c] === WATER_OCEAN) {
      // Icebergs on cold open sea near the ice.
      if (w.biome[c] !== B.SEA_ICE && w.temperature[c] < 0.2) {
        const n = Math.floor(rng() * 4 * area + rng());
        for (let i = 0; i < n; i++) {
          const pt = this.randomPoint(c, rng, true);
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
        const f = 0.45 / spacing, clump = this.clump!;
        const cn = 0.5 + 0.5 * clump(P[c * 3] * f, P[c * 3 + 1] * f, P[c * 3 + 2] * f);
        // Forest and open country take their shape from the grove pattern (shared with the ground
        // shader's canopy); elsewhere the old cell-scale clumping still varies density.
        const forest = FOREST.has(b), open = OPEN.has(b);
        const groves = forest ? 3.2 : open ? 2.6 : Math.max(0.05, 1.9 * cn * cn);
        const gf = groveFreq(g.count);
        const riverThin = w.river[c] ? 0.85 : 1;   // the channel itself is kept clear (inWater)
        for (const [kind, col, density, size = 1] of spec) {
          const n = Math.round(density * DENSITY * groves * riverThin * area * (0.85 + 0.3 * rng()));
          const shaped = (forest || open) && kind !== ROCK && kind !== CACTUS;
          for (let i = 0; i < n; i++) {
            const pt = this.randomPoint(c, rng, false);
            if (!pt) continue;
            if (w.river[c] || g.neighbors[c].some((nb) => w.river[nb])) {
              if (this.inWater?.(pt[0], pt[1], pt[2], c)) continue;
            }
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
    }
    const arr = Float32Array.from(out);
    this.cache.set(c, arr);
    return arr;
  }

  /**
   * A random point on one of the cell's terrain triangles. Land: skip steep slopes, snow and
   * anything at or below the waterline. Sea: the point is lifted onto the water surface.
   */
  private randomPoint(c: number, rng: () => number, onWater: boolean): number[] | null {
    const count = this.triCount[c];
    if (!count || !this.pos || !this.index) return null;
    const t = this.triStart[c] + Math.floor(rng() * count);
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
