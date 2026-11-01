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
import { FLORA, ICEBERG, packTrees, type TreeSpot, type TreeData } from './flora.ts';
import { cellColors, type ViewMode, type TerrainStyle } from './colors.ts';
import type { Grid } from './grid.ts';

export const SEA = 1.0;
/** Height of the highest land above sea level at relief ×1, in planet radii. */
export const RELIEF = 0.013;

interface Surface {
  terrain: THREE.BufferGeometry;
  faces: Int32Array;
  water: THREE.BufferGeometry | null;
  trees: TreeSpot[];
  /** Height of each cell's centre (smooth) or flat top (tiles). */
  cellTop: Float32Array;
  /** Height at each corner (smooth only). */
  cornerH: Float32Array | null;
  /** Grid lines along the drawn surface, as segment pairs (smooth only). */
  grid?: Float32Array;
}

/** Raw arrays for one mesh: what crosses from the worker to the page. */
export interface MeshData {
  position: Float32Array;
  normal?: Float32Array;
  color?: Float32Array;
  /** Terrain only: blended (moisture, temperature) per vertex, for the ground patterns. */
  climate?: Float32Array;
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
  /** Grid lines draped on the drawn surface (smooth only). */
  grid: Float32Array | null;
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
    position: a('position')!, normal: a('normal'), color: a('color'), climate: a('climate'), depth: a('depth'),
    index: geo.index ? Uint32Array.from(geo.index.array) : undefined,
  };
}

