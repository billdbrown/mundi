/**
 * Cloud cover as raw RGBA pixels (equirectangular), computed in the worker and uploaded as a
 * DataTexture. Row 0 is the south pole: DataTextures put row 0 at v = 0, and SphereGeometry
 * puts v = 0 at the south pole.
 *
 * Earth's clouds come in types tied to climate, and the look from space depends on getting
 * them in the right places, so each type has its own pattern:
 *  - fronts: long, swirled streaks at mid-latitudes, plus cyclones with spiral arms
 *  - the equatorial band: clusters of thunderstorm cloud
 *  - stratocumulus: honeycomb sheets over cool subtropical ocean, heaviest off west coasts
 *  - fair-weather cumulus: popcorn over wet land; deserts stay clear
 *  - polar overcast
 *
 * The main texture's alpha is raw cover, not finished cloud: the deck shader adds slowly
 * drifting noise and thresholds it (see cloudCover in sky.ts). Encoded so 0.42 means clear
 * and 0.87 solid, which leaves fine patterns intact under the drift.
 */
import { makeSimplex, fbm } from './noise.ts';
import { makeRng } from './rng.ts';
import { WATER_LAND, WATER_OCEAN, type World } from './world.ts';

export const CLOUD_W = 1280, CLOUD_H = 640;

export interface CloudPixels { main: Uint8Array; cirrus: Uint8Array; width: number; height: number }

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const DEG = Math.PI / 180;

interface Storm { x: number; y: number; z: number; r: number; spin: number }

/**
 * Cyclones between 15° and 60°, counterclockwise in the north and clockwise in the south,
 * as on Earth. Mid-latitude ones are the big frontal lows; low-latitude ones are tighter.
 */
function makeStorms(seed: number): Storm[] {
  const rng = makeRng(seed * 31 + 11);
  const n = 3 + Math.floor(rng() * 3);
  const out: Storm[] = [];
  for (let i = 0; i < n; i++) {
    const north = rng() < 0.5;
    const latDeg = 15 + rng() * 45;
    const lat = latDeg * DEG * (north ? 1 : -1);
    const lon = rng() * Math.PI * 2;
    out.push({
      x: -Math.cos(lon) * Math.cos(lat), y: Math.sin(lat), z: Math.sin(lon) * Math.cos(lat),
      r: latDeg > 35 ? 0.22 + rng() * 0.14 : 0.12 + rng() * 0.06,
      spin: (north ? 1 : -1) * (2.5 + rng() * 2),
    });
  }
  return out;
}

/** Cellular noise: distance to the nearest and second-nearest jittered point (F1, F2). */
function worley(x: number, y: number, z: number, seed: number): [number, number] {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let f1 = 9, f2 = 9;
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const cx = xi + dx, cy = yi + dy, cz = zi + dz;
    let h = Math.imul(cx, 0x8da6b343) ^ Math.imul(cy, 0xd8163841) ^ Math.imul(cz, 0xcb1ab31f) ^ seed;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    const jx = ((h & 1023) / 1023), jy = (((h >>> 10) & 1023) / 1023), jz = (((h >>> 20) & 1023) / 1023);
    const ddx = cx + jx - x, ddy = cy + jy - y, ddz = cz + jz - z;
    const d = ddx * ddx + ddy * ddy + ddz * ddz;
    if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
  }
  return [Math.sqrt(f1), Math.sqrt(f2)];
}

