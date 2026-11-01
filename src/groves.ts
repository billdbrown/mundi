/**
 * Groves and clearings: one pattern shared by the tree placer (JavaScript) and the ground
 * shader (GLSL), so canopy texture and trees agree on where the forest is.
 *
 * It is a handful of sine waves in different directions, domain-warped by two more. Hashed
 * noise would not do: float32 on the GPU and float64 here would disagree about the hashes.
 * Sines of moderate arguments come out the same on both sides to well within what shows.
 *
 * The frequency is tied to the cell size: groves a few to ten kilometres across, several to a
 * cell.
 */

/** Direction (x, y, z), frequency multiple, phase, amplitude. */
const WAVES: [number, number, number, number, number, number][] = [
  [0.83, 0.41, 0.37, 1.0, 0.0, 1.0],
  [-0.29, 0.91, -0.3, 1.37, 1.7, 0.8],
  [0.45, -0.33, 0.83, 1.71, 3.1, 0.68],
  [-0.71, -0.52, 0.47, 2.23, 4.6, 0.55],
  [0.12, 0.68, 0.72, 2.9, 0.9, 0.45],
  [0.64, -0.75, -0.16, 3.7, 2.4, 0.36],
];
const NORM = WAVES.reduce((s, w) => s + w[5], 0);

/** Grove frequency for a world with N cells (radians⁻¹). */
export const groveFreq = (N: number) => 7 / Math.sqrt((4 * Math.PI) / N);

/** About −1..1; high in groves, low in clearings. p is a point near the unit sphere. */
export function groveField(x: number, y: number, z: number, f: number): number {
  const wx = x + (0.5 / f) * Math.sin((y * 1.9 + z * 0.7) * f * 0.55 + 1.3);
  const wy = y + (0.5 / f) * Math.sin((z * 1.3 - x * 0.8) * f * 0.55 + 2.9);
  const wz = z + (0.5 / f) * Math.sin((x * 1.1 + y * 0.6) * f * 0.55 + 0.4);
  let s = 0;
  for (const [a, b, c, k, ph, amp] of WAVES) s += Math.sin((a * wx + b * wy + c * wz) * f * k + ph) * amp;
  return s / NORM * 1.8;
}

export const GROVE_GLSL = /* glsl */`
  uniform float uGrove;
  float groveField(vec3 p) {
    float f = uGrove;
    vec3 w = p + (0.5 / f) * vec3(
      sin((p.y * 1.9 + p.z * 0.7) * f * 0.55 + 1.3),
      sin((p.z * 1.3 - p.x * 0.8) * f * 0.55 + 2.9),
      sin((p.x * 1.1 + p.y * 0.6) * f * 0.55 + 0.4));
    float s = 0.0;
    ${WAVES.map(([a, b, c, k, ph, amp]) => `s += sin(dot(w, vec3(${a.toFixed(3)}, ${b.toFixed(3)}, ${c.toFixed(3)})) * f * ${k.toFixed(3)} + ${ph.toFixed(3)}) * ${amp.toFixed(3)};`).join('\n    ')}
    return s / ${NORM.toFixed(4)} * 1.8;
  }
`;

/** How much of a forest biome is under trees here: mostly forest, with clearings. */
export const forestMask = (g: number) => smooth(-0.35, 0.25, g);
/** Open country (savanna, grassland): trees only in scattered groves. */
export const openMask = (g: number) => smooth(0.25, 0.7, g);
function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