/** Builds the meshes for a world. Pure: runs in the worker. */
export function buildSurfaceData(world: World, o: BuildOptions): SurfaceData {
  const seed = world.params.seed;
  const input: SurfaceInput = {
    // Plants are placed near the camera by LodFlora; the worker only builds the ground.
    world, cellColor: cellColors(world, o.mode), relief: o.relief, blend: o.blend, flora: false,
    natural: o.mode === 'biome', tint: makeSimplex(seed * 5 + 11), rough: makeSimplex(seed * 5 + 12),
  };
  const s = o.style === 'smooth' ? buildSmooth(input) : buildTiles(input);
  return {
    style: o.style, terrain: meshData(s.terrain), faces: s.faces,
    water: s.water ? meshData(s.water) : null, trees: packTrees(s.trees),
    cellTop: s.cellTop, cornerH: s.cornerH, grid: s.grid ?? null,
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
  add(d.faces); add(d.cellTop); add(d.cornerH); add(d.grid);
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

/**
 * Natural land colour as a continuous function of moisture (columns) and temperature (rows),
 * read off true-colour satellite mosaics: salmon-tan hot desert, olive savanna, deep green
 * rainforest; grey-tan cold desert, steppe, grassland, temperate forest; dark taiga; brown
 * tundra. Interpolated, so climate zones shade into each other as on Earth instead of
 * switching colour at cell edges.
 */
const CLIMATE_M = [0.08, 0.24, 0.4, 0.56, 0.78];
const CLIMATE_T = [0.1, 0.3, 0.55, 0.82];
const CLIMATE_PALETTE = [
  [0x8a8068, 0x7c7a60, 0x6b6c4e, 0x5d6445, 0x545e42],   // tundra
  [0x8a8466, 0x6f7552, 0x4d5a38, 0x34442a, 0x2c3b26],   // boreal: moss and heath, not sand
  [0xc4a582, 0xab9e72, 0x7b8a49, 0x4a642c, 0x34542b],   // temperate
  [0xd99b6a, 0xbf9862, 0x8f8a4a, 0x52682b, 0x2a5222],   // tropical
].map((row) => row.map((hex) => new THREE.Color(hex)));
function climateColour(m: number, t: number, out: THREE.Color) {
  const idx = (v: number, xs: number[]) => {
    if (v <= xs[0]) return [0, 0];
    for (let i = 0; i < xs.length - 1; i++) if (v <= xs[i + 1]) return [i, (v - xs[i]) / (xs[i + 1] - xs[i])];
    return [xs.length - 2, 1];
  };
  const [mi, mf] = idx(m, CLIMATE_M), [ti, tf] = idx(t, CLIMATE_T);
  const P = CLIMATE_PALETTE;
  const r = (row: number) => {
    const a = P[row][mi], b = P[row][mi + 1];
    return [a.r + (b.r - a.r) * mf, a.g + (b.g - a.g) * mf, a.b + (b.b - a.b) * mf];
  };
  const lo = r(ti), hi = r(ti + 1);
  out.setRGB(lo[0] + (hi[0] - lo[0]) * tf, lo[1] + (hi[1] - lo[1]) * tf, lo[2] + (hi[2] - lo[2]) * tf);
}
/** Cells whose own colour stands rather than the climate palette: ice and bare high rock. */
const OWN_COLOUR = new Set<number>([B.ICE]);   // mountains take the climate's colour; rock is per pixel

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

const ALPINE = new THREE.Color(0x6e6858);
const LAKEBED = new THREE.Color(0x2c3a30);
const SEABED_SAND = new THREE.Color(0x8a8064), SEABED_DEEP = new THREE.Color(0x26323a);
const SNOW = new THREE.Color(0xf2f5f8), ROCK = new THREE.Color(0x776b5f), SAND = new THREE.Color(0xd9c89b);

/**
 * Per-vertex detail the cell biomes are too coarse for: snow where it is cold enough at that
 * height (so snow lines follow the terrain, not cell edges), bare rock on steep slopes, and
 * sand in a thin strip at the waterline.
 */
function naturalShading(geo: THREE.BufferGeometry, relief: number, heat: number, noise: Noise3, lakeSide: number[]) {
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
    // Beach sand at the sea's edge only (lowland lakes sit near sea level too).
    // Thin and partial: from orbit a full-strength strip outlined every continent in yellow.
    // (Low coastal cells sit only ~0.0012 above the sea, so a wider band painted whole cells.)
    if (!lakeSide[i]) mix(i, SAND, sm(0.0005, 0.0001, above) * sm(0.25, 0.4, vertexTemp(y / l, e, heat)) * 0.7);
    mix(i, ROCK, sm(0.04, 0.12, slope) * 0.6);
    // Altitude zones: vegetation thins to bare rock and alpine scrub above the tree line, so
    // mountains step through rock before snow instead of snow sitting on desert sand.
    const n = noise(x * 90, y * 90, z * 90) * 0.5 + noise(x * 260 + 4.1, y * 260, z * 260) * 0.25;
    // The tree line follows temperature, not height alone: high in the tropics, low near the
    // poles (Earth: ~3,800 m on the equator, ~2,000 m at 45°). Above it, alpine scrub.
    mix(i, ALPINE, sm(0.3, 0.18, vertexTemp(y / l, e, heat) + n * 0.05) * 0.7);
    // Snow settles on gentler slopes first.
    const tv = vertexTemp(y / l, e, heat);
    // Patchy edge: noise moves the snow line, so it breaks into streaks along ridges.
    const tvn = tv + n * 0.07;
    // Thresholds sit below the biome's ice line on purpose: the generator calls a whole high
    // plateau "cold", but only its crests should be white, with rock in the valleys between.
    const snow = Math.max(sm(0.08, -0.04, tvn), sm(1.0, 1.2, e + n * 0.1) * sm(0.5, 0.35, tvn));
    // Snow sheds off steep faces and lies in streaks along ridges, with rock showing between:
    // the striped look of high ranges from space, rather than a solid white cap.
    const streak = 1 - Math.abs(noise(x * 170 + 9.7, y * 170, z * 170));
    const lie = (1 - 0.85 * sm(0.035, 0.11, slope)) * (0.35 + 0.65 * sm(0.45, 0.85, streak + (snow - 0.5) * 0.4));
    // Snow itself is drawn per pixel in the terrain shader (sky.ts); here it only keeps the
    // alpine band from browning ground that will be white anyway.
    void SNOW; void lie;
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
  // Vertical exaggeration: peaks reach ~1.3% of the radius (~85 km on an Earth-sized planet,
  // ~10× Everest), low enough to stay under the cloud deck. Real scale would look smooth as a
  // marble; readable mountains come from ridges (below) more than from height.
  const relief = RELIEF * inp.relief;
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
      cellH[c] = landH(w.elevation[c]) - 0.005;
    } else {
      cellH[c] = landH(w.elevation[c]);
    }
  }
  // Rivers carve valleys, deeper for bigger rivers. Corners average their cells, so carving the
  // river cells alone is enough to lower the edges between them too.
  for (let c = 0; c < N; c++) {
    if (!w.river[c]) continue;
    const carve = Math.min(0.3, 0.07 * Math.log2(1 + w.flow[c] / w.riverThreshold));
    // Floors stay above the beach-sand band (SEA + 0.0017), or every river reads as a shoreline.
    cellH[c] = Math.max(Math.min(cellH[c], SEA + 0.0024), cellH[c] - carve * relief);
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
    // One level per lake: the generator's spill height (filled surface), shared by every cell of
    // the lake, so neighbouring cells don't hold water at different heights with land showing
    // between. At least a little above the bed.
    level[c] = Math.max(landH(w.surface[c]) - 0.0015, cellH[c] + 0.0015);
  }
  // Water drawn over a cell: its own, or a neighbour's (so dips along a coast fill in).
  const vLevel = new Float32Array(N).fill(-1);
  for (let c = 0; c < N; c++) {
    if (level[c] > 0) { vLevel[c] = level[c]; continue; }
    // River cells keep their own (dry) level: their carved valleys would otherwise fill with a
    // thin, foamy channel of the neighbouring sea or lake.
    if (w.river[c]) continue;
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
  /**
   * Colour at a point from the nearby cell centres, weighted by distance from a noise-warped
   * position. Interpolating centre-to-corner made every biome boundary trace hexagon edges;
   * this gives boundaries that wander like real ones. Only cells on the same side of the
   * waterline as the owner count, so coasts stay crisp.
   */
  let owner = 0;
  const wf = 1.1 / spacing, sigma2 = (0.42 * spacing) ** 2, warpAmp = 0.38 * spacing;
  // In natural colours a lake cell blends as land (its dry margins are shore, not water; the
  // bed under the water is darkened in add()). On the data maps lakes keep their own colour.
  const wetOf = (c: number) => (w.water[c] === WATER_OCEAN || w.biome[c] === B.SEA_ICE || (!inp.natural && w.water[c] !== WATER_LAND) ? 1 : 0);
  const colourAt = (dx: number, dy: number, dz: number, out: number[]) => {
    const qx = dx + warpAmp * (tint(dx * wf + 11.3, dy * wf, dz * wf) + 0.5 * tint(dx * wf * 2.3, dy * wf * 2.3 + 5.1, dz * wf * 2.3));
    const qy = dy + warpAmp * (tint(dx * wf, dy * wf + 23.7, dz * wf) + 0.5 * tint(dx * wf * 2.3 + 3.3, dy * wf * 2.3, dz * wf * 2.3));
    const qz = dz + warpAmp * (tint(dx * wf, dy * wf, dz * wf + 37.1) + 0.5 * tint(dx * wf * 2.3, dy * wf * 2.3, dz * wf * 2.3 + 8.9));
    const side = wetOf(owner);
    let sr = 0, sg = 0, sb = 0, sw = 0, sm = 0, st = 0, so = 0;
    const consider = (c: number) => {
      if (wetOf(c) !== side) return;
      const ex = P[c * 3] - qx, ey = P[c * 3 + 1] - qy, ez = P[c * 3 + 2] - qz;
      const wt = Math.exp(-(ex * ex + ey * ey + ez * ez) / sigma2);
      sr += cellColor[c * 3] * wt; sg += cellColor[c * 3 + 1] * wt; sb += cellColor[c * 3 + 2] * wt; sw += wt;
      sm += w.moisture[c] * wt; st += w.temperature[c] * wt;
      if (OWN_COLOUR.has(w.biome[c]) || w.water[c] === WATER_OCEAN) so += wt;
    };
    consider(owner);
    for (const n of g.neighbors[owner]) consider(n);
    if (sw < 1e-9) {
      out[0] = cellColor[owner * 3]; out[1] = cellColor[owner * 3 + 1]; out[2] = cellColor[owner * 3 + 2];
      out[3] = w.moisture[owner]; out[4] = w.temperature[owner];
      return;
    }
    out[0] = sr / sw; out[1] = sg / sw; out[2] = sb / sw; out[3] = sm / sw; out[4] = st / sw;
    // Natural colours: the climate palette, except where the cell's own colour stands.
    if (inp.natural && side === 0) {
      climateColour(out[3], out[4], climTmp);
      const k = 1 - so / sw;
      out[0] += (climTmp.r - out[0]) * k; out[1] += (climTmp.g - out[1]) * k; out[2] += (climTmp.b - out[2]) * k;
    }
  };
  const climTmp = new THREE.Color();
  const blendRGB = [0, 0, 0, 0, 0];
  const clim: number[] = [];
  const add = (dx: number, dy: number, dz: number, h: number, r: number, gg: number, b: number, lvl: number, lake = false) => {
    const i = pos.length / 3;
    // Lake shores: a wobble in the ground near the water line, so the shore wanders through
    // the cell instead of tracing hexagon edges. Position-only noise, so vertices shared by two
    // cells agree.
    if (lake && w.water[owner] !== WATER_OCEAN) {
      const near = h > lvl - 0.0006 ? Math.max(0, 1 - Math.abs(h - lvl) / 0.0016) : 0;
      h += near * 0.0011 * (tint(dx * lf + 3.3, dy * lf, dz * lf) + 0.45 * tint(dx * lf * 2.7, dy * lf * 2.7 + 8.1, dz * lf * 2.7));
    }
    pos.push(dx * h, dy * h, dz * h);
    lakeSide.push(lake ? 1 : 0);
    if (inp.blend) {
      colourAt(dx, dy, dz, blendRGB); r = blendRGB[0]; gg = blendRGB[1]; b = blendRGB[2];
      clim.push(blendRGB[3], blendRGB[4]);
    } else {
      clim.push(w.moisture[owner], w.temperature[owner]);
    }
    // Sea floor colour by depth, not by cell: sand in the shallowest water, dark mud beyond
    // (per-cell "shallows" colour drew a tan hexagon ring round every coast).
    if (inp.natural && w.water[owner] === WATER_OCEAN && w.biome[owner] !== B.SEA_ICE) {
      const k = Math.max(0, Math.min(1, (lvl - h - 0.0002) / 0.0015));
      r = SEABED_SAND.r + (SEABED_DEEP.r - SEABED_SAND.r) * k;
      gg = SEABED_SAND.g + (SEABED_DEEP.g - SEABED_SAND.g) * k;
      b = SEABED_SAND.b + (SEABED_DEEP.b - SEABED_SAND.b) * k;
    }
    // A lake bed is dark silt and weed, not lake-blue (it shows through the shallows).
    if (inp.natural && lake) {
      const k = Math.max(0, Math.min(1, (lvl - h) / 0.0012));
      r += (LAKEBED.r - r) * k; gg += (LAKEBED.g - gg) * k; b += (LAKEBED.b - b) * k;
    }
    rgb.length = 0;
    tinted(tint, dx, dy, dz, r, gg, b, rgb);
    col.push(rgb[0], rgb[1], rgb[2]);
    wpos.push(dx * lvl, dy * lvl, dz * lvl);
    // Lakes are shallow by sea standards (lowland ones barely below their rims); bias their
    // depth so they read as open water, not lagoon or surf.
    // (Only where there is water: added to dry ground too, it drew lake water over the shore out
    // to the cell edges, which is what made lakes hexagonal.)
    const dd = lvl - h;
    depth.push(lake && dd > 0 ? dd + 0.01 * Math.min(1, dd / 0.0007) : dd);
    return i;
  };
  const lakeSide: number[] = [];
  const lf = 2.2 / spacing;
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
  /**
   * Eroded-looking relief (after Inigo Quilez's derivative-damped fBm): each octave is damped
   * where the octaves below it are already steep, so slopes stay smooth and detail gathers on
   * crests and in valley floors. Combined with a ridged first octave, ranges read as branching
   * spurs and gullies rather than uniform bumps. About −0.5..0.6.
   */
  const H = 0.02;
  const eroded = (dx: number, dy: number, dz: number) => {
    let sum = 0, amp = 0.55, f = ridgeBase * 0.8, gx = 0, gy = 0, gz = 0;
    for (let o = 0; o < 5; o++) {
      const qx = dx * f + 7.1 * o, qy = dy * f, qz = dz * f;
      // The first octave is ridged (1 − |n|): long crest lines to hang the spurs from.
      const shape = (v: number) => (o === 0 ? 0.5 - Math.abs(v) : v);
      const n = shape(rough(qx, qy, qz));
      const nx = (shape(rough(qx + H, qy, qz)) - n) / H, ny = (shape(rough(qx, qy + H, qz)) - n) / H, nz = (shape(rough(qx, qy, qz + H)) - n) / H;
      gx += nx * amp; gy += ny * amp; gz += nz * amp;
      sum += (amp * n) / (1 + 0.6 * (gx * gx + gy * gy + gz * gz));
      amp *= 0.48; f *= 2.03;
    }
    return sum;
  };
  /**
   * Smooth height on high ground. Linear centre-to-corner interpolation makes every high cell a
   * hexagonal pyramid, and snow on the apexes then tiles the range in hexagons. Up high, height
   * instead comes from a noise-warped Gaussian blend of nearby land cells, like the colours.
   */
  const hSigma2 = (0.7 * spacing) ** 2, hWarp = 0.45 * spacing, hf = 0.9 / spacing;
  const smoothH = (dx: number, dy: number, dz: number, lin: number) => {
    const t = Math.max(0, Math.min(1, (lin - SEA - 0.12 * relief) / (0.25 * relief)));
    if (t <= 0 || w.water[owner] !== WATER_LAND) return lin;
    const qx = dx + hWarp * tint(dx * hf + 51.3, dy * hf, dz * hf);
    const qy = dy + hWarp * tint(dx * hf, dy * hf + 63.7, dz * hf);
    const qz = dz + hWarp * tint(dx * hf, dy * hf, dz * hf + 77.1);
    let sh = 0, sw = 0;
    const consider = (c: number) => {
      if (w.water[c] !== WATER_LAND) return;
      const ex = P[c * 3] - qx, ey = P[c * 3 + 1] - qy, ez = P[c * 3 + 2] - qz;
      const wt = Math.exp(-(ex * ex + ey * ey + ez * ez) / hSigma2);
      sh += cellH[c] * wt; sw += wt;
    };
    consider(owner);
    for (const nb of g.neighbors[owner]) consider(nb);
    if (sw < 1e-9) return lin;
    const hs = t * t * (3 - 2 * t);
    return lin + (sh / sw - lin) * hs;
  };
  /** Displacement for a point whose interpolated height is h: gentle in lowlands, craggy up high. */
  const bump = (dx: number, dy: number, dz: number, h0: number) => {
    const h = smoothH(dx, dy, dz, h0);
    const n = rough(dx * freq, dy * freq, dz * freq);
    if (h <= SEA + 0.0005) return h + 0.0003 * n;
    const e = Math.min(1, (h - SEA) / Math.max(1e-6, relief));
    const gentle = (0.0004 + 0.0015 * e) * n;
    // Ranges are ridges and valleys, not domes: only the crests reach the snow line, so snow
    // lies in streaks along them instead of capping the whole massif.
    // Valleys bottom out (the floor clamp) rather than sinking into round pits.
    const crags = e > 0.12
      ? 0.55 * relief * Math.pow(e, 1.1) * Math.max(-0.16, eroded(dx, dy, dz)) * Math.min(1, (e - 0.12) / 0.15)
      : 0;
    // Ice sheets bury their relief: smooth domes, the odd nunatak.
    if (w.biome[owner] === B.ICE) return h + gentle * inp.relief * 0.35 + crags * 0.2;
    return h + gentle * inp.relief + crags;
  };

  const cornerIdx = new Int32Array(K).fill(-1);
  const corner = (kk: number) => {
    if (cornerIdx[kk] < 0) {
      cornerIdx[kk] = add(C[kk * 3], C[kk * 3 + 1], C[kk * 3 + 2], smoothH(C[kk * 3], C[kk * 3 + 1], C[kk * 3 + 2], cornerH[kk]),
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
  const iceRng = makeRng(w.params.seed * 13 + 9);
  const mul = treeBudget(w);

  for (let c = 0; c < N; c++) {
    owner = c;
    const ks = g.corners[c], m = ks.length;
    const r = cellColor[c * 3], gg = cellColor[c * 3 + 1], b = cellColor[c * 3 + 2];
    const lvl = vLevel[c] > 0 ? vLevel[c] : SEA;
    const px = P[c * 3], py = P[c * 3 + 1], pz = P[c * 3 + 2];
    const lake = vLake[c] === 1;
    const iA = add(px, py, pz, smoothH(px, py, pz, cellH[c]), r, gg, b, lvl, lake);
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

      // Icebergs drift on cold open sea near the ice.
      if (inp.flora && w.water[c] === WATER_OCEAN && w.biome[c] !== B.SEA_ICE && w.temperature[c] < 0.2 && iceRng() < 0.25) {
        let wb = iceRng(), wc = iceRng();
        if (wb + wc > 1) { wb = 1 - wb; wc = 1 - wc; }
        const wa = 1 - wb - wc;
        const x = wa * px + wb * C[k0 * 3] + wc * C[k1 * 3], y = wa * py + wb * C[k0 * 3 + 1] + wc * C[k1 * 3 + 1], z = wa * pz + wb * C[k0 * 3 + 2] + wc * C[k1 * 3 + 2];
        const l = Math.hypot(x, y, z);
        const r2 = iceRng();
        trees.push({ x: (x / l) * SEA, y: (y / l) * SEA, z: (z / l) * SEA, kind: ICEBERG, color: 0xeef5fa, s: spacing * (0.12 + 0.25 * r2 * r2), spin: iceRng() * Math.PI * 2, shade: 0.92 + 0.08 * iceRng() });
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
  if (inp.natural) terrain.setAttribute('climate', new THREE.Float32BufferAttribute(clim, 2));
  terrain.setIndex(index);
  terrain.computeVertexNormals();
  if (inp.natural) {
    naturalShading(terrain, relief, w.params.heat, tint, lakeSide);
    // No trees on snow.
    for (let i = trees.length - 1; i >= 0; i--) {
      const t = trees[i], l = Math.hypot(t.x, t.y, t.z);
      if (t.kind !== ICEBERG && vertexTemp(t.y / l, (l - SEA) / relief, w.params.heat) < 0.2) trees.splice(i, 1);
    }
  }

  let water: THREE.BufferGeometry | null = null;
  if (windex.length) {
    water = new THREE.BufferGeometry();
    water.setAttribute('position', new THREE.Float32BufferAttribute(wpos, 3));
    water.setAttribute('depth', new THREE.Float32BufferAttribute(depth, 1));
    water.setIndex(windex);
  }

  // Grid lines through the mesh's own vertices along each cell edge (corner, edge points,
  // corner), so they lie exactly on the drawn ground; over water, at the water level.
  const gp = terrain.getAttribute('position');
  const gridOut: number[] = [];
  const pushV = (v: number, lvl: number) => {
    const x = gp.getX(v), y = gp.getY(v), z = gp.getZ(v), l = Math.hypot(x, y, z);
    const r = Math.max(l, lvl) + 0.00035;
    gridOut.push((x / l) * r, (y / l) * r, (z / l) * r);
  };
  for (let c = 0; c < N; c++) {
    const ks = g.corners[c], m = ks.length;
    for (let i = 0; i < m; i++) {
      const nb = g.neighbors[c][i];
      if (nb < c) continue;
      const k0 = ks[i], k1 = ks[(i + 1) % m];
      const lvl = Math.max(SEA, vLevel[c] > 0 && vLevel[nb] > 0 ? Math.min(vLevel[c], vLevel[nb]) : SEA);
      const chain = [corner(k0)];
      for (let j = 1; j < k; j++) chain.push(edgePoint(k0, k1, j));
      chain.push(corner(k1));
      for (let j = 0; j < chain.length - 1; j++) { pushV(chain[j], lvl); pushV(chain[j + 1], lvl); }
    }
  }

  return { terrain, faces: Int32Array.from(faces), water, trees, cellTop: cellH, cornerH, grid: Float32Array.from(gridOut) };
}

// ---------------------------------------------------------------------------------------------

function buildTiles(inp: SurfaceInput): Surface {
  const { world: w, cellColor, tint } = inp;
  const g = w.grid, N = g.count, P = g.centers, C = g.cornerPos;
  const relief = RELIEF * 0.85 * inp.relief;
  const LAND = SEA + 0.0025;
  const spacing = spacingOf(N);

  const top = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    if (w.water[c] === WATER_OCEAN) top[c] = w.biome[c] === B.SEA_ICE ? SEA + 0.0018 : seaFloor(w.elevation[c]);
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

