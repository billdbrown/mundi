/**
 * The planet's close-up relief on the CPU: the rolling hills, the gully octaves and the carved
 * valleys its ground patch raises near the camera (PATCH_BAKE_GLSL in dunes.ts, EROSION_GLSL in
 * erosion.ts, valleys.ts). The hex view adds the same relief to the planet's ground formula
 * (surface.ts planetGround), so its ridges and valleys are the ones the planet draws.
 *
 * A line-by-line port: the same constants, the same noise (snoise3 agrees with the shaders'
 * snoise to rounding), the same order of operations. Change one side, change the other.
 * Everything here is in planet radii, as in the shaders.
 */
import { snoise3 } from './snoise.ts';
import { RELIEF } from './surface.ts';

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// --- erosion.ts ---
const ERO_L0 = 0.005, ERO_OCT = 6, ERO_STEEP = 0.7, ERO_GAIN = 0.78, ERO_COUPLE = 1.0;

/** eroHash: integer hash of a lattice cell, 0..1 (uint arithmetic, as the shader's). */
function eroHash(cx: number, cy: number, cz: number): number {
  let h = (Math.imul(cx | 0, 1597334677) ^ Math.imul(cy | 0, 3812015801 | 0) ^ Math.imul(cz | 0, 2741598923 | 0)) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0; h = Math.imul(h, 0x7feb352d) >>> 0;
  h = (h ^ (h >>> 15)) >>> 0; h = Math.imul(h, 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h * (1 / 4294967296);
}

/** eroPhase: stripe phase at p (lattice units), stripes perpendicular to `across`. */
function eroPhase(px: number, py: number, pz: number, ax: number, ay: number, az: number): number {
  const F3 = 1 / 3, G3 = 1 / 6;
  const sk = (px + py + pz) * F3;
  const sx = Math.floor(px + sk), sy = Math.floor(py + sk), sz = Math.floor(pz + sk);
  const t = (sx + sy + sz) * G3;
  const x0 = px - sx + t, y0 = py - sy + t, z0 = pz - sz + t;
  // e = step(0, x0 - x0.yzx); i1 = e * (1 - e.zxy); i2 = 1 - e.zxy * (1 - e)
  const ex = x0 - y0 >= 0 ? 1 : 0, ey = y0 - z0 >= 0 ? 1 : 0, ez = z0 - x0 >= 0 ? 1 : 0;
  const i1x = ex * (1 - ez), i1y = ey * (1 - ex), i1z = ez * (1 - ey);
  const i2x = 1 - ez * (1 - ex), i2y = 1 - ex * (1 - ey), i2z = 1 - ey * (1 - ez);
  let Sx = 0, Sy = 0;
  const tap = (cx: number, cy: number, cz: number, x: number, y: number, z: number) => {
    let w = Math.max(0.6 - (x * x + y * y + z * z), 0);
    w *= w; w *= w;
    if (w === 0) return;
    const a = 6.2831853 * ((x * ax + y * ay + z * az) * 1.5 + eroHash(cx, cy, cz));
    Sx += w * Math.cos(a); Sy += w * Math.sin(a);
  };
  tap(sx, sy, sz, x0, y0, z0);
  tap(sx + i1x, sy + i1y, sz + i1z, x0 - i1x + G3, y0 - i1y + G3, z0 - i1z + G3);
  tap(sx + i2x, sy + i2y, sz + i2z, x0 - i2x + 2 * G3, y0 - i2y + 2 * G3, z0 - i2z + 2 * G3);
  tap(sx + 1, sy + 1, sz + 1, x0 - 0.5, y0 - 0.5, z0 - 0.5);
  return Math.atan2(Sy, Sx);
}

function eroHills(qx: number, qy: number, qz: number, px: number, py: number, pz: number): number {
  const n = snoise3(qx * 50, qy * 50, qz * 50);
  return Math.sqrt(n * n + 0.03) + 0.3 * snoise3(px * 25 + 3, py * 25 + 3, pz * 25 + 3);
}

/** hills(): x height (radians), and its uphill gradient (tangent), into out[0..3]. */
export function hills(px: number, py: number, pz: number, ux: number, uy: number, uz: number, hilly: number, out: number[]) {
  const region = smoothstep(-0.3, 0.4, snoise3(px * 9 + 41, py * 9 + 41, pz * 9 + 41) + 0.6 * hilly);
  const a = (0.15 + 0.85 * hilly) * region;
  out[0] = out[1] = out[2] = out[3] = 0;
  if (a <= 0) return;
  // t1 = normalize(cross(up, |up.y| < 0.99 ? (0,1,0) : (1,0,0))); t2 = cross(up, t1)
  let t1x: number, t1y: number, t1z: number;
  if (Math.abs(uy) < 0.99) { t1x = -uz; t1y = 0; t1z = ux; } else { t1x = 0; t1y = uz; t1z = -uy; }
  const tl = Math.hypot(t1x, t1y, t1z); t1x /= tl; t1y /= tl; t1z /= tl;
  const t2x = uy * t1z - uz * t1y, t2y = uz * t1x - ux * t1z, t2z = ux * t1y - uy * t1x;
  const E = 0.0006;
  const wx = 0.004 * snoise3(px * 60 + 11, py * 60 + 11, pz * 60 + 11);
  const wy = 0.004 * snoise3(px * 60 + 23, py * 60 + 23, pz * 60 + 23);
  const wz = 0.004 * snoise3(px * 60 + 37, py * 60 + 37, pz * 60 + 37);
  const h0 = eroHills(px + wx, py + wy, pz + wz, px, py, pz);
  const h1 = eroHills(px + t1x * E + wx, py + t1y * E + wy, pz + t1z * E + wz, px + t1x * E, py + t1y * E, pz + t1z * E);
  const h2 = eroHills(px + t2x * E + wx, py + t2y * E + wy, pz + t2z * E + wz, px + t2x * E, py + t2y * E, pz + t2z * E);
  const k = 0.00045 * a / E;
  out[0] = (h0 - 0.6) * 0.00045 * a;
  out[1] = (t1x * (h1 - h0) + t2x * (h2 - h0)) * k;
  out[2] = (t1y * (h1 - h0) + t2y * (h2 - h0)) * k;
  out[3] = (t1z * (h1 - h0) + t2z * (h2 - h0)) * k;
}

/** erosionSplit() with foot 0: the height of the octaves a grid of spacing sp carries (geoH);
 * their gradient (geo) goes in geo[0..2] if given. */
export function erosionGeoH(px: number, py: number, pz: number, ux: number, uy: number, uz: number, mx: number, my: number, mz: number, sp: number, geo?: number[]): number {
  let gx = 0, gy = 0, gz = 0, geoH = 0, lambda = ERO_L0, amp = 1, qx = 0, qy = 0, qz = 0;
  for (let i = 0; i < ERO_OCT; i++) {
    // across = normalize(cross(up, macro + g * COUPLE))
    const sx = mx + gx * ERO_COUPLE, sy = my + gy * ERO_COUPLE, sz = mz + gz * ERO_COUPLE;
    let ax = uy * sz - uz * sy, ay = uz * sx - ux * sz, az = ux * sy - uy * sx;
    const l = Math.hypot(ax, ay, az);
    if (l < 1e-6) break;
    ax /= l; ay /= l; az /= l;
    const s = 1 / (lambda * 1.5), o = i * 17.31;
    const phi = eroPhase(px * s + o, py * s + o, pz * s + o, ax, ay, az);
    const c = Math.cos(0.5 * phi);
    const prof = Math.sqrt(c * c + 0.02);
    const dprof = -0.25 * Math.sin(phi) / prof;
    const k = amp;
    const d = k * ERO_STEEP * dprof;
    gx += d * ax; gy += d * ay; gz += d * az;
    const gw = sp > 0 ? smoothstep(2.5 * sp, 4 * sp, lambda) : 0;
    geoH += gw * k * ERO_STEEP * lambda / 6.2831853 * (prof - 0.5);
    qx += gw * d * ax; qy += gw * d * ay; qz += gw * d * az;
    amp *= ERO_GAIN;
    lambda *= 0.5;
  }
  if (geo) { geo[0] = qx; geo[1] = qy; geo[2] = qz; }
  return geoH;
}

// --- valleys.ts ---

/**
 * The planet's carved valleys (valleys.ts): per texel of a six-face cube, radians, the carving
 * (the texture's r: snow counts it) and the cut the close-up patch makes (r less b, its local
 * average: groundCut), so the land keeps the plain terrain's height on average.
 */
export interface ValleyField { n: number; carve: Float32Array; cut: Float32Array }

/** Half floats (valleys.ts texture data) to floats. */
export function halfToFloat(h: Uint16Array): Float32Array {
  const out = new Float32Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const v = h[i], s = v & 0x8000 ? -1 : 1, e = (v >> 10) & 0x1f, f = v & 0x3ff;
    out[i] = e === 0 ? s * Math.pow(2, -14) * (f / 1024) : e === 31 ? 0 : s * Math.pow(2, e - 15) * (1 + f / 1024);
  }
  return out;
}

