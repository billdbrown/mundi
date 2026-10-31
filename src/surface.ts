/**
 * Turns a World into triangle meshes: the land/sea-floor surface, the water surface over it,
 * and spots for trees. Two styles:
 *
 *  - smooth: heights blend across cells; each fan triangle is split in four with small noise
 *    on the new points, so coasts and ridges stop following hex edges.
 *  - tiles:  each cell is a flat terrace with cliff walls down to lower neighbours.
 */
import * as THREE from 'three';
import { B } from './biomes.ts';
import { WATER_LAND, WATER_LAKE, WATER_OCEAN, type World } from './world.ts';
import { makeRng } from './rng.ts';
import { makeSimplex, type Noise3 } from './noise.ts';
import { FLORA, packTrees, type TreeSpot, type TreeData } from './flora.ts';
import { cellColors, type ViewMode, type TerrainStyle } from './colors.ts';
import type { Grid } from './grid.ts';

export const SEA = 1.0;

interface Surface {
  terrain: THREE.BufferGeometry;
  faces: Int32Array;
  water: THREE.BufferGeometry | null;
  trees: TreeSpot[];
  /** Height of each cell's centre (smooth) or flat top (tiles). */
  cellTop: Float32Array;
  /** Height at each corner (smooth only). */
  cornerH: Float32Array | null;
}

/** Raw arrays for one mesh: what crosses from the worker to the page. */
export interface MeshData {
  position: Float32Array;
  normal?: Float32Array;
  color?: Float32Array;
  depth?: Float32Array;
  index?: Uint32Array;
}

/** Everything the page needs to draw a world, as plain transferable data. */
export interface SurfaceData {
  style: TerrainStyle;
  terrain: MeshData;
  /** Cell of each terrain triangle, for picking. */
  faces: Int32Array;
  water: MeshData | null;
  trees: TreeData;
  cellTop: Float32Array;
  cornerH: Float32Array | null;
}

export interface BuildOptions {
  mode: ViewMode;
  style: TerrainStyle;
  relief: number;
  blend: boolean;
  trees: boolean;
}

function meshData(geo: THREE.BufferGeometry): MeshData {
  const a = (name: string) => geo.getAttribute(name)?.array as Float32Array | undefined;
  return {
    position: a('position')!, normal: a('normal'), color: a('color'), depth: a('depth'),
    index: geo.index ? Uint32Array.from(geo.index.array) : undefined,
  };
}

/** Builds the meshes for a world. Pure: runs in the worker. */
export function buildSurfaceData(world: World, o: BuildOptions): SurfaceData {
  const seed = world.params.seed;
  const input: SurfaceInput = {
    world, cellColor: cellColors(world, o.mode), relief: o.relief, blend: o.blend, flora: o.trees,
    natural: o.mode === 'biome', tint: makeSimplex(seed * 5 + 11), rough: makeSimplex(seed * 5 + 12),
  };
  const s = o.style === 'smooth' ? buildSmooth(input) : buildTiles(input);
  return {
    style: o.style, terrain: meshData(s.terrain), faces: s.faces,
    water: s.water ? meshData(s.water) : null, trees: packTrees(s.trees),
    cellTop: s.cellTop, cornerH: s.cornerH,
  };
}

/** Buffers in a SurfaceData that can be handed over to the page without copying. */
export function surfaceTransfer(d: SurfaceData): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (a?: ArrayBufferView | null) => { if (a) out.add(a.buffer as ArrayBuffer); };
  for (const m of [d.terrain, d.water]) {
    if (!m) continue;
    add(m.position); add(m.normal); add(m.color); add(m.depth); add(m.index);
  }
  add(d.faces); add(d.cellTop); add(d.cornerH);
  for (const v of Object.values(d.trees)) add(v as ArrayBufferView);
  return [...out];
}

