/** Water shader, clouds, atmosphere and stars. */
import * as THREE from 'three';
import { makeSimplex, fbm } from './noise.ts';
import { hash01 } from './rng.ts';

export function makeWaterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uShallow: { value: new THREE.Color(0x3fb6bd) },
      uMid: { value: new THREE.Color(0x1d6f9e) },
      uDeep: { value: new THREE.Color(0x0b2f57) },
      uSky: { value: new THREE.Color(0x9cc7ef) },
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
      void main() {
        vec3 N = normalize(vWorld);
        // Cheap animated ripples: a few crossing sine fields nudge the normal.
        vec3 p = vWorld * 900.0;
        float t = uTime;
        vec3 g = vec3(
          sin(p.y * 0.71 + t * 1.3) + sin(p.z * 1.13 - t * 0.9),
          sin(p.z * 0.83 + t * 1.1) + sin(p.x * 1.29 + t * 0.7),
          sin(p.x * 0.77 - t * 1.2) + sin(p.y * 1.21 + t * 0.95));
        // Fade ripples with distance: at orbit they alias into stripes.
        float near = 1.0 - smoothstep(0.15, 1.2, length(cameraPosition - vWorld));
        N = normalize(N + g * 0.018 * near);

        float d = clamp(vDepth / uDepthScale, 0.0, 1.0);
        vec3 col = d < 0.25 ? mix(uShallow, uMid, d / 0.25) : mix(uMid, uDeep, (d - 0.25) / 0.75);

        vec3 V = normalize(cameraPosition - vWorld);
        float fres = pow(1.0 - max(dot(N, V), 0.0), 5.0);
        col = mix(col, uSky, fres * 0.55);
        float diff = 0.5 + 0.5 * max(dot(N, uSunDir), 0.0);
        vec3 R = reflect(-uSunDir, N);
        float spec = pow(max(dot(R, V), 0.0), 140.0) * 1.6;
        col = col * diff + vec3(spec);

        float edge = 1.0 - smoothstep(0.0, uFoam, vDepth);
        float lap = 0.65 + 0.35 * sin(t * 1.8 + (vWorld.x + vWorld.y + vWorld.z) * 500.0);
        col = mix(col, vec3(0.93, 0.96, 0.97), clamp(edge * lap, 0.0, 1.0) * 0.75);

        float a = mix(0.5, 0.94, smoothstep(0.0, 0.35, d));
        gl_FragColor = vec4(col, a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

const cloudCache = new Map<number, THREE.Texture>();

/** Equirectangular cloud cover from domain-warped noise, banded like Earth's (cloudy equator and 60°). */
export function cloudTexture(seed: number): THREE.Texture {
  const hit = cloudCache.get(seed);
  if (hit) return hit;
  const W = 512, H = 256;
  const n1 = makeSimplex(seed * 31 + 7), n2 = makeSimplex(seed * 31 + 8);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(W, H);
  for (let y = 0; y < H; y++) {
    const lat = Math.PI / 2 - ((y + 0.5) / H) * Math.PI;
    const band = 0.5 + 0.5 * Math.cos(6 * lat);
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W) * Math.PI * 2;
      const dx = Math.cos(lat) * Math.cos(lon), dy = Math.sin(lat), dz = Math.cos(lat) * Math.sin(lon);
      const q = fbm(n2, dx, dy, dz, 3, 1.6);
      const v = fbm(n1, dx + q * 0.6, dy + q * 0.6, dz, 5, 2.4);
      const cover = v + 0.2 * band - 0.24;
      const a = Math.max(0, Math.min(1, (cover - 0.02) / 0.4));
      const i = (y * W + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = Math.round(a * a * (3 - 2 * a) * 255);
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  cloudCache.set(seed, tex);
  return tex;
}

export function makeClouds(): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, depthWrite: false, roughness: 1, opacity: 0.7 });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1.03, 128, 64), mat);
  mesh.renderOrder = 5;
  return mesh;
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
  const haze = fresnelShell(1.04, THREE.FrontSide, 3.0, 0.45, 0x8fc4ff);
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
