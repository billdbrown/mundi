/** Water shader, clouds (and their shadows), atmosphere and stars. */
import * as THREE from 'three';
import type { CloudPixels } from './clouds.ts';
import { hash01 } from './rng.ts';
import { MERC_GLSL, MERC_DISCARD, mercVertex, patchShaderChunks } from './mercator.ts';
import { GROVE_GLSL } from './groves.ts';
import { EROSION_GLSL } from './erosion.ts';
import { SHADOW_GLSL, shadowLights, shadowUniforms } from './terrainshadow.ts';
import { AERIAL_FULL_GLSL, atmoUniforms, applyAerial } from './atmosphere.ts';
import { DUNES_GLSL, PATCH_GLSL, LIFT_GLSL, patchUniforms, makeDuneUniforms, type DuneUniforms, type PatchUniforms } from './dunes.ts';

patchShaderChunks();

/** Uniforms shared by every material that receives cloud shadows. */
export interface CloudUniforms extends DuneUniforms {
  uCloudMap: { value: THREE.Texture | null };
  uCloudRot: { value: number };
  uCloudShadow: { value: number };
  /** Seconds; drives how cloud shapes evolve. */
  uCloudTime: { value: number };
  /** Sun direction, so shadows fall on the side of a cloud away from the sun. */
  uCloudSun: { value: THREE.Vector3 };
  /** −1..1: +1 is northern midsummer, −1 northern midwinter, 0 an equinox. */
  uSeason: { value: number };
  /** World heat offset and vertical scale, so shaders can reproduce the generator's temperatures. */
  uHeat: { value: number };
  uRelief: { value: number };
  /** 1 where the terrain shows natural colour (snow allowed), 0 on data maps. */
  uSnow: { value: number };
  /** On the flat map: how far away the view "is", standing in for the camera distance. */
  uMapDist: { value: number };
  /** Frequency of the grove pattern (groves.ts), set per world. */
  uGrove: { value: number };
  /** Erosion filter strength, 0..1 (erosion.ts). */
  uErosion: { value: number };
  /** Centuries: the year shown (−1: no civilisation drawn). */
  uYear: { value: number };
  /** Weather time in days, and the active storms (weather.ts). */
  uWeather: { value: number };
  uStorms: { value: THREE.Vector4[] };
}

export function makeCloudUniforms(): CloudUniforms {
  return { uCloudMap: { value: null }, uCloudRot: { value: 0 }, uCloudShadow: { value: 0 }, uCloudTime: { value: 0 }, uCloudSun: { value: new THREE.Vector3(0, 0, 1) },
    uSeason: { value: 0 }, uHeat: { value: 0 }, uRelief: { value: 0.013 }, uSnow: { value: 1 }, uMapDist: { value: 1 }, uGrove: { value: 250 }, uErosion: { value: 1 }, uYear: { value: -1 },
    uWeather: { value: 0 }, uStorms: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) }, ...makeDuneUniforms() };
}

/** Value noise in GLSL: cheap, smooth, good enough for normals and colour breakup. */
export const NOISE_GLSL = /* glsl */`
  float hash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float vnoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }

  // 3D simplex noise (Ashima Arts / Stefan Gustavson, MIT), about −1..1. Unlike the value noise
  // above it has no grid to show once thresholded, so the ground patterns use it.
  vec4 snPermute(vec4 x) { return mod(((x * 34.0) + 10.0) * x, 289.0); }
  vec4 snTaylor(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
  float snoise(vec3 v) {
    const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz), l = 1.0 - g;
    vec3 i1 = min(g.xyz, l.zxy), i2 = max(g.xyz, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx, x2 = x0 - i2 + C.yyy, x3 = x0 - 0.5;
    i = mod(i, 289.0);
    vec4 p = snPermute(snPermute(snPermute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
    vec4 j = p - 49.0 * floor(p / 49.0);
    vec4 x_ = floor(j / 7.0), y_ = floor(j - 7.0 * x_);
    vec4 x = (x_ * 2.0 + 0.5) / 7.0 - 1.0, y = (y_ * 2.0 + 0.5) / 7.0 - 1.0;
    vec4 h = 1.0 - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy), b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2.0 + 1.0, s1 = floor(b1) * 2.0 + 1.0, sh = -step(h, vec4(0.0));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy, a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 g0 = vec3(a0.xy, h.x), g1 = vec3(a0.zw, h.y), g2 = vec3(a1.xy, h.z), g3 = vec3(a1.zw, h.w);
    vec4 norm = snTaylor(vec4(dot(g0, g0), dot(g1, g1), dot(g2, g2), dot(g3, g3)));
    g0 *= norm.x; g1 *= norm.y; g2 *= norm.z; g3 *= norm.w;
    vec4 m = max(0.5 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
    m = m * m;
    return 105.0 * dot(m * m, vec4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3)));
  }
  /** Simplex rescaled to 0..1, a drop-in for vnoise. Large inputs lose float precision, so
   *  each call's frequency should keep |p| under a few thousand. */
  float snoise01(vec3 p) { return 0.5 + 0.5 * snoise(p); }
`;

/**
 * Looks up cloud cover straight above a world point. The UV maths mirrors THREE.SphereGeometry
 * (u = φ/2π with x = −cos φ, v = 1 − θ/π) and undoes the cloud sphere's Y rotation.
 * textureLod avoids the mip seam where φ wraps.
 */
