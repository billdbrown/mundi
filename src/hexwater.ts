/**
 * Water in the hex view (2026-11-06). One material for sea, lakes and rivers, drawn from the
 * water's true depth: the shader reads the ground's height under each pixel (the grass map's height
 * texture), so shallows are clear over their bed and deep water dark, rather than one blue colour.
 *
 * - Ripples scroll with the current along a river (faster in rapids); open water drifts gently.
 * - The sky is reflected at low angles (Fresnel), so from eye level water reads as water.
 * - White water from the river's roughness (rapids, falls), foam along the banks, and on coasts
 *   lines of surf washing in to the shore.
 * - A slow swell on open water moves the shoreline up and down the beach.
 */
import * as THREE from 'three';
import { grassUniforms } from './hexgrass.ts';

export const waterUniforms = {
  uWTime: { value: 0 },
  /** How much the open water swells (metres-ish scale factor). */
  uSwell: { value: 1 },
  uSkyTop: { value: new THREE.Color(0.3, 0.5, 0.8) },
  uSkyHor: { value: new THREE.Color(0.8, 0.85, 0.9) },
  /** Up, in three.js world space (the map may be set on the planet). */
  uUpW: { value: new THREE.Vector3(0, 1, 0) },
  /** The map's axes in world space (rotation only). */
  uMapRot: { value: new THREE.Matrix3() },
};

export interface WaterLook { shallow: number; deep: number; foam: number; opacity: number; roughness: number }

const NOISE_GLSL = /* glsl */`
  float wHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float wNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(wHash(i), wHash(i + vec2(1, 0)), f.x), mix(wHash(i + vec2(0, 1)), wHash(i + vec2(1, 1)), f.x), f.y);
  }
  vec2 wGrad(vec2 p) {
    float e = 0.15;
    return vec2(wNoise(p + vec2(e, 0.0)) - wNoise(p - vec2(e, 0.0)), wNoise(p + vec2(0.0, e)) - wNoise(p - vec2(0.0, e))) / (2.0 * e);
  }
  // The ground under a point of the map (three.js x, z), by hand-filtered height texture.
  uniform sampler2D tGrassHgt; uniform vec3 uGMap;
  float groundH(vec2 xz) {
    vec2 uv0 = vec2(xz.x + uGMap.x, -xz.y + uGMap.x) / uGMap.y;
    vec2 t = uv0 * (uGMap.z - 1.0), f = fract(t), b = (floor(t) + 0.5) / uGMap.z, e = vec2(1.0 / uGMap.z, 0.0);
    return mix(mix(texture2D(tGrassHgt, b).r, texture2D(tGrassHgt, b + e.xy).r, f.x),
               mix(texture2D(tGrassHgt, b + e.yx).r, texture2D(tGrassHgt, b + e.xx).r, f.x), f.y);
  }`;