/** A valley field channel at direction (x, y, z), bilinear (the shader's texture filter). */
export function carveAt(v: ValleyField, x: number, y: number, z: number, c: Float32Array = v.carve): number {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z), n = v.n;
  let u: number, w: number, f: number;
  if (ax >= ay && ax >= az) { u = y / ax; w = z / ax; f = x < 0 ? 1 : 0; }
  else if (ay >= az) { u = z / ay; w = x / ay; f = y < 0 ? 3 : 2; }
  else { u = x / az; w = y / az; f = z < 0 ? 5 : 4; }
  const fx = Math.max(0, Math.min(n - 1.001, (u * 0.5 + 0.5) * n - 0.5));
  const fy = Math.max(0, Math.min(n - 1.001, (w * 0.5 + 0.5) * n - 0.5));
  const i = Math.floor(fx), j = Math.floor(fy), tx = fx - i, ty = fy - j, o = f * n * n;
  const a = c[o + j * n + i], b = c[o + j * n + i + 1], d = c[o + (j + 1) * n + i], e = c[o + (j + 1) * n + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
}

/** dunes.ts sandSea: where sand lies in seas rather than scattered. */
export const sandSea = (x: number, y: number, z: number) => smoothstep(-0.55, 0.05, snoise3(x * 40, y * 40, z * 40) + 0.25 * snoise3(x * 160, y * 160, z * 160));

