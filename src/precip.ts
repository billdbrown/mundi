/**
 * Weather on the ground (2026-11-03). From orbit the storms are cloud (weather.ts, sky.ts);
 * down low, where the cloud deck has faded out, this is what's left of them: how overcast it is
 * over the camera, whether it is raining or snowing, and lightning close by.
 *
 *  - Cover over the camera: the cloud deck's own sum (sky.ts coverAt: the painted cover carried
 *    by the wind bands, its drifting noise and the storms' spiral bands), redone on the CPU
 *    from the same pixels at one point per frame.
 *  - Rain and snow: streaks or flakes in a box round the camera, moved on the GPU (positions
 *    are fract(seed + velocity t), so nothing is touched per frame but a few uniforms). Rain
 *    where the cloud is thick; snow where the ground is cold (the terrain's own seasonal
 *    temperature, sky.ts seasonalTemp).
 *  - Overcast: a grey sky, the sun hidden, haze closing in (atmosphere.ts), set by render.ts.
 *  - Lightning: in thick cloud in warm air, the scene flashes now and then.
 */
import * as THREE from 'three';
import type { CloudPixels } from './clouds.ts';

const fract = (x: number) => x - Math.floor(x);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (e0: number, e1: number, x: number) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };

// sky.ts cnHash / cnNoise, in double precision (close enough: this sets a mood, not a pixel).
function cnHash(x: number, y: number, z: number) {
  x = fract(x * 0.3183099 + 0.1) * 17; y = fract(y * 0.3183099 + 0.1) * 17; z = fract(z * 0.3183099 + 0.1) * 17;
  return fract(x * y * z * (x + y + z));
}
function cnNoise(x: number, y: number, z: number) {
  const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
  let fx = x - ix, fy = y - iy, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
  const h = (a: number, b: number, c: number) => cnHash(ix + a, iy + b, iz + c);
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(l(l(h(0, 0, 0), h(1, 0, 0), fx), l(h(0, 1, 0), h(1, 1, 0), fx), fy),
    l(l(h(0, 0, 1), h(1, 0, 1), fx), l(h(0, 1, 1), h(1, 1, 1), fx), fy), fz);
}
const windEast = (lat: number) => -0.3 * Math.cos(6 * lat) * smooth(1.5, 1.15, Math.abs(lat));

export interface GroundWeather {
  /** Cloud cover over the camera (0.5 is a cloud's edge, ~0.9 solid). */
  cover: number;
  /** 0..1: how overcast, raining, snowing (snow is the cold share of the falling), thundery. */
  overcast: number; rain: number; snow: number; thunder: number;
  /** 0..1, the lightning flash now. */
  flash: number;
}

export class Precip {
  readonly group = new THREE.Group();
  private alpha: Uint8Array | null = null;
  private W = 0;
  private H = 0;
  private rainMat: THREE.ShaderMaterial;
  private snowMat: THREE.ShaderMaterial;
  private rain: THREE.LineSegments;
  private snow: THREE.Points;
  private flashT = 1;
  private flashPeak = 0;
  private t = 0;
  /** 0 night .. 1 day at the camera: rain and snow are hard to see in the dark, but for lightning. */
  daylight = 1;
  readonly state: GroundWeather = { cover: 0, overcast: 0, rain: 0, snow: 0, thunder: 0, flash: 0 };

