/**
 * Placeholder settlements for the hex view (2026-11-04): where Mundi's history (civ.ts) put a
 * town, a plain one is laid out so the styles can be judged with towns in them. Not the town
 * tool (paused): roads follow the history's road network, houses front the roads near the centre
 * and fill in round a small square, and a patchwork of fields with hedgerows rings the town.
 *
 * Works on the local map as hexlocal.ts builds it, through the context it is handed: writes
 * ground layers (paths, fields, hedges), flattens the ground under paths and houses, stops plants
 * growing where the town is, and returns the houses.
 */
import type { World } from './world.ts';
import { WATER_OCEAN } from './world.ts';
import type { History } from './civ.ts';
import { popAt, HISTORY_YEARS } from './civ.ts';
import type { Noise3 } from './noise.ts';

export interface TownContext {
  w: World;
  history: History;
  cellList: number[];
  indexOf: Map<number, number>;
  cellXY: Float32Array;
  res: number; size: number; step: number; half: number;
  heights: Float32Array;
  grow: Float32Array;
  riverNear: Float32Array;
  layers: Float32Array; LAYERS: number;
  L_PATH: number; L_FIELD: number; L_FIELDKIND: number; L_HEDGE: number;
  edgeMid: (a: number, b: number) => [number, number] | null;
  noise: Noise3;
  rng: () => number;
  /** Arable: not too cold, dry or high for crops, at a sample. */
  arable: (v: number) => boolean;
  sea: boolean;
}

/** Per house: x, y, h (ground), rotation, width, depth, wall height, colour (0..1). */
export const HOUSE_STRIDE = 8;