// --- dunes.ts PATCH_BAKE_GLSL (the parts that are not dunes or river channels) ---
const MTN_CARVE = 0.8;
const UERO_R = 512 / 768;   // valleys.ts: uEroR = 512 / VALLEY_N
const CRAG_BAND = 0.00028, CRAG_INV = 1 / 0.0003, CRAG_AMP = 0.0001;
/** One texel of the patch's river mask (dunes.ts CAPTURE_SIZE over 2 PATCH_R), radians. */
const TEXEL = 0.1 / 512;
const fract = (v: number) => v - Math.floor(v);

/** cragCells: distance to the nearest wall of a 3D Voronoi pattern (about F2 - F1), and a random
 * 0..1 for the nearest cell, into out[0..1]. */
function cragCells(x: number, y: number, z: number, out: number[]) {
  const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
  let f1 = 9, f2 = 9, id = 0;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (let k = -1; k <= 1; k++) {
    const gx = cx + i, gy = cy + j, gz = cz + k;
    const ox = eroHash(gx + 1.3, gy + 1.3, gz + 1.3), oy = eroHash(gx + 71.9, gy + 71.9, gz + 71.9), oz = eroHash(gx + 143.7, gy + 143.7, gz + 143.7);
    const d = Math.hypot(gx + ox - x, gy + oy - y, gz + oz - z);
    if (d < f1) { f2 = f1; f1 = d; id = eroHash(gx + 211.1, gy + 211.1, gz + 211.1); } else if (d < f2) f2 = d;
  }
  out[0] = f2 - f1; out[1] = id;
}
const cc2 = [0, 0], geo3 = [0, 0, 0];
/** cragBlocks: each block stands a little proud or sunk, with a crack between them. */
export function cragBlocks(x: number, y: number, z: number): number {
  cragCells(x * CRAG_INV, y * CRAG_INV, z * CRAG_INV, cc2);
  return (cc2[1] - 0.5) - 0.8 * (1 - smoothstep(0, 0.18, cc2[0])) + 0.2;
}

