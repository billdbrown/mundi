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
  /**
   * Hex-tiling (Mikkelsen 2022), translations only (dunes must keep facing the wind): the plane is
   * cut into a triangle grid; each corner reads the tile at its own random offset, and the three
   * are blended by position, favouring whichever stands highest, so seams run along the dunes'
   * own crests and troughs. A single tile, however bent, repeats visibly across a sand sea.
   */
  vec2 dHash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
  vec4 duneHex(vec2 uv, vec4 w) {
    vec2 sk = mat2(1.0, 0.0, -0.57735027, 1.15470054) * (uv * 1.1);
    vec2 base = floor(sk);
    vec3 f = vec3(fract(sk), 0.0);
    f.z = 1.0 - f.x - f.y;
    vec3 bw; vec2 v1, v2, v3;
    if (f.z > 0.0) { bw = vec3(f.z, f.y, f.x); v1 = base; v2 = base + vec2(0.0, 1.0); v3 = base + vec2(1.0, 0.0); }
    else { bw = vec3(-f.z, 1.0 - f.y, 1.0 - f.x); v1 = base + 1.0; v2 = base + vec2(1.0, 0.0); v3 = base + vec2(0.0, 1.0); }
    vec4 a = duneTap(uv + dHash2(v1), w), b = duneTap(uv + dHash2(v2), w), c = duneTap(uv + dHash2(v3), w);
    vec3 k = pow(bw, vec3(9.0)) * pow(vec3(a.w, b.w, c.w) + 0.2, vec3(2.0));
    k /= max(k.x + k.y + k.z, 1e-6);
    return a * k.x + b * k.y + c * k.z;
  }
  vec4 duneFacing(vec2 g, vec4 w, float west) {
    vec2 uv = g / DUNE_TILE;
    vec4 a = duneHex(vec2(-uv.x, uv.y), w);
    a.y = -a.y;
    if (west > 0.999) return a;
    vec4 b = duneHex(uv, w);
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
  /** How far the patch moved the ground (see LIFT_GLSL); 1 while the patch is drawn. */
  /**
   * The patch's relief, worked out once per recentre, one texel per grid vertex (see
   * PATCH_BAKE_GLSL): 0 lift from dunes, lift from erosion (before its distance fade), dune
   * fade; 1 dune slope; 2 erosion slope.
   */
  uBake0: { value: THREE.Texture | null };
  uBake1: { value: THREE.Texture | null };
  uBake2: { value: THREE.Texture | null };
  /** Where rivers run, seen from above: the patch keeps flat floodplains there. */
  uCapR: { value: THREE.Texture | null };
  uPatchOn: { value: number };
}
/** One set, shared by the patch and by whatever must follow its ground (trees, rivers). */
export const patchUniforms: PatchUniforms = {
  uPatchC: { value: new THREE.Vector3(0, 0, 1) }, uPatchE: { value: new THREE.Vector3(1, 0, 0) }, uPatchN: { value: new THREE.Vector3(0, 1, 0) },
  uCapA: { value: null }, uCapB: { value: null }, uBake0: { value: null }, uBake1: { value: null }, uBake2: { value: null }, uCapR: { value: null }, uPatchOn: { value: 0 },
};
export const PATCH_N = 288;          // vertices along a side
export const PATCH_A = 0.15;         // grid spacing at the centre, relative to an even grid
export const PATCH_R = 0.05;         // half-width, radians (~320 km on an Earth-sized world)
export const CAPTURE_SIZE = 512;     // texels along a side of the patch's captures

/** Shared by both patch programs: the terrain under a grid vertex, from the captures. */
const PATCH_BASE_GLSL = /* glsl */`
  uniform vec3 uPatchC, uPatchE, uPatchN;
  uniform sampler2D uCapA, uCapB;
  vec4 capA, capB;
  vec3 base, up, n0;
  vec2 capUv;
  void patchBase(vec2 lat) {
    capUv = lat / (2.0 * ${PATCH_R}) + 0.5;
    capA = texture(uCapA, capUv);
    capB = texture(uCapB, capUv);
    // capA: height above the sea (x50), normal east and north (patch-centre frame), moisture.
    // capB: ground colour, temperature.
    float rad = 1.0 + capA.x / 50.0;
    base = uPatchC * sqrt(max(rad * rad - dot(lat, lat), 0.0)) + uPatchE * lat.x + uPatchN * lat.y;
    up = normalize(base);
    n0 = normalize(uPatchE * capA.y + uPatchN * capA.z + uPatchC * sqrt(max(1.0 - dot(capA.yz, capA.yz), 0.0)));
  }
`;