/** Per-cell climate the clouds respond to, computed once from the world. */
function cellClimate(w: World) {
  const g = w.grid, N = g.count, P = g.centers;
  // How strongly each ocean cell sits off a west coast (land within a few cells to its east).
  const westCoast = new Float32Array(N);
  const reach = Math.max(3, Math.round(w.params.detail / 6));
  for (let c = 0; c < N; c++) {
    if (w.water[c] !== WATER_OCEAN) continue;
    let cur = c;
    for (let k = 1; k <= reach; k++) {
      const x = P[cur * 3], z = P[cur * 3 + 2];
      let best = g.neighbors[cur][0], bd = -Infinity;
      for (const nb of g.neighbors[cur]) {
        const d = (P[nb * 3] - x) * z + (P[nb * 3 + 2] - z) * -x;   // along east = (z, 0, −x)
        if (d > bd) { bd = d; best = nb; }
      }
      cur = best;
      if (w.water[cur] === WATER_LAND) { westCoast[c] = 1 - (k - 1) / reach; break; }
    }
  }
  return { westCoast };
}

export function cloudPixels(seed: number, world?: World): CloudPixels {
  const W = CLOUD_W, H = CLOUD_H;
  const n1 = makeSimplex(seed * 31 + 7), n2 = makeSimplex(seed * 31 + 8), n3 = makeSimplex(seed * 31 + 9);
  const n4 = makeSimplex(seed * 31 + 10);
  const storms = makeStorms(seed);
  const wseed = seed * 2654435761;
  const clim = world ? cellClimate(world) : null;
  const g = world?.grid;

  const main = new Uint8Array(W * H * 4), cirrus = new Uint8Array(W * H * 4);
  let cell = 0;
  for (let py = 0; py < H; py++) {
    const lat = -Math.PI / 2 + ((py + 0.5) / H) * Math.PI;
    const alat = Math.abs(lat) / DEG;
    for (let px = 0; px < W; px++) {
      // SphereGeometry: u = φ/2π, with x = −cos φ·sin θ and z = sin φ·sin θ.
      const phi = ((px + 0.5) / W) * Math.PI * 2;
      const x = -Math.cos(phi) * Math.cos(lat), y = Math.sin(lat), z = Math.sin(phi) * Math.cos(lat);

      // The world cell under this pixel: greedy walk from the previous pixel's cell.
      let ocean = true, temp = 1 - alat / 90, moist = 0.5, west = 0;
      if (world && g && clim) {
        const P = g.centers;
        for (;;) {
          let best = cell, bd = P[cell * 3] * x + P[cell * 3 + 1] * y + P[cell * 3 + 2] * z;
          for (const nb of g.neighbors[cell]) {
            const d = P[nb * 3] * x + P[nb * 3 + 1] * y + P[nb * 3 + 2] * z;
            if (d > bd) { bd = d; best = nb; }
          }
          if (best === cell) break;
          cell = best;
        }
        ocean = world.water[cell] !== WATER_LAND;
        temp = world.temperature[cell];
        moist = world.moisture[cell];
        west = clim.westCoast[cell];
      }

      // --- Fronts and cyclones (mid-latitudes, with a fringe toward the poles) ---
      let sx = x, sy = y, sz = z, swirl = 0;
      for (const s of storms) {
        const dot = sx * s.x + sy * s.y + sz * s.z;
        if (dot < 0.6) continue;
        const d = Math.acos(Math.min(1, dot)) / s.r;           // 0 at the eye, 1 at the edge
        const fall = Math.exp(-d * d * 2.2);
        const a = s.spin * fall;
        const c = Math.cos(a), sn = Math.sin(a), k = (1 - c) * dot;
        const cx = s.y * sz - s.z * sy, cy = s.z * sx - s.x * sz, cz = s.x * sy - s.y * sx;
        sx = sx * c + cx * sn + s.x * k; sy = sy * c + cy * sn + s.y * k; sz = sz * c + cz * sn + s.z * k;
        swirl += 0.5 * fall * smooth(0.1, 0.28, d) - 0.6 * (1 - smooth(0.0, 0.1, d));
      }
      // Warp stretched east–west, so fronts become long bands rather than blobs.
      const qx = fbm(n2, sx * 1.2, sy * 2.4, sz * 1.2, 3, 1.3), qy = fbm(n2, sx + 4.7, sy * 2, sz, 3, 1.3);
      const front = fbm(n1, sx + qx * 0.8, sy * 1.6 + qy * 0.8, sz + qx * 0.4, 7, 2.2);
      const midBand = smooth(25, 38, alat) * (1 - smooth(68, 80, alat));
      let frontsA = smooth(-0.02, 0.32, front + 0.06 + swirl) * (0.35 + 0.65 * midBand);
      frontsA = Math.max(frontsA, smooth(0, 0.3, swirl) * 0.9);

      // --- Equatorial thunderstorm clusters ---
      const itczOff = (lat / DEG - 4 * Math.sin(phi * 2)) / 9;
      const itczBand = Math.exp(-itczOff * itczOff);
      const clump = fbm(n4, x * 3, y * 3, z * 3, 3, 1.5);
      const towers = fbm(n4, x * 16 + 9, y * 16, z * 16, 3, 1.8);
      const itczA = itczBand * smooth(0.0, 0.25, clump + 0.1) * smooth(-0.15, 0.35, towers);

      // --- Stratocumulus: honeycomb cells over cool subtropical ocean ---
      let stratoA = 0;
      if (ocean && alat > 8 && alat < 42) {
        const zone = (smooth(8, 16, alat) * (1 - smooth(32, 42, alat))) * (0.25 + 0.75 * west);
        const patch = smooth(-0.2, 0.25, fbm(n3, x * 2.5 + 3, y * 2.5, z * 2.5, 3, 1.4) + 0.4 * west - 0.05);
        if (zone * patch > 0.01) {
          const s = 70;
          const [f1, f2] = worley(x * s, y * s, z * s, wseed);
          const [g1, g2] = worley(x * s * 2.3, y * s * 2.3, z * s * 2.3, wseed ^ 0x55);
          // Closed cells: bright centres, dark rims where neighbouring cells meet.
          const cellPat = smooth(0.05, 0.35, f2 - f1) * 0.75 + smooth(0.05, 0.3, g2 - g1) * 0.25;
          stratoA = zone * patch * cellPat;
        }
      }

      // --- Fair-weather cumulus over wet, warm land; deserts clear ---
      let cuA = 0;
      if (!ocean) {
        // Coarse enough to span several texels; finer turns into square blocks.
        const pop = fbm(n4, x * 32, y * 32, z * 32, 2, 1.0);
        cuA = smooth(0.35, 0.8, moist) * smooth(0.35, 0.6, temp) * smooth(0.02, 0.5, pop) * 0.7;
      }
      const dryClear = ocean ? 1 : 0.35 + 0.65 * smooth(0.15, 0.45, moist);

      // --- Polar overcast ---
      const polarA = smooth(62, 80, alat) * smooth(-0.3, 0.2, fbm(n3, x * 3, y * 3, z * 3, 4, 2)) * 0.8;

      // Fine edge detail everywhere: clouds are fractal, not soft blobs.
      const fine = fbm(n3, x * 40 + 7, y * 40, z * 40, 3, 1.0);
      let a = 1 - (1 - frontsA * dryClear) * (1 - itczA) * (1 - stratoA) * (1 - cuA) * (1 - polarA);
      a = Math.max(0, Math.min(1, a + fine * 0.18 * a * (1 - a) * 4));

      const i = (py * W + px) * 4;
      main[i] = main[i + 1] = main[i + 2] = 255;
      main[i + 3] = Math.round((0.42 + a * 0.45) * 255);

      // Cirrus: thin, east–west streaks, stronger at mid-latitudes.
      const v = fbm(n3, x * 1.2, y * 6, z * 1.2, 5, 1.8);
      const band = 0.4 + 0.6 * midBand;
      cirrus[i] = cirrus[i + 1] = cirrus[i + 2] = 255;
      cirrus[i + 3] = Math.round(smooth(0.18, 0.6, v * band) * 0.45 * 255);
    }
  }
  return { main, cirrus, width: W, height: H };
}

