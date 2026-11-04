/**
 * Looks for the hex view (2026-11-04: Bill chose to stop imitating the planet and give the hex its
 * own look). The planet still decides the layout, biome, rivers and climate; a style decides only
 * how they are drawn: ground palette, light, sky, water, the map's sides, camera and grade.
 * Five are offered side by side (keys 1–5) to choose from. Moodboard: vault
 * raw/2026-11-04-hex-moodboard (Dorfromantik, Civilization VI and VII, Banished), for ideas only.
 */
import { LAYERS, L_GRASS, L_MOTTLE, L_FOREST, L_ROCK, L_SNOW, L_SAND, L_BED, L_LUSH, L_ALPINE, L_DEPTH, L_AO, L_CLEARING, L_PATH, L_FIELD, L_FIELDKIND, L_HEDGE, L_ELEV, type LocalMap } from './hexlocal.ts';

type RGB = [number, number, number];
/** sRGB hex to linear RGB. */
const lin = (hex: number): RGB => [0, 1, 2].map((k) => Math.pow(((hex >> (16 - 8 * k)) & 255) / 255, 2.2)) as RGB;

export interface HexStyle {
  id: string;
  label: string;
  blurb: string;
  /** 'hex': the tile is cut to the hex itself, with sides; 'square': the hex and its surroundings. */
  frame: 'hex' | 'square';
  /** Background, top and bottom of the screen (sRGB hex). */
  sky: [number, number];
  /** Fog: density x 1/map size (0 for none), and colour (sRGB hex). */
  fog: number;
  fogColor: number;
  /** Sun: colour, intensity, elevation and azimuth (degrees; azimuth 0 = from the south, clockwise). */
  sun: { color: number; intensity: number; elev: number; azim: number };
  /** A second light from behind the view, for a rim on edges (0 for none). */
  rim: number;
  hemi: { sky: number; ground: number; intensity: number };
  exposure: number;
  /** How the ground is painted: 'planet' uses the Earth-look colours as generated; 'palette' repaints. */
  ground: 'planet' | 'palette';
  palette: {
    /** How much of the planet's climate colour to keep under the palette's grass (0..1). */
    keepBase: number;
    grass: number; grassDry: number; forest: number; clearing: number; rock: number; snow: number;
    sand: number; bed: number; lush: number; alpine: number; seaShallow: number; seaDeep: number;
    /** Saturation multiplier on the final ground colour. */
    sat: number;
    /** Strength of mottling (grass patches) and of the crease shading. */
    mottle: number; ao: number;
    /** Per-sample grain, a painted or textured feel. */
    grain: number;
    /** Mountains drawn the style's own way, by height on the map: alpine, then rock, then snow caps (0 = off). */
    peaks: number;
  };
  water: { shallow: number; deep: number; foam: number; opacity: number; foamDepth: number; roughness: number };
  /** Bands of the map's sides from the top down (sRGB hex). */
  sides: number[];
  /** Plants: colour, and for stylised looks fewer, bigger trees (keep: share drawn; scale: x life-size). */
  plants: { sat: number; bright: number; scale: number; keep: number; tufts: boolean };
  /** Towns: path, hedge and crop colours (the crops picked per field), house walls and roofs. */
  town: { path: number; hedge: number; crops: number[]; walls: number[]; roofs: number[]; scale: number };
  grade: { sat: number; contrast: number; tint: RGB; vignette: number; lift: number };
  /** The Earth look's own photographic grade (grade.ts) instead of the parametric one. */
  photoGrade: boolean;
  /** The planet's own atmosphere (atmosphere.ts): the map is drawn in place on the planet, at
   * true size, so the sky, haze and sunlight are the planet's. */
  atmosphere: boolean;
  camera: { tilt: number; fov: number; dist: number };
  tiltShift: boolean;
}