/** A water material. river: has a 'flow' attribute (direction on the map, roughness 0..1). */
export function waterMaterial(W: WaterLook, river: boolean): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: river ? Math.max(W.roughness, 0.3) : W.roughness, metalness: 0.0, transparent: true,
    // Pushed back a touch in depth: on gentle shores the ground and the water are nearly the same
    // height and flickered over each other; the ground wins ties.
    polygonOffset: true, polygonOffsetFactor: 0.5, polygonOffsetUnits: 2,
  });
  if (river) mat.defines = { RIVER: '' };
  const own = {
    uShallow: { value: new THREE.Color(W.shallow) }, uDeep: { value: new THREE.Color(W.deep) },
    uFoam: { value: new THREE.Color(W.foam).lerp(new THREE.Color(1, 1, 1), 0.5) }, uOpacity: { value: W.opacity },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, waterUniforms, own, { tGrassHgt: grassUniforms.tGrassHgt, uGMap: grassUniforms.uGMap });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uWTime, uSwell;
        varying vec3 vWP;
        #ifdef RIVER
        attribute vec3 flow; varying vec3 vFlow;
        #endif`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifndef RIVER
          // A slow swell: the shoreline creeps up and down the beach.
          transformed.y += (sin(uWTime * 0.55 + position.x * 0.021 + position.z * 0.013) * 0.09
                        + sin(uWTime * 0.83 - position.x * 0.011 + position.z * 0.024) * 0.05) * uSwell;
        #endif
        vWP = transformed;
        #ifdef RIVER
        vFlow = flow;
        #endif`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWP;
        uniform float uWTime, uOpacity; uniform vec3 uShallow, uDeep, uFoam, uSkyTop, uSkyHor, uUpW; uniform mat3 uMapRot;
        #ifdef RIVER
        varying vec3 vFlow;
        #endif
        ${NOISE_GLSL}
        float wDepth; float wFoam; float wFar;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          wDepth = max(0.0, vWP.y - groundH(vWP.xz));
          // Where a pixel spans metres, fine detail averages out or it shimmers.
          wFar = smoothstep(0.3, 1.4, length(fwidth(vWP.xz)));
          #ifdef RIVER
            float k = 1.0 - exp(-wDepth / 2.2);
          #else
            float k = 1.0 - exp(-wDepth / 7.0);
          #endif
          diffuseColor.rgb = mix(uShallow, uDeep, k);
          // Clear in the shallows, so the bed shows; opaque where deep.
          diffuseColor.a = mix(0.18, uOpacity, smoothstep(0.0, 2.2, wDepth));
          wFoam = 0.0;
          #ifdef RIVER
          {
            vec2 fd = vFlow.xy / max(1e-3, length(vFlow.xy)); fd.y = -fd.y;
            float r = vFlow.z;
            // Streaks along the current (u), narrow across it (s), drifting downstream; u also runs
            // down a fall's face, so its foam pours.
            float u = dot(vWP.xz, fd) - vWP.y * 1.2, s = dot(vWP.xz, vec2(-fd.y, fd.x));
            float n = wNoise(vec2(u * 0.35 - uWTime * 1.9, s * 2.4)) * 0.55 + wNoise(vec2(u * 1.1 - uWTime * 3.6, s * 6.0)) * 0.45;
            float th = mix(0.95, 0.4, r);
            float fm = smoothstep(th, th + 0.12, n) * smoothstep(0.0, 0.12, r);
            fm = max(fm, smoothstep(0.8, 1.0, r) * 0.4);
            // A frill of foam where the water thins against the banks, drifting down.
            float bank = (1.0 - smoothstep(0.05, 0.35 + 0.2 * r, wDepth)) * smoothstep(0.45, 0.75, wNoise(vec2(u * 0.6 - uWTime * 1.2, s * 1.5)));
            wFoam = mix(max(fm, bank * 0.55), r * r * 0.5, wFar);
          }
          #else
          {
            // Surf: lines of foam washing in over the shallows, broken up, and a lace at the edge.
            float n = wNoise(vWP.xz * 0.09 + uWTime * 0.05);
            // By distance from the shore, not depth: on a gentle shelf the first half metre of depth
            // runs tens of metres out, and depth-based foam was a wide pale band. Distance is the
            // depth over the bed's slope.
            vec2 e = vec2(2.0, 0.0);
            float sl = length(vec2(groundH(vWP.xz + e.xy) - groundH(vWP.xz - e.xy), groundH(vWP.xz + e.yx) - groundH(vWP.xz - e.yx))) / 4.0;
            float dist = wDepth / max(sl, 0.01);
            float band = smoothstep(0.86, 0.98, sin(dist * 0.9 - uWTime * 1.3 + n * 4.0) * 0.5 + 0.5)
                       * (1.0 - smoothstep(4.0, 18.0, dist)) * smoothstep(0.3, 0.6, wNoise(vWP.xz * 0.2 + vec2(uWTime * 0.1, 0.0)));
            float lace = 1.0 - smoothstep(0.3, 1.2 + 1.5 * n, dist);
            wFoam = mix(max(band * 0.8, lace * 0.85), lace * 0.4, wFar);
          }
          #endif
          diffuseColor.rgb = mix(diffuseColor.rgb, uFoam, wFoam);
          diffuseColor.a = mix(diffuseColor.a, 1.0, wFoam);
        }`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        {
          #ifdef RIVER
            vec2 fd = vFlow.xy / max(1e-3, length(vFlow.xy)); fd.y = -fd.y;
            float sp = 0.9 + 3.0 * vFlow.z;
          #else
            vec2 fd = vec2(0.6, 0.8); float sp = 0.25;
          #endif
          // Each layer fades out once a pixel is wider than about half its ripples, or at a glancing
          // angle far off they sparkle into dark specks.
          float fw = length(fwidth(vWP.xz));
          vec2 g = wGrad(vWP.xz * 0.28 - fd * uWTime * sp * 0.28) * 0.6 * (1.0 - smoothstep(0.8, 2.4, fw))
                 + wGrad(vWP.xz * 0.75 - fd * uWTime * sp * 0.6 + vec2(0.3, -0.2) * uWTime * 0.3 + 7.1) * 0.4 * (1.0 - smoothstep(0.3, 0.9, fw));
          float amp = 0.22 * (1.0 - wFoam);
          #ifdef RIVER
            amp *= 1.0 + 1.5 * vFlow.z;
          #endif
          normal = normalize(normal + (viewMatrix * vec4(uMapRot * vec3(g.x, 0.0, g.y), 0.0)).xyz * amp);
        }`)
      .replace('#include <opaque_fragment>', `{
          // The sky in the water, at a glancing angle.
          vec3 vd = normalize(vViewPosition), up = normalize((viewMatrix * vec4(uUpW, 0.0)).xyz);
          vec3 rf = reflect(-vd, normal);
          float fres = 0.02 + 0.98 * pow(1.0 - clamp(dot(normal, vd), 0.0, 1.0), 5.0);
          fres *= 1.0 - wFoam;
          // (The water is rough at this scale: it mirrors a blurred sky, mostly its blue, never white.)
          vec3 sky = mix(mix(uSkyHor, uSkyTop, 0.45), uSkyTop, smoothstep(0.0, 0.5, dot(rf, up)));
          outgoingLight = mix(outgoingLight, sky * 0.9, min(0.55, fres * 0.6));
          diffuseColor.a = mix(diffuseColor.a, 1.0, fres * 0.6);
        }
        #include <opaque_fragment>`);
  };
  mat.customProgramCacheKey = () => (river ? 'hexriver2' : 'hexwater2');
  return mat;
}

