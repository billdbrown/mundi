import { buildGrid, type Grid } from './grid.ts';
import { makeRng } from './rng.ts';
import { makeSimplex, fbm } from './noise.ts';
import { B, landBiome } from './biomes.ts';

export interface WorldParams {
  seed: number;
  /** Grid subdivision frequency; cells = 10·detail² + 2. */
  detail: number;
  /** Fraction of cells below sea level, 0..1. */
  ocean: number;
  plates: number;
  /** How many separate clusters the continental plates are grouped into. */
  continents: number;
  /** Coastline noise strength, 0..1. Low = solid landmasses, high = archipelagos. */
  roughness: number;
  /** Climate offsets, about −0.3..0.3. */
  heat: number;
  wetness: number;
  /** River density multiplier. */
  rivers: number;
}

export const DEFAULT_PARAMS: WorldParams = {
  seed: 1, detail: 40, ocean: 0.68, plates: 12, continents: 3, roughness: 0.45, heat: 0, wetness: 0, rivers: 1,
};

export const WATER_LAND = 0, WATER_OCEAN = 1, WATER_LAKE = 2;

export interface World {
  params: WorldParams;
  grid: Grid;
  /** Sea level is 0. Land 0..1, ocean −1..0. */
  elevation: Float32Array;
  /** Water surface for lakes (their spill level); equal to elevation elsewhere. */
  surface: Float32Array;
  plate: Int16Array;
  temperature: Float32Array;
  moisture: Float32Array;
  water: Uint8Array;
  biome: Uint8Array;
  /** Cell each cell drains into, −1 for ocean. */
  downstream: Int32Array;
  flow: Float32Array;
  river: Uint8Array;
  /** Flow above which a cell carries a river. */
  riverThreshold: number;
}

const gridCache = new Map<number, Grid>();

