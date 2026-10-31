/** Water shader, clouds (and their shadows), atmosphere and stars. */
import * as THREE from 'three';
import { makeSimplex, fbm } from './noise.ts';
import { hash01 } from './rng.ts';

/** Uniforms shared by every material that receives cloud shadows. */
export interface CloudUniforms {
  uCloudMap: { value: THREE.Texture | null };
  uCloudRot: { value: number };
  uCloudShadow: { value: number };
}

export function makeCloudUniforms(): CloudUniforms {
  return { uCloudMap: { value: null }, uCloudRot: { value: 0 }, uCloudShadow: { value: 0 } };
}

/**
 * Looks up cloud cover straight above a world point. The UV maths mirrors THREE.SphereGeometry
 * (u = φ/2π with x = −cos φ, v = 1 − θ/π) and undoes the cloud sphere's Y rotation.
 * textureLod avoids the mip seam where φ wraps.
 */
const CLOUD_GLSL = /* glsl */`
  uniform sampler2D uCloudMap;
  uniform float uCloudRot, uCloudShadow;
  float cloudShade(vec3 p) {
    if (uCloudShadow <= 0.0) return 1.0;
    vec3 d = normalize(p);
    float c = cos(uCloudRot), s = sin(uCloudRot);
    vec3 q = vec3(d.x * c - d.z * s, d.y, d.x * s + d.z * c);
    float theta = acos(clamp(q.y, -1.0, 1.0));
    float phi = atan(q.z, -q.x);
    if (phi < 0.0) phi += 6.2831853;
    float a = textureLod(uCloudMap, vec2(phi / 6.2831853, 1.0 - theta / 3.14159265), 1.5).a;
    return 1.0 - uCloudShadow * a;
  }
`;

/** Patches a built-in lit material so clouds darken what is under them. Handles instancing. */
export function applyCloudShadow(mat: THREE.Material, u: CloudUniforms) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec4 cloudP = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cloudP = instanceMatrix * cloudP;
        #endif
        vCloudP = (modelMatrix * cloudP).xyz;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCloudP;\n' + CLOUD_GLSL)
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb *= cloudShade(vCloudP);');
  };
  mat.needsUpdate = true;
}

