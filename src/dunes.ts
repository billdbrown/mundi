/**
 * Dunes in the terrain shader, from tiles simulated with Werner's slab model (src/dunesim.ts,
 * baked by scripts/bake-dunes.ts into public/dunes.bin): barchans, transverse ridges, linear
 * ridges and network dunes, one per channel. The shader picks and blends them by sand supply,
 * dryness and how steady the wind is, and turns them to face the prevailing wind.
 */
import * as THREE from 'three';

export const DUNE_SIZE = 256;

export interface DuneUniforms {
  uDunes: { value: THREE.Texture };
  /** Tallest point of each tile, in cells, to normalise heights for colour. */
  uDuneMax: { value: THREE.Vector4 };
}

export function makeDuneUniforms(): DuneUniforms {
  const blank = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  blank.needsUpdate = true;
  const u: DuneUniforms = { uDunes: { value: blank }, uDuneMax: { value: new THREE.Vector4(1, 1, 1, 1) } };
  if (typeof window !== 'undefined') {
    fetch(new URL('dunes.bin', document.baseURI)).then((r) => r.arrayBuffer()).then((buf) => {
      const data = new Uint16Array(buf);
      if (data.length !== DUNE_SIZE * DUNE_SIZE * 4) return;
      const max = [0, 0, 0, 0];
      for (let i = 0; i < data.length; i++) max[i & 3] = Math.max(max[i & 3], THREE.DataUtils.fromHalfFloat(data[i]));
      const tex = new THREE.DataTexture(data, DUNE_SIZE, DUNE_SIZE, THREE.RGBAFormat, THREE.HalfFloatType);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.magFilter = tex.minFilter = THREE.LinearFilter;
      tex.needsUpdate = true;
      u.uDunes.value = tex;
      u.uDuneMax.value.set(max[0] || 1, max[1] || 1, max[2] || 1, max[3] || 1);
    }).catch(() => { /* no dunes file: deserts stay flat sand */ });
  }
  return u;
}

/**
 * dunes(p, w): w weights the four kinds (barchan, transverse, linear, network).
 * Returns x height 0..1, y slip face 0..1, zw slope east and north (true slopes).
 */
export const DUNES_GLSL = /* glsl */`
  uniform sampler2D uDunes;
  uniform vec4 uDuneMax;
  // One tile is ~57 km on an Earth-sized world: transverse ridges come out ~7 km apart
  // (exaggerated, like all relief here).
  const float DUNE_TILE = 0.009;
  const float DUNE_TEXEL = 1.0 / ${DUNE_SIZE}.0;
  // One tile cell, in radians: heights in cells times this are heights on the planet.
  const float DUNE_CELL = DUNE_TILE / ${DUNE_SIZE}.0;
  // Spacing of transverse ridges, for fading dunes out where they get too small to see.
  const float DUNE = 0.0011;
  // Height (0..1, for colour), slope along u and v, and height in cells, at uv; kinds weighted by w.
  vec4 duneTap(vec2 uv, vec4 w) {
    vec4 h0 = texture(uDunes, uv);
    vec4 hu = texture(uDunes, uv + vec2(DUNE_TEXEL, 0.0));
    vec4 hv = texture(uDunes, uv + vec2(0.0, DUNE_TEXEL));
    // Heights are in cell widths and one texel is one cell, so a difference is a slope.
    return vec4(dot(h0 / uDuneMax, w), dot(hu - h0, w), dot(hv - h0, w), dot(h0, w));
  }
  // The tiles' wind blows toward +u. Facing west (trade winds) mirrors u.
  vec4 duneFacing(vec2 g, vec4 w, float west) {
    vec2 uv = g / DUNE_TILE;
    vec4 a = duneTap(vec2(-uv.x, uv.y), w);
    a.y = -a.y;
    if (west > 0.999) return a;
    vec4 b = duneTap(uv, w);
    return mix(b, a, west);
  }
  /**
   * Which dunes, and how much (Wasson & Hyde): barchans where sand is thin, at the edges of the
   * sand seas; in the seas, transverse ridges under a steady wind, network dunes where the winds
   * vary (the horse latitudes, ~20-35°), linear ridges in the less dry margins (as in the
   * Kalahari and Australia). desert: how much this is hot lowland desert; sea: the sand-sea
   * mask. Returns weights summing to 1; k is the overall amount.
   */
  vec4 duneWeights(vec3 p, float moist, float desert, float sea, out float k) {
    float core = smoothstep(0.35, 0.75, sea);
    float varied = smoothstep(0.33, 0.55, abs(asin(clamp(normalize(p).y, -1.0, 1.0))));
    float semi = smoothstep(0.1, 0.19, moist);
    vec4 dw = vec4(smoothstep(0.04, 0.3, sea) * (1.0 - core),
                   core * (1.0 - varied) * (1.0 - semi), core * (1.0 - varied) * semi, core * varied);
    float total = dw.x + dw.y + dw.z + dw.w;
    k = desert * min(1.0, total);
    return dw / max(1e-4, total);
  }
  /** The sand-sea mask: where a hot desert is sand rather than gravel plain or rock. */
  float sandSea(vec3 p) { return smoothstep(-0.55, 0.05, snoise(p * 40.0) + 0.25 * snoise(p * 160.0)); }
  vec4 dunes(vec3 p, vec4 w, out float raw) {
    vec3 n = normalize(p);
    float lat = asin(clamp(n.y, -1.0, 1.0)), lon = atan(n.x, n.z);
    // Trade winds blow toward the west below ~30°, the westerlies toward the east above.
    float west = 1.0 - smoothstep(0.47, 0.58, abs(lat));
    // Bend the rows a little, so the tile doesn't repeat in straight lines.
    vec2 warp = DUNE_TILE * 0.15 * vec2(snoise(p * 50.0), snoise(p * 50.0 + 7.0));
    vec2 g = vec2(lon * cos(lat), lat) + warp;
    vec4 d = duneFacing(g, w, west);
    // Longitude wraps at ±180°, where the tile would jump: blend with the other side there.
    float seam = smoothstep(3.1, 3.1416, abs(lon));
    if (seam > 0.0) {
      vec2 g2 = vec2((lon - sign(lon) * 6.2831853) * cos(lat), lat) + warp;
      d = mix(d, duneFacing(g2, w, west), seam * 0.5);
    }
    // Slip faces: steep slopes facing downwind (any steep slope in network dunes).
    float downwind = mix(d.y, -d.y, west);
    float lee = smoothstep(0.3, 0.55, -downwind) * (1.0 - w.w) + smoothstep(0.35, 0.6, length(d.yz)) * w.w;
    raw = d.w;
    return vec4(d.x, clamp(lee, 0.0, 1.0), d.yz);
  }
`;