/**
 * The patch's relief, baked once per recentre (needs NOISE_GLSL, EROSION_GLSL, DUNES_GLSL
 * before it): for the grid vertex at lat, the dunes, the rolling hills and the gully octaves
 * the grid is fine enough for, by the same rules as the terrain shader. The patch's drawing
 * shaders only read the results (PATCH_GLSL). Run in them directly, this made the patch's
 * colour shader take ~13 s to compile on Windows, stalling the first descent into a world.
 */
export const PATCH_BAKE_GLSL = PATCH_BASE_GLSL + /* glsl */`
  uniform sampler2D uCapR;
  uniform float uRelief;
  vec4 bake0, bake1, bake2;   // see PatchUniforms.uBake0..2
  void patchBake(vec2 lat) {
    const float R = ${PATCH_R};
    patchBase(lat);
    vec4 a = capA, b = capB;
    vec3 east = normalize(vec3(up.z, 0.0, -up.x)), north = cross(up, east);
    float hAbove = length(base) - 1.0;
    float highland = smoothstep(0.12, 0.85, hAbove / uRelief);
    // Grid spacing here, and the fade to plain terrain at the patch edge.
    float s = max(abs(lat.x), abs(lat.y)) / R;
    float spacing = R * (${PATCH_A} + 2.0 * (1.0 - ${PATCH_A}) * s) * 2.0 / ${PATCH_N - 1}.0;
    float edge = 1.0 - smoothstep(0.8, 0.97, s);

    // Dunes stand up where the grid resolves them (finer than a third of their spacing).
    float desert = smoothstep(0.24, 0.12, a.w) * smoothstep(0.4, 0.55, b.w) * (1.0 - highland) * smoothstep(0.0003, 0.0008, hAbove);
    float geo = (1.0 - smoothstep(DUNE * 0.2, DUNE * 0.36, spacing)) * edge;
    float k = 0.0, raw = 0.0;
    vec4 d = vec4(0.0);
    if (desert * geo > 0.0) {
      vec4 w = duneWeights(base, a.w, desert, sandSea(base), k);
      if (k > 0.0) d = dunes(base, w, raw);
    }
    float hk = k * geo;

    // Erosion, as in the terrain shader (sky.ts), at full strength: the drawing shaders fade it
    // with distance from the camera.
    float liftEro = 0.0;
    vec3 eroG = vec3(0.0);
    float eroFar = uErosion * edge;
    // Rivers run on flat valley floors: no hills or gullies within a few km of one. (Relief
    // crossing a river also rose between the river ribbon's sparse points and hid the water.)
    if (eroFar > 0.0) {
      float t = 1.0 / ${CAPTURE_SIZE}.0, river = texture(uCapR, capUv).r;
      for (int i = 0; i < 8; i++) {
        float ang = float(i) * 0.785398;
        vec2 o = vec2(cos(ang), sin(ang)) * t;
        river = max(river, max(texture(uCapR, capUv + o * 2.0).r, texture(uCapR, capUv + o * 4.0).r * 0.6));
      }
      eroFar *= 1.0 - river;
    }
    if (eroFar > 0.0) {
      float iceK = smoothstep(0.6, 0.8, min(b.r, min(b.g, b.b)));
      float sandE = smoothstep(0.24, 0.12, a.w) * smoothstep(0.4, 0.55, b.w) * (1.0 - highland);
      if (sandE > 0.0) eroFar *= 1.0 - sandE * mix(0.6, 1.0, smoothstep(0.2, 0.5, sandSea(base)));
      eroFar *= smoothstep(0.0001, 0.001, hAbove + 0.0004 * snoise(base * 150.0));
      if (eroFar >= 0.01 && iceK < 0.99) {
        float cz = max(dot(n0, up), 0.3);
        vec3 macro = -(n0 - up * dot(n0, up)) / cz;
        vec4 hl = hills(base, up, smoothstep(0.02, 0.3, hAbove / uRelief)) * (1.0 - iceK);
        macro += hl.yzw;
        float eroK = smoothstep(0.0, 0.07, length(macro)) * (1.0 - iceK) * eroFar;
        liftEro += hl.x * eroFar;
        eroG += hl.yzw * eroFar;
        if (eroK > 0.0) {
          Ero er = erosionSplit(base, up, macro, 0.0, spacing);
          liftEro += er.geoH * eroK;
          eroG += er.geo * eroK;
        }
      }
    }
    bake0 = vec4(raw * DUNE_CELL * hk, liftEro, geo, 0.0);
    bake1 = vec4((east * d.z + north * d.w) * hk, 0.0);
    bake2 = vec4(eroG, 0.0);
  }
`;