const CLOUD_GLSL = /* glsl */`
  uniform sampler2D uCloudMap;
  uniform float uCloudRot, uCloudShadow, uCloudTime, uSeason, uHeat, uRelief, uSnow, uMapDist, uWeather;
  uniform vec3 uCloudSun;
  uniform vec4 uStorms[8];
  /**
   * Seasons. The generator's annual-mean temperature for a point (the same formula as the
   * per-vertex snow), and that temperature shifted by the season: the tilt warms one hemisphere
   * while it cools the other, more toward the poles, not at all at the equator.
   */
  float meanTemp(vec3 n, float above) {
    float lat = abs(asin(clamp(n.y, -1.0, 1.0))) / 1.5707963;
    return 1.0 - 1.1 * pow(lat, 1.25) - 0.55 * max(0.0, above) / uRelief + uHeat;
  }
  float seasonalTemp(vec3 n, float mean) { return mean + 0.24 * n.y * uSeason; }
  // Own noise (distinct names), so this chunk can sit beside NOISE_GLSL in one shader.
  float cnHash(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
  }
  float cnNoise(vec3 x) {
    vec3 i = floor(x), f = fract(x);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(mix(cnHash(i), cnHash(i + vec3(1, 0, 0)), f.x), mix(cnHash(i + vec3(0, 1, 0)), cnHash(i + vec3(1, 1, 0)), f.x), f.y),
      mix(mix(cnHash(i + vec3(0, 0, 1)), cnHash(i + vec3(1, 0, 1)), f.x), mix(cnHash(i + vec3(0, 1, 1)), cnHash(i + vec3(1, 1, 1)), f.x), f.y),
      f.z);
  }
  /**
   * Live cover at direction d (in the cloud layer's own frame): the painted base plus two
   * octaves of slowly drifting noise. 0.5 is a cloud's edge. Used by the clouds themselves and
   * by every shadow lookup, so shadows keep the same shapes.
   */
  float cloudCover(float raw, vec3 d, float t) {
    float a = cnNoise(d * 7.0 + vec3(0.030, 0.020, -0.025) * t) - 0.5;
    float b = cnNoise(d * 19.0 - vec3(0.050, 0.035, 0.045) * t) - 0.5;
    return raw + a * 0.15 + b * 0.06;   // gentle, so the painted cell and streak patterns survive
  }
  /**
   * Prevailing winds, as eastward angular speed (radians a day) by latitude: trade winds blow
   * west near the equator, westerlies east at mid-latitudes, polar easterlies west again.
   * About three times real speeds, so a day's motion reads from orbit.
   */
  float windEast(float lat) { return -0.3 * cos(6.0 * lat) * smoothstep(1.5, 1.15, abs(lat)); }
  /** Spiral cloud bands of the active storms at direction d (world frame). */
  float stormCover(vec3 d) {
    float s = 0.0;
    for (int i = 0; i < 8; i++) {
      vec4 S = uStorms[i];
      if (S.w <= 0.001) continue;
      float R = abs(S.z);
      vec3 c = vec3(cos(S.y) * sin(S.x), sin(S.y), cos(S.y) * cos(S.x));
      float cd = dot(d, c);
      if (cd < cos(R * 2.6)) continue;
      float r = acos(clamp(cd, -1.0, 1.0)) / R;
      vec3 e = normalize(cross(vec3(0.0, 1.0, 0.0), c)), n = cross(c, e);
      float az = atan(dot(d, n), dot(d, e));
      float spin = sign(S.y);                       // cyclones turn the other way in the south
      bool tropical = S.z < 0.0;
      float arms = tropical ? 3.0 : 2.0, tight = tropical ? 2.6 : 1.6;
      // The arms turn with weather time, as a whole (a differential spin would wind them ever
      // tighter): anticlockwise in the north, the way they trail. At the idle weather rate a
      // tropical storm turns about once in 16 s, a big mid-latitude low once in 35 s.
      float turn = spin * uWeather * (tropical ? 40.0 : 18.0);
      float band = 0.5 + 0.5 * sin(arms * (az - turn) + spin * tight * log(max(r, 0.12)) * 3.0);
      float body = exp(-r * r * (tropical ? 1.6 : 1.1));
      float v = body * mix(0.45, 1.0, band) * mix(0.75, 1.15, cnNoise(d * 60.0 + float(i)));
      if (tropical) v = max(v, exp(-r * r * 9.0) * 1.1) * smoothstep(0.05, 0.13, r);   // dense core, clear eye
      else v = max(v * (0.75 + 0.35 * cos(az * spin - 1.2)), exp(-r * r * 5.0) * 0.85);  // comma tail, solid middle
      s = max(s, v * S.w);
    }
    return s;
  }
  /**
   * Cloud cover at direction d (world frame), carried by the wind bands. Two copies of the
   * pattern are advected and cross-faded half a cycle apart (the flow-map trick), so moving
   * cloud never smears into ever-longer streaks.
   */
  float coverAt(vec3 d, float lod) {
    float lat = asin(clamp(d.y, -1.0, 1.0));
    float phi = atan(d.z, -d.x);
    float w = windEast(lat), T = 0.5;
    float p0 = fract(uWeather / T), p1 = fract(uWeather / T + 0.5);
    float c0, c1;
    {
      float o = -w * p0 * T, co = cos(o), so = sin(o);
      vec3 q = vec3(d.x * co - d.z * so, d.y, d.x * so + d.z * co);
      float raw = textureLod(uCloudMap, vec2((phi + o) / 6.2831853, 0.5 + lat / 3.14159265), lod).a;
      c0 = cloudCover(raw, q, uCloudTime);
    }
    {
      float o = -w * p1 * T, co = cos(o), so = sin(o);
      vec3 q = vec3(d.x * co - d.z * so, d.y, d.x * so + d.z * co);
      float raw = textureLod(uCloudMap, vec2((phi + o) / 6.2831853, 0.5 + lat / 3.14159265), lod).a;
      c1 = cloudCover(raw, q, uCloudTime + 37.0);
    }
    float cover = mix(c0, c1, abs(1.0 - 2.0 * p0));
    float st = stormCover(d);
    return max(cover, st) + 0.12 * st;
  }
  // Wide ramp: thin cloud is translucent, only the cores are opaque.
  float cloudAlpha(float cover) { return smoothstep(0.47, 0.86, cover); }
  float cloudShade(vec3 p) {
    if (uCloudShadow <= 0.0) return 1.0;
    vec3 n = normalize(p);
    // The cloud shading this point sits up the line toward the sun, at cloud height: offset the
    // lookup sunward, more when the sun is low (capped near the terminator).
    #ifdef MERCATOR
      vec3 d = n;   // the map is lit from overhead: shadows sit straight under their clouds
    #else
      float mu = max(dot(n, uCloudSun), 0.25);
      vec3 d = normalize(n + (uCloudSun - n * dot(n, uCloudSun)) * (0.019 / mu));
    #endif
    return 1.0 - uCloudShadow * cloudAlpha(coverAt(d, 1.5));
  }
`;

/**
 * Terrain material: cloud shadows, plus detail the mesh is too coarse for. A noise gradient
 * bends the normal so slopes catch light like rock and scree, stronger on high ground, and
 * the same noise breaks up colour. Both fade out with distance, where they would only shimmer.
 */
