/**
 * A carpet of grass blades around the camera (2026-11-06), so close up the ground is a sward rather
 * than a texture with tufts dotted on it. Drawn entirely on the GPU: each blade's place comes from
 * its instance number on a grid that follows the camera (snapped to the grid, so blades stay put as
 * it moves); a map of the tile says how thick and tall the grass is there and what colour.
 *
 * Two rings: fine blades within ~40 m, coarser clumps out to ~120 m, both fading out at their edge
 * and from high up, where the ground's own texture is the grass.
 */
import * as THREE from 'three';
import { LAYERS, L_DEPTH, L_FIELD, L_PATH, L_LUSH, L_HEDGE, L_ALPINE, type LocalMap } from './hexlocal.ts';
import { SWAY_GLSL, wind } from './hexwind.ts';

/** Per tile: where grass grows and how, as textures over the map square. */
export interface GrassField { col: THREE.DataTexture; hgt: THREE.DataTexture }

/**
 * Build the grass maps from the ground: paint (linear RGB per sample, as the terrain is drawn),
 * grain (soil, stone, snow per sample: hexstyle.ts groundGrain), shade (0..1 crowns overhead, at
 * CANOPY resolution), and the water.
 */
export function grassField(m: LocalMap, paint: Float32Array, grain: Float32Array, shade: Uint8Array, shadeRes: number): GrassField {
  const R = m.res, N = R * R;
  const col = new Uint8Array(N * 4), hgt = new Float32Array(N * 2);
  for (let v = 0; v < N; v++) {
    const L = v * LAYERS, ly = (k: number) => m.layers[L + k];
    const i = v % R, j = (v / R) | 0;
    const sh = shade[Math.min(shadeRes - 1, Math.floor((j + 0.5) / R * shadeRes)) * shadeRes + Math.min(shadeRes - 1, Math.floor((i + 0.5) / R * shadeRes))] / 255;
    const h = m.heights[v];
    const wet = ly(L_DEPTH) > 0 || (m.sea && h < 0.3) || (!Number.isNaN(m.lakeLevel) && m.lakeMask[v] > 0.5 && h < m.lakeLevel + 0.2);
    const bare = Math.max(grain[v * 3], grain[v * 3 + 1], grain[v * 3 + 2] * 1.4, ly(L_PATH));
    const field = ly(L_FIELD);
    let dens = wet ? 0 : Math.max(0, 1 - bare * 1.35) * (1 - 0.75 * sh);
    // Sparse and short where it is cold up high; tall and lush in wet meadows; crops tall and even.
    let tall = 0.32 + 0.4 * ly(L_LUSH) - 0.15 * ly(L_ALPINE) + 0.25 * ly(L_HEDGE);
    if (field > 0.5) { dens = Math.max(dens, 0.95); tall = 0.85; }
    // Colour: the ground's own, a touch brighter and greener so blades read against it.
    const r = paint[v * 3], g = paint[v * 3 + 1], b = paint[v * 3 + 2];
    const k = field > 0.5 ? 1.1 : 1.15;
    col[v * 4] = Math.round(255 * Math.sqrt(Math.min(1, r * k)));
    col[v * 4 + 1] = Math.round(255 * Math.sqrt(Math.min(1, g * k * (field > 0.5 ? 1 : 1.06))));
    col[v * 4 + 2] = Math.round(255 * Math.sqrt(Math.min(1, b * k)));
    col[v * 4 + 3] = Math.round(255 * Math.min(1, dens));
    hgt[v * 2] = h;
    hgt[v * 2 + 1] = Math.max(0.12, tall);
  }
  const ct = new THREE.DataTexture(col, R, R, THREE.RGBAFormat, THREE.UnsignedByteType);
  const ht = new THREE.DataTexture(hgt, R, R, THREE.RGFormat, THREE.FloatType);
  ct.magFilter = ct.minFilter = THREE.LinearFilter;
  // (Float textures aren't filterable everywhere; the shader filters heights itself.)
  ht.magFilter = ht.minFilter = THREE.NearestFilter;
  ct.needsUpdate = ht.needsUpdate = true;
  return { col: ct, hgt: ht };
}

