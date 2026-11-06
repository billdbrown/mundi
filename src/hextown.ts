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
import { popAt, realmAt, HISTORY_YEARS } from './civ.ts';
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

/** Per house: x, y, h (ground), rotation, width, depth, wall height, colour (0..1), kind (0 a house,
 * 1..3 the landmark on a village's, town's or city's square), people (the realm + 1, 0 for none). */
export const HOUSE_STRIDE = 10;

/** The small things of town life (hexhouses.ts draws them from the pack's props, in this order):
 * per prop x, y, ground, heading, kind, size (the wider side, metres). */
export const PROP_STRIDE = 6;
export const PROPS = ['Well', 'MarketStand_1', 'MarketStand_2', 'Bench_1', 'Cart', 'Barrel', 'Crate', 'Bags', 'Hay', 'Logs', 'Fence'];
const [P_WELL, P_STALL, P_STALL2, P_BENCH, P_CART, P_BARREL, P_CRATE, P_BAGS, P_HAY, P_LOGS, P_FENCE] = PROPS.map((_, i) => i);
const PROP_SIZE = [2.4, 3.2, 3.2, 1.8, 2.6, 0.7, 0.9, 1.0, 1.6, 2.4, 2.4];
/** One fence panel's length, metres. */
const FENCE_M = 2.4;