  constructor() {
    const uniforms = () => ({
      uT: { value: 0 }, uFrame: { value: new THREE.Matrix4() }, uWind: { value: new THREE.Vector2() },
      uAmount: { value: 0 }, uLen: { value: 0.025 }, uNear: { value: 0.001 }, uColor: { value: new THREE.Color() }, uPx: { value: 1 },
    });
    // Rain: N streaks, two vertices each (top, bottom), in a unit box.
    const N = 6000, pos = new Float32Array(N * 2 * 3), seed = new Float32Array(N * 2 * 4);
    for (let i = 0; i < N; i++) {
      const s = [Math.random(), Math.random(), Math.random(), Math.random()];
      for (let e = 0; e < 2; e++) seed.set([s[0], s[1], s[2], s[3] + 2 * e], (i * 2 + e) * 4);   // w: 0..1 top, 2..3 tail
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    rg.setAttribute('seed', new THREE.BufferAttribute(seed, 4));
    const common = /* glsl */`
      attribute vec4 seed;
      uniform float uT, uAmount, uLen, uNear;
      uniform mat4 uFrame;    // box (east, north, up, each -0.5..0.5) to world
      uniform vec2 uWind;     // sideways drift, box widths a second
      varying float vA;
      vec3 boxPos(float fall, float sway) {
        vec3 p = fract(seed.xyz + vec3(uWind * uT, -fall * uT)) - 0.5;
        p.xy += sway * vec2(sin(uT * 1.7 + seed.w * 40.0), cos(uT * 1.3 + seed.w * 31.0));
        return p;
      }
      // Faded at the box's edges (where drops wrap round) and thinned by the amount falling.
      float boxFade(vec3 p) {
        vec3 a = abs(p);
        return (1.0 - smoothstep(0.3, 0.5, max(max(a.x, a.y), a.z))) * step(fract(seed.w * 0.5 + 0.37), uAmount);
      }`;
    this.rainMat = new THREE.ShaderMaterial({
      uniforms: uniforms(), transparent: true, depthWrite: false,
      vertexShader: common + /* glsl */`
        void main() {
          vec3 p = boxPos(2.6, 0.0);
          // The streak: from where the drop is to where it was a moment ago (wind slants it).
          if (seed.w >= 1.5) p -= vec3(uWind * uLen, -2.6 * uLen);
          vA = boxFade(p);
          vec4 w = uFrame * vec4(p, 1.0);
          vec4 mv = viewMatrix * w;
          // Nothing right at the lens (a streak there filled the screen).
          vA *= smoothstep(uNear, uNear * 3.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vA;
        void main() { gl_FragColor = vec4(uColor, vA * 0.22); }`,
    });
    this.rain = new THREE.LineSegments(rg, this.rainMat);
    // Snow: flakes, one point each, falling slowly and swaying.
    const M = 7000, spos = new Float32Array(M * 3), sseed = new Float32Array(M * 4);
    for (let i = 0; i < M; i++) sseed.set([Math.random(), Math.random(), Math.random(), Math.random() * 2], i * 4);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(spos, 3));
    sg.setAttribute('seed', new THREE.BufferAttribute(sseed, 4));
    this.snowMat = new THREE.ShaderMaterial({
      uniforms: uniforms(), transparent: true, depthWrite: false,
      vertexShader: common + /* glsl */`
        uniform float uPx;
        void main() {
          vec3 p = boxPos(0.22, 0.02);
          vA = boxFade(p);
          vec4 mv = viewMatrix * (uFrame * vec4(p, 1.0));
          vA *= smoothstep(uNear * 0.6, uNear * 1.6, -mv.z);
          gl_PointSize = clamp(uPx * 0.00003 * (0.6 + 0.4 * fract(seed.w * 7.3)) / max(-mv.z, 1e-5), 1.0, 5.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform vec3 uColor;
        varying float vA;
        void main() {
          float r = length(gl_PointCoord - 0.5);
          gl_FragColor = vec4(uColor, vA * 0.85 * (1.0 - smoothstep(0.25, 0.5, r)));
        }`,
    });
    this.snow = new THREE.Points(sg, this.snowMat);
    for (const o of [this.rain, this.snow]) { o.frustumCulled = false; o.renderOrder = 6; o.visible = false; }
    this.group.add(this.rain, this.snow);
  }

  setClouds(px: CloudPixels) {
    this.W = px.width; this.H = px.height;
    const a = new Uint8Array(px.width * px.height);
    for (let i = 0; i < a.length; i++) a[i] = px.main[i * 4 + 3];
    this.alpha = a;
  }