export interface Towns { houses: Float32Array; names: string[] }

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function layoutTowns(c: TownContext): Towns {
  const { w, history, cellList, indexOf, cellXY, res, step, half, heights, layers, LAYERS } = c;
  const N = res * res;
  const idxAt = (x: number, y: number) => {
    const i = Math.round((x + half) / step), j = Math.round((y + half) / step);
    return i < 0 || j < 0 || i >= res || j >= res ? -1 : j * res + i;
  };
  const hAt = (x: number, y: number) => {
    const fi = Math.max(0, Math.min(res - 1.001, (x + half) / step)), fj = Math.max(0, Math.min(res - 1.001, (y + half) / step));
    const i0 = Math.floor(fi), j0 = Math.floor(fj), tx = fi - i0, ty = fj - j0;
    const a = heights[j0 * res + i0], b = heights[j0 * res + i0 + 1], cc = heights[(j0 + 1) * res + i0], d = heights[(j0 + 1) * res + i0 + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (cc * (1 - tx) + d * tx) * ty;
  };
  const slopeAt = (x: number, y: number) => Math.hypot(hAt(x + 3, y) - hAt(x - 3, y), hAt(x, y + 3) - hAt(x, y - 3)) / 6;
  const wet = (x: number, y: number) => {
    const v = idxAt(x, y);
    return v < 0 || heights[v] < 0.4 || c.riverNear[v] < 1.6 || layers[v * LAYERS + 9] > 0;   // 9 = L_DEPTH
  };

  // Towns on the map's cells, as they stand at the end of the history.
  const towns = history.settlements
    .filter((s) => indexOf.has(s.cell) && popAt(s, HISTORY_YEARS) > 0 && w.water[s.cell] !== WATER_OCEAN)
    .map((s) => {
      const i = indexOf.get(s.cell)!, pop = popAt(s, HISTORY_YEARS);
      const n = Math.round(Math.max(8, Math.min(220, Math.sqrt(pop) * 2.2)));
      return { s, x: cellXY[i * 2], y: cellXY[i * 2 + 1], pop, n, r: 45 + 10 * Math.sqrt(n) };
    });

  // --- Roads: the history's road network, cell centre through the shared edge's middle to the next
  // centre (as rivers), wandering a little. Dirt paths, flattened.
  const roadSegs: number[] = [];       // x0 y0 x1 y1 width
  const seen = new Set<string>();
  for (const road of history.roads) {
    for (let k = 0; k + 1 < road.cells.length; k++) {
      const a = road.cells[k], b = road.cells[k + 1];
      if (!indexOf.has(a) || !indexOf.has(b)) continue;
      const key = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const mid = c.edgeMid(a, b);
      if (!mid) continue;
      const ia = indexOf.get(a)!, ib = indexOf.get(b)!;
      const ax = cellXY[ia * 2], ay = cellXY[ia * 2 + 1], bx = cellXY[ib * 2], by = cellXY[ib * 2 + 1];
      const qx = 2 * mid[0] - (ax + bx) / 2, qy = 2 * mid[1] - (ay + by) / 2;
      const len = Math.hypot(bx - ax, by - ay), n = Math.max(8, Math.ceil(len / 12));
      let px = ax, py = ay;
      for (let s = 1; s <= n; s++) {
        const t = s / n, u = 1 - t;
        let x = u * u * ax + 2 * u * t * qx + t * t * bx, y = u * u * ay + 2 * u * t * qy + t * t * by;
        const pin = Math.sin(t * Math.PI * 2) ** 2, m = 18 * pin * c.noise(x / 90, y / 90, 201 + (a % 37));
        const tx = bx - ax, ty = by - ay, tl = Math.hypot(tx, ty) || 1;
        x += (-ty / tl) * m; y += (tx / tl) * m;
        roadSegs.push(px, py, x, y, 7);
        px = x; py = y;
      }
    }
  }
  // Streets in towns with no road: a short cross through the centre.
  for (const t of towns) {
    const ang = c.rng() * Math.PI;
    for (const a of [ang, ang + Math.PI / 2]) {
      const dx = Math.cos(a) * t.r * 0.9, dy = Math.sin(a) * t.r * 0.9;
      roadSegs.push(t.x - dx, t.y - dy, t.x + dx, t.y + dy, 5);
    }
  }
  // Paint and flatten paths, and keep plants off them.
  const pathNear = new Float32Array(N).fill(Infinity);
  for (let k = 0; k < roadSegs.length; k += 5) {
    const x0 = roadSegs[k], y0 = roadSegs[k + 1], x1 = roadSegs[k + 2], y1 = roadSegs[k + 3], wd = roadSegs[k + 4];
    const reach = wd * 2;
    const iA = Math.max(0, Math.floor((Math.min(x0, x1) - reach + half) / step)), iB = Math.min(res - 1, Math.ceil((Math.max(x0, x1) + reach + half) / step));
    const jA = Math.max(0, Math.floor((Math.min(y0, y1) - reach + half) / step)), jB = Math.min(res - 1, Math.ceil((Math.max(y0, y1) + reach + half) / step));
    const sx = x1 - x0, sy = y1 - y0, sl2 = sx * sx + sy * sy || 1;
    for (let j = jA; j <= jB; j++) for (let i = iA; i <= iB; i++) {
      const x = -half + i * step, y = -half + j * step, v = j * res + i;
      const t = Math.max(0, Math.min(1, ((x - x0) * sx + (y - y0) * sy) / sl2));
      const d = Math.hypot(x - x0 - sx * t, y - y0 - sy * t);
      if (d > reach) continue;
      pathNear[v] = Math.min(pathNear[v], d / (wd / 2));
    }
  }
  for (let v = 0; v < N; v++) {
    if (pathNear[v] === Infinity || layers[v * LAYERS + 9] > 0 || c.riverNear[v] < 1) continue;
    const p = smooth(1.4, 0.8, pathNear[v] + 0.25 * c.noise(v % res / 3, Math.floor(v / res) / 3, 205));
    layers[v * LAYERS + c.L_PATH] = Math.max(layers[v * LAYERS + c.L_PATH], p);
    if (pathNear[v] < 2) c.grow[v] = 0;
  }

  // --- Houses: first along the roads near each town, facing them; then filling in round a square.
  const houses: number[] = [];
  const taken: [number, number, number][] = [];
  const free = (x: number, y: number, r: number) => {
    for (const [hx, hy, hr] of taken) if ((x - hx) ** 2 + (y - hy) ** 2 < (r + hr) ** 2) return false;
    return true;
  };
  const clearOfRoad = (x: number, y: number, r: number) => {
    const v = idxAt(x, y);
    return v >= 0 && pathNear[v] * 2.5 > r * 0.9;
  };
  const place = (x: number, y: number, rot: number, big: number) => {
    const wd = 6 + 3 * c.rng() + big * 3, dp = 5 + 2 * c.rng() + big, wallH = 3 + 1.5 * c.rng() + big * 2.5;
    const r = Math.hypot(wd, dp) / 2 + 1;
    if (wet(x, y) || slopeAt(x, y) > 0.35 || !free(x, y, r) || !clearOfRoad(x, y, r)) return false;
    taken.push([x, y, r]);
    houses.push(x, y, hAt(x, y), rot, wd, dp, wallH, c.rng());
    return true;
  };
  for (const t of towns) {
    let placed = 0;
    taken.push([t.x, t.y, 9]);           // the square
    // Along the roads: walk each segment near the town, both sides, facing the road.
    for (let k = 0; k < roadSegs.length && placed < t.n * 0.6; k += 5) {
      const x0 = roadSegs[k], y0 = roadSegs[k + 1], x1 = roadSegs[k + 2], y1 = roadSegs[k + 3];
      const len = Math.hypot(x1 - x0, y1 - y0);
      if (len < 1) continue;
      const dx = (x1 - x0) / len, dy = (y1 - y0) / len, rot = Math.atan2(dy, dx);
      for (let s = 0; s < len; s += 15) {
        const cx = x0 + dx * s, cy = y0 + dy * s;
        const dist = Math.hypot(cx - t.x, cy - t.y);
        if (dist > t.r * 1.2 || c.rng() > 1.1 - dist / (t.r * 1.2)) continue;
        for (const side of [-1, 1]) {
          const off = 9 + 2 * c.rng();
          if (place(cx - dy * off * side, cy + dx * off * side, rot, dist < t.r * 0.35 ? 1 : 0)) placed++;
        }
      }
    }
    // Filling in: denser near the centre.
    for (let tries = 0; tries < t.n * 30 && placed < t.n; tries++) {
      const a = c.rng() * Math.PI * 2, rr = t.r * Math.sqrt(c.rng());
      const x = t.x + Math.cos(a) * rr, y = t.y + Math.sin(a) * rr;
      const rot = Math.atan2(y - t.y, x - t.x) + (c.rng() < 0.5 ? 0 : Math.PI / 2);
      if (place(x, y, rot, rr < t.r * 0.3 ? 1 : 0)) placed++;
    }
    // The square: a paved patch.
    for (let v = 0; v < N; v++) {
      const i = v % res, j = Math.floor(v / res), x = -half + i * step, y = -half + j * step;
      const d = Math.hypot(x - t.x, y - t.y);
      if (d < 12) { layers[v * LAYERS + c.L_PATH] = Math.max(layers[v * LAYERS + c.L_PATH], smooth(12, 9, d)); c.grow[v] = 0; }
    }
  }
  // No plants in the houses' yards; the ground under each house levelled to its centre.
  for (let k = 0; k < houses.length; k += HOUSE_STRIDE) {
    const x = houses[k], y = houses[k + 1], r = Math.hypot(houses[k + 4], houses[k + 5]) / 2 + 3;
    const i0 = Math.floor((x - r + half) / step), i1 = Math.ceil((x + r + half) / step);
    const j0 = Math.floor((y - r + half) / step), j1 = Math.ceil((y + r + half) / step);
    for (let j = Math.max(0, j0); j <= Math.min(res - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(res - 1, i1); i++) {
      const v = j * res + i, d = Math.hypot(-half + i * step - x, -half + j * step - y);
      if (d < r) { c.grow[v] = 0; heights[v] += (houses[k + 2] - heights[v]) * smooth(r, r * 0.5, d); }
    }
  }

  // --- Fields: parcels round each town (cells of scattered seed points), on flat, arable, dry
  // ground; each a crop, with a hedge along its edges. Fewer further out.
  const seeds: number[] = [];          // x y kind keep
  for (const t of towns) {
    const outer = t.r * 2.6 + 160, count = Math.round(outer * outer / 1800);
    for (let k = 0; k < count; k++) {
      const a = c.rng() * Math.PI * 2, rr = Math.sqrt(c.rng()) * outer;
      const x = t.x + Math.cos(a) * rr, y = t.y + Math.sin(a) * rr;
      const keep = rr > t.r * 0.85 && c.rng() < 1.35 - rr / outer ? 1 : 0;
      seeds.push(x, y, c.rng(), keep);
    }
  }
  if (seeds.length) {
    const S = seeds.length / 4;
    const cellSz = 60, gx = Math.ceil((half * 2) / cellSz) + 1;
    const grid = new Map<number, number[]>();
    for (let s = 0; s < S; s++) {
      const key = Math.floor((seeds[s * 4] + half) / cellSz) + gx * Math.floor((seeds[s * 4 + 1] + half) / cellSz);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(s);
    }
    for (let v = 0; v < N; v++) {
      const i = v % res, j = Math.floor(v / res), x = -half + i * step, y = -half + j * step;
      const ci = Math.floor((x + half) / cellSz), cj = Math.floor((y + half) / cellSz);
      let b1 = -1, d1 = Infinity, d2 = Infinity;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const list = grid.get(ci + di + gx * (cj + dj));
        if (!list) continue;
        for (const s of list) {
          const d = (seeds[s * 4] - x) ** 2 + (seeds[s * 4 + 1] - y) ** 2;
          if (d < d1) { d2 = d1; d1 = d; b1 = s; } else if (d < d2) d2 = d;
        }
      }
      if (b1 < 0 || !seeds[b1 * 4 + 3]) continue;
      if (Math.sqrt(d1) > 75) continue;
      if (layers[v * LAYERS + 9] > 0 || c.riverNear[v] < 2.5 || pathNear[v] < 1.3 || heights[v] < 0.5) continue;
      if (slopeAt(x, y) > 0.22 || !c.arable(v)) continue;
      const edge = Math.sqrt(d2) - Math.sqrt(d1);           // distance to the parcel's edge, x2
      layers[v * LAYERS + c.L_FIELD] = 1;
      layers[v * LAYERS + c.L_FIELDKIND] = seeds[b1 * 4 + 2];
      layers[v * LAYERS + c.L_HEDGE] = smooth(4, 1.5, edge);
      c.grow[v] = 0;
    }
  }
  return { houses: new Float32Array(houses), names: towns.map((t) => t.s.name) };
}
