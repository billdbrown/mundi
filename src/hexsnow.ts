/**
 * Snow on the hex view's ground, per pixel (Bill, 2026-11-06: "snow on these mountain peaks
 * doesn't look nearly snowy enough", with photographs of the Alps).
 *
 * The map says where snow can lie (grain.z, hexstyle.ts groundGrain: the snow layer, from
 * hexlocal.ts). Here, per pixel:
 *  - Steep faces shed it: they show as dark rock, with a crisp, broken edge (the rock texture
 *    decides exactly where), as the black crags and ribs between white slopes in the photographs.
 *  - Snow is white, cool rather than cream (the style's light and grade are warm), with no ground
 *    grain, a faint wind ripple, and a little sheen.
 *  - In shade it goes blue: the light there is the sky's, and snow reflects nearly all of it.
 *
 * Chained onto the ground material's own onBeforeCompile (texturedGround, hex.ts), after the
 * blocks already there: call snowGround(sh) last.
 */

import type * as THREE from 'three';

// How steep (1 - the normal's up component) a face must be for snow to slide off it, and how much
// the rock texture breaks the edge up. (On the mountain hexes measured, half the snowy ground is
// steeper than 0.08 and a tenth steeper than 0.2-0.25: this leaves rock on about a quarter.)
const SHED = 0.17, SHED_SOFT = 0.035, BREAK = 0.12;

export function snowGround(sh: { fragmentShader: string }) {
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <alphamap_fragment>', /* glsl */`
      // --- Snow (hexsnow.ts).
      float snowZone = smoothstep(0.15, 0.6, vGrain.z);
      float snowK = 0.0;
      if (snowZone > 0.0) {
        vec2 suv = vLPos.xz / 7.0;
        vec2 suv2 = mat2(0.8, -0.6, 0.6, 0.8) * suv * 0.37;
        // The rock texture at two scales: where it is dark, snow gives out first.
        float rk = 0.5 * (texL(tRock, suv * 0.5) + texL(tRock, suv2 * 0.5)) / uMeans.z;
        float rkFine = texL(tRock, suv2 * 2.3) / uMeans.z;
        float rkBig = texL(tRock, suv * 0.06) / uMeans.z;
        float steep = 1.0 - normalize(vLN).y;
        // Thicker snow (deeper in the zone) clings to steeper ground.
        float shed = ${SHED.toFixed(3)} + 0.05 * smoothstep(0.6, 1.0, vGrain.z);
        // (Three scales of the texture fray the edge, so rock reads as ribs and crags, not blobs.)
        float frayed = steep + ${BREAK.toFixed(3)} * ((1.0 - rk) * 0.6 + (1.0 - rkBig) * 0.6 + (1.0 - rkFine) * 0.5);
        snowK = 1.0 - smoothstep(shed - ${SHED_SOFT.toFixed(3)}, shed + ${SHED_SOFT.toFixed(3)}, frayed);
        // Snow caught on the rock's ledges: where the texture is bright and the face not sheer.
        // (By the middle scale: the fine one salted the rock with white specks.)
        snowK = max(snowK, smoothstep(1.2, 1.45, rk) * (1.0 - smoothstep(shed + 0.04, shed + 0.22, steep)) * 0.9);
        // Thin cover at the zone's edge: patchy, by the same texture.
        snowK *= smoothstep(0.0, 0.35, snowZone - 0.25 * (1.0 - rkBig));
        // Rock in the snow zone: dark and grey, as wet granite and schist look against snow.
        // (Dark cool grey, smooth: textured, under the style's gold, it read as brown dirt and gravel.)
        vec3 rockCol = vec3(0.105, 0.108, 0.115) * clamp((0.55 + 0.45 * rk) * (0.7 + 0.45 * rkBig), 0.5, 1.6);
        // Snow: cool white; a faint wind ripple instead of the ground's grain.
        float rip = texL(tGround, vec2(vLPos.x * 0.9 + vLPos.z * 0.35, vLPos.z * 0.12) * 0.5) / uMeans.y;
        vec3 snowCol = vec3(0.86, 0.9, 0.97) * (0.96 + 0.05 * rip);
        vec3 zoneCol = mix(rockCol, snowCol, snowK);
        diffuseColor.rgb = mix(diffuseColor.rgb, zoneCol, snowZone);
        snowK *= snowZone;
      }
      #include <alphamap_fragment>`)
    .replace('#include <metalnessmap_fragment>', /* glsl */`#include <metalnessmap_fragment>
      // Snow has a little sheen; the rock among it is rough.
      roughnessFactor = mix(roughnessFactor, 0.62, snowK);`)
    .replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
      // In shade snow is lit by the sky: blue. In sun, less of the style's gold.
      reflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(0.78, 0.93, 1.35), snowK);
      reflectedLight.directDiffuse *= mix(vec3(1.0), vec3(0.93, 0.98, 1.08), snowK);`);
}

/**
 * The same light on snow in the blurred backdrop of neighbouring hexes (hex.ts addContext), which
 * is painted, not textured: near-white ground there is snow. Chains onto any onBeforeCompile.
 */
export function snowContext(mat: THREE.Material) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        float snowK = smoothstep(0.62, 0.8, min(diffuseColor.r, min(diffuseColor.g, diffuseColor.b)));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.86, 0.9, 0.97), snowK);`)
      .replace('#include <lights_fragment_end>', /* glsl */`#include <lights_fragment_end>
        reflectedLight.indirectDiffuse *= mix(vec3(1.0), vec3(0.78, 0.93, 1.35), snowK);
        reflectedLight.directDiffuse *= mix(vec3(1.0), vec3(0.93, 0.98, 1.08), snowK);`);
  };
  mat.customProgramCacheKey = () => prevKey.call(mat) + '+snow';
}
