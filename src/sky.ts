/** Water shader, clouds (and their shadows), atmosphere and stars. */
import * as THREE from 'three';
import type { CloudPixels } from './clouds.ts';
import { hash01 } from './rng.ts';
import { MERC_GLSL, MERC_DISCARD, mercVertex, patchShaderChunks } from './mercator.ts';
import { GROVE_GLSL } from './groves.ts';

patchShaderChunks();

/** Uniforms shared by every material that receives cloud shadows. */
export interface CloudUniforms {
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
  /** Centuries: the year shown (−1: no civilisation drawn). */
  uYear: { value: number };
  /** Weather time in days, and the active storms (weather.ts). */
  uWeather: { value: number };
  uStorms: { value: THREE.Vector4[] };
}

export function makeCloudUniforms(): CloudUniforms {
  return { uCloudMap: { value: null }, uCloudRot: { value: 0 }, uCloudShadow: { value: 0 }, uCloudTime: { value: 0 }, uCloudSun: { value: new THREE.Vector3(0, 0, 1) },
    uSeason: { value: 0 }, uHeat: { value: 0 }, uRelief: { value: 0.013 }, uSnow: { value: 1 }, uMapDist: { value: 1 }, uGrove: { value: 250 }, uYear: { value: -1 },
    uWeather: { value: 0 }, uStorms: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) } };
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
      float band = 0.5 + 0.5 * sin(arms * az + spin * tight * log(max(r, 0.12)) * 3.0);
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
      float o = w * p0 * T, co = cos(o), so = sin(o);
      vec3 q = vec3(d.x * co - d.z * so, d.y, d.x * so + d.z * co);
      float raw = textureLod(uCloudMap, vec2((phi + o) / 6.2831853, 0.5 + lat / 3.14159265), lod).a;
      c0 = cloudCover(raw, q, uCloudTime);
    }
    {
      float o = w * p1 * T, co = cos(o), so = sin(o);
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
export function makeTerrainMaterial(u: CloudUniforms, climate = false): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  // Ground patterns need the per-vertex climate (natural colours, smooth style only).
  if (climate) mat.defines = { ...mat.defines, USE_CLIMATE: '' };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
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
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vCloudP = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #ifdef USE_CLIMATE
          vClim = climate;
        #endif
        #ifdef USE_CIV
          vCiv = civ;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;\n' + CLOUD_GLSL + NOISE_GLSL + /* glsl */`
        // Ridged octaves (1 - |2n - 1|) give crest lines and gullies rather than uniform grain.
        float ridge(float n) { return 1.0 - abs(2.0 * n - 1.0); }
        float rockNoise(vec3 p) {
          return ridge(vnoise(p * 320.0)) * 0.5 + ridge(vnoise(p * 900.0)) * 0.3 + vnoise(p * 2600.0) * 0.2;
        }
        // Orbit-scale relief: ridge-and-valley texture a few hundred km across, the hillshaded
        // look of land from space. Takes over as the fine rock detail fades out.
        float landNoise(vec3 p) {
          return ridge(vnoise(p * 45.0)) * 0.55 + ridge(vnoise(p * 120.0)) * 0.3 + vnoise(p * 300.0) * 0.15;
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
        float aaFade(float lambda, float foot) { return 1.0 - smoothstep(lambda * 0.12, lambda * 0.45, foot); }
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
        /**
         * Dunes: crests roughly north-south, across the east-west trade winds, with a long gentle
         * windward slope and a short steep lee face. Wavering, and broken into fields with flat
         * sand between them. About 7 km apart (exaggerated, as everything here is).
         */
        const float DUNE = 0.0011;
        /** One dune train: asymmetric profile of phase f (long windward slope, short lee face). */
        float duneProfile(float f) {
          float prof = f < 0.72 ? f / 0.72 : (1.0 - f) / 0.28;
          return prof * prof * (3.0 - 2.0 * prof);
        }
        /** x: height 0..1. y: how much of a lee (slip) face this is, for shading. */
        vec2 duneField(vec3 p) {
          vec3 n = normalize(p);
          float lon = atan(n.x, n.z), lat = asin(clamp(n.y, -1.0, 1.0));
          vec2 g = vec2(lon * cos(lat), lat);
          // Sinuous crests: phase warped at two scales, so crests wind, fork and rejoin.
          // (Gentle: much more and the crests curl into fingerprint whorls.)
          float warp = snoise(p * 70.0) * 0.6 + snoise(p * 300.0 + 9.0) * 0.12;
          // Fixed orientation, across the trade winds (any spatially varying rotation of a phase
          // this large turns into rings far from the origin).
          float u = g.x / DUNE + warp;
          float f = fract(u);
          // Each crest breaks into sections along its length (barchanoid ridges).
          float along = snoise(vec3(floor(u) * 1.7, g.y / DUNE * 0.22, 0.5));
          float seg = smoothstep(-0.55, 0.05, along);
          float h1 = duneProfile(f) * mix(0.35, 1.0, seg);
          // A weaker second train at an angle, from a secondary wind: star and network dunes.
          float v = (g.y * 0.9 - g.x * 0.45) / (DUNE * 1.7) + snoise(p * 90.0 + 3.0) * 0.4;
          float h2 = duneProfile(fract(v)) * 0.3 * smoothstep(0.0, 0.5, snoise(p * 30.0 + 5.0));
          // Fields of dunes with flat sand corridors between them.
          // Sand seas: most of a hot desert, with flat gravel plains between.
          float field = smoothstep(-0.55, 0.05, snoise(p * 40.0) + 0.25 * snoise(p * 160.0));
          float h = max(h1, h2) * field;
          float lee = (f > 0.72 ? smoothstep(0.72, 0.8, f) : 0.0) * (h1 >= h2 ? 1.0 : 0.0) * field * mix(0.35, 1.0, seg);
          return vec2(h, lee);
        }
        float duneH(vec3 p) { return duneField(p).x; }
`)
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
        diffuseColor.rgb *= mix(1.0, 0.82 + 0.36 * rn, (0.35 + 0.65 * highland) * detailFade);
        float farFade = smoothstep(0.12, 0.8, camDist) * step(0.0005, hAbove);
        float ln = landNoise(vCloudP);
        diffuseColor.rgb *= mix(1.0, 0.74 + 0.52 * ln, (0.45 + 0.55 * highland) * farFade);
        float foot = length(fwidth(vCloudP));
        float desertW = 0.0;
        #ifdef USE_CLIMATE
          if (hAbove > 0.0004) {
            float moist = vClim.x, temp = vClim.y;
            float lowland = 1.0 - highland;
            // Deserts: dune fields (shaded in the normal step below) and the odd white salt pan in
            // low basins.
            desertW = smoothstep(0.24, 0.12, moist) * smoothstep(0.4, 0.55, temp) * lowland;
            if (desertW > 0.0) {
              float pan = smoothstep(0.83, 0.88, snoise01(vCloudP * 38.0) + 0.06 * snoise(vCloudP * 300.0)) * (1.0 - smoothstep(0.06, 0.16, hAbove / uRelief));
              diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.80, 0.77, 0.70), pan * desertW * 0.85);
              // Crests are bright, loose orange sand; corridors between are flatter, paler and
              // greyer; slip faces sit in their own shade whatever the light.
              vec2 dn = duneField(vCloudP);
              float dk = desertW * aaFade(DUNE * 0.6, foot);
              vec3 sand = mix(diffuseColor.rgb * vec3(1.0, 0.97, 0.92), diffuseColor.rgb * vec3(1.12, 1.0, 0.82), dn.x);
              diffuseColor.rgb = mix(diffuseColor.rgb, sand * (0.86 + 0.24 * dn.x) * (1.0 - 0.32 * dn.y), dk);
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
            float forestW = smoothstep(0.005, 0.04, diffuseColor.g - max(diffuseColor.r, diffuseColor.b)) * smoothstep(0.35, 0.5, moist) * lowland;
            float gv = groveField(vCloudP);
            if (forestW > 0.0) {
              float inGrove = smoothstep(-0.35, 0.25, gv);
              float crowns = snoise01(vCloudP * 3200.0) * 0.6 + snoise01(vCloudP * 9000.0) * 0.4;
              diffuseColor.rgb *= mix(1.0, 0.68, forestW * inGrove);
              diffuseColor.rgb *= mix(1.0, 0.75 + 0.35 * crowns, forestW * inGrove * aaFade(0.0003, foot));
              diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(1.18, 1.12, 0.82), forestW * (1.0 - inGrove) * 0.55);
            }
            if (grassW > 0.0) {
              diffuseColor.rgb *= mix(1.0, 0.82, grassW * smoothstep(0.25, 0.7, gv) * smoothstep(0.3, 0.45, moist));
            }
            // Tundra: frost polygons, a net of dark cracks with the odd meltwater pond.
            float tundraW = smoothstep(0.08, 0.16, temp) * smoothstep(0.34, 0.24, temp) * lowland;
            if (tundraW > 0.0) {
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
        if (detailFade > 0.0 && hAbove > 0.0) {
          vec3 up = normalize(vCloudP);
          vec3 t1 = normalize(cross(up, abs(up.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
          vec3 t2 = cross(up, t1);
          float e = 0.0003;
          vec3 grad = t1 * (rockNoise(vCloudP + t1 * e) - rn) + t2 * (rockNoise(vCloudP + t2 * e) - rn);
          float amp = (0.15 + 0.6 * highland) * detailFade;
          normal = normalize(normal - TOVIEW(grad * amp));
        }
        // Dunes catch the light on their windward slopes and shade their lee faces.
        if (desertW > 0.0) {
          float k = desertW * aaFade(DUNE * 0.6, foot);
          if (k > 0.0) {
            vec3 up = normalize(vCloudP);
            vec3 t1 = normalize(cross(up, abs(up.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
            vec3 t2 = cross(up, t1);
            float e = DUNE * 0.08, h0 = duneH(vCloudP);
            vec3 grad = (t1 * (duneH(vCloudP + t1 * e) - h0) + t2 * (duneH(vCloudP + t2 * e) - h0)) / e;
            normal = normalize(normal - TOVIEW(grad * DUNE * 0.45 * k));
          }
        }
        // Rock strata: bands across steep high ground, as layered rock shows in cliffs.
        if (highland > 0.0 && hAbove > 0.0) {
          #ifdef MERCATOR
            float steep = 1.0 - normal.z;
          #else
            float steep = 1.0 - dot(normalize((vec4(normal, 0.0) * viewMatrix).xyz), normalize(vCloudP));
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
          float amp = (1.0 + 3.0 * highland) * farFade;
          normal = normalize(normal - TOVIEW(grad * amp));
        }
        // Snow, per pixel: where it is cold enough for the height, latitude and season. Done
        // here rather than per vertex, where its edge broke along the mesh triangles. It sheds
        // off steep faces and lies in streaks along ridges, so ranges read as rock with white
        // crests, not white blobs. It cools with height at about half the generator's rate:
        // the generator calls whole plateaus frozen, but only their crests should be white.
        if (uSnow > 0.0 && hAbove > 0.0004) {
          vec3 sn = normalize(vCloudP);
          float lat = abs(asin(clamp(sn.y, -1.0, 1.0))) / 1.5707963;
          float st = seasonalTemp(sn, 1.0 - 1.1 * pow(lat, 1.25) - 0.3 * hAbove / uRelief + uHeat);
          float line = 0.27;
          float edge = (vnoise(vCloudP * 40.0) - 0.5) * 0.1 + (vnoise(vCloudP * 300.0) - 0.5) * 0.05;
          float snow = smoothstep(line + 0.04, line - 0.06, st + edge);
          #ifdef MERCATOR
            float slope = 1.0 - normal.z;
          #else
            float slope = 1.0 - dot(normalize((vec4(normal, 0.0) * viewMatrix).xyz), sn);
          #endif
          // Value noise shows its grid once thresholded, so warp it and rotate each octave.
          vec3 q = vCloudP * 160.0;
          q += vec3(vnoise(q * 0.37), vnoise(q * 0.37 + 5.2), vnoise(q * 0.37 + 9.1)) * 2.5;
          mat3 R = mat3(0.8, 0.6, 0.0, -0.36, 0.48, 0.8, 0.48, -0.64, 0.6);
          float streak = vnoise(q) * 0.5 + vnoise(R * q * 2.1) * 0.3 + vnoise(R * R * q * 4.3) * 0.2;
          float lie = (1.0 - 0.9 * smoothstep(0.08, 0.3, slope)) * smoothstep(0.25, 0.65, streak + snow * 0.35);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.93, 0.95, 0.98), clamp(snow * lie, 0.0, 1.0) * 0.95);
        }`);
  };
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
    Object.assign(sh.uniforms, u, sun ?? {}, fade ?? {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;' + (fade ? '\nuniform float uFadeNear, uFadeFar, uYear;\nattribute float cut;' : ''))
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
      #endif
      ${MERC_GLSL}
      #include <fog_pars_vertex>
      void main() {
        vDepth = depth;
        #ifdef USE_FADE
          vFade = fade;
        #endif
        vec4 w = modelMatrix * vec4(position, 1.0);
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
        vec3 col = d < 0.12 ? mix(uShallow, uMid, smoothstep(0.0, 0.12, d)) : mix(uMid, uDeep, smoothstep(0.12, 0.6, d));
        // Light passing through wave crests in shallow water.
        col += uShallow * (h0 - 0.5) * 0.25 * near * (1.0 - d);

        float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        col = mix(col, uSky, 0.02 + fres * 0.45);
        float diff = 0.55 + 0.45 * max(dot(N, uSunDir), 0.0);
        vec3 R = reflect(-uSunDir, N);
        // Glint: broad and soft from orbit, tight and bright up close.
        // Glint: from orbit a broad, dim, silvery patch (the sea is rough at that scale), up close
        // a tight bright highlight.
        float shine = mix(14.0, 380.0, near);
        float spec = pow(max(dot(R, V), 0.0), shine) * mix(0.32, 2.2, near);
        #ifdef USE_FADE
          spec *= 0.12;   // rivers: sparkle on a thin channel reads as whitewater
        #endif
        float shade = cloudShade(vWorld);
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
        col = mix(night, col * diff * shade + vec3(spec) * shade, day);

        // Foam: a steady line at the shore, plus swells rolling in toward it.
        // Depth is interpolated linearly across big triangles, so shore lines come out straight;
        // wobbling it with noise makes the foam follow a ragged, natural-looking shore.
        float fd = vDepth + (vnoise(vWorld * 900.0) - 0.5) * uFoam * 1.6 + (vnoise(vWorld * 2400.0) - 0.5) * uFoam * 0.7;
        float edge = 1.0 - smoothstep(0.0, uFoam, fd);
        float zone = 1.0 - smoothstep(0.0, uFoam * 2.5, fd);
        float swell = smoothstep(0.8, 1.0, sin(fd / uFoam * 4.0 + t * 1.6)) * zone * 0.6;
        float breakup = smoothstep(0.35, 0.75, vnoise(vWorld * 2600.0 + vec3(t * 0.3)));
        float foam = clamp(edge * (0.6 + 0.4 * breakup) + swell * breakup * near, 0.0, 1.0);
        #ifdef USE_FADE
          foam = 0.0;   // rivers have no breakers
        #endif
        col = mix(col, vec3(0.94, 0.97, 0.98) * shade * mix(0.06, 1.0, day), foam * 0.8);

        float a = mix(0.5, 0.95, smoothstep(0.0, 0.35, d));
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
        float coast = smoothstep(0.0, uFoam * 0.35, vDepth - (cn - 0.4) * uFoam * 1.1);
        a *= coast;
        foam *= coast;
        gl_FragColor = vec4(col, max(a, foam * 0.9));
        #ifdef USE_FADE
          gl_FragColor.a *= vFade * uVis;
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

/** Shared by the atmosphere shells: the sun's direction in world space. */
export interface SunUniforms { uSunDir: { value: THREE.Vector3 } }

function fresnelShell(radius: number, side: THREE.Side, power: number, strength: number, color: number, sun: SunUniforms): THREE.Mesh {
  const c = new THREE.Color(color);
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      ...sun, uColor: { value: c }, uPower: { value: power }, uStrength: { value: strength },
      uBack: { value: side === THREE.BackSide ? 1 : 0 },
    },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vWN;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vWN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor, uSunDir; uniform float uPower, uStrength, uBack;
      varying vec3 vN; varying vec3 vV; varying vec3 vWN;
      void main() {
        float d = dot(vN, vV);
        float f = uBack > 0.5
          // Far side of the shell: 0 at its silhouette, rising toward the planet's limb.
          ? pow(smoothstep(0.0, 0.24, -d), uPower)
          // Near side: a haze that thickens toward the planet's edge but fades out at the shell's.
          : pow(1.0 - d, uPower) * smoothstep(0.0, 0.25, d);
        // Lit by the sun: bright on the day side, faint at night, orange along the terminator.
        float s = dot(normalize(vWN), uSunDir);
        float day = 0.08 + 0.92 * smoothstep(-0.3, 0.35, s);
        float dusk = 1.0 - smoothstep(0.0, 0.32, abs(s + 0.04));
        vec3 col = mix(uColor, vec3(1.0, 0.5, 0.25), dusk * 0.75);
        gl_FragColor = vec4(col * f * uStrength * day, 1.0);
      }`,
    side, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), mat);
}

/**
 * Haze over the whole disc: the planet is always seen through air. Opacity grows with the
 * length of the line of sight through a thin shell (short straight down, long at the limb),
 * so the centre stays clear while the edge fades, loses colour and turns blue-white, as in
 * photographs. Normal blending, so it veils as well as brightens. Dark on the night side.
 */
function hazeShell(radius: number, sun: SunUniforms): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...sun, uColor: { value: new THREE.Color(0x9cc4f0) }, uDensity: { value: 0.055 } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV; varying vec3 vWN;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vWN = normalize(mat3(modelMatrix) * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor, uSunDir; uniform float uDensity;
      varying vec3 vN; varying vec3 vV; varying vec3 vWN;
      void main() {
        float mu = max(dot(vN, vV), 0.02);
        float path = 1.0 / mu;                                // ~1 at the centre, large at the limb
        float a = 1.0 - exp(-uDensity * max(0.0, path - 0.85));   // ~clear straight down
        a *= smoothstep(0.0, 0.12, mu);                       // thin out at the shell's own edge
        float s = dot(normalize(vWN), uSunDir);
        float day = smoothstep(-0.25, 0.3, s);
        float dusk = 1.0 - smoothstep(0.0, 0.3, abs(s + 0.03));
        vec3 col = mix(uColor, vec3(1.0, 0.55, 0.3), dusk * 0.6);
        gl_FragColor = vec4(col * (0.15 + 0.85 * day), clamp(a * (0.25 + 0.75 * day), 0.0, 0.85));
      }`,
    transparent: true, depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 128, 64), mat);
}