export function makeTerrainMaterial(u: CloudUniforms, climate = false, patch?: PatchUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  // Ground patterns need the per-vertex climate (natural colours, smooth style only).
  if (climate) mat.defines = { ...mat.defines, USE_CLIMATE: '' };
  // The dune patch (dunepatch.ts): the same ground shading on a fine grid that carries the dunes.
  if (patch) mat.defines = { ...mat.defines, DUNE_PATCH: '' };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, patch ?? {}, shadowUniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCloudP;
        #ifdef USE_CLIMATE
          attribute vec2 climate;
          varying vec2 vClim;
        #endif
        #ifdef USE_CIV
          attribute vec2 civ;
          varying vec2 vCiv;
        #endif
        #ifdef DUNE_PATCH
          ${PATCH_GLSL}
        #endif`)
      .replace('#include <color_vertex>', `#include <color_vertex>
        #ifdef DUNE_PATCH
          patchSample(position.xy);
          vColor.rgb = pCol;
        #endif`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
        #ifdef DUNE_PATCH
          objectNormal = pNorm;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef DUNE_PATCH
          transformed = pSurf;
        #endif
        vCloudP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #ifdef USE_CLIMATE
          #ifdef DUNE_PATCH
            vClim = pClim;
          #else
            vClim = climate;
          #endif
        #endif
        #ifdef USE_CIV
          vCiv = civ;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;\n' + CLOUD_GLSL + SHADOW_GLSL + NOISE_GLSL + /* glsl */`
        // Ridged octaves (1 - |2n - 1|) give crest lines and gullies rather than uniform grain.
        float ridge(float n) { return 1.0 - abs(2.0 * n - 1.0); }
        float rockNoise(vec3 p) {
          return ridge(snoise01(p * 320.0)) * 0.5 + ridge(snoise01(p * 900.0 + 3.0)) * 0.3 + vnoise(p * 2600.0) * 0.2;
        }
        // Orbit-scale relief: ridge-and-valley texture a few hundred km across, the hillshaded
        // look of land from space. Takes over as the fine rock detail fades out.
        float landNoise(vec3 p) {
          // Simplex, not value noise: value noise's lattice showed as chevrons over whole continents.
          return ridge(snoise01(p * 45.0)) * 0.55 + ridge(snoise01(p * 120.0 + 3.0)) * 0.3 + snoise01(p * 300.0 + 7.0) * 0.15;
        }
        #ifdef USE_CLIMATE
          varying vec2 vClim;
          ${GROVE_GLSL}
        #endif
        #ifdef USE_CIV
          varying vec2 vCiv;
          uniform float uYear;
        #endif
        // --- Ground patterns, by climate. Each fades out once its features get smaller than a
        // few pixels (fwidth), so it adds detail up close without shimmering from orbit.
        // (aaFade, which fades patterns out below a few pixels, is in erosion.ts.)
        vec3 hash3(vec3 p) {
          p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
          return fract(sin(p) * 43758.5453);
        }
        /** Distance to the nearest cell wall of a 3D Voronoi pattern (0 on the wall), for cracks. */
        float voronoiEdge(vec3 x) {
          vec3 i = floor(x), f = fract(x);
          float d1 = 8.0, d2 = 8.0;
          for (int a = -1; a <= 1; a++) for (int b = -1; b <= 1; b++) for (int c = -1; c <= 1; c++) {
            vec3 g = vec3(a, b, c), r = g + hash3(i + g) - f;
            float d = dot(r, r);
            if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) d2 = d;
          }
          return sqrt(d2) - sqrt(d1);
        }
        // Dunes: simulated tiles (dunes.ts).
        #ifdef DUNE_PATCH
          varying float vDuneGeo;
          varying vec3 vTerrN, vBase, vEroGeo;
        #endif
` + EROSION_GLSL + DUNES_GLSL)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        float hAbove = length(vCloudP) - 1.0;
        #ifdef MERCATOR
          float camDist = uMapDist;
        #else
          float camDist = length(cameraPosition - vCloudP);
        #endif
        float detailFade = 1.0 - smoothstep(0.25, 1.4, camDist);
        float highland = smoothstep(0.12, 0.85, hAbove / uRelief);
        float rn = rockNoise(vCloudP);
        // Ice sheets (white ground) are smooth: little rock grain, a faint blue in their shading.
        float iceK = smoothstep(0.6, 0.8, min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b)));
        diffuseColor.rgb *= mix(1.0, 0.82 + 0.36 * rn, (0.35 + 0.65 * highland) * detailFade * (1.0 - 0.8 * iceK));
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.95, 0.98, 1.03), iceK);
        float farFade = smoothstep(0.12, 0.8, camDist) * step(0.0005, hAbove);
        float ln = landNoise(vCloudP);
        diffuseColor.rgb *= mix(1.0, 0.74 + 0.52 * ln, (0.45 + 0.55 * highland) * farFade * (1.0 - 0.75 * iceK));
        float foot = length(fwidth(vCloudP));
        float desertW = 0.0;
        vec4 duneS = vec4(0.0);   // dunes(): height, slip face, slope east, north
        float duneK = 0.0, duneRaw = 0.0;
        // Erosion (erosion.ts): gullies running down the meshed slope, branching as they go.
        // eroH says how deep in a gully this is; eroGrad bends the normal (below).
        // On the dune patch the point and slope are the terrain's, before the patch's own relief,
        // so the gullies here line up with the ones its vertices raised.
        #ifdef DUNE_PATCH
          vec3 eroP = vBase;
          float eroHA = length(vBase) - 1.0;
        #else
          vec3 eroP = vCloudP;
          float eroHA = hAbove;
        #endif
        float eroH = 0.0, eroK = 0.0;
        vec3 eroGrad = vec3(0.0);
        float poolK = 0.0;   // standing water in marshes: shiny (roughness, below)
        if (uErosion > 0.0 && eroHA > 0.0001 && camDist < 0.22 && iceK < 0.99) {
          #if defined(DUNE_PATCH)
            vec3 wN = normalize(vTerrN);
          #elif defined(MERCATOR)
            vec3 wN = normalize(normalize(vNormal) * mercFrame(vCloudP));
          #else
            vec3 wN = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
          #endif
          vec3 up = normalize(eroP);
          // From high up the gullies read as hatching: they fade out, the orbit-scale relief
          // (landNoise) takes over.
          float eroFar = 1.0 - smoothstep(0.08, 0.22, camDist);
          float cz = max(dot(wN, up), 0.3);
          vec3 macro = -(wN - up * dot(wN, up)) / cz;
          // Sand seas are flat between their dunes; rocky desert keeps some dry channels (wadis).
          #ifdef USE_CLIMATE
            float sandE = smoothstep(0.24, 0.12, vClim.x) * smoothstep(0.4, 0.55, vClim.y) * (1.0 - highland);
          #else
            float sandE = 0.0;
          #endif
          // In the sand seas themselves (the same mask as the desert colours) dunes cover
          // everything: no erosion at all, which also saves its cost there.
          if (sandE > 0.0) eroFar *= 1.0 - sandE * mix(0.6, 1.0, smoothstep(0.2, 0.5, sandSea(eroP)));
          // Comes in over the first stretch above the shore rather than at a contour (it ended in
          // a hard line along every coast), the line itself wavering.
          eroFar *= smoothstep(0.0001, 0.001, eroHA + 0.0004 * snoise(eroP * 150.0));
          if (eroFar >= 0.01) {
            // The mesh is nearly flat between ranges: rolling hills (shaded too) give the water
            // something to carve.
            vec3 hg = hillGrad(eroP, up, smoothstep(0.02, 0.3, eroHA / uRelief)) * (1.0 - iceK);
            macro += hg;
            // Strength follows the slope smoothly: flats stay flat, and no hard edge where it starts.
            eroK = smoothstep(0.0, 0.07, length(macro)) * (1.0 - iceK) * uErosion * eroFar;
            eroGrad = hg * uErosion * eroFar;
            if (eroK > 0.0) {
              vec4 er = erosion(eroP, up, macro, foot);
              eroH = er.x;
              eroGrad += er.yzw * eroK;
            }
            // On the patch the hills and coarse gullies are relief already (in the normal): shade
            // only what its vertices didn't raise. (Fades back in at the patch edge with them.)
            #ifdef DUNE_PATCH
              eroGrad -= vEroGeo;
            #endif
          }
        }
        #ifdef USE_CLIMATE
          if (hAbove > 0.0004) {
            float moist = vClim.x, temp = vClim.y;
            float lowland = 1.0 - highland;
            // Deserts: dune fields (shaded in the normal step below) and the odd white salt pan in
            // low basins.
            desertW = smoothstep(0.24, 0.12, moist) * smoothstep(0.4, 0.55, temp) * lowland;
            // Hot deserts at the scale seen from orbit: dark, rusty rock on plateaus and massifs
            // (hamada; the Tibesti, the Ahaggar), pale gravel plains (reg) between the sand seas,
            // and the sand seas themselves a warmer orange. Highland is included, unlike dunes.
            float aridW = smoothstep(0.24, 0.12, moist) * smoothstep(0.4, 0.55, temp);
            float seaMask = 0.0;
            if (aridW > 0.0) {
              seaMask = smoothstep(-0.55, 0.05, snoise(vCloudP * 40.0) + 0.25 * snoise(vCloudP * 160.0));
              float plateau = smoothstep(0.08, 0.3, hAbove / uRelief + 0.08 * snoise(vCloudP * 50.0 + 2.0));
              vec3 wq = vCloudP * 6.0 + vec3(snoise(vCloudP * 11.0), snoise(vCloudP * 11.0 + 4.0), 0.0) * 0.5;
              float rockyN = smoothstep(0.15, 0.85, snoise(wq + 7.0) + 0.35 * snoise(vCloudP * 30.0)) * 0.7;
              float hamada = max(plateau, rockyN * (1.0 - seaMask) * 0.8);
              vec3 base = diffuseColor.rgb;
              vec3 reg = base * vec3(1.03, 1.0, 0.95) * 1.04;
              vec3 erg = base * vec3(1.08, 0.97, 0.84);
              vec3 rock = base * vec3(0.62, 0.5, 0.42) * (0.9 + 0.2 * snoise(vCloudP * 220.0));
              vec3 surf = mix(reg, erg, seaMask);
              surf = mix(surf, rock, hamada);
              diffuseColor.rgb = mix(base, surf, aridW);
            }
            if (desertW > 0.0) {
              // Salt pans: few, large and ragged, in the lowest basins only. (Thresholding a single
              // noise's peaks gave an even grid of white dots.)
              float pn = 0.6 * snoise(vCloudP * 9.0) + 0.3 * snoise(vCloudP * 31.0 + 4.0) + 0.1 * snoise(vCloudP * 140.0);
              float pan = smoothstep(0.42, 0.5, pn) * (1.0 - smoothstep(0.03, 0.09, hAbove / uRelief));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.77, 0.70), pan * desertW * 0.85);
              // Which dunes where (dunes.ts).
              vec4 dw = duneWeights(vCloudP, moist, desertW, seaMask, duneRaw);
              duneK = duneRaw * aaFade(DUNE * 0.6, foot);
              if (duneK > 0.0) {
                float dh;
                duneS = dunes(vCloudP, dw, dh);
                // Crests are bright, loose orange sand; the flats between are paler and greyer;
                // slip faces sit in their own shade whatever the light.
                vec3 sand = mix(diffuseColor.rgb * vec3(1.0, 0.97, 0.92), diffuseColor.rgb * vec3(1.12, 1.0, 0.82), duneS.x);
                diffuseColor.rgb = mix(diffuseColor.rgb, sand * (0.88 + 0.22 * duneS.x) * (1.0 - 0.3 * duneS.y), duneK);
              }
            }
            // Grass and steppe: mottled, sun-bleached patches over a few kilometres.
            float grassW = smoothstep(0.12, 0.25, moist) * smoothstep(0.62, 0.42, moist) * smoothstep(0.25, 0.4, temp) * lowland;
            if (grassW > 0.0) {
              float m = snoise01(vCloudP * 900.0) * 0.55 + snoise01(vCloudP * 2600.0) * 0.3 + snoise01(vCloudP * 7000.0) * 0.15;
              float k = grassW * aaFade(0.0006, foot);
              diffuseColor.rgb *= mix(1.0, 0.76 + 0.48 * m, k);
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.12, 1.04, 0.8), smoothstep(0.55, 0.8, m) * k * 0.6);
            }
            // Forest: dense canopy in the groves, with lumpy crowns up close, and paler, yellower
            // clearings between. Open country gets the odd dark grove. The trees placed near the
            // camera follow the same pattern (groves.ts), so canopy and trees agree.
            // Forest is where it's moist enough and warmer than tundra (by climate: a test on the
            // ground colour missed dark taiga, which then read as bare hills past the trees).
            float forestW = smoothstep(0.3, 0.45, moist) * smoothstep(0.17, 0.24, temp) * lowland;
            float gv = groveField(vCloudP);
            if (forestW > 0.0) {
              // Fades out where groves are too small to resolve: from orbit the waves of the
              // grove pattern average into chevron stripes.
              // Groves only come in on descent; from orbit a broad, irregular canopy shade stands in
              // (the grove waves, seen together from afar, lined up into chevrons).
              float groveNear = 1.0 - smoothstep(0.18, 0.45, camDist);
              float broad = smoothstep(-0.4, 0.5, snoise(vCloudP * 60.0) + 0.5 * snoise(vCloudP * 170.0 + 2.0));
              // Wetter forest has fewer clearings (matches the offsets in lodflora.ts).
              float closed = smoothstep(0.6, 0.72, moist) * mix(0.35, 0.5, smoothstep(0.65, 0.75, temp));
              float inGrove = mix(mix(0.45 + closed, 0.85 + closed * 0.3, broad), smoothstep(-0.35, 0.25, gv + closed), groveNear);
              float crowns = snoise01(vCloudP * 3200.0) * 0.6 + snoise01(vCloudP * 9000.0) * 0.4;
              // Under the canopy the ground takes the trees' own colours (flora.ts), as forest looks
              // from the air: dark, bluer in the north. Past the drawn trees (plants are small, so
              // only drawn near the view) this is what carries the forest.
              vec3 canopy = mix(vec3(0.026, 0.066, 0.03), vec3(0.04, 0.12, 0.025), smoothstep(0.3, 0.7, temp));
              diffuseColor.rgb = mix(diffuseColor.rgb, canopy, forestW * inGrove * 0.6);
              diffuseColor.rgb *= mix(1.0, 0.85, forestW * inGrove);
              diffuseColor.rgb *= mix(1.0, 0.75 + 0.35 * crowns, forestW * inGrove * aaFade(0.0003, foot));
              // Clearings: sun-bleached grass in warm forest, moss and bog in cold forest.
              vec3 glade = mix(vec3(0.82, 0.98, 0.8), vec3(1.18, 1.12, 0.82), smoothstep(0.35, 0.55, temp));
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * glade, forestW * (1.0 - inGrove) * 0.55);
            }
            if (grassW > 0.0) {
              diffuseColor.rgb *= mix(1.0, 0.82, grassW * smoothstep(0.25, 0.7, gv) * smoothstep(0.3, 0.45, moist) * (1.0 - smoothstep(0.18, 0.45, camDist)));
            }
            // Wetlands: on low, flat, wet ground (and on big rivers' floodplains even in drier
            // country, like the Sudd; and on low coasts), reed beds broken by pools of standing
            // water that catch the sun.
            {
              #ifdef MERCATOR
                vec3 wNw = normalize(normalize(vNormal) * mercFrame(vCloudP));
              #else
                vec3 wNw = normalize((vec4(vNormal, 0.0) * viewMatrix).xyz);
              #endif
              float level = smoothstep(0.965, 0.99, dot(wNw, normalize(vCloudP)));
              float low = smoothstep(0.0045, 0.0012, hAbove);
              float riverWet = smoothstep(0.08, 0.35, groundRiver(vCloudP).y) * smoothstep(0.2, 0.45, moist);
              float coastWet = smoothstep(0.0009, 0.0004, hAbove) * smoothstep(0.35, 0.55, moist);
              float wet = max(max(smoothstep(0.45, 0.62, moist) * low, riverWet * low * 1.2), coastWet) * level * (1.0 - iceK);
              // Broad patches: not every wet lowland is marsh.
              wet *= smoothstep(0.05, 0.55, snoise(vCloudP * 22.0 + 17.0) + 0.5 * snoise(vCloudP * 70.0));
              if (wet > 0.01) {
                vec3 reed = mix(vec3(0.2, 0.2, 0.09), vec3(0.13, 0.17, 0.07), smoothstep(0.4, 0.7, temp));
                float rn = snoise01(vCloudP * 1500.0) * 0.6 + snoise01(vCloudP * 4500.0) * 0.4;
                diffuseColor.rgb = mix(diffuseColor.rgb, reed * (0.8 + 0.4 * rn), wet * 0.75);
                // Pools: ragged, thresholded simplex at two scales (value noise showed its grid).
                float pn = snoise(vCloudP * 700.0) * 0.6 + snoise(vCloudP * 2000.0 + 3.0) * 0.3 + snoise(vCloudP * 5500.0 + 7.0) * 0.1;
                poolK = smoothstep(0.3, 0.38, pn + 0.3 * (wet - 0.7)) * wet * aaFade(0.0016, foot);
                diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.035, 0.055, 0.065), poolK * 0.9);
              }
            }
            // Tundra: frost polygons, a net of dark cracks with the odd meltwater pond.
            float tundraW = smoothstep(0.08, 0.16, temp) * smoothstep(0.34, 0.24, temp) * lowland;
            if (tundraW > 0.0) {
              // From the air: mottled — pale lichen, rusty heath, mossy green in hollows — and
              // pocked with ponds and thaw lakes.
              float mt = snoise(vCloudP * 70.0) * 0.6 + snoise(vCloudP * 230.0 + 1.0) * 0.4;
              vec3 heath = mix(diffuseColor.rgb * vec3(1.18, 1.12, 1.0), diffuseColor.rgb * vec3(0.88, 1.06, 0.82), smoothstep(-0.5, 0.5, mt));
              diffuseColor.rgb = mix(diffuseColor.rgb, heath, tundraW);
              float lakesT = smoothstep(0.55, 0.62, snoise(vCloudP * 160.0) * 0.7 + snoise(vCloudP * 520.0 + 9.0) * 0.3) * smoothstep(0.3, 0.45, moist);
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.05, 0.08, 0.11), lakesT * tundraW * 0.85);
              float k = tundraW * aaFade(0.0007, foot);
              // Warped, so the polygons are irregular rather than paving stones.
              vec3 q = vCloudP * 2200.0 + vec3(snoise01(vCloudP * 900.0), snoise01(vCloudP * 900.0 + 7.0), snoise01(vCloudP * 900.0 + 13.0)) * 1.2;
              float edge = voronoiEdge(q);
              float crack = 1.0 - smoothstep(0.0, 0.08, edge);
              diffuseColor.rgb *= mix(1.0, 1.0 - 0.18 * crack * (0.5 + snoise01(vCloudP * 600.0)), k);
              float pond = smoothstep(0.82, 0.86, snoise01(vCloudP * 3000.0)) * smoothstep(0.25, 0.5, moist);
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.06, 0.1, 0.14), pond * k * 0.8);
            }
          }
        #endif
        // Rivers green the land along them (the Nile from space): a strip right along the water,
        // and a fainter valley floor around it, from the water map (terrainshadow.ts). Strongest
        // in dry country, where nothing else is green; in wet country a deeper green.
        #ifdef USE_CLIMATE
          if (hAbove > 0.0002) {
            vec2 rv = groundRiver(vCloudP);
            if (rv.x + rv.y > 0.002) {
              float dryR = smoothstep(0.5, 0.18, vClim.x) * smoothstep(0.15, 0.3, vClim.y);
              // A crisp-edged strip (irrigated and flooded land ends abruptly at the desert), with
              // ragged edges at several scales, and a faint valley floor around it.
              float rag = snoise(vCloudP * 700.0) * 0.55 + snoise(vCloudP * 2200.0) * 0.3 + snoise(vCloudP * 6000.0) * 0.15;
              float nearR = smoothstep(0.07, 0.13, rv.x + 0.05 * rag);
              float wideR = smoothstep(0.02, 0.25, rv.y);
              vec3 lush = vec3(0.075, 0.14, 0.035) * (0.85 + 0.3 * snoise01(vCloudP * 3000.0));
              vec3 valley = mix(diffuseColor.rgb, vec3(0.2, 0.22, 0.1), 0.5);
              float a = (1.0 - iceK) * mix(0.3, 1.0, dryR);
              diffuseColor.rgb = mix(diffuseColor.rgb, valley, wideR * 0.5 * a);
              diffuseColor.rgb = mix(diffuseColor.rgb, lush, nearR * 0.92 * a);
            }
          }
        #endif
        // Beach: a thin, wavering strip of sand right at the sea's edge, in all but cold climates.
        // Thin and partial: from orbit a full-strength strip outlined every continent in yellow.
        // Within the water map's region the shore is found by distance from the sea (a fixed
        // few km), not by height, which on gentle coasts painted sand bands tens of km wide.
        // Where the land rises steeply behind the shore it is rock, not sand.
        #ifdef USE_CLIMATE
          if (hAbove > -0.0004 && hAbove < 0.004) {
            float cs = groundCoast(vCloudP);
            float warmB = smoothstep(0.25, 0.4, vClim.y);
            if (cs >= 0.0) {
              float wob = 0.06 * snoise(vCloudP * 900.0) + 0.04 * snoise(vCloudP * 2800.0);
              float shore = smoothstep(0.1, 0.32, cs + wob) * step(-0.0002, hAbove);
              if (shore > 0.0) {
                // How high the land is a few km inland: up the coast field's slope.
                float e; vec2 uv = groundUv(vCloudP, e);
                vec2 d = vec2(1.0 / 512.0, 0.0);
                vec2 gr = vec2(texture(uShRiv, uv + d.xy).b - texture(uShRiv, uv - d.xy).b,
                               texture(uShRiv, uv + d.yx).b - texture(uShRiv, uv - d.yx).b);
                vec2 inland = -gr / max(length(gr), 1e-6);
                float km = 0.0005 / (2.0 * uShR);   // ~3 km in uv
                float hIn = texture(uShH, uv + inland * km * 2.0).r / 50.0;
                float cliff = smoothstep(0.0016, 0.0035, hIn + 0.0006 * snoise(vCloudP * 200.0));
                vec3 rockC = vec3(0.3, 0.28, 0.25) * (0.85 + 0.3 * snoise01(vCloudP * 2400.0));
                vec3 sand = vec3(0.69, 0.58, 0.33);
                diffuseColor.rgb = mix(diffuseColor.rgb, mix(sand, rockC, cliff), shore * mix(0.75 * warmB, 0.85, cliff));
              }
            } else if (hAbove < 0.0006) {
              float bk = 1.0 - smoothstep(0.00005, 0.00035, hAbove + 0.00012 * snoise(vCloudP * 300.0));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.69, 0.58, 0.33), bk * warmB * 0.7);
            }
          }
        #endif
        // Water gathers in the gullies: their floors are greener and darker, the spurs between
        // them barer and paler, most of all in dry country (as in the Ethiopian highlands).
        if (eroK > 0.0) {
          #ifdef USE_CLIMATE
            float dryE = 1.0 - smoothstep(0.4, 0.75, vClim.x);
          #else
            float dryE = 0.5;
          #endif
          float floorK = smoothstep(0.08, -0.25, eroH) * eroK;
          float spurK = smoothstep(0.0, 0.3, eroH) * eroK;
          diffuseColor.rgb *= mix(vec3(1.0), mix(vec3(0.78, 0.86, 0.74), vec3(0.5, 0.7, 0.42), dryE), floorK);
          diffuseColor.rgb *= mix(vec3(1.0), vec3(1.16, 1.07, 0.9), spurK * (0.3 + 0.7 * dryE));
        }
        // Centuries: farmland (a patchwork of fields with hedges) and towns (blocks and streets),
        // each from the year the history says it reached this spot.
        float civTown = 0.0;
        #ifdef USE_CIV
          if (uYear >= 0.0 && hAbove > 0.0004) {
            // Ragged edges: noise shifts when each spot is reached.
            float farm = smoothstep(0.0, 40.0, uYear - vCiv.x + (vnoise(vCloudP * 500.0) - 0.5) * 260.0 + (vnoise(vCloudP * 2000.0) - 0.5) * 90.0);
            civTown = smoothstep(0.0, 30.0, uYear - vCiv.y + (vnoise(vCloudP * 900.0) - 0.5) * 200.0 + (vnoise(vCloudP * 3000.0) - 0.5) * 80.0);
            vec3 n = normalize(vCloudP);
            float lat = asin(clamp(n.y, -1.0, 1.0));
            vec2 geo = vec2(atan(n.x, n.z) * cos(lat), lat);
            if (farm > 0.0) {
              const float FIELD = 0.0011;     // ~7 km: exaggerated, like everything here
              float ang = vnoise(vCloudP * 25.0) * 3.14159;
              vec2 uv = mat2(cos(ang), sin(ang), -sin(ang), cos(ang)) * geo / FIELD;
              uv.y += floor(uv.x) * 0.37;                 // staggered strips, not a chessboard
              vec2 id = floor(uv), f = fract(uv);
              float rnd = fract(sin(dot(id, vec2(12.9898, 78.233))) * 43758.5453);
              vec3 crop = rnd < 0.3 ? vec3(0.10, 0.16, 0.04) : rnd < 0.55 ? vec3(0.36, 0.30, 0.12)
                        : rnd < 0.75 ? vec3(0.20, 0.14, 0.08) : vec3(0.07, 0.12, 0.03);
              float hedge = smoothstep(0.0, 0.07, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
              vec3 fields = mix(crop * 0.55, crop * (0.85 + 0.3 * vnoise(vCloudP * 4000.0)), hedge);
              // From afar, farmland is the land a little lighter and yellower, with a faint grain.
              vec3 far = mix(diffuseColor.rgb, vec3(0.26, 0.25, 0.10), 0.45) * (0.85 + 0.3 * vnoise(vCloudP * 400.0));
              diffuseColor.rgb = mix(diffuseColor.rgb, mix(far, fields, aaFade(FIELD * 0.3, foot)), farm * 0.75);
            }
            if (civTown > 0.0) {
              const float BLOCK = 0.0005;
              vec2 uv = geo / BLOCK;
              vec2 f = fract(uv), id = floor(uv);
              float rnd = fract(sin(dot(id, vec2(39.3468, 11.135))) * 43758.5453);
              float street = 1.0 - smoothstep(0.0, 0.1, min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y)));
              vec3 roofs = mix(vec3(0.30, 0.13, 0.08), vec3(0.32, 0.30, 0.27), rnd);
              vec3 town = mix(roofs, vec3(0.42, 0.40, 0.36), street);
              vec3 far = vec3(0.27, 0.21, 0.17);
              diffuseColor.rgb = mix(diffuseColor.rgb, mix(far, town, aaFade(BLOCK * 0.4, foot)), civTown * 0.8);
            }
          }
        #endif
        if (uSeason != 0.0 && hAbove > 0.0006) {
          vec3 sn = normalize(vCloudP);
          // Winter browns the mid-latitude vegetation of the cold hemisphere.
          float winter = max(0.0, -sign(sn.y) * uSeason) * smoothstep(0.2, 0.55, abs(sn.y));
          float green = clamp((diffuseColor.g - max(diffuseColor.r, diffuseColor.b)) * 6.0, 0.0, 1.0);
          float l = dot(diffuseColor.rgb, vec3(0.3, 0.55, 0.15));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.12, 0.98, 0.7) * l, green * winter * 0.55);
        }
        diffuseColor.rgb *= cloudShade(vCloudP);`)
      .replace('#include <roughnessmap_fragment>', /* glsl */`#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.12, poolK);`)
      .replace('#include <emissivemap_fragment>', /* glsl */`#include <emissivemap_fragment>
        // Town lights on the night side.
        #if defined(USE_CIV) && !defined(MERCATOR)
          if (civTown > 0.0) {
            float night = 1.0 - smoothstep(-0.12, 0.08, dot(normalize(vCloudP), uCloudSun));
            float spark = smoothstep(0.35, 0.9, vnoise(vCloudP * 6000.0));
            totalEmissiveRadiance += vec3(1.0, 0.72, 0.38) * civTown * night * (0.25 + 1.6 * spark);
          }
        #endif`)
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
        // World-space vectors into view space (on the map, view space is east/north/up).
        #ifdef MERCATOR
          #define TOVIEW(v) (mercFrame(vCloudP) * (v))
        #else
          #define TOVIEW(v) ((viewMatrix * vec4(v, 0.0)).xyz)
        #endif
        // The surface's own normal, before any detail: slope tests far away use it, because
        // the detail normal is mostly noise at that scale and turned rock and snow to speckle.
        vec3 geoN = normal;
        if (detailFade > 0.0 && hAbove > 0.0) {
          vec3 up = normalize(vCloudP);
          vec3 t1 = normalize(cross(up, abs(up.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
          vec3 t2 = cross(up, t1);
          float e = 0.0003;
          vec3 grad = t1 * (rockNoise(vCloudP + t1 * e) - rn) + t2 * (rockNoise(vCloudP + t2 * e) - rn);
          float amp = (0.15 + 0.6 * highland) * detailFade * (1.0 - 0.7 * iceK) * (1.0 - 0.75 * eroK);
          normal = normalize(normal - TOVIEW(grad * amp));
        }
        if (uErosion > 0.0) normal = normalize(normal - TOVIEW(eroGrad));
        // Dunes catch the light on their windward slopes and shade their lee faces.
        // (On the dune patch the nearer dunes are real geometry, already in the normal.)
        #ifdef DUNE_PATCH
          float duneShade = 1.0 - vDuneGeo;
        #else
          float duneShade = 1.0;
        #endif
        if (duneK * duneShade > 0.0) {
          vec3 up = normalize(vCloudP);
          vec3 east = normalize(vec3(up.z, 0.0, -up.x));
          vec3 north = cross(up, east);
          normal = normalize(normal - TOVIEW((east * duneS.z + north * duneS.w) * duneK * duneShade));
        }
        // Rock strata: bands across steep high ground, as layered rock shows in cliffs.
        if (highland > 0.0 && hAbove > 0.0) {
          #ifdef MERCATOR
            float steep = 1.0 - normalize(mix(geoN, normal, detailFade)).z;
          #else
            float steep = 1.0 - dot(normalize((vec4(normalize(mix(geoN, normal, detailFade)), 0.0) * viewMatrix).xyz), normalize(vCloudP));
          #endif
          float band = sin(hAbove / uRelief * 70.0 + (vnoise(vCloudP * 260.0) - 0.5) * 6.0);
          float k = smoothstep(0.04, 0.16, steep) * highland * aaFade(0.0005, foot);
          diffuseColor.rgb *= mix(1.0, 0.86 + 0.14 * band, k);
        }
        if (farFade > 0.0) {
          vec3 up = normalize(vCloudP);
          vec3 t1 = normalize(cross(up, abs(up.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
          vec3 t2 = cross(up, t1);
          float e = 0.002;
          vec3 grad = t1 * (landNoise(vCloudP + t1 * e) - ln) + t2 * (landNoise(vCloudP + t2 * e) - ln);
          float amp = (1.0 + 3.0 * highland) * farFade * (1.0 - 0.6 * iceK);
          normal = normalize(normal - TOVIEW(grad * amp));
        }
        // Bare rock, per pixel, where the detailed surface (normal included) is steep on high
        // ground: crests and cliffs show rock while slopes and valleys keep their vegetation,
        // as mountains look from the air, rather than whole ranges painted one flat brown.
        if (uSnow > 0.0 && hAbove > 0.0004) {
          #ifdef MERCATOR
            float rslope = 1.0 - normalize(mix(geoN, normal, detailFade)).z;
          #else
            float rslope = 1.0 - dot(normalize((vec4(normalize(mix(geoN, normal, detailFade)), 0.0) * viewMatrix).xyz), normalize(vCloudP));
          #endif
          float hiK = smoothstep(0.15, 0.55, hAbove / uRelief);
          float rockK = smoothstep(0.16, 0.34, rslope + 0.08 * hiK) * smoothstep(0.1, 0.35, hAbove / uRelief);
          vec3 rock = vec3(0.30, 0.28, 0.25) * (0.85 + 0.3 * rn);
          diffuseColor.rgb = mix(diffuseColor.rgb, rock, clamp(rockK * (0.55 + 0.45 * hiK), 0.0, 0.9));
        }
        // Snow, per pixel: where it is cold enough for the height, latitude and season. Done
        // here rather than per vertex, where its edge broke along the mesh triangles. It sheds
        // off steep faces and lies in streaks along ridges, so ranges read as rock with white
        // crests, not white blobs. It cools with height at about half the generator's rate:
        // the generator calls whole plateaus frozen, but only their crests should be white.
        if (uSnow > 0.0 && hAbove > 0.0004) {
          vec3 sn = normalize(vCloudP);
          float lat = abs(asin(clamp(sn.y, -1.0, 1.0))) / 1.5707963;
          float st = seasonalTemp(sn, 1.0 - 1.1 * pow(lat, 1.25) - 0.5 * hAbove / uRelief + uHeat);
          // Lying snow at an equinox: polar margins and high ground. (0.27 put snow over all the
          // tundra and much of the taiga.) The season moves it, via seasonalTemp.
          float line = 0.15;
          float edge = snoise(vCloudP * 25.0) * 0.06 + snoise(vCloudP * 110.0 + 3.0) * 0.03 + snoise(vCloudP * 420.0 + 5.0) * 0.015;
          float snow = smoothstep(line + 0.04, line - 0.06, st + edge);
          #ifdef MERCATOR
            float slope = 1.0 - normalize(mix(geoN, normal, detailFade)).z;
          #else
            float slope = 1.0 - dot(normalize((vec4(normalize(mix(geoN, normal, detailFade)), 0.0) * viewMatrix).xyz), sn);
          #endif
          // Value noise shows its grid once thresholded, so warp it and rotate each octave.
          vec3 q = vCloudP * 160.0;
          q += vec3(vnoise(q * 0.37), vnoise(q * 0.37 + 5.2), vnoise(q * 0.37 + 9.1)) * 2.5;
          mat3 R = mat3(0.8, 0.6, 0.0, -0.36, 0.48, 0.8, 0.48, -0.64, 0.6);
          float streak = vnoise(q) * 0.5 + vnoise(R * q * 2.1) * 0.3 + vnoise(R * R * q * 4.3) * 0.2;
          float lie = (1.0 - 0.9 * smoothstep(0.08, 0.3, slope)) * smoothstep(0.25, 0.65, streak + snow * 0.35);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), clamp(snow * lie, 0.0, 1.0) * 0.95);
          // Glaciers: ice fills the high valleys and flows down them, past the snow line, as
          // tongues streaked along the flow with dark lines of rock debris (moraines). Valleys
          // from the shadow height map: ground lower than the ring around it.
          float gfade;
          vec2 guv = groundUv(vCloudP, gfade);
          if (gfade > 0.0 && st < line + 0.13 && hAbove / uRelief > 0.15) {
            float rr = 0.0015 / (2.0 * uShR);
            float hc = texture(uShH, guv).r / 50.0, ring = 0.0, ring2 = 0.0;
            for (int i = 0; i < 6; i++) {
              vec2 o = vec2(cos(float(i) * 1.0472), sin(float(i) * 1.0472));
              ring += texture(uShH, guv + o * rr).r / 50.0;
              ring2 += texture(uShH, guv + o * rr * 3.0).r / 50.0;
            }
            // Valleys at two scales: side valleys a few km across, and the main valleys.
            // Valleys: the floors of the erosion filter's gullies (the valleys you see; the height
            // map is too coarse for them), and the broad valleys of the height map.
            float valley = max(smoothstep(-0.06, -0.26, eroH) * smoothstep(0.0, 0.3, eroK) * 1.1,
                               smoothstep(0.0003, 0.0015, ring2 / 6.0 - hc));
            valley = clamp(valley, 0.0, 1.0);
            float iceZone = smoothstep(line + 0.13, line + 0.03, st + edge * 0.5);
            float gl = valley * iceZone * gfade * smoothstep(0.15, 0.3, hAbove / uRelief);
            if (gl > 0.01) {
              // Downhill, from the height map, for streaks along the flow.
              vec2 gh = vec2(texture(uShH, guv + vec2(rr, 0.0)).r - texture(uShH, guv - vec2(rr, 0.0)).r,
                             texture(uShH, guv + vec2(0.0, rr)).r - texture(uShH, guv - vec2(0.0, rr)).r);
              vec3 down = -(uShE * gh.x + uShN * gh.y);
              down = normalize(down - sn * dot(down, sn) + sn.yzx * 1e-5);
              vec3 across = cross(sn, down);
              float u = dot(vCloudP, across), v = dot(vCloudP, down);
              float flow = snoise(vec3(u * 2500.0, v * 180.0, 3.0)) * 0.6 + snoise(vec3(u * 7000.0, v * 500.0, 9.0)) * 0.4;
              float moraine = 1.0 - smoothstep(0.03, 0.1, abs(sin(u * 1400.0 + snoise(vec3(u * 300.0, v * 60.0, 1.0)) * 2.0)));
              vec3 ice = vec3(0.78, 0.86, 0.93) * (0.9 + 0.12 * flow);
              ice = mix(ice, vec3(0.32, 0.3, 0.28), moraine * 0.55 * aaFade(0.0005, foot));
              diffuseColor.rgb = mix(diffuseColor.rgb, ice, smoothstep(0.05, 0.4, gl) * 0.92);
            }
          }
        }`);
    // Shadows cast by the terrain dim the sun's direct light (terrainshadow.ts).
    sh.fragmentShader = shadowLights(sh.fragmentShader, 'vCloudP');
  };
  // The atmosphere (atmosphere.ts): haze over distance, sunlight reddened at low sun.
  applyAerial(mat, true);
  return mat;
}

/**
 * Patches a built-in lit material so clouds darken what is under them. Handles instancing.
 * With `sun`, it also darkens things past the terminator: small objects like trees have faces
 * that point at a sun below their horizon, and with no shadows those would glow at night.
 */
export function applyCloudShadow(
  mat: THREE.Material, u: CloudUniforms, sun?: { uSunDir: { value: THREE.Vector3 } },
  fade?: { uFadeNear: { value: number }; uFadeFar: { value: number } },
) {
  // With `fade`, each instance grows from nothing at uFadeFar to full size at uFadeNear
  // (scaled about its base, so it rises out of the ground) instead of popping in.
  // Centuries: a plant with a 'cut' year (0 = never) is gone once the shown year passes it,
  // cleared for fields and towns.
  const grow = fade ? `
        #ifdef USE_INSTANCING
          vec4 fadeO = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          transformed *= 1.0 - smoothstep(uFadeNear, uFadeFar, length(cameraPosition - fadeO.xyz));
          if (cut > 0.5 && uYear >= 0.0) transformed *= 1.0 - smoothstep(cut, cut + 25.0, uYear);
        #endif` : '';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, sun ?? {}, fade ?? {}, fade ? patchUniforms : {}, fade ? shadowUniforms : {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;' + (fade ? '\nuniform float uFadeNear, uFadeFar, uYear;\nattribute float cut;\n' + LIFT_GLSL : ''))
      // Plants stand on the ground as the high-detail patch shapes it (dunepatch.ts).
      .replace('#include <project_vertex>', fade ? `
        vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          mvPosition.xyz += normalize(fadeO.xyz) * patchLift(fadeO.xyz);
        #endif
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;` : '#include <project_vertex>')
      .replace('#include <begin_vertex>', `#include <begin_vertex>${grow}
        vec4 cloudP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cloudP = instanceMatrix * cloudP;
        #endif
        vCloudP = (modelMatrix * cloudP).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;\n' + CLOUD_GLSL + (sun ? 'uniform vec3 uSunDir;\n' : ''))
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= cloudShade(vCloudP);' +
        (sun ? '\ndiffuseColor.rgb *= mix(0.12, 1.0, smoothstep(-0.12, 0.12, dot(normalize(vCloudP), uSunDir)));' : ''));
    // Plants stand in the terrain's shadows too.
    if (fade) sh.fragmentShader = shadowLights(sh.fragmentShader.replace('#include <common>', '#include <common>\n' + SHADOW_GLSL), 'vCloudP');
  };
  mat.needsUpdate = true;
}

export function makeWaterMaterial(cloud: CloudUniforms, fade = false): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    defines: fade ? { USE_FADE: '' } : {},
    fog: true,
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...cloud,
      ...(fade ? patchUniforms : {}),
      ...shadowUniforms,
      ...atmoUniforms,
      ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      // Open ocean seen from space is deep navy, close to black; turquoise belongs to shallow
      // banks only (the Bahamas, not every coast).
      uShallow: { value: new THREE.Color(0x3aa8a6) },
      uMid: { value: new THREE.Color(0x0f4a74) },
      uDeep: { value: new THREE.Color(0x041a33) },
      uSky: { value: new THREE.Color(0x8fb4d8) },
      uDepthScale: { value: 0.014 },
      uFoam: { value: 0.0013 },
      uVis: { value: 1 },
    },
    vertexShader: /* glsl */`
      attribute float depth;
      varying float vDepth;
      varying vec3 vWorld;
      #ifdef USE_FADE
        attribute float fade;
        varying float vFade;
        ${LIFT_GLSL}
      #endif
      ${MERC_GLSL}
      #include <fog_pars_vertex>
      void main() {
        vDepth = depth;
        #ifdef USE_FADE
          vFade = fade;
        #endif
        vec4 w = modelMatrix * vec4(position, 1.0);
        // Rivers follow the ground as the high-detail patch shapes it (dunepatch.ts).
        #if defined(USE_FADE) && !defined(MERCATOR)
          w.xyz += normalize(w.xyz) * patchLift(w.xyz);
        #endif
        vWorld = w.xyz;
        #ifdef MERCATOR
          ${mercVertex('w.xyz')}
        #else
          gl_Position = projectionMatrix * viewMatrix * w;
        #endif
        vec4 mvPosition = viewMatrix * w;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */`
      ${MERC_GLSL}
      #include <fog_pars_fragment>
      uniform float uTime, uDepthScale, uFoam;
      uniform vec3 uSunDir, uShallow, uMid, uDeep, uSky;
      varying float vDepth;
      varying vec3 vWorld;
      #ifdef USE_FADE
        varying float vFade;
        uniform float uVis;
      #endif
      ${CLOUD_GLSL}
      ${SHADOW_GLSL}
      ${AERIAL_FULL_GLSL}
      ${NOISE_GLSL}
      // Three octaves of drifting noise; each drifts its own way so the surface never repeats.
      float waves(vec3 p, float t) {
        return vnoise(p * 520.0 + vec3(t * 0.55, 0.0, t * 0.35)) * 0.55
             + vnoise(p * 1300.0 - vec3(0.0, t * 0.8, t * 0.45)) * 0.3
             + vnoise(p * 3300.0 + vec3(t * 1.1)) * 0.15;
      }

      void main() {
        ${MERC_DISCARD}
        vec3 Ng = normalize(vWorld);
        #ifdef MERCATOR
          // The map looks straight down everywhere, from a height set by the zoom.
          vec3 V = Ng;
          float dist = uMapDist;
        #else
          vec3 V = normalize(cameraPosition - vWorld);
          float dist = length(cameraPosition - vWorld);
        #endif
        // Ripples fade with distance: at orbit they would alias into stripes.
        float near = 1.0 - smoothstep(0.12, 1.1, dist);
        float t = uTime;

        vec3 T = normalize(cross(Ng, abs(Ng.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
        vec3 Bt = cross(Ng, T);
        float e = 0.00035;
        float h0 = waves(vWorld, t);
        vec3 N = Ng;
        if (near > 0.0) {
          float hT = waves(vWorld + T * e, t), hB = waves(vWorld + Bt * e, t);
          N = normalize(Ng - (T * (hT - h0) + Bt * (hB - h0)) * (0.9 * near));
        }

        float d = clamp(vDepth / uDepthScale, 0.0, 1.0);
        // Depth for the shore's clear fringe and surf. The mesh's depth reaches deep water across
        // one ~60 km triangle, so on gentle coasts the see-through band and the surf were tens of
        // km wide; the water map's distance from shore (terrainshadow.ts) caps them at a few km.
        float sd = vDepth, cs = -1.0;
        #if !defined(USE_FADE) && !defined(MERCATOR)
          if (length(vWorld) < 1.0002) {
            cs = groundCoast(vWorld);
            if (cs >= 0.0) sd = max(vDepth, (cs - 0.5) * 0.0032);
          }
        #endif
        // Turquoise shallows belong to warm seas (Bahamas, Red Sea, northern Australia); cold
        // shelves are only a little lighter and greener than the open ocean.
        vec3 shallow = uShallow;
        #ifndef USE_FADE
          float warmSea = smoothstep(0.5, 0.8, meanTemp(Ng, 0.0));
          shallow = mix(mix(uMid, vec3(0.16, 0.33, 0.38), 0.6), uShallow, warmSea);
        #endif
        vec3 col = d < 0.12 ? mix(shallow, uMid, smoothstep(0.0, 0.12, d)) : mix(uMid, uDeep, smoothstep(0.12, 0.6, d));
        // Light passing through wave crests in shallow water.
        col += shallow * (h0 - 0.5) * 0.25 * near * (1.0 - d);

        float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        col = mix(col, uSky, 0.02 + fres * 0.45);
        float diff = 0.55 + 0.45 * max(dot(N, uSunDir), 0.0);
        vec3 R = reflect(-uSunDir, N);
        // Glint: broad and soft from orbit, tight and bright up close.
        // Glint: from orbit a broad, dim, silvery patch (the sea is rough at that scale), up close
        // a tight bright highlight.
        float shine = mix(40.0, 380.0, near);
        float spec = pow(max(dot(R, V), 0.0), shine) * mix(0.15, 2.2, near);
        #ifdef USE_FADE
          spec *= 0.12;   // rivers: sparkle on a thin channel reads as whitewater
        #endif
        float shade = cloudShade(vWorld);
        vec3 sunTint = atmoSunTint(vWorld);
        // Mountains' shadows fall on the water too (terrainshadow.ts).
        shade *= mix(0.45, 1.0, terrainShadow(vWorld));
        // Night: the sea goes nearly black with a faint moonlit blue, and surf, glint and sky
        // reflection all dim with it. (Ng, not the rippled N, so the terminator stays soft.)
        #ifdef MERCATOR
          float day = 1.0;     // the map has no night side
          spec = 0.0;          // nor a sun glint, which would sit in one arbitrary spot
          diff = 0.92;
        #else
          float day = smoothstep(-0.12, 0.22, dot(Ng, uSunDir));
        #endif
        vec3 night = vec3(0.012, 0.022, 0.04) + col * 0.05;
        col = mix(night, (col * diff * shade + vec3(spec) * shade) * sunTint, day);

        // Foam: a steady line at the shore, plus swells rolling in toward it.
        // Depth is interpolated linearly across big triangles, so shore lines come out straight;
        // wobbling it with noise makes the foam follow a ragged, natural-looking shore.
        float fd = sd + (vnoise(vWorld * 900.0) - 0.5) * uFoam * 1.6 + (vnoise(vWorld * 2400.0) - 0.5) * uFoam * 0.7;
        float edge = 1.0 - smoothstep(0.0, uFoam, fd);
        float zone = 1.0 - smoothstep(0.0, uFoam * 2.5, fd);
        float swell = smoothstep(0.8, 1.0, sin(fd / uFoam * 4.0 + t * 1.6)) * zone * 0.6;
        float breakup = smoothstep(0.35, 0.75, vnoise(vWorld * 2600.0 + vec3(t * 0.3)));
        // Surf is metres wide: from orbit it would be an outline round every coast, so it fades.
        float foam = clamp(edge * (0.6 + 0.4 * breakup) + swell * breakup * near, 0.0, 1.0) * (1.0 - smoothstep(0.35, 1.3, dist));
        // Reefs in warm, shallow seas: a crest along the shelf's edge with breakers on it, and a
        // bright lagoon inside, in patches along the coast.
        #if !defined(USE_FADE) && !defined(MERCATOR)
          if (cs > 0.52 && vDepth < 0.004 && warmSea > 0.6) {
            float r0 = 0.0011 + 0.0005 * snoise(vWorld * 140.0);
            float patchy = smoothstep(0.3, 0.6, snoise(vWorld * 16.0 + 11.0) + 0.35 * snoise(vWorld * 55.0)) * smoothstep(0.6, 0.85, warmSea);
            float crest = (1.0 - smoothstep(0.00004, 0.00016, abs(vDepth - r0))) * patchy;
            float lagoon = smoothstep(r0, r0 - 0.0003, vDepth) * patchy;
            col = mix(col, vec3(0.3, 0.75, 0.72) * shade * mix(0.06, 1.0, day), lagoon * 0.45);
            col = mix(col, vec3(0.62, 0.7, 0.6) * shade * mix(0.06, 1.0, day), crest * 0.6);
            foam = max(foam, crest * (0.35 + 0.65 * breakup) * smoothstep(0.9, 0.3, dist) * 0.8);
          }
        #endif
        // Silt: rivers carry mud out to sea, a brownish plume swirling off the mouth and fading
        // tens of km out (the water map's river valleys reaching past the coast).
        #if !defined(USE_FADE) && !defined(MERCATOR)
          if (cs >= 0.0) {
            vec4 gw = groundWater(vWorld);
            float plume = smoothstep(0.012, 0.07, gw.g) * (1.0 - smoothstep(0.8, 0.98, gw.a));
            if (plume > 0.0) {
              float swirl = snoise(vWorld * 120.0 + vec3(t * 0.02)) * 0.5 + snoise(vWorld * 400.0 - vec3(t * 0.03)) * 0.3;
              plume *= smoothstep(-0.2, 0.4, swirl + plume - 0.3);
              col = mix(col, vec3(0.44, 0.37, 0.2) * shade * mix(0.06, 1.0, day), plume * 0.65);
            }
          }
        #endif
        #ifdef USE_FADE
          foam = 0.0;   // rivers have no breakers
        #endif
        col = mix(col, vec3(0.94, 0.97, 0.98) * shade * mix(0.06, 1.0, day), foam * 0.8);

        // Shallow water clears only near the shore: with ~60 km mesh steps, depth reaches deep
        // water across one long triangle, and a wide see-through band read as a flat sandy shelf.
        float a = mix(0.62, 0.95, smoothstep(0.0, 0.18, clamp(sd / uDepthScale, 0.0, 1.0)));
        #ifndef USE_FADE
          if (uSeason != 0.0) {
            float mt = meanTemp(Ng, 0.0), st = seasonalTemp(Ng, mt);
            // Big wobbles (currents, bays) plus floes, so the ice edge isn't a circle of latitude.
            float floe = (vnoise(vWorld * 9.0) - 0.5) * 0.14 + (vnoise(vWorld * 40.0) - 0.5) * 0.06 + vnoise(vWorld * 180.0) * 0.05;
            float ice = smoothstep(0.17, 0.11, st + floe) * (1.0 - smoothstep(0.17, 0.11, mt));
            col = mix(col, vec3(0.88, 0.92, 0.95) * shade * mix(0.08, 1.0, day), ice);
            a = max(a, ice);
          }
        #endif
        // Ragged coastline: in a noisy fringe along the shore the water thins out and the sandy
        // floor shows, so the land edge is jagged at every scale instead of a smooth curve.
        float cn = vnoise(vWorld * 110.0) * 0.75 + vnoise(vWorld * 330.0) * 0.25;
        float coast = smoothstep(0.0, uFoam * 0.35, sd - (cn - 0.4) * uFoam * 1.1);
        // Lakes (water above sea level): their depth is biased deep right up to the shore, and
        // with two mesh steps per cell the shore can only fall on cell edges. A strong per-pixel
        // wobble pulls the shoreline in from the hexagon instead. (Simplex: thresholded value
        // noise shows its grid.)
        #ifndef USE_FADE
          if (length(vWorld) > 1.0002) {
            float ln = snoise(vWorld * 80.0) * 0.5 + snoise(vWorld * 210.0 + 5.0) * 0.3 + snoise(vWorld * 600.0 + 9.0) * 0.2;
            float lk = smoothstep(0.0, 0.0008, vDepth - (0.5 + 0.5 * ln) * 0.009);
            a *= lk; foam *= lk;
          }
        #endif
        a *= coast;
        foam *= coast;
        gl_FragColor = vec4(col, max(a, foam * 0.9));
        #ifdef USE_FADE
          gl_FragColor.a *= vFade * uVis;
        #endif
        #ifndef MERCATOR
          gl_FragColor.rgb = aerialApply(gl_FragColor.rgb, (viewMatrix * vec4(vWorld - cameraPosition, 0.0)).xyz);
        #endif
        #include <fog_fragment>
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export interface CloudTextures { main: THREE.Texture; cirrus: THREE.Texture }

/** Uploads worker-painted cloud pixels as textures, mipmapped (the shadow lookup samples a blurred level). */
export function cloudTexturesFromPixels(px: CloudPixels): CloudTextures {
  const tex = (data: Uint8Array) => {
    const t = new THREE.DataTexture(data, px.width, px.height, THREE.RGBAFormat);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = THREE.RepeatWrapping;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  return { main: tex(px.main), cirrus: tex(px.cirrus) };
}

export function makeClouds(u: CloudUniforms): THREE.Group {
  const g = new THREE.Group();
  const layer = (r: number, opacity: number) => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(r, 160, 80),
      new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, depthWrite: false, roughness: 1, opacity }),
    );
    m.renderOrder = 5;
    m.userData.baseOpacity = opacity;
    return m;
  };
  // Low over the ground (the highest peaks poke through, as real ones do).
  const deck = layer(1.019, 0.85), cirrus = layer(1.026, 0.5);
  // The deck's texture holds raw cover; shapes are decided here, live.
  const mat = deck.material as THREE.MeshStandardMaterial;
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudLocal;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCloudLocal = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudLocal;\n' + CLOUD_GLSL)
      .replace('#include <map_fragment>', `#include <map_fragment>
        #ifdef USE_MAP
          // Mip level from screen-space change, as texture2D would pick (textureLod needs it given).
          vec2 tsz = vec2(textureSize(map, 0));
          vec2 duv = max(abs(dFdx(vMapUv)), abs(dFdy(vMapUv))) * tsz;
          float lod = clamp(log2(max(min(duv.x, 32.0), duv.y)), 0.0, 8.0);
          float cover = coverAt(normalize(vCloudLocal), lod);
          // Texture inside the cloud: lumpy tops catch more or less light; thick cores grey.
          vec3 cd = normalize(vCloudLocal);
          float lumps = cnNoise(cd * 90.0) * 0.6 + cnNoise(cd * 260.0) * 0.4;
          diffuseColor.rgb = vec3((0.78 + 0.3 * lumps) * (1.0 - 0.22 * smoothstep(0.72, 0.92, cover)));
          diffuseColor.a = opacity * cloudAlpha(cover);
        #else
          diffuseColor.a = 0.0;   // compiled before the worker's texture arrives
        #endif`);
  };
  g.add(deck, cirrus);
  return g;
}

export function makeStars(): THREE.Points {
  const n = 2500, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const z = hash01(i) * 2 - 1, a = hash01(i + n) * Math.PI * 2, r = Math.sqrt(1 - z * z);
    pos[i * 3] = r * Math.cos(a) * 80; pos[i * 3 + 1] = r * Math.sin(a) * 80; pos[i * 3 + 2] = z * 80;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  // Drawn before the sky (opaque, no depth), which dims and hides them by day (atmosphere.ts).
  const p = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xb3b3b3, size: 1.2, sizeAttenuation: false, depthWrite: false }));
  p.renderOrder = -20;
  return p;
}
