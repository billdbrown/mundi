/**
 * Erosion filter: gullies and spurs below the terrain mesh's resolution, drawn per pixel.
 *
 * Water carves land into valleys that run downhill and branch: small gullies run down the
 * walls of bigger ones. This imitates that without simulating it. Each octave is a set of
 * stripes running down the slope, the slope being the mesh's own plus the octaves above it,
 * so each finer octave runs down the sides of the coarser gullies and the pattern branches.
 * (After the "eroded terrain" shader filters by Clay John and Fewes, in 3D for the sphere.)
 *
 * The stripes are phasor noise on a simplex lattice: four kernels a point, each a sinusoid
 * across the slope with a random phase, summed as complex numbers; the angle of the sum is a
 * stripe phase with full contrast everywhere, and where the kernels disagree the stripes fork,
 * which reads as tributaries joining. A 3D lattice has no seams anywhere on the sphere.
 *
 * On the dune patch (dunepatch.ts) the octaves its grid can carry become real relief in the
 * vertex shader (erosionSplit with the grid spacing), and only the finer ones stay shading.
 */
export const EROSION_GLSL = /* glsl */`
  uniform float uErosion;
  // Fades a pattern out once its features (spacing lambda) get smaller than a few pixels (foot).
  float aaFade(float lambda, float foot) { return 1.0 - smoothstep(lambda * 0.12, lambda * 0.45, foot); }
  const float ERO_L0 = 0.005;     // widest gully spacing (radians; ~30 km on an Earth-sized world)
  const int ERO_OCT = 6;          // down to ~1 km
  const float ERO_STEEP = 0.7;    // gully wall slope (exaggerated, like all relief here)
  const float ERO_GAIN = 0.78;    // slope falloff per octave
  const float ERO_COUPLE = 1.0;   // how much coarser gullies steer finer ones

  float eroHash(vec3 c) {
    uvec3 q = uvec3(ivec3(c));
    uint h = (q.x * 1597334677u) ^ (q.y * 3812015801u) ^ (q.z * 2741598923u);
    h ^= h >> 16; h *= 0x7feb352du; h ^= h >> 15; h *= 0x846ca68bu; h ^= h >> 16;
    return float(h) * (1.0 / 4294967296.0);
  }
  vec2 eroTap(vec3 cell, vec3 x, vec3 across) {
    float w = max(0.6 - dot(x, x), 0.0);
    w *= w; w *= w;
    // 1.5 stripes per lattice unit: each kernel spans a stripe or two, enough to be coherent.
    float a = 6.2831853 * (dot(x, across) * 1.5 + eroHash(cell));
    return w * vec2(cos(a), sin(a));
  }
  /** Stripe phase at p (lattice units); stripes run perpendicular to across. */
  float eroPhase(vec3 p, vec3 across) {
    const float F3 = 1.0 / 3.0, G3 = 1.0 / 6.0;
    vec3 s = floor(p + dot(p, vec3(F3)));
    vec3 x0 = p - s + dot(s, vec3(G3));
    vec3 e = step(vec3(0.0), x0 - x0.yzx);
    vec3 i1 = e * (1.0 - e.zxy);
    vec3 i2 = 1.0 - e.zxy * (1.0 - e);
    vec2 S = eroTap(s, x0, across) + eroTap(s + i1, x0 - i1 + G3, across)
           + eroTap(s + i2, x0 - i2 + 2.0 * G3, across) + eroTap(s + 1.0, x0 - 0.5, across);
    return atan(S.y, S.x);
  }
  /**
   * Valleys as connected lines (the zero set of a noise, |n|), not the pits of a noise: water
   * leaves every hollow on real land, and pits drew starbursts of gullies draining into them.
   * q is the point already warped (so the valleys wind); p unwarped.
   */
  float eroHills(vec3 q, vec3 p) {
    // Rounded floors (a hard |n| crease read as folded cloth); one scale only, the gully
    // octaves add the rest.
    float n = snoise(q * 50.0);
    return sqrt(n * n + 0.03) + 0.3 * snoise(p * 25.0 + 3.0);
  }
  /**
   * Hills for the gullies to carve where the mesh is nearly flat: rolling ground 60-120 km
   * across, strong on uplands, patchy in lowlands (some plains stay plains). x: height (radians,
   * about zero-mean), yzw: its gradient (tangent, uphill). hilly: 0..1 from height above the sea.
   */
  vec4 hills(vec3 p, vec3 up, float hilly) {
    // Where hills are at all: broad regions, so lowlands mix plains and hill country.
    float region = smoothstep(-0.3, 0.4, snoise(p * 9.0 + 41.0) + 0.6 * hilly);
    float a = (0.15 + 0.85 * hilly) * region;
    if (a <= 0.0) return vec4(0.0);
    vec3 t1 = normalize(cross(up, abs(up.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
    vec3 t2 = cross(up, t1);
    const float E = 0.0006;
    // The warp is broad next to E, so the three samples share it: 9 noise lookups, not 15.
    vec3 w = 0.004 * vec3(snoise(p * 60.0 + 11.0), snoise(p * 60.0 + 23.0), snoise(p * 60.0 + 37.0));
    float h0 = eroHills(p + w, p), h1 = eroHills(p + t1 * E + w, p + t1 * E), h2 = eroHills(p + t2 * E + w, p + t2 * E);
    // Scaled to slopes of about 0.3.
    return vec4((h0 - 0.6) * 0.00045 * a, (t1 * (h1 - h0) + t2 * (h2 - h0)) / E * 0.00045 * a);
  }
  vec3 hillGrad(vec3 p, vec3 up, float hilly) { return hills(p, up, hilly).yzw; }
  /**
   * The gully octaves, split between relief and shading. p: point on the planet; up: its
   * direction; macro: the height gradient of the surface (uphill, tangent), which steers the
   * gullies; foot: pixel footprint (0 in a vertex shader), to drop octaves too fine to see;
   * sp: spacing of a grid carrying the coarse octaves as relief (0: none, all shading).
   */
  struct Ero {
    float h;       // where this is in the gully relief, about -0.5 (floor) to 0.5 (crest)
    vec3 shade;    // gradient of the octaves left to shading (tangent, uphill)
    vec3 geo;      // gradient of the octaves the grid carries
    float geoH;    // height of those octaves, radians
  };
  Ero erosionSplit(vec3 p, vec3 up, vec3 macro, float foot, float sp) {
    Ero e = Ero(0.0, vec3(0.0), vec3(0.0), 0.0);
    vec3 g = vec3(0.0);
    float norm = 0.0, lambda = ERO_L0, amp = 1.0;
    for (int i = 0; i < ERO_OCT; i++) {
      float fade = aaFade(lambda, foot);
      if (fade <= 0.0) break;
      vec3 across = cross(up, macro + g * ERO_COUPLE);
      float l = length(across);
      if (l < 1e-6) break;
      across /= l;
      float phi = eroPhase(p / (lambda * 1.5) + float(i) * 17.31, across);
      // V-shaped floors, rounded crests: |cos(phi/2)|, softened at the floor.
      float c = cos(0.5 * phi);
      float prof = sqrt(c * c + 0.02);
      float dprof = -0.25 * sin(phi) / prof;
      float k = amp * fade;
      e.h += k * lambda * (prof - 0.5);
      norm += amp * lambda;
      // Height amplitude lambda * steep / 2pi, times the phase gradient 2pi / lambda.
      vec3 dg = k * ERO_STEEP * dprof * across;
      g += dg;
      // A grid shows an octave as relief once it has several vertices per gully.
      float gw = sp > 0.0 ? smoothstep(2.5 * sp, 4.0 * sp, lambda) : 0.0;
      e.geo += gw * dg;
      e.geoH += gw * k * ERO_STEEP * lambda / 6.2831853 * (prof - 0.5);
      e.shade += (1.0 - gw) * dg;
      amp *= ERO_GAIN;
      lambda *= 0.5;
    }
    e.h /= max(norm, 1e-9);
    return e;
  }
  /** All octaves as shading: x where in the gully relief, yzw gradient. */
  vec4 erosion(vec3 p, vec3 up, vec3 macro, float foot) {
    Ero e = erosionSplit(p, up, macro, foot, 0.0);
    return vec4(e.h, e.shade);
  }
  /** Slope variance (per axis) of the octaves too fine to draw at footprint foot (leanShadow, sky.ts). */
  float eroLostVar(float foot) {
    float v = 0.0, lambda = ERO_L0, amp = 1.0;
    for (int i = 0; i < ERO_OCT; i++) {
      float s = amp * ERO_STEEP * 0.25;   // rms of dprof is about a quarter
      v += s * s * (1.0 - aaFade(lambda, foot));
      amp *= ERO_GAIN; lambda *= 0.5;
    }
    return v;
  }
`;