/** One ring of blades: a grid of n x n around the camera, `spacing` metres apart. */
function ring(n: number, spacing: number, width: number, inner: number) {
  // A clump of three blades fanned out, each a tapering strip in 3 segments leaning outward;
  // x and z across (in blade widths), y up (0..1). Thin grass reads as tussocks, not lone spikes.
  const segs = 3, pos: number[] = [], idx: number[] = [];
  for (let b = 0; b < 3; b++) {
    const a = b * 2.094 + 0.3 * b, ca = Math.cos(a), sa = Math.sin(a), o0 = pos.length / 3;
    for (let k = 0; k <= segs; k++) {
      const y = k / segs, w = (1 - y * 0.85) * 0.5, out = 0.3 + y * y * 1.6;
      // Across the blade is perpendicular to its outward lean.
      const pt = (x: number) => pos.push(ca * out - sa * x, y * (0.85 + 0.15 * b), sa * out + ca * x);
      if (k < segs) { pt(-w); pt(w); } else pt(0);
    }
    for (let k = 0; k < segs - 1; k++) { const o = o0 + k * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
    const o = o0 + (segs - 1) * 2; idx.push(o, o + 1, o + 2);
  }
  const g = new THREE.InstancedBufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setIndex(idx);
  g.instanceCount = n * n;
  // Instanced draws need a bounding sphere; the blades go wherever the camera is.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return { g, n, spacing, width, inner };
}

export const grassUniforms = {
  tGrassCol: { value: null as THREE.DataTexture | null },
  tGrassHgt: { value: null as THREE.DataTexture | null },
  /** Map half-size and full size, metres; samples per side. */
  uGMap: { value: new THREE.Vector3(1, 2, 2) },
  /** Camera on the map (x, height, -y): three.js axes, map metres. */
  uGCam: { value: new THREE.Vector3() },
  /** 0..1: fades the carpet out as the camera climbs. */
  uGShow: { value: 1 },
};

export class Grass {
  readonly group = new THREE.Group();
  private mats: THREE.MeshStandardMaterial[] = [];

  constructor(field: GrassField, m: LocalMap) {
    grassUniforms.tGrassCol.value = field.col;
    grassUniforms.tGrassHgt.value = field.hgt;
    grassUniforms.uGMap.value.set(m.size / 2, m.size, m.res);
    // Near: fine blades; far: wider clumps, fewer.
    for (const r of [ring(260, 0.32, 0.07, 0), ring(200, 1.1, 0.2, 36)]) {
      const mat = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, roughness: 0.85, vertexColors: false });
      mat.onBeforeCompile = (sh) => {
        Object.assign(sh.uniforms, grassUniforms, wind, { uGSpacing: { value: r.spacing }, uGN: { value: r.n }, uGWidth: { value: r.width }, uGInner: { value: r.inner } });
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>
            ${SWAY_GLSL}
            uniform sampler2D tGrassCol, tGrassHgt; uniform vec3 uGMap, uGCam; uniform float uGShow;
            uniform float uGSpacing, uGN, uGWidth, uGInner;
            varying vec3 vGCol; varying float vGY;
            float gHash(vec2 p) { return fract(sin(dot(p, vec2(41.31, 289.17))) * 43758.5453); }
            vec2 gHgt(vec2 uv) {
              // Bilinear by hand (float textures may not filter).
              vec2 t = uv * uGMap.z - 0.5, f = fract(t), b = (floor(t) + 0.5) / uGMap.z, e = vec2(1.0 / uGMap.z, 0.0);
              return mix(mix(texture2D(tGrassHgt, b).rg, texture2D(tGrassHgt, b + e.xy).rg, f.x),
                         mix(texture2D(tGrassHgt, b + e.yx).rg, texture2D(tGrassHgt, b + e.xx).rg, f.x), f.y);
            }`)
          .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
          .replace('#include <begin_vertex>', `
            vec3 transformed = vec3(0.0, -1e5, 0.0);
            vGCol = vec3(0.0); vGY = position.y;
            {
              float id = float(gl_InstanceID);
              vec2 cell = vec2(mod(id, uGN), floor(id / uGN)) - uGN * 0.5;
              vec2 base = floor(uGCam.xz / uGSpacing) * uGSpacing;
              vec2 wc = floor(base / uGSpacing) + cell;          // the cell in map-wide terms: stable
              vec2 p = (wc + vec2(gHash(wc), gHash(wc + 17.3))) * uGSpacing;
              vec2 uv0 = vec2(p.x + uGMap.x, -p.y + uGMap.x) / uGMap.y, uv = (uv0 * (uGMap.z - 1.0) + 0.5) / uGMap.z;
              float r = gHash(wc + 3.1);
              vec4 c = texture2D(tGrassCol, uv);
              float d = length(p - uGCam.xz), R = uGN * uGSpacing * 0.5;
              float fade = (1.0 - smoothstep(R * 0.6, R * 0.95, d)) * smoothstep(uGInner * 0.8, uGInner * 1.1, d) * uGShow;
              if (uv0.x > 0.0 && uv0.x < 1.0 && uv0.y > 0.0 && uv0.y < 1.0 && r < c.a && fade > 0.01) {
                vec2 hg = gHgt(uv);
                float tall = hg.y * (0.6 + 0.8 * gHash(wc + 7.7)) * fade;
                float a = gHash(wc + 9.2) * 6.283, ca = cos(a), sa = sin(a);
                float wd = uGWidth * (0.7 + 0.6 * r / max(c.a, 0.01));
                vec3 q = vec3(position.x * wd, position.y * tall, position.z * wd);
                q = vec3(q.x * ca - q.z * sa, q.y, q.x * sa + q.z * ca);
                // Leaning a little at random, then the wind on top.
                vec2 lean = vec2(gHash(wc + 4.4) - 0.5, gHash(wc + 5.5) - 0.5) * 0.5;
                q.xz += lean * position.y * position.y * tall;
                q += windSway(p, position.y, 1.0, 0.55) * tall * 3.0;
                transformed = vec3(p.x, hg.x, p.y) + q;
                vGCol = c.rgb * c.rgb;
              }
            }`);
        sh.fragmentShader = sh.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vGCol; varying float vGY;')
          // Both faces lit as the ground is (three turns a back face's normal away, blackening it).
          .replace('#include <normal_fragment_begin>', THREE.ShaderChunk.normal_fragment_begin.replace('normal *= faceDirection;', ''))
          .replace('#include <color_fragment>', `#include <color_fragment>
            // Darker at the root (the sward shades itself), lighter at the tip.
            diffuseColor.rgb = vGCol * mix(0.55, 1.18, vGY);`);
      };
      mat.customProgramCacheKey = () => 'hexgrass' + r.n;
      const mesh = new THREE.Mesh(r.g, mat);
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.name = 'grass';
      this.group.add(mesh);
      this.mats.push(mat);
    }
  }

  /** Follow the camera (map coordinates, three.js axes) at hAG metres over the ground. */
  update(cam: THREE.Vector3, hAG: number) {
    grassUniforms.uGCam.value.copy(cam);
    // The blade grid uses (x, z) as the map's (x, -y): uGCam.xz is three.js x, z.
    grassUniforms.uGShow.value = 1 - THREE.MathUtils.smoothstep(hAG, 25, 70);
    this.group.visible = grassUniforms.uGShow.value > 0.01;
  }

  dispose() {
    for (const c of this.group.children) (c as THREE.Mesh).geometry.dispose();
    for (const m of this.mats) m.dispose();
  }
}
