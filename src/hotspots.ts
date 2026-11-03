/**
 * Hotspot island chains, like Hawaii's (2026-11-03).
 *
 * The science. A hotspot is a plume of hot mantle rising from deep down (Wilson 1963, Morgan
 * 1971), roughly fixed while the plates slide over it. Where it reaches the surface it builds a
 * volcano; the plate carries the volcano away and the plume builds the next, so a hotspot leaves
 * a chain that ages in the direction the plate moves: the Hawaiian-Emperor chain runs ~6,000 km
 * and 80 million years from the Big Island, with a bend where the Pacific plate turned ~47 Myr
 * ago. Carried off the plume, a volcano cools, sinks and erodes: a high island, then low ones,
 * then in warm seas an atoll (coral keeps growing as the rock sinks: Darwin 1842, confirmed by
 * drilling at Enewetak in 1952), then a drowned flat-topped seamount; at the plate's edge the
 * chain goes down a trench (the Emperor chain into the Kuril-Aleutian). The plume also lifts a
 * broad swell of sea floor round itself, ~1,000 km across.
 *
 * The model. Mundi's plates already move as rigid rotations about their own poles (world.ts,
 * omega), so a chain is the hotspot's place turned back along its plate's rotation: the volcano
 * k steps old sits where the plate has carried it, rotated by k steps about the plate's pole. A
 * few hotspots go in the open ocean, far from land, which is where they are most often found
 * and where small islands are most wanted.
 */
import { makeRng, hash01 } from './rng.ts';
import type { Grid } from './grid.ts';

export interface HotspotInput {
  grid: Grid;
  elevation: Float32Array;   // land 0..1, sea -1..0
  water: Uint8Array;         // 0 land, 1 ocean
  plate: Int16Array;
  omega: Float32Array;       // per plate, rotation vector (axis x speed)
  seed: number;
}
export interface HotspotResult {
  /** Cells of the active volcanoes (one a hotspot), youngest first: for lava fields (render.ts). */
  active: number[];
  /** Drowned volcanoes near the surface in warm water: atolls (reef). */
  atolls: number[];
  /** Every volcano placed: centre cell, age step, peak height. For tests and the readout. */
  volcanoes: { cell: number; age: number; peak: number; chain: number }[];
}

const LAND = 0, OCEAN = 1;

/** Rotate v about unit axis a by angle t (Rodrigues). */
function rotate(v: number[], a: number[], t: number): number[] {
  const c = Math.cos(t), s = Math.sin(t), d = v[0] * a[0] + v[1] * a[1] + v[2] * a[2];
  const x = a[1] * v[2] - a[2] * v[1], y = a[2] * v[0] - a[0] * v[2], z = a[0] * v[1] - a[1] * v[0];
  return [v[0] * c + x * s + a[0] * d * (1 - c), v[1] * c + y * s + a[1] * d * (1 - c), v[2] * c + z * s + a[2] * d * (1 - c)];
}