/**
 * Vertex code for the patch's drawing shaders: the terrain under the vertex, raised by the baked
 * relief (erosion faded with distance from the camera, as in the terrain shader).
 */
export const PATCH_GLSL = PATCH_BASE_GLSL + /* glsl */`
  uniform sampler2D uBake0, uBake1, uBake2;
  varying float vDuneGeo;
  varying vec3 vTerrN, vBase, vEroGeo;
  vec3 pSurf, pNorm, pCol;
  vec2 pClim;
  void patchSample(vec2 lat) {
    patchBase(lat);
    ivec2 ij = ivec2(gl_VertexID % ${PATCH_N}, gl_VertexID / ${PATCH_N});
    vec4 b0 = texelFetch(uBake0, ij, 0), b1 = texelFetch(uBake1, ij, 0), b2 = texelFetch(uBake2, ij, 0);
    float farDist = 1.0 - smoothstep(0.08, 0.22, length(cameraPosition - base));
    pSurf = base + up * (b0.x + b0.y * farDist);
    // At sea the patch sinks out of the way and the plain seabed shows: its depth offset (to sit
    // in front of the terrain) made the water fail its depth test in the shallows, which drew
    // the patch's square edge across the sea.
    if (capA.x <= 0.0) pSurf = base - up * 0.002;
    pNorm = normalize(n0 - b1.xyz - b2.xyz * farDist);
    pCol = capB.rgb;
    pClim = vec2(capA.w, capB.w);
    vDuneGeo = b0.z;
    // The erosion slope this vertex carries as relief: the pixel shader shades the rest.
    vEroGeo = b2.xyz * farDist;
    vTerrN = n0;
    vBase = base;
  }
`;

/**
 * For things that sit on the ground (trees, rivers): how far the patch has raised or lowered
 * it under a point p, from the baked relief (the grid's spacing mapping inverted to find p's
 * place in it).
 */
export const LIFT_GLSL = /* glsl */`
  uniform vec3 uPatchC, uPatchE, uPatchN;
  uniform sampler2D uBake0;
  uniform float uPatchOn;
  float gridT(float x) {
    // Inverse of x = R t (a + (1 - a)|t|), the grid's spacing (dunepatch.ts).
    const float A = ${PATCH_A};
    float ax = min(abs(x) / ${PATCH_R}, 1.0);
    return sign(x) * (-A + sqrt(A * A + 4.0 * (1.0 - A) * ax)) / (2.0 * (1.0 - A));
  }
  float patchLift(vec3 p) {
    if (uPatchOn < 0.5 || dot(normalize(p), uPatchC) < 0.9) return 0.0;
    vec2 lat = vec2(dot(p, uPatchE), dot(p, uPatchN));
    if (abs(lat.x) >= ${PATCH_R} || abs(lat.y) >= ${PATCH_R}) return 0.0;
    vec2 t = vec2(gridT(lat.x), gridT(lat.y)) * 0.5 + 0.5;            // 0..1 across the grid
    vec2 uv = (t * ${PATCH_N - 1}.0 + 0.5) / ${PATCH_N}.0;           // texel centres
    vec2 l = texture(uBake0, uv).xy;
    return l.x + l.y * (1.0 - smoothstep(0.08, 0.22, length(cameraPosition - p)));
  }
`;
