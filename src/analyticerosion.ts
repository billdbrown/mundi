/**
 * Analytical river erosion on a height grid, after Tzathas et al. 2024 ("Physically-based
 * analytical erosion for fast terrain generation") and the stream-power law behind it
 * (Braun & Willett 2013).
 *
 * Rivers cut down until their slope balances their discharge: at equilibrium the slope of the
 * land along the flow is S = k * A^-m, A the area draining through the point. So heights don't
 * need simulating: route the water once, accumulate drainage area, then integrate those slopes
 * up each flow path from where it leaves the grid (the sea, or the grid's edge). Ridges, with
 * little area, come out steep, so they keep their original height; valleys, with a lot, are
 * gentle, so they are cut down below it. The result here is the carving only: original height
 * minus the equilibrium height, where the latter is lower. No time steps, so a 512² grid takes
 * a fraction of a second.
 *
 * Water routing is by priority-flood (Barnes et al. 2014), which gives every cell a downhill
 * route out, through depressions if need be.
 */

export interface ErosionInput {
  /** Heights above sea level (<= 0 is sea), row-major n x n. */
  height: Float32Array;
  n: number;
  /** Grid spacing, in the same units as height. */
  spacing: number;
  /** A small deterministic roughness per cell, so channels start somewhere (world-anchored). */
  jitter?: Float32Array;
  /**
   * Slope of a one-cell catchment; larger keeps more of the uplands. Steep: cells with tiny
   * catchments are hillslopes, held up near their critical angle; gentler and it carved the
   * ridge next to a valley down to the valley floor.
   */
  k?: number;
  /** Area exponent: how much gentler big rivers run than small ones. */
  m?: number;
  /**
   * How far erosion has got (Tzathas et al.'s time, as a height): erosion travels up from the
   * outlets as a wave, and at a point it has reached once the equilibrium profile there rises
   * less than this above its outlet. Beyond, the land is as it was: valleys cut back into
   * uplands that keep their shape, rather than the whole range worn down to equilibrium.
   */
  reach?: number;
}

export interface ErosionOutput {
  /** How far the land was cut down (>= 0), same units as height. */
  carve: Float32Array;
  /** Drainage area, in cells. */
  area: Float32Array;
}

export function analyticErosion(o: ErosionInput): ErosionOutput {
  const { height: h0, n, spacing } = o;
  const k = o.k ?? 1.4, m = o.m ?? 0.45;
  const N = n * n;
  const h = new Float32Array(N);
  for (let i = 0; i < N; i++) h[i] = h0[i] + (o.jitter ? o.jitter[i] : 0);

  // Priority-flood from the sea and the grid's edge. order[] is the flood order (outlets first),
  // rcv[] the cell each drains to (-1 at outlets).
  const rcv = new Int32Array(N).fill(-1), order = new Int32Array(N), done = new Uint8Array(N);
  const heap = new Heap(N), fill = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const x = i % n, y = (i / n) | 0;
    if (h0[i] <= 0 || x === 0 || y === 0 || x === n - 1 || y === n - 1) { done[i] = 1; fill[i] = h[i]; heap.push(i, h[i]); }
  }
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const DIST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
  const rdist = new Float32Array(N);
  let count = 0;
  while (heap.size) {
    const c = heap.pop();
    order[count++] = c;
    const x = c % n, y = (c / n) | 0;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (done[j]) continue;
      done[j] = 1;
      fill[j] = Math.max(h[j], fill[c] + 1e-9);
      rcv[j] = c;
      rdist[j] = DIST[d] * spacing;
      heap.push(j, fill[j]);
    }
  }

  // Each cell drains to its steepest downhill neighbour on the filled surface, slopes weighted by
  // a fixed random factor (stochastic routing, as in Cordonnier et al. 2016): plain steepest
  // descent on an 8-neighbour grid runs water down smooth slopes in parallel diagonal lines.
  // Neighbours flooded earlier are lower, so the flood order stays a valid drainage order.
  for (let c = 0; c < N; c++) {
    if (rcv[c] < 0) continue;
    const x = c % n, y = (c / n) | 0;
    let best = rcv[c], bs = -1;
    for (let d = 0; d < 8; d++) {
      const nx = x + DX[d], ny = y + DY[d];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (fill[j] >= fill[c]) continue;
      const r = hash(c * 8 + d);
      const s = (fill[c] - fill[j]) / DIST[d] * (0.4 + 1.2 * r);
      if (s > bs) { bs = s; best = j; rdist[c] = DIST[d] * spacing; }
    }
    rcv[c] = best;
  }
  // Drainage area, from the tops of the trees down.
  const area = new Float32Array(N).fill(1);
  for (let i = count - 1; i >= 0; i--) { const c = order[i], r = rcv[c]; if (r >= 0) area[r] += area[c]; }

  // Equilibrium heights up from the outlets; carving where they fall below the original.
  const eq = new Float32Array(N), carve = new Float32Array(N), base = new Float32Array(N);
  const reach = o.reach ?? Infinity;
  for (let i = 0; i < count; i++) {
    const c = order[i], r = rcv[c];
    if (r < 0) { eq[c] = base[c] = h0[c]; continue; }
    base[c] = base[r];
    eq[c] = Math.min(eq[r] + k * Math.pow(area[c], -m) * rdist[c], Math.max(h0[c], eq[r]));
    // Erosion's front: full behind it, fading out over the last stretch before it.
    const rise = eq[c] - base[c];
    const front = rise >= reach ? 0 : rise <= 0.5 * reach ? 1 : (reach - rise) / (0.5 * reach);
    carve[c] = Math.max(0, h0[c] - eq[c]) * front;
  }
  // A light blur: grid steps show as sawteeth along every valley wall otherwise.
  const out = new Float32Array(N);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let s = 0, w = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(n - 1, Math.max(0, x + dx)), yy = Math.min(n - 1, Math.max(0, y + dy));
      const ww = dx === 0 && dy === 0 ? 4 : dx === 0 || dy === 0 ? 2 : 1;
      s += carve[yy * n + xx] * ww; w += ww;
    }
    // (Never deeper than the land is high: the blur spread carving into low coastal cells.)
    out[y * n + x] = Math.min(s / w, Math.max(0, h0[y * n + x]));
  }
  return { carve: out, area };
}