export const STYLES: HexStyle[] = [
  {
    id: 'tabletop', label: 'Tabletop', blurb: 'A painted tile on a warm table',
    frame: 'hex', sky: [0xf3d6b6, 0xe8c39c], fog: 0, fogColor: 0xeccaa6,
    sun: { color: 0xffe4c4, intensity: 2.7, elev: 42, azim: 140 }, rim: 0,
    hemi: { sky: 0xfff0dc, ground: 0x8a6a50, intensity: 1.5 }, exposure: 1.0,
    ground: 'palette',
    palette: {
      keepBase: 0.35, grass: 0x789a44, grassDry: 0xb8a05a, forest: 0x46703a, clearing: 0x98ad55, rock: 0xa39282, snow: 0xf6f2ea,
      sand: 0xebd29c, bed: 0x7a6a50, lush: 0x6fae4a, alpine: 0x9c9a6a, seaShallow: 0x8ad8c4, seaDeep: 0x3fa3a6,
      sat: 1.0, mottle: 0.55, ao: 0.55, grain: 0.05, peaks: 0.8,
    },
    water: { shallow: 0x86dccd, deep: 0x46b0b2, foam: 0xf7f2e4, opacity: 0.94, foamDepth: 0.8, roughness: 0.35 },
    sides: [0x5c7a3a, 0x6b4f36, 0x7f5f40, 0x6a4b33, 0x8c6b48, 0x5e432e],
    plants: { sat: 1.15, bright: 1.1, scale: 1.6, keep: 0.4, tufts: false },
    town: { path: 0xc9a77a, hedge: 0x4a6a34, crops: [0xe8a83a, 0xd88a2e, 0xc6c050, 0xb07a44, 0x9ab84e], walls: [0xe8dcc4, 0xd9c9a8, 0xc8a882, 0xb8a090], roofs: [0xd2563a, 0xc0462e, 0x3f8f9a, 0x8a5a3a, 0xe0703e], scale: 1.6 },
    grade: { sat: 1.08, contrast: 1.04, tint: [1.04, 1.0, 0.94], vignette: 0.22, lift: 0.01 },
    photoGrade: false, atmosphere: false, camera: { tilt: 50, fov: 30, dist: 0.85 }, tiltShift: true,
  },
  {
    id: 'storybook', label: 'Storybook', blurb: 'Bold, saturated, sculpted',
    frame: 'square', sky: [0x5b8fd0, 0xbcd8ee], fog: 0.25, fogColor: 0xbcd8ee,
    sun: { color: 0xfff4e0, intensity: 3.0, elev: 50, azim: 150 }, rim: 1.2,
    hemi: { sky: 0xcfe4ff, ground: 0x5a5a3a, intensity: 1.3 }, exposure: 1.0,
    ground: 'palette',
    palette: {
      keepBase: 0.25, grass: 0x5a9634, grassDry: 0xb0a84a, forest: 0x2f6a26, clearing: 0x7ab43c, rock: 0x8c8aa0, snow: 0xffffff,
      sand: 0xf2dc8c, bed: 0x5a5040, lush: 0x4fae30, alpine: 0x8a9a6a, seaShallow: 0x3cc0d8, seaDeep: 0x1a4f9c,
      sat: 1.12, mottle: 0.4, ao: 0.6, grain: 0.03, peaks: 1,
    },
    water: { shallow: 0x2fb4d4, deep: 0x163f8a, foam: 0xffffff, opacity: 0.93, foamDepth: 1.0, roughness: 0.15 },
    sides: [0x4a7a2a, 0x6a5a48, 0x7a6a56, 0x5a4a3a],
    plants: { sat: 1.35, bright: 1.1, scale: 1.7, keep: 0.4, tufts: false },
    town: { path: 0xd8b878, hedge: 0x2f6a26, crops: [0xf0c040, 0x9acd40, 0xd8a050, 0xc8d860], walls: [0xf4ecdc, 0xe8d8b8, 0xdcc8a0], roofs: [0x3a6ad0, 0xd84a3a, 0xe8b040, 0x8a4a2a], scale: 1.3 },
    grade: { sat: 1.18, contrast: 1.1, tint: [1.0, 1.0, 1.02], vignette: 0.15, lift: 0.0 },
    photoGrade: false, atmosphere: false, camera: { tilt: 55, fov: 40, dist: 1.0 }, tiltShift: false,
  },
  {
    id: 'golden', label: 'Golden hour', blurb: 'Natural materials, low warm sun',
    frame: 'square', sky: [0x6f8fb8, 0xf2c79a], fog: 0.15, fogColor: 0xe8c4a0,
    sun: { color: 0xffc48a, intensity: 3.0, elev: 30, azim: 235 }, rim: 0,
    hemi: { sky: 0xb0c4e0, ground: 0x7a6048, intensity: 1.5 }, exposure: 1.15,
    ground: 'palette',
    palette: {
      keepBase: 0.75, grass: 0x7a8a42, grassDry: 0xb09a58, forest: 0x34502a, clearing: 0x8a8f4a, rock: 0x8a7c6c, snow: 0xf0ece4,
      sand: 0xd8c08c, bed: 0x5a4a38, lush: 0x5e8a36, alpine: 0x8a8462, seaShallow: 0x5aa0a0, seaDeep: 0x24506a,
      sat: 1.0, mottle: 0.7, ao: 0.6, grain: 0.12, peaks: 0.5,
    },
    water: { shallow: 0x5aa6a8, deep: 0x23506c, foam: 0xf4eadc, opacity: 0.9, foamDepth: 0.6, roughness: 0.08 },
    sides: [0x4a5a2e, 0x5a4634, 0x6a5440, 0x4e3c2c],
    plants: { sat: 1.0, bright: 1.0, scale: 1.2, keep: 0.75, tufts: true },
    town: { path: 0x9a8060, hedge: 0x3a4a28, crops: [0xc8a050, 0x8a8a40, 0x7a5e44, 0xb09850], walls: [0xc8b8a0, 0xa89880, 0x8a7a68], roofs: [0x9a5a3a, 0x7a4a32, 0x8a7a5a, 0x6a5040], scale: 1.0 },
    grade: { sat: 1.05, contrast: 1.12, tint: [1.05, 1.0, 0.92], vignette: 0.3, lift: 0.0 },
    photoGrade: false, atmosphere: false, camera: { tilt: 62, fov: 35, dist: 0.95 }, tiltShift: true,
  },
  {
    id: 'earth', label: 'Earth', blurb: "The planet's own colours, haze and grade",
    frame: 'square', sky: [0x2f5490, 0x9fb4c8], fog: 0.55, fogColor: 0x9fb4c8,
    sun: { color: 0xfff1dc, intensity: 2.6, elev: 50, azim: 150 }, rim: 0,
    hemi: { sky: 0xd6e6f2, ground: 0x5b5242, intensity: 1.3 }, exposure: 1.0,
    ground: 'planet',
    palette: {
      keepBase: 1, grass: 0, grassDry: 0, forest: 0, clearing: 0, rock: 0, snow: 0, sand: 0, bed: 0, lush: 0, alpine: 0,
      seaShallow: 0, seaDeep: 0, sat: 1, mottle: 0, ao: 0.35, grain: 0, peaks: 0,
    },
    water: { shallow: 0x3a7a86, deep: 0x1c3e52, foam: 0xdfe8ec, opacity: 0.92, foamDepth: 0.5, roughness: 0.1 },
    sides: [0x4a3c2e],
    plants: { sat: 1, bright: 1, scale: 1, keep: 1, tufts: true },
    town: { path: 0x8a7458, hedge: 0x34502a, crops: [0xc9a654, 0x8a9a46, 0x7a6248, 0xa8b060], walls: [0xc8bca8, 0xb0a490], roofs: [0x8a4a34, 0x6a5444, 0x7a6a5a], scale: 1.0 },
    grade: { sat: 1, contrast: 1, tint: [1, 1, 1], vignette: 0, lift: 0 },
    photoGrade: true, atmosphere: true, camera: { tilt: 65, fov: 50, dist: 1.0 }, tiltShift: false,
  },
  {
    id: 'homestead', label: 'Homestead', blurb: 'Muted, lived-in, seen from above',
    frame: 'square', sky: [0x8ea6b8, 0xc8d0c8], fog: 0.2, fogColor: 0xc4ccc4,
    sun: { color: 0xfff6e6, intensity: 2.4, elev: 58, azim: 160 }, rim: 0,
    hemi: { sky: 0xdfe6e8, ground: 0x6a6048, intensity: 1.4 }, exposure: 1.0,
    ground: 'palette',
    palette: {
      keepBase: 0.6, grass: 0x6f8a3e, grassDry: 0x9a9258, forest: 0x3e5a2e, clearing: 0x7a8a46, rock: 0x7f776c, snow: 0xeceae4,
      sand: 0xc8b48a, bed: 0x5a4c3a, lush: 0x5f8a3a, alpine: 0x7f7c60, seaShallow: 0x5a8a86, seaDeep: 0x2e4a52,
      sat: 0.88, mottle: 0.8, ao: 0.45, grain: 0.1, peaks: 0.4,
    },
    water: { shallow: 0x5a7f7c, deep: 0x2c4248, foam: 0xd8dccc, opacity: 0.92, foamDepth: 0.4, roughness: 0.2 },
    sides: [0x4a5a30, 0x5a4a38, 0x4a3c2e],
    plants: { sat: 0.9, bright: 0.95, scale: 1.3, keep: 0.6, tufts: true },
    town: { path: 0x8a7a60, hedge: 0x3e5030, crops: [0xa89860, 0x7a8a48, 0x6a5a44, 0x9a9a5a], walls: [0x8a7a64, 0x9a8a70, 0x7a6a56], roofs: [0x7a6a50, 0x6a5a44, 0x8a7458], scale: 1.0 },
    grade: { sat: 0.9, contrast: 1.0, tint: [1.0, 1.01, 0.96], vignette: 0.12, lift: 0.01 },
    photoGrade: false, atmosphere: false, camera: { tilt: 35, fov: 40, dist: 1.0 }, tiltShift: false,
  },
];