export function addHotspots(w: HotspotInput): HotspotResult {
  const g = w.grid, N = g.count, P = g.centers, nb = g.neighbors, E = w.elevation;
  const spacing = Math.sqrt((4 * Math.PI) / N);
  const rng = makeRng(w.seed * 131 + 17);
  const out: HotspotResult = { active: [], atolls: [], volcanoes: [] };

  // Distance to land, in cells.
  const dist = new Int32Array(N).fill(-1), q: number[] = [];
  let ocean = 0;
  for (let c = 0; c < N; c++) { if (w.water[c] === LAND) { dist[c] = 0; q.push(c); } else ocean++; }
  for (let i = 0; i < q.length; i++) for (const n of nb[q[i]]) if (dist[n] < 0) { dist[n] = dist[q[i]] + 1; q.push(n); }

  // How many: about one per 9% of the planet in open ocean (Earth has a dozen or so well-known
  // intraplate ocean hotspots); none in a world with little sea.
  const count = Math.round((ocean / N) * 8 * (0.7 + 0.6 * rng())) - 1;
  if (count <= 0) return out;
  // Places: far from land (open ocean), weighted toward the remotest, apart from each other.
  const cand: number[] = [];
  for (let c = 0; c < N; c++) if (w.water[c] === OCEAN && dist[c] >= 6) cand.push(c);
  const chosen: number[] = [];
  const minCos = Math.cos(spacing * 18);
  for (let tries = 0; tries < 400 && chosen.length < count && cand.length; tries++) {
    const c = cand[Math.floor(rng() * cand.length)];
    if (rng() > Math.min(1, dist[c] / 14)) continue;   // remoter, likelier
    if (chosen.some((k) => P[k * 3] * P[c * 3] + P[k * 3 + 1] * P[c * 3 + 1] + P[k * 3 + 2] * P[c * 3 + 2] > minCos)) continue;
    chosen.push(c);
  }

  // The cell under a point: walk from a start cell to the nearest centre.
  const cellAt = (p: number[], start: number) => {
    let c = start;
    for (;;) {
      let best = c, bd = P[c * 3] * p[0] + P[c * 3 + 1] * p[1] + P[c * 3 + 2] * p[2];
      for (const n of nb[c]) { const d = P[n * 3] * p[0] + P[n * 3 + 1] * p[1] + P[n * 3 + 2] * p[2]; if (d > bd) { bd = d; best = n; } }
      if (best === c) return c;
      c = best;
    }
  };
  // A shield volcano: a broad, gentle cone, raising whatever is there toward its peak. Its
  // reach varies cell to cell (rough), so a small island isn't a cell and its six neighbours,
  // whose coast drew a six-pointed star (2026-11-03).
  // (Their own random stream, so the chains themselves are where they were before.)
  const shape = makeRng(w.seed * 131 + 29), salt = Math.floor(shape() * 1e6);
  const build = (p: number[], start: number, peak: number, radius: number, rough = 0) => {
    const centre = cellAt(p, start), r = radius * spacing, seen = new Set([centre]), ring = [centre];
    for (let i = 0; i < ring.length; i++) {
      const c = ring[i];
      const jitter = rough && c !== centre ? 1 + rough * (hash01(c * 7919 + salt) - 0.5) : 1;
      const d = jitter * Math.acos(Math.min(1, P[c * 3] * p[0] + P[c * 3 + 1] * p[1] + P[c * 3 + 2] * p[2])) / r;
      if (d >= 1) continue;
      const f = Math.pow(1 - d, 1.4);
      const target = E[c] + (peak - E[c]) * f;
      if (target > E[c]) E[c] = target;
      for (const n of nb[c]) if (!seen.has(n)) { seen.add(n); ring.push(n); }
    }
    return centre;
  };

  chosen.forEach((h0, chain) => {
    const p0 = [P[h0 * 3], P[h0 * 3 + 1], P[h0 * 3 + 2]];
    const pl = w.plate[h0];
    const ox = w.omega[pl * 3], oy = w.omega[pl * 3 + 1], oz = w.omega[pl * 3 + 2], om = Math.hypot(ox, oy, oz) || 1;
    let axis = [ox / om, oy / om, oz / om];
    // The swell: a broad rise of sea floor round the plume.
    {
      const seen = new Set([h0]), ring = [h0], R = 7 * spacing;
      for (let i = 0; i < ring.length; i++) {
        const c = ring[i], d = Math.acos(Math.min(1, P[c * 3] * p0[0] + P[c * 3 + 1] * p0[1] + P[c * 3 + 2] * p0[2]));
        if (d > R) continue;
        if (w.water[c] === OCEAN) E[c] = Math.min(-0.05, E[c] + 0.18 * Math.exp(-((d / (0.5 * R)) ** 2)));
        for (const n of nb[c]) if (!seen.has(n)) { seen.add(n); ring.push(n); }
      }
    }
    // Steps along the chain 2.3 cells apart, so the islands stand apart with sea between (at 1.6
    // the widened cones ran together into one long island).
    const sinT = Math.max(0.25, Math.sqrt(Math.max(0, 1 - (p0[0] * axis[0] + p0[1] * axis[1] + p0[2] * axis[2]) ** 2)));
    const step = (2.3 * spacing) / sinT;
    const peak0 = 0.42 + 0.22 * rng();          // the active island: high (Mauna Kea, Mauna Loa)
    const above = 4 + Math.floor(rng() * 3);    // volcanoes still above water
    const length = above + 5 + Math.floor(rng() * 6);
    const bendAt = rng() < 0.6 ? 3 + Math.floor(rng() * 5) : 99;   // a change of plate motion
    let p = p0, cell = h0;
    for (let k = 0; k < length; k++) {
      if (k > 0) {
        if (k === bendAt) {
          // Turn the older part of the chain: the plate moved round a different pole then.
          const t = rng() < 0.5 ? 0.5 : -0.5;
          axis = rotate(axis, p, t);
        }
        p = rotate(p, axis, step);
        const next = cellAt(p, cell);
        // The chain ends where its plate does (it went down a trench), or at a continent.
        if (w.plate[next] !== pl || (w.water[next] === LAND && E[next] > 0.02)) break;
        cell = next;
      }
      // Age: tall over the plume, then lower and smaller as it cools, sinks and erodes; past
      // `above` it is under water, shallow at first (an atoll in warm seas), then a deep seamount.
      const peak = k < above ? peak0 * Math.pow(1 - k / above, 1.3) + 0.02 : -0.04 - 0.06 * (k - above);
      // (A little wider than life, ~1.7 cells: at Hawaii's real size the islands were specks.)
      const radius = Math.max(1.1, 2.4 - 0.15 * k);
      const centre = build(p, cell, peak, radius, 0.6);
      // An island is several volcanoes grown together (the Big Island is five): one or two
      // lower cones beside the main one, off to random sides, so each island has its own shape.
      if (peak > 0) {
        const extra = 1 + Math.floor(shape() * 2);
        for (let e = 0; e < extra; e++) {
          // A direction in the tangent plane at p, and a step of 0.8-1.4 of the cone's radius.
          const ax = Math.abs(p[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
          const t1 = [p[1] * ax[2] - p[2] * ax[1], p[2] * ax[0] - p[0] * ax[2], p[0] * ax[1] - p[1] * ax[0]];
          const tl = Math.hypot(t1[0], t1[1], t1[2]);
          const dirAxis = rotate(t1.map((v) => v / tl), p, shape() * 2 * Math.PI);
          const q = rotate(p, dirAxis, (0.8 + 0.6 * shape()) * radius * spacing);
          build(q, centre, peak * (0.35 + 0.35 * shape()), radius * (0.55 + 0.25 * shape()), 0.6);
        }
      }
      out.volcanoes.push({ cell: centre, age: k, peak, chain });
      if (k === 0) out.active.push(centre);
      const lat = Math.abs(Math.asin(Math.max(-1, Math.min(1, p[1])))) * 57.2958;
      if (k >= above && peak > -0.12 && lat < 28) out.atolls.push(centre);
    }
  });
  // Raised above the sea: land now.
  for (let c = 0; c < N; c++) if (w.water[c] === OCEAN && E[c] >= 0) w.water[c] = LAND;
  return out;
}