/** Height lookups the page needs for rivers, grid lines and the hover outline. */
export interface SurfaceQueries {
  /** Height at the centre of a cell. */
  centerH: (c: number) => number;
  /** Heights of the shared edge c → neighbors[c][i], seen from c's side and from the far side. */
  edgeH: (c: number, i: number) => [number, number];
  /** Height to draw the outline at for corner i of cell c. */
  outlineH: (c: number, i: number) => number;
}

export function surfaceQueries(d: SurfaceData, g: Grid): SurfaceQueries {
  const top = d.cellTop, cornerH = d.cornerH;
  if (d.style === 'smooth' && cornerH) {
    return {
      centerH: (c) => top[c],
      edgeH: (c, i) => {
        const ks = g.corners[c];
        const h = (cornerH[ks[i]] + cornerH[ks[(i + 1) % ks.length]]) / 2;
        return [h, h];
      },
      outlineH: (c, i) => Math.max(cornerH[g.corners[c][i]], SEA) + 0.0015,
    };
  }
  return {
    centerH: (c) => top[c],
    edgeH: (c, i) => [top[c], top[g.neighbors[c][i]]],
    outlineH: (c) => Math.max(top[c], SEA) + 0.002,
  };
}

interface SurfaceInput {
  world: World;
  /** Linear RGB per cell. */
  cellColor: Float32Array;
  relief: number;
  blend: boolean;
  flora: boolean;
  /** Biome view: shade snow, rock and sand per vertex from height, slope and latitude. */
  natural: boolean;
  tint: Noise3;
  rough: Noise3;
}

/** Per-vertex colour variation, so a biome is not one flat colour. */
function tinted(tint: Noise3, x: number, y: number, z: number, r: number, g: number, b: number, out: number[]) {
  const n1 = tint(x * 6, y * 6, z * 6);
  const n2 = tint(x * 19 + 3.1, y * 19, z * 19);
  const f = 0.9 + 0.1 * n1 + 0.04 * n2;
  out.push(r * f * (1 + 0.05 * n2), g * f, b * f * (1 - 0.07 * n2));
}

function cornerCellsOf(world: World): number[][] {
  const g = world.grid;
  const out: number[][] = Array.from({ length: g.cornerPos.length / 3 }, () => []);
  for (let c = 0; c < g.count; c++) for (const k of g.corners[c]) out[k].push(c);
  return out;
}

const spacingOf = (n: number) => Math.sqrt((4 * Math.PI) / n);

/** Sea floor drops away quickly past the shoreline, so shelves read as sea, not lagoon. */
const seaFloor = (e: number) => SEA - 0.0015 - Math.pow(Math.max(0, -e), 0.7) * 0.035;


/**
 * Groves and clearings: a slow noise scales tree density from near zero to almost double, so
 * forests come in stands with gaps instead of an even scatter.
 */
function clumpAt(noise: Noise3, x: number, y: number, z: number, spacing: number): number {
  const f = 0.45 / spacing;
  const n = 0.5 + 0.5 * noise(x * f + 17.3, y * f, z * f);
  return Math.max(0, Math.min(1.9, 1.9 * n * n + 0.05));
}

function placeTrees(
  world: World, c: number, m: number, rng: () => number, mul: number, spacing: number,
  sample: (a: number, b: number, cc: number) => [number, number, number] | null, out: TreeSpot[],
  clump = 1,
) {
  const spec = FLORA[world.biome[c]];
  if (!spec) return;
  for (const [kind, color, density, size = 1] of spec) {
    const expected = (density * mul * clump) / m;
    let n = Math.floor(expected) + (rng() < expected % 1 ? 1 : 0);
    while (n-- > 0) {
      let b = rng(), cc = rng();
      if (b + cc > 1) { b = 1 - b; cc = 1 - cc; }
      const p = sample(1 - b - cc, b, cc);
      if (!p) continue;
      // Sizes skew small: lots of young trees, a few big ones.
      const r = rng();
      out.push({ x: p[0], y: p[1], z: p[2], kind, color, s: spacing * size * (0.16 + 0.22 * r * r), spin: rng() * Math.PI * 2, shade: 0.8 + 0.32 * rng() });
    }
  }
}

