/** Water shader, clouds (and their shadows), atmosphere and stars. */
import * as THREE from 'three';
import type { CloudPixels } from './clouds.ts';
import { hash01 } from './rng.ts';

/** Uniforms shared by every material that receives cloud shadows. */
export interface CloudUniforms {
  uCloudMap: { value: THREE.Texture | null };
  uCloudRot: { value: number };
  uCloudShadow: { value: number };
  /** Seconds; drives how cloud shapes evolve. */
  uCloudTime: { value: number };
  /** Sun direction, so shadows fall on the side of a cloud away from the sun. */
  uCloudSun: { value: THREE.Vector3 };
}

export function makeCloudUniforms(): CloudUniforms {
  return { uCloudMap: { value: null }, uCloudRot: { value: 0 }, uCloudShadow: { value: 0 }, uCloudTime: { value: 0 }, uCloudSun: { value: new THREE.Vector3(0, 0, 1) } };
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
`;

/**
 * Looks up cloud cover straight above a world point. The UV maths mirrors THREE.SphereGeometry
 * (u = φ/2π with x = −cos φ, v = 1 − θ/π) and undoes the cloud sphere's Y rotation.
 * textureLod avoids the mip seam where φ wraps.
 */
const CLOUD_GLSL = /* glsl */`
  uniform sampler2D uCloudMap;
  uniform float uCloudRot, uCloudShadow, uCloudTime;
  uniform vec3 uCloudSun;
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
  // Wide ramp: thin cloud is translucent, only the cores are opaque.
  float cloudAlpha(float cover) { return smoothstep(0.47, 0.86, cover); }
  float cloudShade(vec3 p) {
    if (uCloudShadow <= 0.0) return 1.0;
    vec3 n = normalize(p);
    // The cloud shading this point sits up the line toward the sun, at cloud height: offset the
    // lookup sunward, more when the sun is low (capped near the terminator).
    float mu = max(dot(n, uCloudSun), 0.25);
    vec3 d = normalize(n + (uCloudSun - n * dot(n, uCloudSun)) * (0.016 / mu));
    float c = cos(uCloudRot), s = sin(uCloudRot);
    vec3 q = vec3(d.x * c - d.z * s, d.y, d.x * s + d.z * c);
    float theta = acos(clamp(q.y, -1.0, 1.0));
    float phi = atan(q.z, -q.x);
    if (phi < 0.0) phi += 6.2831853;
    float raw = textureLod(uCloudMap, vec2(phi / 6.2831853, 1.0 - theta / 3.14159265), 1.5).a;
    return 1.0 - uCloudShadow * cloudAlpha(cloudCover(raw, q, uCloudTime));
  }
`;

/**
 * Terrain material: cloud shadows, plus detail the mesh is too coarse for. A noise gradient
 * bends the normal so slopes catch light like rock and scree, stronger on high ground, and
 * the same noise breaks up colour. Both fade out with distance, where they would only shimmer.
 */
export function makeTerrainMaterial(u: CloudUniforms): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCloudP = (modelMatrix * vec4(transformed, 1.0)).xyz;');
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
        }`)
      .replace('#include <color_fragment>', /* glsl */`#include <color_fragment>
        float hAbove = length(vCloudP) - 1.0;
        float camDist = length(cameraPosition - vCloudP);
        float detailFade = 1.0 - smoothstep(0.25, 1.4, camDist);
        float highland = smoothstep(0.004, 0.03, hAbove);
        float rn = rockNoise(vCloudP);
        diffuseColor.rgb *= mix(1.0, 0.82 + 0.36 * rn, (0.35 + 0.65 * highland) * detailFade);
        float farFade = smoothstep(0.12, 0.8, camDist) * step(0.0005, hAbove);
        float ln = landNoise(vCloudP);
        diffuseColor.rgb *= mix(1.0, 0.74 + 0.52 * ln, (0.45 + 0.55 * highland) * farFade);
        diffuseColor.rgb *= cloudShade(vCloudP);`)
      .replace('#include <normal_fragment_maps>', /* glsl */`#include <normal_fragment_maps>
        if (detailFade > 0.0 && hAbove > 0.0) {
          vec3 up = normalize(vCloudP);
          vec3 t1 = normalize(cross(up, abs(up.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
          vec3 t2 = cross(up, t1);
          float e = 0.0003;
          vec3 grad = t1 * (rockNoise(vCloudP + t1 * e) - rn) + t2 * (rockNoise(vCloudP + t2 * e) - rn);
          float amp = (0.2 + 1.6 * highland) * detailFade;
          normal = normalize(normal - (viewMatrix * vec4(grad * amp, 0.0)).xyz);
        }
        if (farFade > 0.0) {
          vec3 up = normalize(vCloudP);
          vec3 t1 = normalize(cross(up, abs(up.y) < 0.99 ? vec3(0, 1, 0) : vec3(1, 0, 0)));
          vec3 t2 = cross(up, t1);
          float e = 0.002;
          vec3 grad = t1 * (landNoise(vCloudP + t1 * e) - ln) + t2 * (landNoise(vCloudP + t2 * e) - ln);
          float amp = (1.2 + 7.0 * highland) * farFade;
          normal = normalize(normal - (viewMatrix * vec4(grad * amp, 0.0)).xyz);
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
  const grow = fade ? `
        #ifdef USE_INSTANCING
          vec4 fadeO = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          transformed *= 1.0 - smoothstep(uFadeNear, uFadeFar, length(cameraPosition - fadeO.xyz));
        #endif` : '';
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, sun ?? {}, fade ?? {});
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;' + (fade ? '\nuniform float uFadeNear, uFadeFar;' : ''))
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
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...cloud,
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
      void main() {
        vDepth = depth;
        #ifdef USE_FADE
          vFade = fade;
        #endif
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
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
        vec3 Ng = normalize(vWorld);
        vec3 V = normalize(cameraPosition - vWorld);
        float dist = length(cameraPosition - vWorld);
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
        float day = smoothstep(-0.12, 0.22, dot(Ng, uSunDir));
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
  const deck = layer(1.016, 0.85), cirrus = layer(1.024, 0.5);
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
          float cover = cloudCover(texture2D(map, vMapUv).a, normalize(vCloudLocal), uCloudTime);
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