  /** The painted cover at uv (bilinear; u wraps). Row 0 is the south pole (clouds.ts). */
  private raw(u: number, v: number) {
    const a = this.alpha!, W = this.W, H = this.H;
    const x = fract(u) * W - 0.5, y = clamp01(v) * (H - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const at = (i: number, j: number) => a[Math.min(H - 1, j) * W + (((i % W) + W) % W)];
    return ((at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy) / 255;
  }

  /** sky.ts coverAt, at unit direction d. */
  coverAt(d: THREE.Vector3, weather: number, time: number, storms: THREE.Vector4[]) {
    if (!this.alpha) return 0;
    const lat = Math.asin(Math.max(-1, Math.min(1, d.y))), phi = Math.atan2(d.z, -d.x);
    const w = windEast(lat), T = 0.5, p0 = fract(weather / T), p1 = fract(weather / T + 0.5);
    const copy = (p: number, t: number) => {
      const o = -w * p * T, co = Math.cos(o), so = Math.sin(o);
      const qx = d.x * co - d.z * so, qy = d.y, qz = d.x * so + d.z * co;
      const raw = this.raw((phi + o) / (2 * Math.PI), 0.5 + lat / Math.PI);
      const a = cnNoise(qx * 7 + 0.03 * t, qy * 7 + 0.02 * t, qz * 7 - 0.025 * t) - 0.5;
      const b = cnNoise(qx * 19 - 0.05 * t, qy * 19 - 0.035 * t, qz * 19 - 0.045 * t) - 0.5;
      return raw + a * 0.15 + b * 0.06;
    };
    const cover = copy(p0, time) + (copy(p1, time + 37) - copy(p0, time)) * Math.abs(1 - 2 * p0);
    const st = this.stormCover(d, weather, storms);
    return Math.max(cover, st) + 0.12 * st;
  }

  /** sky.ts stormCover (the spiral bands' texture left out: their body is what matters here). */
  private stormCover(d: THREE.Vector3, weather: number, storms: THREE.Vector4[]) {
    let s = 0;
    for (const S of storms) {
      if (S.w <= 0.001) continue;
      const R = Math.abs(S.z);
      const cx = Math.cos(S.y) * Math.sin(S.x), cy = Math.sin(S.y), cz = Math.cos(S.y) * Math.cos(S.x);
      const cd = d.x * cx + d.y * cy + d.z * cz;
      if (cd < Math.cos(R * 2.6)) continue;
      const r = Math.acos(Math.max(-1, Math.min(1, cd))) / R;
      const tropical = S.z < 0;
      const body = Math.exp(-r * r * (tropical ? 1.6 : 1.1));
      let v = body * 0.75;
      if (tropical) v = Math.max(v, Math.exp(-r * r * 9) * 1.1) * smooth(0.05, 0.13, r);
      else v = Math.max(v * 0.8, Math.exp(-r * r * 5) * 0.85);
      s = Math.max(s, v * S.w);
      void weather;
    }
    return s;
  }

  /**
   * Each frame. cam: camera; up: unit direction under it; above: camera height over the ground;
   * temp: the seasonal temperature on the ground there (sky.ts scale: snow lies below ~0.15);
   * low: 0..1, how far down into the weather the view is.
   */
  update(dt: number, cam: THREE.PerspectiveCamera, up: THREE.Vector3, above: number, temp: number, cover: number, low: number, heightPx: number) {
    this.t += dt;
    const st = this.state;
    st.cover = cover;
    // Overcast from broken cloud to solid; rain from thick cloud; thunder from the thickest in
    // warm air (as convective() in sky.ts). Snow is the cold share of what falls.
    const falling = smooth(0.7, 0.9, cover);
    const cold = smooth(0.3, 0.18, temp);
    st.overcast = smooth(0.52, 0.85, cover) * low;
    st.rain = falling * (1 - cold) * low;
    st.snow = falling * cold * low;
    st.thunder = smooth(0.8, 0.95, cover) * smooth(0.35, 0.6, temp) * low;
    // Lightning: now and then, more in a stronger storm; a flicker of a stroke and a restrike.
    if (dt > 0 && st.thunder > 0 && this.flashT > 0.6 && Math.random() < dt * 0.5 * st.thunder) { this.flashT = 0; this.flashPeak = 0.5 + 0.5 * Math.random(); }
    this.flashT += dt;
    const f = this.flashT;
    st.flash = this.flashPeak * (f < 0.06 ? 1 : f < 0.1 ? 0.2 : f < 0.16 ? 0.7 : f < 0.4 ? 0.7 * (1 - (f - 0.16) / 0.24) : 0);

    const show = (st.rain > 0.02 || st.snow > 0.02);
    this.rain.visible = st.rain > 0.02;
    this.snow.visible = st.snow > 0.02;
    if (!show) return;
    // The box: a few times the camera's height across (min and max so it neither vanishes nor
    // spreads thin), centred a little ahead along the view, upright on the ground below.
    const B = Math.min(0.012, Math.max(0.0025, above * 2.2));
    let east = new THREE.Vector3(up.z, 0, -up.x);
    if (east.lengthSq() < 1e-8) east.set(1, 0, 0);
    east.normalize();
    const north = new THREE.Vector3().crossVectors(up, east);
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const centre = cam.position.clone().addScaledVector(fwd, B * 0.3);
    const m = new THREE.Matrix4().makeBasis(east.multiplyScalar(B), north.multiplyScalar(B), up.clone().multiplyScalar(B));
    m.setPosition(centre);
    for (const [mat, amt, col] of [[this.rainMat, st.rain, 0xb8c4d0], [this.snowMat, st.snow, 0xf4f6fa]] as const) {
      const u = mat.uniforms;
      u.uT.value = this.t;
      u.uFrame.value.copy(m);
      u.uAmount.value = amt;
      u.uWind.value.set(mat === this.rainMat ? 0.35 : 0.05, mat === this.rainMat ? 0.1 : 0.02);
      u.uColor.value.set(col).multiplyScalar((0.55 + 0.45 * (1 - st.overcast * 0.6)) * (0.15 + 0.85 * this.daylight) + st.flash);
      u.uPx.value = heightPx;
      u.uNear.value = B * 0.12;
    }
  }
}
