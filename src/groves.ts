/**
 * Groves and clearings: one pattern shared by the tree placer (JavaScript) and the ground
 * shader (GLSL), so canopy texture and trees agree on where the forest is.
 *
 * Three octaves of simplex noise, domain-warped by three more (snoise.ts has it on both sides,
 * agreeing to about 0.0005). Until 2026-11-02 it was twelve sine waves, chosen because hashed
 * noise was thought to come out differently on the GPU; but at mid zoom the waves lined up into
 * a printed-looking pattern of parallel streaks (Bill's screenshot over dry forest). The noise
 * was tuned to the waves' statistics: the same spread, grove size (zero crossings per radian)
 * and shares of forest and open ground under forestMask and openMask.
 *
 * The frequency is tied to the cell size: groves a few to ten kilometres across, several to a
 * cell.
 */
import { snoise3 } from './snoise.ts';

/** Base frequency (times the grove frequency), and the field's scale: see above. */
const G_FREQ = 0.165, G_WARP_FREQ = G_FREQ * 0.5, G_WARP = 0.9 / (G_FREQ * 2.5), G_SCALE = 2.33;

/**
 * Ground distances that should not change with the cell count (tree size and density, grove
 * size, mesh noise) are given in multiples of this: the cell spacing at 16,002 cells (detail 40),
 * which they were tuned at. About 0.028 radians.
 */
export const REF_SPACING = Math.sqrt((4 * Math.PI) / 16002);

/** Grove frequency (radians⁻¹). The same on every world, whatever its cell count. */
export const groveFreq = (_N?: number) => 7 / REF_SPACING;

/** About −1..1; high in groves, low in clearings. p is a point near the unit sphere. */
export function groveField(x: number, y: number, z: number, f: number): number {
  const a = f * G_WARP_FREQ, A = G_WARP / f;
  const wx = x + A * snoise3(x * a, y * a, z * a);
  const wy = y + A * snoise3(x * a + 31.4, y * a, z * a);
  const wz = z + A * snoise3(x * a, y * a + 47.2, z * a);
  const q = f * G_FREQ;
  return G_SCALE * (0.6 * snoise3(wx * q, wy * q, wz * q)
    + 0.28 * snoise3(wx * q * 2.1 + 5.2, wy * q * 2.1, wz * q * 2.1)
    + 0.12 * snoise3(wx * q * 4.3, wy * q * 4.3 + 9.1, wz * q * 4.3));
}

const glf = (v: number) => v.toFixed(6);
export const GROVE_GLSL = /* glsl */`
  uniform float uGrove;
  // (Needs snoise: NOISE_GLSL first.)
  float groveField(vec3 p) {
    float f = uGrove, a = f * ${glf(G_WARP_FREQ)}, A = ${glf(G_WARP)} / f;
    vec3 pa = p * a;
    vec3 w = p + A * vec3(snoise(pa), snoise(pa + vec3(31.4, 0.0, 0.0)), snoise(pa + vec3(0.0, 47.2, 0.0)));
    vec3 q = w * (f * ${glf(G_FREQ)});
    return ${glf(G_SCALE)} * (0.6 * snoise(q) + 0.28 * snoise(q * 2.1 + vec3(5.2, 0.0, 0.0)) + 0.12 * snoise(q * 4.3 + vec3(0.0, 9.1, 0.0)));
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
