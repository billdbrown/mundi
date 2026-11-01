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
  // Height and slope along u and v of the tile at uv, each kind weighted by w.
  vec3 duneTap(vec2 uv, vec4 w) {
    vec4 h0 = texture(uDunes, uv);
    vec4 hu = texture(uDunes, uv + vec2(DUNE_TEXEL, 0.0));
    vec4 hv = texture(uDunes, uv + vec2(0.0, DUNE_TEXEL));
    // Heights are in cell widths and one texel is one cell, so a difference is a slope.
    return vec3(dot(h0 / uDuneMax, w), dot(hu - h0, w), dot(hv - h0, w));
  }
  // The tiles' wind blows toward +u. Facing west (trade winds) mirrors u.
  vec3 duneFacing(vec2 g, vec4 w, float west) {
    vec2 uv = g / DUNE_TILE;
    vec3 a = duneTap(vec2(-uv.x, uv.y), w);
    a.y = -a.y;
    if (west > 0.999) return a;
    vec3 b = duneTap(uv, w);
    return mix(b, a, west);
  }
  vec4 dunes(vec3 p, vec4 w) {
    vec3 n = normalize(p);
    float lat = asin(clamp(n.y, -1.0, 1.0)), lon = atan(n.x, n.z);
    // Trade winds blow toward the west below ~30°, the westerlies toward the east above.
    float west = 1.0 - smoothstep(0.47, 0.58, abs(lat));
    // Bend the rows a little, so the tile doesn't repeat in straight lines.
    vec2 warp = DUNE_TILE * 0.15 * vec2(snoise(p * 50.0), snoise(p * 50.0 + 7.0));
    vec2 g = vec2(lon * cos(lat), lat) + warp;
    vec3 d = duneFacing(g, w, west);
    // Longitude wraps at ±180°, where the tile would jump: blend with the other side there.
    float seam = smoothstep(3.1, 3.1416, abs(lon));
    if (seam > 0.0) {
      vec2 g2 = vec2((lon - sign(lon) * 6.2831853) * cos(lat), lat) + warp;
      d = mix(d, duneFacing(g2, w, west), seam * 0.5);
    }
    // Slip faces: steep slopes facing downwind (any steep slope in network dunes).
    float downwind = mix(d.y, -d.y, west);
    float lee = smoothstep(0.3, 0.55, -downwind) * (1.0 - w.w) + smoothstep(0.35, 0.6, length(d.yz)) * w.w;
    return vec4(d.x, clamp(lee, 0.0, 1.0), d.yz);
  }
`;