const smooth01 = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash = (n: number) => {
  let h = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** The ground colour per sample (linear RGB) for a style. */
export function paintGround(m: LocalMap, st: HexStyle): Float32Array {
  const N = m.res * m.res, out = new Float32Array(N * 3);
  if (st.ground === 'planet') {
    out.set(m.colors);
    for (let v = 0; v < N; v++) {
      const ao = 1 - st.palette.ao * m.layers[v * LAYERS + L_AO];
      out[v * 3] *= ao; out[v * 3 + 1] *= ao; out[v * 3 + 2] *= ao;
    }
    return out;
  }
  const p = st.palette;
  const C = {
    grass: lin(p.grass), dry: lin(p.grassDry), forest: lin(p.forest), clearing: lin(p.clearing), rock: lin(p.rock),
    snow: lin(p.snow), sand: lin(p.sand), bed: lin(p.bed), lush: lin(p.lush), alpine: lin(p.alpine),
    sh: lin(p.seaShallow), sd: lin(p.seaDeep),
  };
  const TC = { path: lin(st.town.path), hedge: lin(st.town.hedge), crops: st.town.crops.map(lin) };
  const c: RGB = [0, 0, 0];
  const mix = (to: RGB, t: number) => { if (t > 0) for (let k = 0; k < 3; k++) c[k] += (to[k] - c[k]) * Math.min(1, t); };
  for (let v = 0; v < N; v++) {
    const L = v * LAYERS, ly = (k: number) => m.layers[L + k];
    const depth = ly(L_DEPTH);
    if (depth > 0) {
      const t = Math.min(1, depth / 12);
      for (let k = 0; k < 3; k++) c[k] = C.sh[k] + (C.sd[k] - C.sh[k]) * t;
    } else {
      // The planet's climate colour, pulled toward the style's grass (dry where the climate is pale).
      const b0 = m.base[v * 3], b1 = m.base[v * 3 + 1], b2 = m.base[v * 3 + 2];
      const pale = Math.min(1, Math.max(0, (b0 - b1) * 6 + 0.3));      // reddish-tan base: dry country
      for (let k = 0; k < 3; k++) {
        const g = C.grass[k] + (C.dry[k] - C.grass[k]) * pale;
        c[k] = g + ([b0, b1, b2][k] - g) * p.keepBase;
      }
      const mt = ly(L_MOTTLE);
      if (p.mottle > 0 && ly(L_GRASS) > 0) {
        const f = 1 + (mt - 0.5) * 0.5 * p.mottle * ly(L_GRASS);
        for (let k = 0; k < 3; k++) c[k] *= f;
        mix(C.dry, Math.max(0, mt - 0.65) * 1.5 * p.mottle * ly(L_GRASS));
      }
      mix(C.forest, ly(L_FOREST) * 0.85);
      mix(C.clearing, ly(L_CLEARING) * 0.35);
      mix(C.lush, ly(L_LUSH) * 0.9);
      mix(C.bed, ly(L_BED));
      mix(C.rock, ly(L_ROCK) * 0.9);
      mix(C.alpine, ly(L_ALPINE) * 0.6);
      mix(C.sand, ly(L_SAND));
      mix(C.snow, ly(L_SNOW) * 0.95);
      if (p.peaks > 0 && ly(L_ELEV) > 0.3) {
        const e = ly(L_ELEV) + (hash(v * 7 + 1) - 0.5) * 0.04;
        mix(C.alpine, smooth01(0.45, 0.65, e) * 0.8 * p.peaks);
        mix(C.rock, smooth01(0.68, 0.82, e) * 0.85 * p.peaks);
        mix(C.snow, smooth01(0.86, 0.93, e) * p.peaks);
      }
      if (ly(L_FIELD) > 0) {
        const crops = TC.crops;
        mix(crops[Math.min(crops.length - 1, Math.floor(ly(L_FIELDKIND) * crops.length))], 0.9);
        // Furrows: stripes across the field, a painted texture.
        const i = v % m.res, j = Math.floor(v / m.res), k0 = ly(L_FIELDKIND) * 6.28;
        const st2 = 0.5 + 0.5 * Math.sin((i * Math.cos(k0) + j * Math.sin(k0)) * 1.9);
        for (let k = 0; k < 3; k++) c[k] *= 0.92 + 0.1 * st2;
        mix(TC.hedge, ly(L_HEDGE) * 0.85);
      }
      mix(TC.path, ly(L_PATH) * 0.9);
    }
    // Saturation, crease shading, grain.
    const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    const ao = 1 - p.ao * ly(L_AO);
    const gr = 1 + (hash(v) - 0.5) * 2 * p.grain;
    for (let k = 0; k < 3; k++) out[v * 3 + k] = Math.max(0, (l + (c[k] - l) * p.sat) * ao * gr);
  }
  return out;
}

/** A parametric grade in linear light: saturation, contrast, tint, lift, vignette. */
export const STYLE_GRADE = {
  uniforms: {
    tDiffuse: { value: null }, uSat: { value: 1 }, uContrast: { value: 1 }, uTint: { value: [1, 1, 1] },
    uVig: { value: 0 }, uLift: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSat, uContrast, uVig, uLift;
    uniform vec3 uTint;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
      vec3 g = mix(vec3(l), c.rgb, uSat) * uTint;
      // Contrast about mid-grey, in a log-ish space so darks aren't crushed.
      g = pow(max(g, 0.0), vec3(1.0 / 2.2));
      g = (g - 0.5) * uContrast + 0.5 + uLift;
      g = pow(max(g, 0.0), vec3(2.2));
      float d = length((vUv - 0.5) * vec2(1.25, 1.0));
      g *= 1.0 - uVig * smoothstep(0.35, 0.85, d);
      gl_FragColor = vec4(g, c.a);
    }`,
};

/**
 * Tilt-shift: blur that grows away from a horizontal band of focus, so the scene reads as a
 * miniature. Run twice, across then down (uDir).
 */
export const TILT_SHIFT = {
  uniforms: {
    tDiffuse: { value: null }, uDir: { value: [1, 0] }, uRes: { value: [1, 1] }, uFocus: { value: 0.5 },
    uBand: { value: 0.2 }, uAmount: { value: 4.5 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uDir, uRes;
    uniform float uFocus, uBand, uAmount;
    varying vec2 vUv;
    void main() {
      float off = max(0.0, abs(vUv.y - uFocus) - uBand);
      float r = uAmount * smoothstep(0.0, 0.35, off);
      if (r < 0.05) { gl_FragColor = texture2D(tDiffuse, vUv); return; }
      vec2 st = uDir / uRes * r / 4.0;
      vec4 sum = vec4(0.0);
      float wsum = 0.0;
      for (int i = -4; i <= 4; i++) {
        float w = exp(-float(i * i) / 8.0);
        sum += texture2D(tDiffuse, vUv + st * float(i)) * w;
        wsum += w;
      }
      gl_FragColor = sum / wsum;
    }`,
};