function hash(i: number): number {
  let h = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

class Heap {
  private ids: Int32Array;
  private keys: Float32Array;
  size = 0;
  constructor(capacity: number) { this.ids = new Int32Array(capacity); this.keys = new Float32Array(capacity); }
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
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= key) break;
      this.ids[i] = this.ids[c]; this.keys[i] = this.keys[c];
      i = c;
    }
    this.ids[i] = id; this.keys[i] = key;
    return top;
  }
}

/**
 * The same erosion over the whole planet: a cube-sphere grid, six faces of n x n cells, face f's
 * cell (x, y) at gnomonic coordinates u, v in -1..1 (point = normalize(axis_k * sign + u axis_i +
 * v axis_j), k = f >> 1, sign by f & 1, i = k + 1, j = k + 2). Water flows across face edges like
 * anywhere else (each face eroded alone, with its edge as an outlet, gave neighbouring faces
 * different valleys where they met). Distances are real ones on the sphere. Only the sea is an
 * outlet. Lean on memory: about 36 bytes a cell.
 */
export interface CubeErosionInput {
  /** Heights above sea level (<= 0 is sea), face-major, n x n per face. */
  height: Float32Array;
  n: number;
  /** A small roughness per cell, added before routing. */
  jitter?: Float32Array;
  k?: number;
  m?: number;
  /**
   * The cell size (radians) k and m were tuned at. Drainage area is counted in cells of that
   * size, whatever this grid's: k * A^-m in cells made a coarser grid carve far less (its cells
   * hold more area each, so the same valley had a smaller count and a steeper slope).
   */
  unit?: number;
}

/** Face f's axes: major k with sign, grid axes i, j. */
export function cubeFace(f: number) {
  const k = f >> 1;
  return { k, sign: f & 1 ? -1 : 1, i: (k + 1) % 3, j: (k + 2) % 3 };
}