/**
 * Keeps trees out of river channels. A river enters and leaves a cell through edges and bends
 * through the centre, so in a river cell: nothing in the fan triangles on those edges, and
 * nothing close to the centre (a = barycentric weight of the centre).
 */
function inRiver(w: World, c: number, i: number, a: number): boolean {
  const g = w.grid, nb = g.neighbors[c][i];
  const onEdge = (w.river[c] && w.downstream[c] === nb) || (w.river[nb] && w.downstream[nb] === c);
  if (onEdge) return true;
  return w.river[c] > 0 && a > 0.55;
}

/** Temperature at a point, the same formula the generator uses per cell (minus its noise). */
function vertexTemp(y: number, e: number, heat: number): number {
  const lat = Math.abs(Math.asin(Math.max(-1, Math.min(1, y)))) / (Math.PI / 2);
  return 1 - 1.1 * Math.pow(lat, 1.25) - 0.55 * Math.max(0, e) + heat;
}

const SNOW = new THREE.Color(0xf2f5f8), ROCK = new THREE.Color(0x776b5f), SAND = new THREE.Color(0xd9c89b);

/**
 * Per-vertex detail the cell biomes are too coarse for: snow where it is cold enough at that
 * height (so snow lines follow the terrain, not cell edges), bare rock on steep slopes, and
 * sand in a thin strip at the waterline.
 */
function naturalShading(geo: THREE.BufferGeometry, relief: number, heat: number) {
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), col = geo.getAttribute('color');
  const mix = (i: number, c: THREE.Color, t: number) => {
    if (t <= 0) return;
    col.setXYZ(i, col.getX(i) + (c.r - col.getX(i)) * t, col.getY(i) + (c.g - col.getY(i)) * t, col.getZ(i) + (c.b - col.getZ(i)) * t);
  };
  const sm = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const l = Math.hypot(x, y, z), above = l - SEA;
    if (above <= 0) continue;
    const e = above / relief;
    const up = (nor.getX(i) * x + nor.getY(i) * y + nor.getZ(i) * z) / l;
    const slope = 1 - up;                         // 0 flat, ~0.3 steep
    mix(i, SAND, sm(0.0017, 0.0007, above) * sm(0.25, 0.4, vertexTemp(y / l, e, heat)));
    mix(i, ROCK, sm(0.025, 0.09, slope) * 0.75);
    // Snow settles on gentler slopes first.
    const tv = vertexTemp(y / l, e, heat);
    const snow = Math.max(sm(0.24, 0.12, tv), sm(0.6, 0.8, e) * sm(0.55, 0.4, tv));
    mix(i, SNOW, snow * (1 - 0.6 * sm(0.06, 0.16, slope)));
  }
  col.needsUpdate = true;
}

function treeBudget(world: World): number {
  let land = 0;
  for (let c = 0; c < world.grid.count; c++) if (world.water[c] === WATER_LAND) land++;
  return Math.min(1, 60000 / Math.max(1, land * 4));
}

// ---------------------------------------------------------------------------------------------