export function generateWorld(params: WorldParams): World {
  const { seed, detail } = params;
  let grid = gridCache.get(detail);
  if (!grid) { grid = buildGrid(detail); gridCache.set(detail, grid); }
  const N = grid.count;
  const P = grid.centers;
  const nbrs = grid.neighbors;
  const rng = makeRng(seed);
  const noiseA = makeSimplex(seed * 7 + 1);
  const noiseB = makeSimplex(seed * 7 + 2);
  const noiseC = makeSimplex(seed * 7 + 3);

  // --- Plates: random seeds, grown by random flood fill so the borders come out ragged ---
  const plateCount = Math.max(2, Math.min(params.plates, 60));
  const plate = new Int16Array(N).fill(-1);
  const frontier: number[] = [];
  for (let p = 0; p < plateCount; p++) {
    let c: number;
    do c = Math.floor(rng() * N); while (plate[c] >= 0);
    plate[c] = p;
    frontier.push(c);
  }
  while (frontier.length) {
    const i = Math.floor(rng() * frontier.length);
    const c = frontier[i];
    frontier[i] = frontier[frontier.length - 1];
    frontier.pop();
    for (const nb of nbrs[c]) {
      if (plate[nb] < 0) { plate[nb] = plate[c]; frontier.push(nb); }
    }
  }

  const plateSize = new Int32Array(plateCount);
  for (let c = 0; c < N; c++) plateSize[plate[c]]++;

  // Continental plates, grouped: a few seed plates, then grow each cluster into neighbouring
  // plates until land covers roughly the requested share. Picking plates independently
  // scatters land everywhere; clustering is what makes continents.
  const plateAdj: Set<number>[] = Array.from({ length: plateCount }, () => new Set());
  for (let c = 0; c < N; c++) for (const nb of nbrs[c]) if (plate[nb] !== plate[c]) plateAdj[plate[c]].add(plate[nb]);
  const continental = new Uint8Array(plateCount);
  const target = (1 - params.ocean) * N * 1.05;
  let covered = 0;
  const clusters = Math.max(1, Math.min(Math.round(params.continents), plateCount));
  for (let k = 0; k < clusters && covered < target; k++) {
    let p: number;
    do p = Math.floor(rng() * plateCount); while (continental[p]);
    continental[p] = 1; covered += plateSize[p];
  }
  while (covered < target) {
    const candidates: number[] = [];
    for (let p = 0; p < plateCount; p++) {
      if (continental[p]) continue;
      for (const q of plateAdj[p]) if (continental[q]) { candidates.push(p); break; }
    }
    if (!candidates.length) break;
    const p = candidates[Math.floor(rng() * candidates.length)];
    continental[p] = 1; covered += plateSize[p];
  }
  const baseHeight = new Float32Array(plateCount);
  for (let p = 0; p < plateCount; p++) {
    baseHeight[p] = continental[p] ? 0.22 + rng() * 0.12 : -0.48 + rng() * 0.12;
  }

  // Each plate rotates about its own axis; velocity at p is ω × p.
  const omega = new Float32Array(plateCount * 3);
  for (let p = 0; p < plateCount; p++) {
    const z = rng() * 2 - 1, a = rng() * Math.PI * 2, r = Math.sqrt(1 - z * z);
    const speed = 0.4 + rng() * 0.8;
    omega[p * 3] = r * Math.cos(a) * speed;
    omega[p * 3 + 1] = r * Math.sin(a) * speed;
    omega[p * 3 + 2] = z * speed;
  }
  const vel = (p: number, c: number, out: number[]) => {
    const ox = omega[p * 3], oy = omega[p * 3 + 1], oz = omega[p * 3 + 2];
    const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
    out[0] = oy * z - oz * y; out[1] = oz * x - ox * z; out[2] = ox * y - oy * x;
  };

  // --- Base elevation, smoothed so continents get shelves instead of cliffs ---
  let elev = new Float32Array(N);
  for (let c = 0; c < N; c++) elev[c] = baseHeight[plate[c]];
  const smoothPasses = Math.max(1, Math.round(detail / 7));
  for (let s = 0; s < smoothPasses; s++) {
    const next = new Float32Array(N);
    for (let c = 0; c < N; c++) {
      let sum = elev[c];
      for (const nb of nbrs[c]) sum += elev[nb];
      next[c] = sum / (nbrs[c].length + 1);
    }
    elev = next;
  }

  // --- Plate boundaries: collisions raise mountains, separations open rifts and ridges ---
  const boundary = new Float32Array(N);
  const va = [0, 0, 0], vb = [0, 0, 0];
  const sources: number[] = [];
  for (let c = 0; c < N; c++) {
    let best = 0, isEdge = false;
    for (const nb of nbrs[c]) {
      if (plate[nb] === plate[c]) continue;
      isEdge = true;
      vel(plate[c], c, va);
      vel(plate[nb], c, vb);
      let dx = P[nb * 3] - P[c * 3], dy = P[nb * 3 + 1] - P[c * 3 + 1], dz = P[nb * 3 + 2] - P[c * 3 + 2];
      const dl = Math.hypot(dx, dy, dz); dx /= dl; dy /= dl; dz /= dl;
      const conv = Math.max(-1, Math.min(1,
        (va[0] - vb[0]) * dx + (va[1] - vb[1]) * dy + (va[2] - vb[2]) * dz));
      const ca = continental[plate[c]], cb = continental[plate[nb]];
      let e: number;
      if (conv > 0) {
        if (ca && cb) e = 0.85 * conv;        // continent hits continent: Himalaya
        else if (ca) e = 0.6 * conv;          // ocean dives under continent: Andes
        else if (cb) e = -0.25 * conv;        // the diving side: trench
        else e = 0.14 * conv;                 // ocean on ocean: island arc, mostly shoals
      } else {
        e = ca ? 0.18 * conv : -0.12 * conv;  // rift on land, ridge at sea
      }
      if (Math.abs(e) > Math.abs(best)) best = e;
    }
    if (isEdge) { boundary[c] = best; sources.push(c); }
  }

  // Spread each boundary's effect inland with a falloff (multi-source BFS).
  const dist = new Int32Array(N).fill(-1);
  const src = new Int32Array(N).fill(-1);
  for (const s of sources) { dist[s] = 0; src[s] = s; }
  for (let qi = 0; qi < sources.length; qi++) {
    const c = sources[qi];
    for (const nb of nbrs[c]) {
      if (dist[nb] < 0) { dist[nb] = dist[c] + 1; src[nb] = src[c]; sources.push(nb); }
    }
  }
  const width = Math.max(1.5, detail / 11);
  for (let c = 0; c < N; c++) {
    if (src[c] < 0) continue;
    const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
    const wobble = 1 + 0.5 * noiseC(x * 4, y * 4, z * 4);
    const d = dist[c] / (width * wobble);
    elev[c] += boundary[src[c]] * Math.exp(-d * d);
  }

  // --- Noise for coastlines and texture; ridged noise roughens the high ground ---
  for (let c = 0; c < N; c++) {
    const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
    elev[c] += 0.4 * params.roughness * fbm(noiseA, x, y, z, 5, 1.3);
    const ridge = 1 - Math.abs(fbm(noiseB, x, y, z, 4, 3));
    elev[c] += 0.12 * ridge * ridge * Math.max(0, elev[c]);
  }

  // --- Sea level at the requested ocean fraction, then normalise each side ---
  const sorted = Float32Array.from(elev).sort();
  const seaLevel = sorted[Math.min(N - 1, Math.floor(params.ocean * N))];
  const landTop = Math.max(1e-6, sorted[Math.floor(N * 0.997)] - seaLevel);
  const oceanBottom = Math.max(1e-6, seaLevel - sorted[0]);
  for (let c = 0; c < N; c++) {
    const e = elev[c] - seaLevel;
    elev[c] = e >= 0 ? Math.min(1, e / landTop) : Math.max(-1, e / oceanBottom);
  }

  const water = new Uint8Array(N);
  for (let c = 0; c < N; c++) water[c] = elev[c] < 0 ? WATER_OCEAN : WATER_LAND;

  // --- Cleanup: sink specks of land, and fill small seas cut off from the main ocean ---
  const comp = new Int32Array(N).fill(-1);
  const comps: number[][] = [];
  for (let c = 0; c < N; c++) {
    if (comp[c] >= 0) continue;
    const id = comps.length, members = [c], kind = water[c];
    comp[c] = id;
    for (let qi = 0; qi < members.length; qi++) {
      for (const nb of nbrs[members[qi]]) {
        if (comp[nb] < 0 && water[nb] === kind) { comp[nb] = id; members.push(nb); }
      }
    }
    comps.push(members);
  }
  let mainOcean = -1;
  for (let i = 0; i < comps.length; i++) {
    if (water[comps[i][0]] === WATER_OCEAN && (mainOcean < 0 || comps[i].length > comps[mainOcean].length)) mainOcean = i;
  }
  const minIsland = Math.max(2, N * 0.0005);
  const maxInlandSea = N * 0.004;
  for (let i = 0; i < comps.length; i++) {
    const m = comps[i];
    if (water[m[0]] === WATER_LAND && m.length < minIsland) {
      for (const c of m) { elev[c] = -0.03; water[c] = WATER_OCEAN; }
    } else if (water[m[0]] === WATER_OCEAN && i !== mainOcean && m.length < maxInlandSea) {
      for (const c of m) { elev[c] = 0.01; water[c] = WATER_LAND; }
    }
  }

  // --- Temperature: latitude, altitude, a little noise ---
  const lat = new Float32Array(N);
  const temperature = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
    lat[c] = Math.asin(Math.max(-1, Math.min(1, y)));
    // Steeper near the poles than a straight line, so ice caps start around 75°.
    let t = 1 - 1.1 * Math.pow(Math.abs(lat[c]) / (Math.PI / 2), 1.25);
    t -= Math.max(0, elev[c]) * 0.55;
    t += 0.08 * noiseC(x * 2.5 + 9, y * 2.5, z * 2.5) + params.heat;
    temperature[c] = Math.max(0, Math.min(1, t));
  }

  // --- Moisture: distance from the sea plus the wet/dry latitude bands of Earth's circulation ---
  const coastDist = new Int32Array(N).fill(-1);
  const queue: number[] = [];
  for (let c = 0; c < N; c++) if (water[c] === WATER_OCEAN) { coastDist[c] = 0; queue.push(c); }
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi];
    for (const nb of nbrs[c]) if (coastDist[nb] < 0) { coastDist[nb] = coastDist[c] + 1; queue.push(nb); }
  }
  const reach = Math.max(2, detail / 4.5);

  // Prevailing winds in Earth's three bands: trade winds blow toward the west below 30°,
  // westerlies toward the east from 30° to 60°, polar easterlies beyond. For each cell, the
  // neighbour most nearly upwind.
  const upwind = new Int32Array(N);
  for (let c = 0; c < N; c++) {
    const x = P[c * 3], z = P[c * 3 + 2];
    const deg = Math.abs(lat[c]) * 180 / Math.PI;
    const toward = deg < 30 || deg > 60 ? -1 : 1;      // +1 = blowing east
    const ux = -toward * z, uz = toward * x;           // upwind = −(wind); east is (z, 0, −x)
    let best = nbrs[c][0], bd = -Infinity;
    for (const nb of nbrs[c]) {
      const d = (P[nb * 3] - x) * ux + (P[nb * 3 + 2] - z) * uz;
      if (d > bd) { bd = d; best = nb; }
    }
    upwind[c] = best;
  }
  // Walk upwind: how soon do we reach the sea, and what is the highest ground in between?
  // Air that has crossed mountains has rained out (rain shadow); air rising up a slope rains
  // more (windward side).
  const walk = Math.max(3, Math.round(detail / 3));
  const moisture = new Float32Array(N);
  for (let c = 0; c < N; c++) {
    const x = P[c * 3], y = P[c * 3 + 1], z = P[c * 3 + 2];
    const coast = Math.exp(-Math.max(0, coastDist[c]) / reach);
    // Earth's zonal rainfall: the equatorial rain belt (ITCZ) is by far the wettest, the
    // subtropical highs near 25° the driest, the mid-latitude storm tracks near 50° wet again,
    // the poles dry.
    const deg = Math.abs(lat[c]) * 180 / Math.PI;
    const band = 1.25 * Math.exp(-((deg / 13) ** 2)) + 0.75 * Math.exp(-(((deg - 52) / 13) ** 2)) + 0.1;
    const n = 0.5 + 0.5 * fbm(noiseB, x + 5, y, z, 3, 2);
    let fromSea = 0, shadow = 0, windward = 0;
    if (water[c] !== WATER_OCEAN) {
      let cur = c, maxE = 0;
      for (let k = 1; k <= walk; k++) {
        cur = upwind[cur];
        if (water[cur] === WATER_OCEAN) { fromSea = Math.exp(-(k - 1) / (walk * 0.45)); break; }
        maxE = Math.max(maxE, elev[cur]);
      }
      shadow = Math.max(0, Math.min(1, (maxE - Math.max(0, elev[c])) * 1.6));
      windward = Math.max(0, Math.min(0.25, (elev[c] - Math.max(0, elev[upwind[c]])) * 4));
    }
    const m = 0.3 * coast + 0.35 * fromSea * (1 - shadow) + 0.25 * band + 0.25 * n
      - 0.08 - 0.25 * shadow + windward + params.wetness;
    moisture[c] = Math.max(0, Math.min(1, m));
  }

  // --- Ocean currents, roughly. Subtropical gyres send cold currents along the west coasts of
  // continents, which makes coastal deserts (Atacama, Namib). At mid-latitudes the westerlies
  // blow in off a warm ocean drift and keep west coasts mild (Western Europe). Both only touch
  // land with the sea close by to its west. ---
  const sstep = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const reachWest = Math.max(2, Math.round(detail / 8));
  for (let c = 0; c < N; c++) {
    if (water[c] === WATER_OCEAN) continue;
    const deg = Math.abs(lat[c]) * 180 / Math.PI;
    const cold = sstep(12, 18, deg) * (1 - sstep(32, 40, deg));
    const mild = sstep(38, 45, deg) * (1 - sstep(60, 66, deg));
    if (cold + mild === 0) continue;
    let cur = c, westSea = 0;
    for (let k = 1; k <= reachWest; k++) {
      const x = P[cur * 3], z = P[cur * 3 + 2];
      let best = nbrs[cur][0], bd = -Infinity;
      for (const nb of nbrs[cur]) {
        const d = (P[nb * 3] - x) * -z + (P[nb * 3 + 2] - z) * x;   // along west = (−z, 0, x)
        if (d > bd) { bd = d; best = nb; }
      }
      cur = best;
      if (water[cur] === WATER_OCEAN) { westSea = 1 - (k - 1) / reachWest; break; }
    }
    if (!westSea) continue;
    moisture[c] = Math.max(0, moisture[c] - 0.28 * cold * westSea);
    temperature[c] = Math.max(0, Math.min(1, temperature[c] - 0.05 * cold * westSea + 0.07 * mild * westSea));
  }

  // --- Monsoon east coasts. On the western flank of each subtropical high, warm moist air
  // flows onto the east coasts of continents in summer: the humid subtropics (south-east USA,
  // south China, eastern Australia, southern Brazil) instead of the deserts of the west sides. ---
  const reachEast = Math.max(2, Math.round(detail / 6));
  for (let c = 0; c < N; c++) {
    if (water[c] === WATER_OCEAN) continue;
    const deg = Math.abs(lat[c]) * 180 / Math.PI;
    const zone = sstep(16, 22, deg) * (1 - sstep(38, 45, deg));
    if (zone === 0) continue;
    let cur = c, eastSea = 0;
    for (let k = 1; k <= reachEast; k++) {
      const x = P[cur * 3], z = P[cur * 3 + 2];
      let best = nbrs[cur][0], bd = -Infinity;
      for (const nb of nbrs[cur]) {
        const d = (P[nb * 3] - x) * z + (P[nb * 3 + 2] - z) * -x;   // along east = (z, 0, −x)
        if (d > bd) { bd = d; best = nb; }
      }
      cur = best;
      if (water[cur] === WATER_OCEAN) { eastSea = 1 - (k - 1) / reachEast; break; }
    }
    moisture[c] = Math.min(1, moisture[c] + 0.3 * zone * eastSea);
  }

  // --- Smooth the moisture field over land. The upwind walk, rain shadow and windward terms
  // jump from cell to cell, and the biomes they produced were a cell-scale camouflage; Earth's
  // climate zones are broad and coherent (one Sahara, a clean Sahel, solid rainforest). ---
  {
    const tmp = new Float32Array(N);
    const passes = Math.max(2, Math.round(detail / 12));
    for (let it = 0; it < passes; it++) {
      for (let c = 0; c < N; c++) {
        if (water[c] === WATER_OCEAN) { tmp[c] = moisture[c]; continue; }
        let s = 0, n = 0;
        for (const nb of nbrs[c]) if (water[nb] !== WATER_OCEAN) { s += moisture[nb]; n++; }
        tmp[c] = n ? 0.4 * moisture[c] + 0.6 * (s / n) : moisture[c];
      }
      moisture.set(tmp);
    }
  }

  // --- Drainage: priority-flood from the sea gives every land cell a downhill route out.
  // Cells the flood has to raise noticeably are basins, and become lakes. ---
  const filled = Float32Array.from(elev);
  const downstream = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);
  const heap = new MinHeap(N);
  for (let c = 0; c < N; c++) if (water[c] === WATER_OCEAN) { heap.push(c, elev[c]); done[c] = 1; }
  const EPS = 1e-5;
  while (heap.size) {
    const c = heap.pop();
    for (const nb of nbrs[c]) {
      if (done[nb]) continue;
      done[nb] = 1;
      filled[nb] = Math.max(elev[nb], filled[c] + EPS);
      downstream[nb] = c;
      heap.push(nb, filled[nb]);
    }
  }
  const surface = Float32Array.from(elev);
  for (let c = 0; c < N; c++) {
    if (water[c] === WATER_LAND && filled[c] - elev[c] > 0.09) {
      water[c] = WATER_LAKE;
      surface[c] = filled[c];
    }
  }

  // Flow accumulation, uphill to downhill. Rain scales with moisture.
  const land: number[] = [];
  for (let c = 0; c < N; c++) if (water[c] !== WATER_OCEAN) land.push(c);
  land.sort((a, b) => filled[b] - filled[a]);
  const flow = new Float32Array(N);
  for (const c of land) {
    flow[c] += 0.15 + moisture[c];
    const d = downstream[c];
    if (d >= 0 && water[d] !== WATER_OCEAN) flow[d] += flow[c];
  }
  const river = new Uint8Array(N);
  const threshold = (N * 0.0011) / Math.max(0.05, params.rivers);
  for (const c of land) {
    if (water[c] === WATER_LAND && flow[c] > threshold && temperature[c] > 0.12) {
      river[c] = flow[c] > threshold * 5 ? 2 : 1;
    }
  }
  // Rivers wet their banks.
  for (const c of land) if (river[c]) moisture[c] = Math.min(1, moisture[c] + 0.12);

  // --- Biomes ---
  const biome = new Uint8Array(N);
  for (let c = 0; c < N; c++) {
    const e = elev[c], t = temperature[c];
    if (water[c] === WATER_OCEAN) {
      biome[c] = t < 0.12 ? B.SEA_ICE : e > -0.12 ? B.SHALLOWS : e > -0.45 ? B.OCEAN : B.DEEP;
    } else if (water[c] === WATER_LAKE) {
      biome[c] = t < 0.12 ? B.ICE : B.LAKE;
    } else {
      // (No whole-cell beaches: a cell is ~100 km across, and the sand strip at the waterline is
      // drawn per vertex. Beach cells made every coast a broad yellow band.)
      biome[c] = landBiome(t, moisture[c], e);
    }
  }

  return { params, grid, elevation: elev, surface, plate, temperature, moisture, water, biome, downstream, flow, river, riverThreshold: threshold };
}

class MinHeap {
  private ids: Int32Array;
  private keys: Float32Array;
  size = 0;
  constructor(capacity: number) {
    this.ids = new Int32Array(capacity);
    this.keys = new Float32Array(capacity);
  }
  push(id: number, key: number) {
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.ids[i] = this.ids[p]; this.keys[i] = this.keys[p];
      i = p;
    }
    this.ids[i] = id; this.keys[i] = key;
  }
  pop(): number {
    const top = this.ids[0];
    const id = this.ids[--this.size], key = this.keys[this.size];
    let i = 0;
    for (;;) {
      let m = 2 * i + 1;
      if (m >= this.size) break;
      if (m + 1 < this.size && this.keys[m + 1] < this.keys[m]) m++;
      if (this.keys[m] >= key) break;
      this.ids[i] = this.ids[m]; this.keys[i] = this.keys[m];
      i = m;
    }
    this.ids[i] = id; this.keys[i] = key;
    return top;
  }
}