/** The high-detail ground patch (dunepatch.ts): its grid, and the vertex code that drapes it. */
export interface PatchUniforms {
  uPatchC: { value: THREE.Vector3 };
  uPatchE: { value: THREE.Vector3 };
  uPatchN: { value: THREE.Vector3 };
  uCapA: { value: THREE.Texture | null };
  uCapB: { value: THREE.Texture | null };
}
export const PATCH_N = 288;          // vertices along a side
export const PATCH_A = 0.15;         // grid spacing at the centre, relative to an even grid
export const PATCH_R = 0.05;         // half-width, radians (~320 km on an Earth-sized world)

/**
 * Vertex code for the patch (needs NOISE_GLSL and DUNES_GLSL before it). Each vertex's position
 * is a point (x, y) in the tangent plane at the patch centre; the terrain under it comes from a
 * capture of the terrain mesh seen from straight above (height, normal, colour, climate), and
 * the dunes raise it. Where the grid is too coarse for the dunes, they flatten into shading.
 */
export const PATCH_GLSL = /* glsl */`
  uniform vec3 uPatchC, uPatchE, uPatchN;
  uniform sampler2D uCapA, uCapB;
  uniform float uRelief;
  varying float vDuneGeo, vDuneK;
  vec3 pSurf, pNorm, pCol;
  vec2 pClim;
  void patchSample(vec2 lat) {
    const float R = ${PATCH_R};
    vec2 uv = lat / (2.0 * R) + 0.5;
    vec4 a = texture(uCapA, uv), b = texture(uCapB, uv);
    // a: height above the sea (x50), normal east and north (patch-centre frame), moisture.
    // b: ground colour, temperature.
    float rad = 1.0 + a.x / 50.0;
    vec3 base = uPatchC * sqrt(max(rad * rad - dot(lat, lat), 0.0)) + uPatchE * lat.x + uPatchN * lat.y;
    vec3 up = normalize(base);
    vec3 n0 = normalize(uPatchE * a.y + uPatchN * a.z + uPatchC * sqrt(max(1.0 - dot(a.yz, a.yz), 0.0)));
    float hAbove = rad - 1.0;
    float highland = smoothstep(0.12, 0.85, hAbove / uRelief);
    float desert = smoothstep(0.24, 0.12, a.w) * smoothstep(0.4, 0.55, b.w) * (1.0 - highland) * smoothstep(0.0003, 0.0008, hAbove);
    // Dunes stand up where the grid resolves them (finer than a third of their spacing), and
    // sink back to nothing at the patch edge, where it meets the plain terrain.
    float s = max(abs(lat.x), abs(lat.y)) / R;
    float spacing = R * (${PATCH_A} + 2.0 * (1.0 - ${PATCH_A}) * s) * 2.0 / ${PATCH_N - 1}.0;
    float geo = (1.0 - smoothstep(DUNE * 0.2, DUNE * 0.36, spacing)) * (1.0 - smoothstep(0.8, 0.97, s));
    float k = 0.0, raw = 0.0;
    vec4 d = vec4(0.0);
    if (desert > 0.0) {
      vec4 w = duneWeights(base, a.w, desert, sandSea(base), k);
      if (k * geo > 0.0) d = dunes(base, w, raw);
    }
    vDuneK = k;
    float hk = k * geo;
    vec3 east = normalize(vec3(up.z, 0.0, -up.x)), north = cross(up, east);
    pSurf = base + up * (raw * DUNE_CELL * hk);
    // No dunes here: sink below the terrain, which then draws in front. (Discarding instead
    // would stop the GPU skipping hidden pixels, and dunes hide plenty behind themselves.)
    if (k < 0.002) pSurf = base - up * 0.002;
    pNorm = normalize(n0 - (east * d.z + north * d.w) * hk);
    pCol = b.rgb;
    pClim = vec2(a.w, b.w);
    vDuneGeo = geo;
  }
`;