function buildSmooth(inp: SurfaceInput): Surface {
  const { world: w, cellColor, tint, rough } = inp;
  const g = w.grid, N = g.count, P = g.centers, C = g.cornerPos, K = C.length / 3;
  const relief = 0.05 * inp.relief;
  const spacing = spacingOf(N);
  const landH = (e: number) => SEA + 0.0012 + Math.pow(Math.max(0, e), 1.35) * relief;

  const cellH = new Float32Array(N);
  const level = new Float32Array(N).fill(-1);
  for (let c = 0; c < N; c++) {
    if (w.water[c] === WATER_OCEAN) {
      cellH[c] = w.biome[c] === B.SEA_ICE ? SEA + 0.0016 : seaFloor(w.elevation[c]);
      level[c] = SEA;
    } else if (w.water[c] === WATER_LAKE && w.biome[c] === B.ICE) {
      cellH[c] = landH(w.surface[c]);      // frozen lake: a flat ice sheet, no open water
    } else if (w.water[c] === WATER_LAKE) {
      cellH[c] = landH(w.elevation[c]) - 0.003;
    } else {
      cellH[c] = landH(w.elevation[c]);
    }
  }
  // Rivers carve valleys, deeper for bigger rivers. Corners average their cells, so carving the
  // river cells alone is enough to lower the edges between them too.
  for (let c = 0; c < N; c++) {
    if (!w.river[c]) continue;
    const carve = Math.min(0.3, 0.07 * Math.log2(1 + w.flow[c] / w.riverThreshold));
    cellH[c] = Math.max(SEA + 0.0009, cellH[c] - carve * relief);
  }
  const cornerCells = cornerCellsOf(w);
  const rimH = (k: number) => {
    let h = 0;
    for (const o of cornerCells[k]) h += cellH[o];
    return h / cornerCells[k].length;
  };
  // A lake's surface sits between its floor and its lowest rim corner, so the shore falls
  // inside the cell instead of tracing the hexagon.
  for (let c = 0; c < N; c++) {
    if (w.water[c] !== WATER_LAKE || w.biome[c] === B.ICE) continue;
    let lo = Infinity;
    for (const k of g.corners[c]) lo = Math.min(lo, rimH(k));
    level[c] = cellH[c] + 0.7 * Math.max(0.0005, lo - cellH[c]);
  }
  // Water drawn over a cell: its own, or a neighbour's (so dips along a coast fill in).
  const vLevel = new Float32Array(N).fill(-1);
  for (let c = 0; c < N; c++) {
    if (level[c] > 0) { vLevel[c] = level[c]; continue; }
    for (const nb of g.neighbors[c]) vLevel[c] = Math.max(vLevel[c], level[nb]);
  }

  // Which water is lake water: lake cells, and land cells whose drawn water comes from a lake.
  const vLake = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    if (w.water[c] === WATER_LAKE) { vLake[c] = level[c] > 0 ? 1 : 0; continue; }
    if (level[c] > 0) continue;
    for (const nb of g.neighbors[c]) if (w.water[nb] === WATER_LAKE && level[nb] > 0 && level[nb] === vLevel[c]) vLake[c] = 1;
  }
  const cornerLake = new Uint8Array(K);
  for (let kk = 0; kk < K; kk++) for (const o of cornerCells[kk]) if (vLake[o] && w.water[o] === WATER_LAKE) cornerLake[kk] = 1;
  const cornerH = new Float32Array(K), cornerLevel = new Float32Array(K), cornerCol = new Float32Array(K * 3);
  for (let k = 0; k < K; k++) {
    const cells = cornerCells[k];
    let h = 0, lvl = -1;
    for (const c of cells) { h += cellH[c]; lvl = Math.max(lvl, vLevel[c]); }
    h /= cells.length;
    cornerH[k] = h;
    cornerLevel[k] = lvl > 0 ? lvl : SEA;
    // Above water, colour from the land cells only, so beaches are not tinted by sea floor.
    const landOnly = h > SEA && cells.some((c) => w.water[c] === WATER_LAND);
    let r = 0, gg = 0, b = 0, n = 0;
    for (const c of cells) {
      if (landOnly && w.water[c] !== WATER_LAND) continue;
      r += cellColor[c * 3]; gg += cellColor[c * 3 + 1]; b += cellColor[c * 3 + 2]; n++;
    }
    cornerCol[k * 3] = r / n; cornerCol[k * 3 + 1] = gg / n; cornerCol[k * 3 + 2] = b / n;
  }

  const pos: number[] = [], col: number[] = [], wpos: number[] = [], depth: number[] = [];
  const rgb: number[] = [];
  const add = (dx: number, dy: number, dz: number, h: number, r: number, gg: number, b: number, lvl: number, lake = false) => {
    const i = pos.length / 3;
    pos.push(dx * h, dy * h, dz * h);
    rgb.length = 0;
    tinted(tint, dx, dy, dz, r, gg, b, rgb);
    col.push(rgb[0], rgb[1], rgb[2]);
    wpos.push(dx * lvl, dy * lvl, dz * lvl);
    // Lakes are shallow by sea standards (lowland ones barely below their rims); bias their
    // depth so they read as open water, not lagoon or surf.
    depth.push(lvl - h + (lake ? 0.006 : 0));
    return i;
  };
  // Each fan triangle (cell centre + two corners) becomes a k×k triangular grid. k is picked so
  // the planet stays near a fixed triangle budget: finer on small worlds, coarser on big ones.
  const k = Math.max(2, Math.min(6, Math.round(Math.sqrt(850000 / (N * 6)))));
  // Noise scales are tied to the vertex spacing: the finest octave spans about three vertices.
  // Finer than that, neighbouring vertices get unrelated heights and the surface turns to spikes.
  const freq = 0.5 / spacing;
  const ridgeBase = 0.45 / spacing;
  /** Ridged multi-octave noise, about 0..1: sharp crests where the noise crosses zero. */
  const ridged = (dx: number, dy: number, dz: number) => {
    let sum = 0, amp = 0.5, f = ridgeBase, norm = 0;
    for (let o = 0; o < 3; o++) {
      const n = 1 - Math.abs(rough(dx * f + 3.7 * o, dy * f, dz * f));
      sum += n * n * amp; norm += amp; amp *= 0.5; f *= 2;
    }
    return sum / norm;
  };
  /** Displacement for a point whose interpolated height is h: gentle in lowlands, craggy up high. */
  const bump = (dx: number, dy: number, dz: number, h: number) => {
    const n = rough(dx * freq, dy * freq, dz * freq);
    if (h <= SEA + 0.0005) return h + 0.0003 * n;
    const e = Math.min(1, (h - SEA) / Math.max(1e-6, relief));
    const gentle = (0.0004 + 0.0015 * e) * n;
    const crags = 0.006 * Math.pow(e, 1.5) * (ridged(dx, dy, dz) - 0.4);
    return h + (gentle + crags) * inp.relief;
  };

  const cornerIdx = new Int32Array(K).fill(-1);
  const corner = (kk: number) => {
    if (cornerIdx[kk] < 0) {
      cornerIdx[kk] = add(C[kk * 3], C[kk * 3 + 1], C[kk * 3 + 2], cornerH[kk],
        cornerCol[kk * 3], cornerCol[kk * 3 + 1], cornerCol[kk * 3 + 2], cornerLevel[kk], cornerLake[kk] === 1);
    }
    return cornerIdx[kk];
  };
  // Points along a shared edge are keyed by the edge and the step from its lower-numbered corner,
  // so the two cells on either side reuse the same vertices: no cracks.
  const edgePts = new Map<number, number>();
  const edgePoint = (k0: number, k1: number, j: number) => {
    const lo = Math.min(k0, k1), hi = Math.max(k0, k1), st = k0 < k1 ? j : k - j;
    const key = (lo * K + hi) * (k + 1) + st;
    let i = edgePts.get(key);
    if (i === undefined) {
      const t = st / k;
      let dx = C[lo * 3] * (1 - t) + C[hi * 3] * t, dy = C[lo * 3 + 1] * (1 - t) + C[hi * 3 + 1] * t, dz = C[lo * 3 + 2] * (1 - t) + C[hi * 3 + 2] * t;
      const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      i = add(dx, dy, dz, bump(dx, dy, dz, cornerH[lo] * (1 - t) + cornerH[hi] * t),
        cornerCol[lo * 3] * (1 - t) + cornerCol[hi * 3] * t, cornerCol[lo * 3 + 1] * (1 - t) + cornerCol[hi * 3 + 1] * t,
        cornerCol[lo * 3 + 2] * (1 - t) + cornerCol[hi * 3 + 2] * t, Math.max(cornerLevel[lo], cornerLevel[hi]),
        cornerLake[lo] === 1 || cornerLake[hi] === 1);
      edgePts.set(key, i);
    }
    return i;
  };

  const index: number[] = [], windex: number[] = [], faces: number[] = [];
  const trees: TreeSpot[] = [];
  const rng = makeRng(w.params.seed * 13 + 5);
  const mul = treeBudget(w);

  for (let c = 0; c < N; c++) {
    const ks = g.corners[c], m = ks.length;
    const r = cellColor[c * 3], gg = cellColor[c * 3 + 1], b = cellColor[c * 3 + 2];
    const lvl = vLevel[c] > 0 ? vLevel[c] : SEA;
    const px = P[c * 3], py = P[c * 3 + 1], pz = P[c * 3 + 2];
    const lake = vLake[c] === 1;
    const iA = add(px, py, pz, cellH[c], r, gg, b, lvl, lake);
    // Spokes: points from the centre toward each corner, shared by the two fan triangles there.
    const spoke: number[][] = Array.from(ks, (kk) => {
      const out: number[] = [];
      for (let st = 1; st < k; st++) {
        const t = st / k;
        let dx = px * (1 - t) + C[kk * 3] * t, dy = py * (1 - t) + C[kk * 3 + 1] * t, dz = pz * (1 - t) + C[kk * 3 + 2] * t;
        const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
        out[st] = add(dx, dy, dz, bump(dx, dy, dz, cellH[c] * (1 - t) + cornerH[kk] * t),
          r * (1 - t) + cornerCol[kk * 3] * t, gg * (1 - t) + cornerCol[kk * 3 + 1] * t, b * (1 - t) + cornerCol[kk * 3 + 2] * t, lvl, lake);
      }
      return out;
    });
    const hasWater = vLevel[c] > 0;
    for (let i = 0; i < m; i++) {
      const k0 = ks[i], k1 = ks[(i + 1) % m];
      // Local grid: idx[a][bb] is a steps toward corner k0 and bb steps toward corner k1.
      const idx: number[][] = [];
      for (let a = 0; a <= k; a++) {
        idx[a] = [];
        for (let bb = 0; a + bb <= k; bb++) {
          let v: number;
          if (a === 0 && bb === 0) v = iA;
          else if (bb === 0) v = a === k ? corner(k0) : spoke[i][a];
          else if (a === 0) v = bb === k ? corner(k1) : spoke[(i + 1) % m][bb];
          else if (a + bb === k) v = edgePoint(k0, k1, bb);
          else {
            const wa = 1 - (a + bb) / k, wb = a / k, wc = bb / k;
            let dx = wa * px + wb * C[k0 * 3] + wc * C[k1 * 3];
            let dy = wa * py + wb * C[k0 * 3 + 1] + wc * C[k1 * 3 + 1];
            let dz = wa * pz + wb * C[k0 * 3 + 2] + wc * C[k1 * 3 + 2];
            const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
            v = add(dx, dy, dz, bump(dx, dy, dz, wa * cellH[c] + wb * cornerH[k0] + wc * cornerH[k1]),
              wa * r + wb * cornerCol[k0 * 3] + wc * cornerCol[k1 * 3],
              wa * gg + wb * cornerCol[k0 * 3 + 1] + wc * cornerCol[k1 * 3 + 1],
              wa * b + wb * cornerCol[k0 * 3 + 2] + wc * cornerCol[k1 * 3 + 2], lvl, lake);
          }
          idx[a][bb] = v;
        }
      }
      for (let a = 0; a < k; a++) {
        for (let bb = 0; a + bb < k; bb++) {
          index.push(idx[a][bb], idx[a + 1][bb], idx[a][bb + 1]);
          faces.push(c);
          if (hasWater) windex.push(idx[a][bb], idx[a + 1][bb], idx[a][bb + 1]);
          if (a + bb < k - 1) {
            index.push(idx[a + 1][bb], idx[a + 1][bb + 1], idx[a][bb + 1]);
            faces.push(c);
            if (hasWater) windex.push(idx[a + 1][bb], idx[a + 1][bb + 1], idx[a][bb + 1]);
          }
        }
      }

      if (inp.flora && w.water[c] === WATER_LAND) {
        placeTrees(w, c, m, rng, mul, spacing, (wA, wB, wC) => {
          if (inRiver(w, c, i, wA)) return null;
          // Find the small grid triangle holding this point and interpolate its vertices.
          const u = wB * k, v = wC * k;
          const ia = Math.min(Math.floor(u), k - 1), ib = Math.min(Math.floor(v), k - 1 - ia);
          const fu = u - ia, fv = v - ib;
          let vs: number[], ws: number[];
          if (fu + fv > 1 && ia + ib < k - 1) { vs = [idx[ia + 1][ib + 1], idx[ia][ib + 1], idx[ia + 1][ib]]; ws = [fu + fv - 1, 1 - fu, 1 - fv]; }
          else { vs = [idx[ia][ib], idx[ia + 1][ib], idx[ia][ib + 1]]; ws = [1 - fu - fv, fu, fv]; }
          let x = 0, y = 0, z = 0;
          for (let j = 0; j < 3; j++) { x += pos[vs[j] * 3] * ws[j]; y += pos[vs[j] * 3 + 1] * ws[j]; z += pos[vs[j] * 3 + 2] * ws[j]; }
          return Math.hypot(x, y, z) < SEA + 0.0008 ? null : [x, y, z];
        }, trees, clumpAt(tint, C[k0 * 3], C[k0 * 3 + 1], C[k0 * 3 + 2], spacing));
      }
    }
  }

  const terrain = new THREE.BufferGeometry();
  terrain.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  terrain.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  terrain.setIndex(index);
  terrain.computeVertexNormals();
  if (inp.natural) {
    naturalShading(terrain, relief, w.params.heat);
    // No trees on snow.
    for (let i = trees.length - 1; i >= 0; i--) {
      const t = trees[i], l = Math.hypot(t.x, t.y, t.z);
      if (vertexTemp(t.y / l, (l - SEA) / relief, w.params.heat) < 0.2) trees.splice(i, 1);
    }
  }

  let water: THREE.BufferGeometry | null = null;
  if (windex.length) {
    water = new THREE.BufferGeometry();
    water.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
    water.setAttribute('depth', new THREE.Float32BufferAttribute(depth, 1));
    water.setIndex(windex);
  }

  return { terrain, faces: Int32Array.from(faces), water, trees, cellTop: cellH, cornerH };
}