export function cubeErosion(o: CubeErosionInput): ErosionOutput {
  const { height: h0, n } = o, k = o.k ?? 1.4, m = o.m ?? 0.45;
  const F = n * n, N = 6 * F;
  const faces = [0, 1, 2, 3, 4, 5].map(cubeFace);
  // Cell centres, computed on demand.
  const pos = (f: number, u: number, v: number, out: Float32Array) => {
    const a = faces[f], l = 1 / Math.sqrt(1 + u * u + v * v);
    out[a.k] = a.sign * l; out[a.i] = u * l; out[a.j] = v * l;
  };
  const toCell = (p: Float32Array): number => {
    const ax = Math.abs(p[0]), ay = Math.abs(p[1]), az = Math.abs(p[2]);
    const kk = ax >= ay && ax >= az ? 0 : ay >= az ? 1 : 2;
    const f = kk * 2 + (p[kk] < 0 ? 1 : 0), a = faces[f], M = a.sign * p[kk];
    const x = Math.min(n - 1, Math.max(0, Math.floor((p[a.i] / M * 0.5 + 0.5) * n)));
    const y = Math.min(n - 1, Math.max(0, Math.floor((p[a.j] / M * 0.5 + 0.5) * n)));
    return f * F + y * n + x;
  };
  const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const Q = new Float32Array(3), R = new Float32Array(3);
  /** Neighbour d of cell c (-1 if it folds back onto c), and the distance to it in dist[0]. */
  const dist = new Float32Array(1);
  const nb = (c: number, d: number): number => {
    const f = (c / F) | 0, r = c - f * F, x = r % n, y = (r / n) | 0;
    const nx = x + DX[d], ny = y + DY[d];
    pos(f, ((x + 0.5) / n) * 2 - 1, ((y + 0.5) / n) * 2 - 1, Q);
    pos(f, ((nx + 0.5) / n) * 2 - 1, ((ny + 0.5) / n) * 2 - 1, R);
    // Off the face: the grid carried on past its edge lands in the next face's cell.
    const j = nx >= 0 && ny >= 0 && nx < n && ny < n ? f * F + ny * n + nx : toCell(R);
    if (j === c) return -1;
    dist[0] = Math.hypot(Q[0] - R[0], Q[1] - R[1], Q[2] - R[2]);
    return j;
  };

  const h = new Float32Array(N);
  for (let i = 0; i < N; i++) h[i] = h0[i] + (o.jitter ? o.jitter[i] : 0);
  // Priority-flood from the sea. rcv: -2 not reached yet, -1 outlet, else the cell drained to.
  const rcv = new Int32Array(N).fill(-2), order = new Int32Array(N);
  const fill = new Float32Array(N), rdist = new Float32Array(N);
  const heap = new Heap(N);
  for (let i = 0; i < N; i++) if (h0[i] <= 0) { rcv[i] = -1; fill[i] = h[i]; heap.push(i, h[i]); }
  let count = 0;
  while (heap.size) {
    const c = heap.pop();
    order[count++] = c;
    for (let d = 0; d < 8; d++) {
      const j = nb(c, d);
      if (j < 0 || rcv[j] !== -2) continue;
      fill[j] = Math.max(h[j], fill[c] + 1e-9);
      rcv[j] = c;
      rdist[j] = dist[0];
      heap.push(j, fill[j]);
    }
  }
  // (A world with no sea: nothing reached. Leave it uncarved.)
  if (count < N) for (let i = 0; i < N; i++) if (rcv[i] === -2) { rcv[i] = -1; order[count++] = i; fill[i] = h[i]; }
  // Stochastic steepest descent on the filled surface (see analyticErosion).
  for (let c = 0; c < N; c++) {
    if (rcv[c] < 0) continue;
    let best = rcv[c], bs = -1, bd = rdist[c];
    for (let d = 0; d < 8; d++) {
      const j = nb(c, d);
      if (j < 0 || fill[j] >= fill[c]) continue;
      const s = (fill[c] - fill[j]) / dist[0] * (0.4 + 1.2 * hash(c * 8 + d));
      if (s > bs) { bs = s; best = j; bd = dist[0]; }
    }
    rcv[c] = best; rdist[c] = bd;
  }
  // Drainage area, in cells of size unit (each cell's own area on the sphere: gnomonic cells
  // shrink toward a face's edges).
  const area = new Float32Array(N), unit = o.unit ?? 2 / n, cell = (2 / n) * (2 / n) / (unit * unit);
  for (let f = 0; f < 6; f++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const u = ((x + 0.5) / n) * 2 - 1, v = ((y + 0.5) / n) * 2 - 1;
    area[f * F + y * n + x] = cell / Math.pow(1 + u * u + v * v, 1.5);
  }
  for (let i = count - 1; i >= 0; i--) { const c = order[i], r = rcv[c]; if (r >= 0) area[r] += area[c]; }
  // Equilibrium heights up from the outlets (into fill, no longer needed), carving into rdist
  // (each cell's own distance is used before it is overwritten).
  const eq = fill, carve = rdist;
  for (let i = 0; i < count; i++) {
    const c = order[i], r = rcv[c];
    if (r < 0) { eq[c] = h0[c]; carve[c] = 0; continue; }
    eq[c] = Math.min(eq[r] + k * Math.pow(area[c], -m) * rdist[c], Math.max(h0[c], eq[r]));
    carve[c] = Math.max(0, h0[c] - eq[c]);
  }
  // Light blur over the same neighbours, across face edges too (into h, no longer needed).
  const out = h;
  for (let c = 0; c < N; c++) {
    let s = 4 * carve[c], w = 4;
    for (let d = 0; d < 8; d++) {
      const j = nb(c, d);
      if (j < 0) continue;
      const ww = d < 4 ? 2 : 1;
      s += carve[j] * ww; w += ww;
    }
    out[c] = Math.min(s / w, Math.max(0, h0[c]));
  }
  return { carve: out, area };
}