export function makeWaterMaterial(cloud: CloudUniforms): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      ...cloud,
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uShallow: { value: new THREE.Color(0x45c0c0) },
      uMid: { value: new THREE.Color(0x1a6a9a) },
      uDeep: { value: new THREE.Color(0x082a50) },
      uSky: { value: new THREE.Color(0xa8cff2) },
      uDepthScale: { value: 0.014 },
      uFoam: { value: 0.0013 },
    },
    vertexShader: /* glsl */`
      attribute float depth;
      varying float vDepth;
      varying vec3 vWorld;
      void main() {
        vDepth = depth;
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }`,
    fragmentShader: /* glsl */`
      uniform float uTime, uDepthScale, uFoam;
      uniform vec3 uSunDir, uShallow, uMid, uDeep, uSky;
      varying float vDepth;
      varying vec3 vWorld;
      ${CLOUD_GLSL}

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
        vec3 col = d < 0.25 ? mix(uShallow, uMid, d / 0.25) : mix(uMid, uDeep, (d - 0.25) / 0.75);
        // Light passing through wave crests in shallow water.
        col += uShallow * (h0 - 0.5) * 0.25 * near * (1.0 - d);

        float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        col = mix(col, uSky, 0.04 + fres * 0.55);
        float diff = 0.55 + 0.45 * max(dot(N, uSunDir), 0.0);
        vec3 R = reflect(-uSunDir, N);
        // Glint: broad and soft from orbit, tight and bright up close.
        float shine = mix(110.0, 380.0, near);
        float spec = pow(max(dot(R, V), 0.0), shine) * mix(0.45, 2.2, near);
        float shade = cloudShade(vWorld);
        col = col * diff * shade + vec3(spec) * shade;

        // Foam: a steady line at the shore, plus swells rolling in toward it.
        // Depth is interpolated linearly across big triangles, so shore lines come out straight;
        // wobbling it with noise makes the foam follow a ragged, natural-looking shore.
        float fd = vDepth + (vnoise(vWorld * 900.0) - 0.5) * uFoam * 1.6 + (vnoise(vWorld * 2400.0) - 0.5) * uFoam * 0.7;
        float edge = 1.0 - smoothstep(0.0, uFoam, fd);
        float zone = 1.0 - smoothstep(0.0, uFoam * 2.5, fd);
        float swell = smoothstep(0.8, 1.0, sin(fd / uFoam * 4.0 + t * 1.6)) * zone * 0.6;
        float breakup = smoothstep(0.35, 0.75, vnoise(vWorld * 2600.0 + vec3(t * 0.3)));
        float foam = clamp(edge * (0.6 + 0.4 * breakup) + swell * breakup * near, 0.0, 1.0);
        col = mix(col, vec3(0.94, 0.97, 0.98) * shade, foam * 0.8);

        float a = mix(0.5, 0.95, smoothstep(0.0, 0.35, d));
        gl_FragColor = vec4(col, max(a, foam * 0.9));
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

export interface CloudTextures { main: THREE.Texture; cirrus: THREE.Texture }
const cloudCache = new Map<number, CloudTextures>();

function canvasTexture(W: number, H: number, fill: (lat: number, x: number, y: number, z: number) => [number, number]): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  for (let py = 0; py < H; py++) {
    const lat = Math.PI / 2 - ((py + 0.5) / H) * Math.PI;
    for (let px = 0; px < W; px++) {
      const lon = ((px + 0.5) / W) * Math.PI * 2;
      const [shade, alpha] = fill(lat, Math.cos(lat) * Math.cos(lon), Math.sin(lat), Math.cos(lat) * Math.sin(lon));
      const i = (py * W + px) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(shade * 255);
      img.data[i + 3] = Math.round(alpha * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Two equirectangular cloud layers. The main deck is domain-warped noise, banded like Earth's
 * (cloudy at the equator and 60°, clear at 30°) with grey undersides where it is thick. The
 * cirrus layer is thin streaks stretched east–west.
 */
export function cloudTextures(seed: number): CloudTextures {
  const hit = cloudCache.get(seed);
  if (hit) return hit;
  const n1 = makeSimplex(seed * 31 + 7), n2 = makeSimplex(seed * 31 + 8), n3 = makeSimplex(seed * 31 + 9);
  const main = canvasTexture(768, 384, (lat, x, y, z) => {
    const band = 0.5 + 0.5 * Math.cos(6 * lat);
    const qx = fbm(n2, x, y, z, 3, 1.4), qy = fbm(n2, x + 4.7, y, z, 3, 1.4);
    const v = fbm(n1, x + qx * 0.7, y + qy * 0.7, z, 6, 2.2);
    const cover = v + 0.2 * band - 0.24;
    const a = smooth(0.0, 0.42, cover);
    const thick = smooth(0.25, 0.7, cover);
    return [1 - 0.28 * thick, a];
  });
  const cirrus = canvasTexture(768, 384, (lat, x, y, z) => {
    // Stretching the sample along y turns blobs into east–west streaks.
    const v = fbm(n3, x * 1.2, y * 6, z * 1.2, 5, 1.8);
    const band = 0.6 + 0.4 * Math.cos(4 * lat);
    return [1, smooth(0.15, 0.6, v * band) * 0.55];
  });
  const out = { main, cirrus };
  cloudCache.set(seed, out);
  return out;
}

export function makeClouds(): THREE.Group {
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
  g.add(layer(1.028, 0.8), layer(1.042, 0.5));
  return g;
}

function fresnelShell(radius: number, side: THREE.Side, power: number, strength: number, color: number): THREE.Mesh {
  const c = new THREE.Color(color);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: c }, uPower: { value: power }, uStrength: { value: strength }, uBack: { value: side === THREE.BackSide ? 1 : 0 } },
    vertexShader: /* glsl */`
      varying vec3 vN; varying vec3 vV;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uColor; uniform float uPower, uStrength, uBack;
      varying vec3 vN; varying vec3 vV;
      void main() {
        float d = dot(vN, vV);
        float f = uBack > 0.5
          // Far side of the shell: 0 at its silhouette, rising toward the planet's limb.
          ? pow(smoothstep(0.0, 0.32, -d), uPower)
          // Near side: a haze that thickens toward the planet's edge but fades out at the shell's.
          : pow(1.0 - d, uPower) * smoothstep(0.0, 0.25, d);
        gl_FragColor = vec4(uColor * f * uStrength, 1.0);
      }`,
    side, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
  });
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 96, 48), mat);
}

/** Outer glow at the limb plus a faint blue haze over the planet's edge. */
export function makeAtmosphere(): THREE.Group {
  const g = new THREE.Group();
  g.add(fresnelShell(1.05, THREE.BackSide, 1.8, 0.7, 0x6aaeff));
  const haze = fresnelShell(1.045, THREE.FrontSide, 3.0, 0.45, 0x8fc4ff);
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
