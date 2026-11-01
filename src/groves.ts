/**
 * Groves and clearings: one pattern shared by the tree placer (JavaScript) and the ground
 * shader (GLSL), so canopy texture and trees agree on where the forest is.
 *
 * It is twelve sine waves in scattered directions, domain-warped by three more. Hashed
 * noise would not do: float32 on the GPU and float64 here would disagree about the hashes.
 * Sines of moderate arguments come out the same on both sides to well within what shows.
 *
 * The frequency is tied to the cell size: groves a few to ten kilometres across, several to a
 * cell.
 */

/**
 * Direction (x, y, z), frequency multiple, phase, amplitude. Twelve waves in directions spread
 * by the golden angle, at frequencies with no simple ratios: few waves of similar size beat
 * into a visible diamond lattice; many scattered ones read as irregular.
 */
const WAVES: [number, number, number, number, number, number][] = Array.from({ length: 12 }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / 12, r = Math.sqrt(1 - y * y), a = i * 2.39996323;
  const k = 0.55 * Math.pow(1.23, i) * (1 + 0.137 * Math.sin(i * 7.1));
  return [r * Math.cos(a), y, r * Math.sin(a), k, (i * 1.618034) % 6.2832, 1 / Math.sqrt(k)];
});
const NORM = WAVES.reduce((s, w) => s + w[5], 0);

/** Grove frequency for a world with N cells (radians⁻¹). */
export const groveFreq = (N: number) => 7 / Math.sqrt((4 * Math.PI) / N);

/** About −1..1; high in groves, low in clearings. p is a point near the unit sphere. */
export function groveField(x: number, y: number, z: number, f: number): number {
  const wx = x + (1.4 / f) * Math.sin((y * 1.9 + z * 0.7) * f * 0.37 + 1.3);
  const wy = y + (1.4 / f) * Math.sin((z * 1.3 - x * 0.8) * f * 0.41 + 2.9);
  const wz = z + (1.4 / f) * Math.sin((x * 1.1 + y * 0.6) * f * 0.33 + 0.4);
  let s = 0;
  for (const [a, b, c, k, ph, amp] of WAVES) s += Math.sin((a * wx + b * wy + c * wz) * f * k + ph) * amp;
  return s / NORM * 2.6;
}

export const GROVE_GLSL = /* glsl */`
  uniform float uGrove;
  float groveField(vec3 p) {
    float f = uGrove;
    vec3 w = p + (1.4 / f) * vec3(
      sin((p.y * 1.9 + p.z * 0.7) * f * 0.37 + 1.3),
      sin((p.z * 1.3 - p.x * 0.8) * f * 0.41 + 2.9),
      sin((p.x * 1.1 + p.y * 0.6) * f * 0.33 + 0.4));
    float s = 0.0;
    ${WAVES.map(([a, b, c, k, ph, amp]) => `s += sin(dot(w, vec3(${a.toFixed(3)}, ${b.toFixed(3)}, ${c.toFixed(3)})) * f * ${k.toFixed(3)} + ${ph.toFixed(3)}) * ${amp.toFixed(3)};`).join('\n    ')}
    return s / ${NORM.toFixed(4)} * 2.6;
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