export interface Towns { houses: Float32Array; props: Float32Array; names: string[] }

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
      return { s, x: cellXY[i * 2], y: cellXY[i * 2 + 1], pop, n, r: 45 + 10 * Math.sqrt(n), people: realmAt(s, HISTORY_YEARS) + 1 };
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
  // --- Streets (2026-11-06, Bill: "city centres, streets, small yards with veg gardens"): from a
  // square in the middle, a main street out along each way the roads leave the town (or two, for
  // a town no road reaches), wandering a little; in bigger places, lanes off the main streets.
  // Every street is a polyline, for the houses to front.
  interface Street { pts: [number, number][]; width: number; main: boolean; town: number }
  const streets: Street[] = [];
  const blocked = (x: number, y: number) => wet(x, y) || slopeAt(x, y) > 0.5 || idxAt(x, y) < 0;
  towns.forEach((t, ti) => {
    // The ways out: towards the next cell along each road through this one.
    const outs: number[] = [];
    for (const road of history.roads) {
      const k = road.cells.indexOf(t.s.cell);
      if (k < 0) continue;
      for (const nb of [road.cells[k - 1], road.cells[k + 1]]) {
        if (nb == null || !indexOf.has(nb)) continue;
        const j = indexOf.get(nb)!, a = Math.atan2(cellXY[j * 2 + 1] - t.y, cellXY[j * 2] - t.x);
        if (outs.every((o) => Math.abs(Math.atan2(Math.sin(a - o), Math.cos(a - o))) > 0.6)) outs.push(a);
      }
    }
    if (outs.length < 2) {
      const a0 = outs[0] ?? c.rng() * Math.PI * 2;
      if (!outs.length) outs.push(a0);
      outs.push(a0 + Math.PI + (c.rng() - 0.5) * 0.6);
      if (t.n > 70) outs.push(a0 + Math.PI / 2 + (c.rng() - 0.5) * 0.5);
    }
    const mainW = t.n > 120 ? 8 : 7;      // (as wide as the roads they carry on from)
    for (const a0 of outs) {
      const pts: [number, number][] = [];
      let a = a0, x = t.x + Math.cos(a) * 14, y = t.y + Math.sin(a) * 14;
      for (let d = 14; d < t.r * 1.25; d += 10) {
        if (blocked(x, y)) break;
        pts.push([x, y]);
        a += 0.35 * c.noise(x / 70, y / 70, 311 + ti) - 0.08 * Math.atan2(Math.sin(a - a0), Math.cos(a - a0));
        x += Math.cos(a) * 10; y += Math.sin(a) * 10;
      }
      if (pts.length < 2) continue;
      streets.push({ pts: [[t.x, t.y], ...pts], width: mainW, main: true, town: ti });
      // Lanes, both ways off the main street, in places big enough to need them.
      if (t.n < 30) continue;
      for (let k = 3; k < pts.length - 1; k += 4 + Math.floor(c.rng() * 2)) {
        for (const side of [-1, 1]) {
          if (c.rng() < 0.35) continue;
          const [px, py] = pts[k], [qx, qy] = pts[k + 1];
          let b = Math.atan2(qy - py, qx - px) + side * (Math.PI / 2 + (c.rng() - 0.5) * 0.4);
          const lane: [number, number][] = [[px, py]];
          let lx = px, ly = py;
          const len = t.r * (0.25 + 0.3 * c.rng());
          for (let d = 0; d < len; d += 8) {
            lx += Math.cos(b) * 8; ly += Math.sin(b) * 8;
            if (blocked(lx, ly)) break;
            lane.push([lx, ly]);
            b += 0.25 * c.noise(lx / 50, ly / 50, 377 + ti);
          }
          if (lane.length > 2) streets.push({ pts: lane, width: 3.6, main: false, town: ti });
        }
      }
    }
  });
  for (const st of streets) for (let k = 0; k + 1 < st.pts.length; k++) roadSegs.push(st.pts[k][0], st.pts[k][1], st.pts[k + 1][0], st.pts[k + 1][1], st.width);

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

  // --- What stands where: an occupancy grid (one sample a cell), so houses, yards and streets
  // don't overlap. A rectangle is centre, the unit axis along its width, width and depth.
  const occ = new Uint8Array(N);
  const rectCells = (cx: number, cy: number, ax: number, ay: number, w: number, d: number, pad: number, f: (v: number, u: number, s: number) => void) => {
    const R = Math.hypot(w, d) / 2 + pad;
    const iA = Math.max(0, Math.floor((cx - R + half) / step)), iB = Math.min(res - 1, Math.ceil((cx + R + half) / step));
    const jA = Math.max(0, Math.floor((cy - R + half) / step)), jB = Math.min(res - 1, Math.ceil((cy + R + half) / step));
    for (let j = jA; j <= jB; j++) for (let i = iA; i <= iB; i++) {
      const x = -half + i * step - cx, y = -half + j * step - cy;
      const u = x * ax + y * ay, s = -x * ay + y * ax;       // along the width, along the depth
      if (Math.abs(u) <= w / 2 + pad && Math.abs(s) <= d / 2 + pad) f(j * res + i, u, s);
    }
  };
  const rectFree = (cx: number, cy: number, ax: number, ay: number, w: number, d: number) => {
    let ok = true;
    rectCells(cx, cy, ax, ay, w, d, 0, (v) => { if (occ[v] || pathNear[v] < 0.9 || wet(-half + (v % res) * step, -half + Math.floor(v / res) * step)) ok = false; });
    return ok;
  };
  const claim = (cx: number, cy: number, ax: number, ay: number, w: number, d: number, what: number) => rectCells(cx, cy, ax, ay, w, d, 0, (v) => { occ[v] = what; });

  // --- Houses: along both sides of every street, facing it, shoulder to shoulder near the middle
  // and further apart out towards the fields; each with a yard behind, most with a vegetable
  // garden in rows and a hedge or a fence round it. Around the square, the bigger houses.
  const houses: number[] = [];
  const props: number[] = [];
  const gardens: { cx: number; cy: number; ax: number; ay: number; w: number; d: number; hedge: boolean; town: number }[] = [];
  /** A prop (hexhouses.ts PROPS): x, y, ground, heading, kind, size in metres. */
  const prop = (x: number, y: number, rot: number, kind: number, size: number) => {
    if (wet(x, y) || idxAt(x, y) < 0) return;
    props.push(x, y, hAt(x, y), rot, kind, size);
  };
  /** Facing a map direction (fx, fy): the heading that turns a model's front (+z) to it. */
  const facing = (fx: number, fy: number) => Math.atan2(fx, -fy);
  const counts = towns.map(() => 0);
  for (const t of towns) {
    // The square, and on it the place's landmark: a well, a hall, a great building, by its size.
    const tier = t.pop < 1500 ? 1 : t.pop < 5000 ? 2 : 3, lw = [8, 12, 16][tier - 1];
    claim(t.x, t.y, 1, 0, 26, 26, 2);
    if (!wet(t.x, t.y)) houses.push(t.x, t.y, hAt(t.x, t.y), c.rng() * Math.PI * 2, lw, lw, 6 + tier * 3, c.rng(), tier, t.people);
    // Life on the square: a well beside the hall, stalls in a market town, a cart, benches.
    const sa = c.rng() * Math.PI * 2;
    if (tier > 1) prop(t.x + Math.cos(sa) * 10, t.y + Math.sin(sa) * 10, c.rng() * 6.28, P_WELL, 2.4);
    const stalls = tier === 1 ? 0 : tier === 2 ? 3 : 6;
    for (let k = 0; k < stalls; k++) {
      const a = sa + 1 + (k / stalls) * 4.2, rr = 9 + c.rng() * 2;
      const x = t.x + Math.cos(a) * rr, y = t.y + Math.sin(a) * rr;
      prop(x, y, facing(t.x - x, t.y - y), k % 2 ? P_STALL2 : P_STALL, 3.2);
    }
    for (let k = 0; k < 2 + tier; k++) {
      const a = c.rng() * Math.PI * 2, rr = 7 + c.rng() * 4;
      const kinds = [P_BENCH, P_CART, P_BARREL, P_CRATE, P_BAGS];
      const kind = kinds[Math.floor(c.rng() * kinds.length)];
      prop(t.x + Math.cos(a) * rr, t.y + Math.sin(a) * rr, c.rng() * 6.28, kind, PROP_SIZE[kind]);
    }
  }
  for (const st of streets) {
    const t = towns[st.town], ti = st.town;
    // Walk the street at a steady pace, both sides.
    for (const side of [-1, 1]) {
      let k = 0, along = side < 0 ? 6 : 10 + c.rng() * 4;
      const segLen = (i: number) => Math.hypot(st.pts[i + 1][0] - st.pts[i][0], st.pts[i + 1][1] - st.pts[i][1]);
      let into = along;
      while (k + 1 < st.pts.length && counts[ti] < t.n) {
        const L = segLen(k);
        if (into > L) { into -= L; k++; continue; }
        const [x0, y0] = st.pts[k], [x1, y1] = st.pts[k + 1];
        const ux = (x1 - x0) / (L || 1), uy = (y1 - y0) / (L || 1);
        const px = x0 + ux * into, py = y0 + uy * into;
        const dist = Math.hypot(px - t.x, py - t.y), inner = dist < t.r * 0.4;
        if (dist > t.r * 1.15) break;
        // Fewer houses the further out; terraced in the middle of a town.
        const big = inner && t.n > 40 ? 1 : 0;
        const w = 6 + 3 * c.rng() + big * 2, d = 5 + 2.5 * c.rng() + big;
        const nx = -uy * side, ny = ux * side;                 // away from the street
        const back = st.width / 2 + 1.2 + c.rng() * 1.2 + d / 2;
        const hx = px + nx * back, hy = py + ny * back;
        const keep = c.rng() < 1.25 - dist / (t.r * 1.15);
        let placed = false;
        if (keep && slopeAt(hx, hy) < 0.45 && rectFree(hx, hy, ux, uy, w, d)) {
          claim(hx, hy, ux, uy, w, d, 1);
          houses.push(hx, hy, hAt(hx, hy), facing(-nx, -ny), w, d, 3 + 1.5 * c.rng() + big * 2.5, c.rng(), 0, t.people);
          counts[ti]++;
          placed = true;
          // The yard behind: a garden in most, smaller in the middle of a town.
          const gd = (inner && t.n > 80 ? 5 : 8) + c.rng() * (inner ? 5 : 10), gw = w + (inner ? 0 : c.rng() * 4);
          const gx = hx + nx * (d / 2 + 0.8 + gd / 2), gy = hy + ny * (d / 2 + 0.8 + gd / 2);
          if (rectFree(gx, gy, ux, uy, gw, gd)) {
            claim(gx, gy, ux, uy, gw, gd, 3);
            const garden = c.rng() < (inner ? 0.55 : 0.85);
            if (garden) gardens.push({ cx: gx, cy: gy, ax: ux, ay: uy, w: gw, d: gd, hedge: c.rng() < 0.5, town: ti });
            // Something by the back door: a woodpile, barrels, a cart, hay.
            const kinds = [P_LOGS, P_BARREL, P_CRATE, P_HAY, P_CART, P_BAGS];
            const kind = kinds[Math.floor(c.rng() * kinds.length)];
            const sx = (c.rng() - 0.5) * w * 0.7;
            prop(hx + nx * (d / 2 + 1.4) + ux * sx, hy + ny * (d / 2 + 1.4) + uy * sx, facing(ux, uy), kind, PROP_SIZE[kind]);
            // Fences round half the gardens without a hedge.
            if (garden && !gardens[gardens.length - 1].hedge && c.rng() < 0.7) {
              const g = gardens[gardens.length - 1];
              const edges: [number, number, number, number, number][] = [
                [g.cx + nx * g.d / 2, g.cy + ny * g.d / 2, ux, uy, g.w],          // far end
                [g.cx - ux * g.w / 2, g.cy - uy * g.w / 2, nx, ny, g.d],          // sides
                [g.cx + ux * g.w / 2, g.cy + uy * g.w / 2, nx, ny, g.d],
              ];
              for (const [ex, ey, dx, dy, len] of edges) {
                const n = Math.max(1, Math.round(len / FENCE_M));
                for (let f = 0; f < n; f++) {
                  const s = (f + 0.5) / n - 0.5;
                  prop(ex + dx * s * len, ey + dy * s * len, facing(-dy, dx), P_FENCE, len / n);
                }
              }
            }
          }
        }
        // On along the street: next door, or a gap.
        into += (placed ? w : 4) + (inner ? 0.6 + c.rng() * 1.2 : 3 + c.rng() * 9);
      }
    }
  }
  // Where the streets couldn't hold a town (hills, water), the rest of it round the square, facing
  // in, with yards behind as space allows.
  towns.forEach((t, ti) => {
    for (let tries = 0; tries < t.n * 25 && counts[ti] < t.n * 0.7; tries++) {
      const a = c.rng() * Math.PI * 2, rr = 18 + (t.r - 18) * Math.sqrt(c.rng());
      const hx = t.x + Math.cos(a) * rr, hy = t.y + Math.sin(a) * rr;
      const nx = Math.cos(a), ny = Math.sin(a), ux = -ny, uy = nx;
      const w = 6 + 3 * c.rng(), d = 5 + 2.5 * c.rng();
      if (slopeAt(hx, hy) > 0.45 || !rectFree(hx, hy, ux, uy, w, d)) continue;
      claim(hx, hy, ux, uy, w, d, 1);
      houses.push(hx, hy, hAt(hx, hy), facing(-nx, -ny), w, d, 3 + 1.5 * c.rng(), c.rng(), 0, t.people);
      counts[ti]++;
      const gd = 6 + c.rng() * 8, gx = hx + nx * (d / 2 + 0.8 + gd / 2), gy = hy + ny * (d / 2 + 0.8 + gd / 2);
      if (c.rng() < 0.7 && rectFree(gx, gy, ux, uy, w, gd)) { claim(gx, gy, ux, uy, w, gd, 3); gardens.push({ cx: gx, cy: gy, ax: ux, ay: uy, w, d: gd, hedge: c.rng() < 0.6, town: ti }); }
    }
  });
  // Gardens: rows of vegetables (a field the grass shader sows in rows), hedged or not.
  for (const g of gardens) {
    rectCells(g.cx, g.cy, g.ax, g.ay, g.w, g.d, 0, (v, u, s) => {
      if (layers[v * LAYERS + 9] > 0) return;
      const edge = Math.min(g.w / 2 - Math.abs(u), g.d / 2 - Math.abs(s));
      layers[v * LAYERS + c.L_FIELD] = 1;
      // (Kind: its colour, and the rows' heading. Greens.)
      layers[v * LAYERS + c.L_FIELDKIND] = 0.27 + 0.2 * ((g.cx * 0.13 + g.cy * 0.07) % 1 + 1) % 1;
      layers[v * LAYERS + c.L_HEDGE] = g.hedge ? smooth(2.5, 0.8, edge) : 0;
      c.grow[v] = 0;
    });
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
  // Inside a town the woods are cleared: a tree or two left in the yards, more towards the edge.
  for (const t of towns) {
    const R = t.r * 1.05;
    const iA = Math.max(0, Math.floor((t.x - R + half) / step)), iB = Math.min(res - 1, Math.ceil((t.x + R + half) / step));
    const jA = Math.max(0, Math.floor((t.y - R + half) / step)), jB = Math.min(res - 1, Math.ceil((t.y + R + half) / step));
    for (let j = jA; j <= jB; j++) for (let i = iA; i <= iB; i++) {
      const d = Math.hypot(-half + i * step - t.x, -half + j * step - t.y);
      if (d < R) c.grow[j * res + i] *= 0.08 + 0.92 * smooth(t.r * 0.55, R, d);
    }
  }
  // The squares: paved.
  for (const t of towns) {
    for (let v = 0; v < N; v++) {
      const i = v % res, j = Math.floor(v / res), x = -half + i * step, y = -half + j * step;
      const d = Math.hypot(x - t.x, y - t.y);
      if (d < 16) { layers[v * LAYERS + c.L_PATH] = Math.max(layers[v * LAYERS + c.L_PATH], smooth(16, 11, d)); c.grow[v] = 0; }
    }
  }
  // Props stand on the ground as levelled.
  for (let k = 0; k < props.length; k += PROP_STRIDE) props[k + 2] = hAt(props[k], props[k + 1]);

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
  return { houses: new Float32Array(houses), props: new Float32Array(props), names: towns.map((t) => t.s.name) };
}