/** Outer glow at the limb plus haze over the planet. */
export function makeAtmosphere(sun: SunUniforms): THREE.Group {
  const g = new THREE.Group();
  // Thin, as a real atmosphere is next to its planet.
  g.add(fresnelShell(1.03, THREE.BackSide, 1.8, 0.75, 0x6aaeff, sun));
  const haze = hazeShell(1.027, sun);
  haze.renderOrder = 6;
  g.add(haze);
  return g;
}

/**
 * Sky seen from low altitude: blue overhead, pale at the horizon, a glow round the sun, dark at
 * night. Drawn first, behind everything, on a sphere that travels with the camera; uLow fades it
 * in from the black of space as you descend.
 */
export function makeSky(sun: SunUniforms): THREE.Mesh {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthTest: false, depthWrite: false,
    uniforms: { ...sun, uLow: { value: 0 } },
    vertexShader: /* glsl */`
      varying vec3 vDir;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vDir = w.xyz - cameraPosition;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSunDir; uniform float uLow;
      varying vec3 vDir;
      void main() {
        vec3 v = normalize(vDir), up = normalize(cameraPosition);
        float h = dot(v, up);
        float day = smoothstep(-0.12, 0.25, dot(up, uSunDir));
        // Linear colours, deep enough to survive the grade and tone mapping as blue.
        vec3 zenith = vec3(0.035, 0.11, 0.38), horizon = vec3(0.36, 0.48, 0.66);
        // Low views show only the first few degrees above the horizon, so most of the gradient lives there.
        vec3 col = mix(horizon, zenith, smoothstep(-0.06, 0.14, h) * 0.75 + smoothstep(0.14, 0.6, h) * 0.25);
        // Sunset warmth along the horizon when the sun is low.
        float low = 1.0 - smoothstep(0.0, 0.35, abs(dot(up, uSunDir)));
        col = mix(col, vec3(0.95, 0.55, 0.32), low * (1.0 - smoothstep(0.0, 0.25, h)) * 0.6 * day);
        col += vec3(1.0, 0.9, 0.7) * pow(max(dot(v, uSunDir), 0.0), 60.0) * 0.6;
        col *= day;
        gl_FragColor = vec4(col * uLow, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(40, 48, 24), mat);
  m.renderOrder = -10;
  m.frustumCulled = false;
  return m;
}

export function makeStars(): THREE.Points {
  const n = 2500, pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const z = hash01(i) * 2 - 1, a = hash01(i + n) * Math.PI * 2, r = Math.sqrt(1 - z * z);
    pos[i * 3] = r * Math.cos(a) * 80; pos[i * 3 + 1] = r * Math.sin(a) * 80; pos[i * 3 + 2] = z * 80;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.2, sizeAttenuation: false, transparent: true, opacity: 0.7 }));
}
