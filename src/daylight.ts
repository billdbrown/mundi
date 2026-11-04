/**
 * Time of day for the hex view. Each style (hexstyle.ts) was designed for one sun, its anchor: an
 * elevation and the colours of sun, sky, fog and ambient light. This moves the sun along its real
 * path for the hex's latitude and scales the style's colours by how daylight at the new elevation
 * differs from daylight at the anchor. So a style keeps its own character at every hour, and looks
 * exactly as designed at its own hour. At night a dim blue moon takes over as the key light.
 * Equinox (Mundi has no seasons), local solar time: sunrise 06:00, noon 12:00, sunset 18:00.
 */
import type { HexStyle } from './hexstyle.ts';

export type RGB = [number, number, number];
const D = Math.PI / 180;
/** sRGB hex to linear RGB. */
const lin = (hex: number): RGB => [0, 1, 2].map((k) => Math.pow(((hex >> (16 - 8 * k)) & 255) / 255, 2.2)) as RGB;
const smooth = (a: number, b: number, x: number) => { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const mul = (c: RGB, r: RGB): RGB => [c[0] * r[0], c[1] * r[1], c[2] * r[2]];
const ratio = (x: RGB, y: RGB): RGB => x.map((v, i) => Math.min(3, v / Math.max(1e-4, y[i]))) as RGB;
const luma = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
/** A ratio's colour shift without its change in brightness. */
const hue = (r: RGB): RGB => { const l = Math.max(1e-4, luma(r)); return r.map((v) => Math.min(3, v / l)) as RGB; };

/** Unit vector to the sun in the map's frame as three.js has it (x east, y up, z south), for a
 * latitude in radians and an hour of local solar time. */
export function sunDirection(lat: number, hour: number): RGB {
  const H = (hour - 12) / 24 * 2 * Math.PI;
  const east = -Math.sin(H), north = -Math.sin(lat) * Math.cos(H), up = Math.cos(lat) * Math.cos(H);
  return [east, up, -north];
}

/** Sun elevation in degrees. */
export const sunElevation = (lat: number, hour: number) => Math.asin(sunDirection(lat, hour)[1]) / D;

/** The afternoon hour at which the sun stands at this elevation (degrees); noon if it never climbs
 * that high (near the poles). */
export function hourForElevation(lat: number, elev: number): number {
  const c = Math.sin(elev * D) / Math.max(1e-6, Math.cos(lat));
  return c >= 1 ? 12 : 12 + Math.acos(Math.max(-1, c)) / (2 * Math.PI) * 24;
}

/** What's left of sunlight after the air: Rayleigh scattering (blue first) plus a little haze, over
 * the air mass of Kasten & Young (1989). Reddens and dims toward the horizon. */
export function transmittance(elev: number): RGB {
  const h = Math.max(elev, -0.5);
  const m = 1 / (Math.sin(h * D) + 0.50572 * Math.pow(h + 6.07995, -1.6364));
  return [0.0464, 0.108, 0.265].map((t) => Math.exp(-m * (t + 0.03))) as RGB;
}

/** Daylight by sun elevation: sky top and bottom, fog, ambient sky and ground, ambient strength. */
const KEYS: { el: number; top: number; bot: number; fog: number; sky: number; gnd: number; amb: number }[] = [
  { el: -18, top: 0x0a1028, bot: 0x1a2440, fog: 0x141c34, sky: 0x2a3866, gnd: 0x141420, amb: 0.16 },
  { el: -8, top: 0x0e1838, bot: 0x2c2c4c, fog: 0x2c2e4a, sky: 0x3a4a80, gnd: 0x241e24, amb: 0.24 },
  { el: -2, top: 0x24346a, bot: 0xb46c58, fog: 0x7c5c62, sky: 0x6070a0, gnd: 0x4a3830, amb: 0.42 },
  { el: 3, top: 0x3c5a98, bot: 0xf0965a, fog: 0xd8956a, sky: 0x8c98b8, gnd: 0x7a5840, amb: 0.65 },
  { el: 12, top: 0x5a80c0, bot: 0xf0c890, fog: 0xe8c8a0, sky: 0xa8bcd8, gnd: 0x7a6450, amb: 0.85 },
  { el: 30, top: 0x5c8ed0, bot: 0xd8e0e8, fog: 0xd0d8e2, sky: 0xb8cce6, gnd: 0x7a6a58, amb: 1.0 },
  { el: 60, top: 0x4a88dc, bot: 0xc8dcf0, fog: 0xc8d8ea, sky: 0xc0d4ee, gnd: 0x807060, amb: 1.08 },
  { el: 90, top: 0x4a88dc, bot: 0xc8dcf0, fog: 0xc8d8ea, sky: 0xc0d4ee, gnd: 0x807060, amb: 1.1 },
];
interface Sky { top: RGB; bot: RGB; fog: RGB; sky: RGB; gnd: RGB; amb: number }
function skyAt(el: number): Sky {
  const e = Math.max(-18, Math.min(90, el));
  let i = 0;
  while (i < KEYS.length - 2 && KEYS[i + 1].el < e) i++;
  const a = KEYS[i], b = KEYS[i + 1], t = (e - a.el) / (b.el - a.el);
  const mix = (x: number, y: number): RGB => { const p = lin(x), q = lin(y); return p.map((v, k) => v + (q[k] - v) * t) as RGB; };
  return { top: mix(a.top, b.top), bot: mix(a.bot, b.bot), fog: mix(a.fog, b.fog), sky: mix(a.sky, b.sky), gnd: mix(a.gnd, b.gnd), amb: a.amb + (b.amb - a.amb) * t };
}

export interface Daylight {
  /** The sun's elevation (degrees) and direction (map frame), whether or not it is up. */
  elev: number;
  sun: RGB;
  /** The light that casts shadows: the sun by day, the moon by night. Linear RGB colour. */
  key: { dir: RGB; color: RGB; intensity: number; moon: boolean };
  /** Sky gradient top and bottom, fog, ambient sky and ground (linear RGB), ambient strength. */
  sky: [RGB, RGB];
  fog: RGB;
  hemiSky: RGB;
  hemiGround: RGB;
  hemiI: number;
  rim: number;
  exposure: number;
  /** The style's grade tint, cooled at night. */
  tint: RGB;
  /** How lit house windows are (0 by day, 1 by night). */
  windows: number;
  /** Brightness of unlit surfaces (the tile's sides): the scene's light after the eye adapts. */
  sideLight: number;
}

/** Roughly how much light falls on open ground at this elevation, relative to the style's anchor
 * (1 there): ambient sky plus the sun (or moon) on flat ground. */
function lightAt(elev: number, anchor: number): number {
  const sk = skyAt(elev), A = skyAt(anchor);
  const sun = smooth(-1.5, 3, elev) * luma(ratio(transmittance(elev), transmittance(anchor)))
    * Math.max(0.1, Math.sin(elev * D)) / Math.max(0.1, Math.sin(anchor * D));
  const moon = 0.22 * (1 - smooth(-12, -4, elev)) * Math.sin(40 * D) / Math.max(0.1, Math.sin(anchor * D));
  return 0.35 * sk.amb / A.amb + 0.65 * (sun + moon);
}

export function daylight(st: HexStyle, lat: number, hour: number): Daylight {
  const sun = sunDirection(lat, hour), elev = Math.asin(sun[1]) / D, anchor = st.sun.elev;
  const S = skyAt(elev), A = skyAt(anchor);
  const up = smooth(-1.5, 3, elev);                 // the sun's light fades out just after sunset
  const night = 1 - smooth(-12, -2, elev);
  let key: Daylight['key'];
  if (elev > -2.5) {
    key = { dir: sun, color: mul(lin(st.sun.color), ratio(transmittance(elev), transmittance(anchor))), intensity: st.sun.intensity * up, moon: false };
  } else {
    // The moon: high, opposite the sun's bearing, faint and blue.
    let hx = -sun[0], hz = -sun[2];
    const hl = Math.hypot(hx, hz);
    if (hl < 1e-3) { hx = 0.5; hz = 0.85; } else { hx /= hl; hz /= hl; }
    const c = Math.cos(40 * D), s = Math.sin(40 * D);
    key = { dir: [hx * c, s, hz * c], color: lin(0xb8c8ec), intensity: st.sun.intensity * 0.22 * (1 - smooth(-12, -4, elev)), moon: true };
  }
  const cool: RGB = [0.88, 0.95, 1.12];
  // The eye adapts: as light falls, exposure rises (partly: dusk and night still read darker).
  const light = lightAt(elev, anchor), adapt = Math.max(0.8, Math.min(5, Math.pow(light, -0.6)));
  return {
    elev, sun, key,
    sky: [mul(lin(st.sky[0]), ratio(S.top, A.top)), mul(lin(st.sky[1]), ratio(S.bot, A.bot))],
    fog: mul(lin(st.fogColor), ratio(S.fog, A.fog)),
    hemiSky: mul(lin(st.hemi.sky), hue(ratio(S.sky, A.sky))),
    hemiGround: mul(lin(st.hemi.ground), hue(ratio(S.gnd, A.gnd))),
    hemiI: st.hemi.intensity * S.amb / A.amb,
    rim: st.rim * up,
    exposure: st.exposure * adapt,
    tint: st.grade.tint.map((v, i) => v * (1 + (cool[i] - 1) * night)) as RGB,
    windows: 1 - smooth(-6, 3, elev),
    sideLight: Math.min(1.1, Math.pow(light * adapt, 2.2)),
  };
}