// ---------------------------------------------------------------------------------------------

function buildTiles(inp: SurfaceInput): Surface {
  const { world: w, cellColor, tint } = inp;
  const g = w.grid, N = g.count, P = g.centers, C = g.cornerPos;
  const relief = 0.04 * inp.relief;
  const LAND = SEA + 0.0025;
  const spacing = spacingOf(N);

  const top = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    if (w.water[c] === WATER_OCEAN) top[c] = w.biome[c] === B.SEA_ICE ? SEA + 0.0018 : SEA + w.elevation[c] * 0.035;
    else if (w.water[c] === WATER_LAKE) top[c] = LAND + w.surface[c] * relief;
    else top[c] = LAND + w.elevation[c] * relief;
  }

  const cornerCells = cornerCellsOf(w);
  const wet = (c: number) => (w.water[c] !== WATER_LAND || w.biome[c] === B.SEA_ICE ? 1 : 0);

  const pos: number[] = [], col: number[] = [], faces: number[] = [];
  const wpos: number[] = [], wdepth: number[] = [];
  const trees: TreeSpot[] = [];
  const rng = makeRng(w.params.seed * 13 + 5);
  const mul = treeBudget(w);
  const rgb: number[] = [];
  const push = (x: number, y: number, z: number, h: number, r: number, gg: number, b: number, shade = 1) => {
    pos.push(x * h, y * h, z * h);
    rgb.length = 0;
    tinted(tint, x, y, z, r, gg, b, rgb);
    col.push(rgb[0] * shade, rgb[1] * shade, rgb[2] * shade);
  };
  const cornerDepth = (k: number) => {
    let d = 0, n = 0;
    for (const o of cornerCells[k]) {
      if (w.water[o] !== WATER_OCEAN) return 0; // touches land: depth 0, so foam lines the coast
      d += SEA - top[o]; n++;
    }
    return d / n;
  };

  for (let c = 0; c < N; c++) {
    const ks = g.corners[c], m = ks.length, h = top[c];
    const r = cellColor[c * 3], gg = cellColor[c * 3 + 1], b = cellColor[c * 3 + 2];
    const cc: number[] = [];
    for (const k of ks) {
      let sr = 0, sg = 0, sb = 0, n = 0;
      if (inp.blend) {
        for (const o of cornerCells[k]) {
          if (wet(o) !== wet(c)) continue;
          sr += cellColor[o * 3]; sg += cellColor[o * 3 + 1]; sb += cellColor[o * 3 + 2]; n++;
        }
      }
      if (n) cc.push((r + sr / n) / 2, (gg + sg / n) / 2, (b + sb / n) / 2);
      else cc.push(r, gg, b);
    }
    const px = P[c * 3], py = P[c * 3 + 1], pz = P[c * 3 + 2];
    for (let i = 0; i < m; i++) {
      const k0 = ks[i], k1 = ks[(i + 1) % m], i1 = (i + 1) % m;
      push(px, py, pz, h, r, gg, b);
      push(C[k0 * 3], C[k0 * 3 + 1], C[k0 * 3 + 2], h, cc[i * 3], cc[i * 3 + 1], cc[i * 3 + 2]);
      push(C[k1 * 3], C[k1 * 3 + 1], C[k1 * 3 + 2], h, cc[i1 * 3], cc[i1 * 3 + 1], cc[i1 * 3 + 2]);
      faces.push(c);

      if (w.water[c] === WATER_OCEAN) {
        wpos.push(px * SEA, py * SEA, pz * SEA, C[k0 * 3] * SEA, C[k0 * 3 + 1] * SEA, C[k0 * 3 + 2] * SEA,
          C[k1 * 3] * SEA, C[k1 * 3 + 1] * SEA, C[k1 * 3 + 2] * SEA);
        wdepth.push(SEA - h, cornerDepth(k0), cornerDepth(k1));
      }
      if (inp.flora && w.water[c] === WATER_LAND) {
        placeTrees(w, c, m, rng, mul, spacing, (a, bb, c2) => inRiver(w, c, i, a) ? null : [
          (a * px + bb * C[k0 * 3] + c2 * C[k1 * 3]) * h,
          (a * py + bb * C[k0 * 3 + 1] + c2 * C[k1 * 3 + 1]) * h,
          (a * pz + bb * C[k0 * 3 + 2] + c2 * C[k1 * 3 + 2]) * h,
        ], trees);
      }
    }
    // Cliff walls down to each lower neighbour, facing outward from c.
    for (let i = 0; i < m; i++) {
      const hn = top[g.neighbors[c][i]];
      if (hn >= h) continue;
      const k0 = ks[i], k1 = ks[(i + 1) % m];
      const ax = C[k0 * 3], ay = C[k0 * 3 + 1], az = C[k0 * 3 + 2];
      const bx = C[k1 * 3], by = C[k1 * 3 + 1], bz = C[k1 * 3 + 2];
      const s = 0.72;
      push(bx, by, bz, h, r, gg, b, s); push(ax, ay, az, h, r, gg, b, s); push(ax, ay, az, hn, r, gg, b, s);
      push(bx, by, bz, h, r, gg, b, s); push(ax, ay, az, hn, r, gg, b, s); push(bx, by, bz, hn, r, gg, b, s);
      faces.push(c, c);
    }
  }

  const terrain = new THREE.BufferGeometry();
  terrain.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  terrain.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  terrain.computeVertexNormals();

  let water: THREE.BufferGeometry | null = null;
  if (wpos.length) {
    water = new THREE.BufferGeometry();
    water.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
    water.setAttribute('depth', new THREE.Float32BufferAttribute(wdepth, 1));
  }

  return { terrain, faces: Int32Array.from(faces), water, trees, cellTop: top, cornerH: null };
}

