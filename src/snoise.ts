/**
 * Simplex noise (Ashima Arts / Stefan Gustavson, MIT), shared by the shaders and JavaScript.
 *
 * The 49 corner gradients come from a table instead of being worked out per call: the terrain
 * shader inlines snoise over a hundred times, and that working was a large share of its compile
 * time (tens of seconds on Windows). The table gives the same numbers.
 *
 * snoise3 is the same function in JavaScript, for things the CPU and GPU must agree on (where
 * the trees stand and where the shader draws canopy, groves.ts). Its hash is integer arithmetic
 * that floats carry exactly on both sides, so the two agree to rounding.
 */

/** The gradients: 49 of them, picked by the hash mod 49, normalised as Ashima normalises them. */
export const SN_GRAD: number[][] = (() => {
  const f = Math.fround, out: number[][] = [];
  for (let j = 0; j < 49; j++) {
    const xi = Math.floor(j / 7), yi = j - 7 * xi;
    // In 32-bit floats step by step, dividing as the GPU does (times 1/7): four gradients have h
    // within a rounding of 0, and which side of it they fall picks the gradient. (Read back from
    // the GPU under Windows/D3D11: 3 and 21 land above, 34 and 46 below. Other GPUs may differ,
    // as they always did with the original working.)
    const r7 = f(1 / 7);
    const x = f(f(f(xi * 2 + 0.5) * r7) - 1), y = f(f(f(yi * 2 + 0.5) * r7) - 1), h = f(f(1 - Math.abs(x)) - Math.abs(y));
    const sh = h <= 0 ? -1 : 0;
    const g = [x + (Math.floor(x) * 2 + 1) * sh, y + (Math.floor(y) * 2 + 1) * sh, h];
    const n = 1.79284291400159 - 0.85373472095314 * (g[0] * g[0] + g[1] * g[1] + g[2] * g[2]);
    out.push(g.map((v) => v * n));
  }
  return out;
})();

export const SNOISE_GLSL = /* glsl */`
  vec4 snPermute(vec4 x) { return mod(((x * 34.0) + 10.0) * x, 289.0); }
  const vec3 SN_GRAD[49] = vec3[](${SN_GRAD.map((g) => `vec3(${g.map((v) => v.toFixed(9)).join(', ')})`).join(', ')});
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz), l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx, x2 = x0 - i2 + C.yyy, x3 = x0 - 0.5;
    i = mod(i, 289.0);
    vec4 p = snPermute(snPermute(snPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    // The corner gradients: 49 possible, from the table instead of worked out here.
    ivec4 j = ivec4(p - 49.0 * floor(p / 49.0) + 0.5);
    vec3 g0 = SN_GRAD[j.x], g1 = SN_GRAD[j.y], g2 = SN_GRAD[j.z], g3 = SN_GRAD[j.w];
    vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 105.0 * dot(m * m, vec4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3)));
  }
`;

const mod289 = (x: number) => x - 289 * Math.floor(x / 289);
const perm = (x: number) => mod289((x * 34 + 10) * x);

/** snoise in JavaScript: about −1..1. */
export function snoise3(vx: number, vy: number, vz: number): number {
  const s = (vx + vy + vz) / 3;
  let ix = Math.floor(vx + s), iy = Math.floor(vy + s), iz = Math.floor(vz + s);
  const t = (ix + iy + iz) / 6;
  const x0 = vx - ix + t, y0 = vy - iy + t, z0 = vz - iz + t;
  // step(x0.yzx, x0.xyz)
  const gx = x0 >= y0 ? 1 : 0, gy = y0 >= z0 ? 1 : 0, gz = z0 >= x0 ? 1 : 0;
  const lx = 1 - gx, ly = 1 - gy, lz = 1 - gz;
  // i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy)
  const i1x = Math.min(gx, lz), i1y = Math.min(gy, lx), i1z = Math.min(gz, ly);
  const i2x = Math.max(gx, lz), i2y = Math.max(gy, lx), i2z = Math.max(gz, ly);
  const xs = [x0, x0 - i1x + 1 / 6, x0 - i2x + 1 / 3, x0 - 0.5];
  const ys = [y0, y0 - i1y + 1 / 6, y0 - i2y + 1 / 3, y0 - 0.5];
  const zs = [z0, z0 - i1z + 1 / 6, z0 - i2z + 1 / 3, z0 - 0.5];
  ix = mod289(ix); iy = mod289(iy); iz = mod289(iz);
  const ox = [0, i1x, i2x, 1], oy = [0, i1y, i2y, 1], oz = [0, i1z, i2z, 1];
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    let m = 0.5 - (xs[k] * xs[k] + ys[k] * ys[k] + zs[k] * zs[k]);
    if (m <= 0) continue;
    const p = perm(perm(perm(iz + oz[k]) + iy + oy[k]) + ix + ox[k]);
    const g = SN_GRAD[p - 49 * Math.floor(p / 49)];
    m *= m;
    sum += m * m * (g[0] * xs[k] + g[1] * ys[k] + g[2] * zs[k]);
  }
  return 105 * sum;
}