/** For the terrain: wet sand above the waterline (following the swell) and light playing on the
 * bed under shallow water. level: the sea's or lake's surface, or NaN. */
export const shoreUniforms = { uSeaLevel: { value: -1e9 }, uLakeLevel: { value: -1e9 } };
export const SHORE_GLSL = /* glsl */`
  uniform float uSeaLevel, uLakeLevel, uWTime;
  float sHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float sNoise(vec2 p) {
    vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
    return mix(mix(sHash(i), sHash(i + vec2(1, 0)), f.x), mix(sHash(i + vec2(0, 1)), sHash(i + vec2(1, 1)), f.x), f.y);
  }
  // How wet (0..1) and how much caustic light (0..1) at a ground point (x, h, z).
  vec2 shore(vec3 p, float slope) {
    float wet = 0.0, ca = 0.0;
    for (int k = 0; k < 2; k++) {
      float lv = k == 0 ? uSeaLevel : uLakeLevel;
      if (lv < -1e8) continue;
      float swell = sin(uWTime * 0.55 + p.x * 0.021 + p.z * 0.013) * 0.09 + sin(uWTime * 0.83 - p.x * 0.011 + p.z * 0.024) * 0.05;
      float above = p.y - (lv + swell);
      // (Only the band just above the water: under it the bed keeps its colour.)
      // A few metres up the beach (by distance: the height over the water, over the slope), not
      // every flat under a metre high.
      float run = above / max(slope, 0.004);
      wet = max(wet, (1.0 - smoothstep(0.0, 0.5 + 0.4 * sNoise(p.xz * 0.2), above)) * (1.0 - smoothstep(1.5, 4.0 + 2.0 * sNoise(p.xz * 0.13), run))
                     * smoothstep(-0.35, -0.05, above));
      float d = -above;
      if (d > 0.0) {
        vec2 q = p.xz * 0.45;
        float c1 = 1.0 - abs(sNoise(q + vec2(uWTime * 0.35, uWTime * 0.2)) * 2.0 - 1.0);
        float c2 = 1.0 - abs(sNoise(q * 1.3 - vec2(uWTime * 0.25, -uWTime * 0.3) + 4.0) * 2.0 - 1.0);
        ca = max(ca, pow(c1 * c2, 4.0) * smoothstep(0.0, 0.3, d) * (1.0 - smoothstep(0.5, 4.0, d)));
      }
    }
    return vec2(wet, ca);
  }`;