export interface ReliefInput {
  /** The point (unit direction) and the ground's height above the sea there (radians). */
  x: number; y: number; z: number; hAbove: number;
  /** The planet mesh's slope there: uphill gradient, tangent (radians per radian). */
  mx: number; my: number; mz: number;
  /** 0..1: sand desert (no gullies), ice (no relief). */
  sand: number; ice: number;
  /** Distance to the nearest drawn river or stream, radians (Infinity for none): the relief
   * fades out toward it, so rivers run on flat floors. */
  river: number;
  /** Grid spacing, radians: octaves too fine for it stay out. */
  sp: number;
}

/**
 * How far the planet's patch raises (or lowers) the ground at a point, radians: the carved
 * valleys (if given), the hills and gullies, and the crags (cliff bands, rock blocks) on steep
 * high ground. As the bake, at full strength (camera close).
 * tmp[4] is set to the valleys' carving there (radians, 0 without them), which snow counts.
 */
export function patchLift(r: ReliefInput, valleys: ValleyField | null, tmp: number[]): number {
  const { x, y, z, hAbove } = r;
  // base = the point at its height; up its direction. (The shader's base sits at radius 1 + h.)
  const bx = x * (1 + hAbove), by = y * (1 + hAbove), bz = z * (1 + hAbove);
  const highland = smoothstep(0.12, 0.85, hAbove / RELIEF);
  // east = normalize(up.z, 0, -up.x), north = cross(up, east)
  let ex = z, ez = -x; const el = Math.hypot(ex, ez) || 1; ex /= el; ez /= el;
  const nx = y * ez, ny = z * ex - x * ez, nz = -y * ex;

  // Valleys: cut relative to the carving's local average (so the land keeps the plain terrain's
  // height on average), deeper in the mountains, never below the sea.
  let liftC = 0, gCx = 0, gCy = 0, gCz = 0;
  tmp[4] = 0;
  if (valleys && hAbove > 0) {
    const e = UERO_R * 2 / 512;
    const c0 = carveAt(valleys, bx, by, bz, valleys.cut);
    const c1 = carveAt(valleys, bx + ex * e, by, bz + ez * e, valleys.cut);
    const c2 = carveAt(valleys, bx + nx * e, by + ny * e, bz + nz * e, valleys.cut);
    tmp[4] = carveAt(valleys, bx, by, bz);
    const full = c0 * (1 + MTN_CARVE * highland), cut = Math.min(full, 0.9 * hAbove);
    liftC = -cut;
    const sc = full > 0 ? cut / full : 1;
    gCx = -(ex * (c1 - c0) + nx * (c2 - c0)) / e * sc;
    gCy = -(ny * (c2 - c0)) / e * sc;
    gCz = -(ez * (c1 - c0) + nz * (c2 - c0)) / e * sc;
    const gl = Math.hypot(gCx, gCy, gCz), k = Math.min(1, 0.35 / Math.max(gl, 1e-6));
    gCx *= k; gCy *= k; gCz *= k;
  }

  // Hills and gullies, fading out toward rivers and streams (2 to 12 texels of the river mask).
  let liftEro = 0, eGx = 0, eGy = 0, eGz = 0;
  let eroFar = smoothstep(2, 12, r.river / TEXEL);
  const iceK = r.ice;
  if (eroFar > 0) {
    const sandE = r.sand * (1 - highland);
    if (sandE > 0) eroFar *= 1 - sandE * (0.6 + 0.4 * smoothstep(0.2, 0.5, sandSea(bx, by, bz)));
    eroFar *= smoothstep(0.0001, 0.001, hAbove + 0.0004 * snoise3(bx * 150, by * 150, bz * 150));
    if (eroFar >= 0.01 && iceK < 0.99) {
      const keep = tmp[4];
      hills(bx, by, bz, x, y, z, smoothstep(0.02, 0.3, hAbove / RELIEF), tmp);
      tmp[4] = keep;
      const hk = 1 - iceK;
      const mx = r.mx + tmp[1] * hk + gCx, my = r.my + tmp[2] * hk + gCy, mz = r.mz + tmp[3] * hk + gCz;
      const eroK = smoothstep(0, 0.07, Math.hypot(mx, my, mz)) * (1 - iceK) * eroFar;
      liftEro += tmp[0] * hk * eroFar;
      eGx += tmp[1] * hk * eroFar; eGy += tmp[2] * hk * eroFar; eGz += tmp[3] * hk * eroFar;
      if (eroK > 0) {
        liftEro += erosionGeoH(bx, by, bz, x, y, z, mx, my, mz, r.sp, geo3) * eroK;
        eGx += geo3[0] * eroK; eGy += geo3[1] * eroK; eGz += geo3[2] * eroK;
      }
    }
  }

  // Crags: cliff bands (the height terraced into ledges and risers) and rock blocks split by
  // cracks, on steep high ground. Both average out to nothing, so ranges keep their height.
  if (eroFar >= 0.01 && hAbove > 0) {
    const Gx = r.mx + gCx + eGx, Gy = r.my + gCy + eGy, Gz = r.mz + gCz + eGz;
    const steep = Math.hypot(Gx, Gy, Gz);
    const k = smoothstep(0.28, 0.55, steep) * smoothstep(0.15, 0.5, hAbove / RELIEF) * eroFar * (1 - 0.6 * iceK);
    if (k > 0) {
      const layered = smoothstep(-0.3, 0.3, snoise3(bx * 14 + 5, by * 14 + 5, bz * 14 + 5));
      const runs = smoothstep(-0.15, 0.45, snoise3(bx * 1200 + 2, by * 1200 + 2, bz * 1200 + 2) + 0.35 * snoise3(bx * 4000 + 8, by * 4000 + 8, bz * 4000 + 8));
      const bandsK = layered * runs * (1 - smoothstep(CRAG_BAND / 7, CRAG_BAND / 3.5, r.sp * steep));
      if (bandsK > 0) {
        const H = hAbove + liftC + liftEro + CRAG_BAND * (0.6 * snoise3(bx * 400 + 9, by * 400 + 9, bz * 400 + 9) + 0.25 * snoise3(bx * 2500 + 4, by * 2500 + 4, bz * 2500 + 4));
        const t = H / CRAG_BAND, u = Math.min(1, Math.max(0, (fract(t) - 0.55) / 0.45));
        liftEro += (Math.floor(t) + u * u * (3 - 2 * u) - t + 0.275) * CRAG_BAND * k * bandsK;
      }
      const blocksK = smoothstep(0.3, 0.6, steep) * (1 - smoothstep(0.25 / CRAG_INV, 0.5 / CRAG_INV, r.sp)) * (1 - 0.5 * layered);
      if (blocksK > 0) liftEro += cragBlocks(bx, by, bz) * CRAG_AMP * k * blocksK;
    }
  }
  return liftC + liftEro;
}
