/**
 * Cloud cover as raw RGBA pixels (equirectangular), so it can be computed in the worker and
 * uploaded as a DataTexture. Row 0 is the south pole: DataTextures put row 0 at v = 0, and
 * SphereGeometry puts v = 0 at the south pole.
 */
import { makeSimplex, fbm } from './noise.ts';
import { makeRng } from './rng.ts';

export const CLOUD_W = 768, CLOUD_H = 384;

export interface CloudPixels { main: Uint8Array; cirrus: Uint8Array; width: number; height: number }

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function paint(fill: (lat: number, x: number, y: number, z: number) => [number, number]): Uint8Array {
  const W = CLOUD_W, H = CLOUD_H, data = new Uint8Array(W * H * 4);
  for (let py = 0; py < H; py++) {
    const lat = -Math.PI / 2 + ((py + 0.5) / H) * Math.PI;
    for (let px = 0; px < W; px++) {
      // SphereGeometry: u = φ/2π, with x = −cos φ·sin θ and z = sin φ·sin θ.
      const phi = ((px + 0.5) / W) * Math.PI * 2;
      const x = -Math.cos(phi) * Math.cos(lat), y = Math.sin(lat), z = Math.sin(phi) * Math.cos(lat);
      const [shade, alpha] = fill(lat, x, y, z);
      const i = (py * W + px) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.round(shade * 255);
      data[i + 3] = Math.round(alpha * 255);
    }
  }
  return data;
}

interface Storm { x: number; y: number; z: number; r: number; spin: number }

/**
 * A few cyclones between 12° and 55° latitude. They turn counterclockwise in the north and
 * clockwise in the south, as on Earth.
 */
function makeStorms(seed: number): Storm[] {
  const rng = makeRng(seed * 31 + 11);
  const n = 2 + Math.floor(rng() * 3);
  const out: Storm[] = [];
  for (let i = 0; i < n; i++) {
    const north = rng() < 0.5;
    const lat = (12 + rng() * 43) * (Math.PI / 180) * (north ? 1 : -1);
    const lon = rng() * Math.PI * 2;
    out.push({
      x: -Math.cos(lon) * Math.cos(lat), y: Math.sin(lat), z: Math.sin(lon) * Math.cos(lat),
      r: 0.16 + rng() * 0.12,
      spin: (north ? 1 : -1) * (2.5 + rng() * 2),
    });
  }
  return out;
}

/**
 * Main deck: domain-warped noise, banded like Earth's (cloudy at the equator and 60°, clear at
 * 30°), grey underneath where it is thick. Cirrus: thin streaks stretched east–west.
 */
export function cloudPixels(seed: number): CloudPixels {
  const n1 = makeSimplex(seed * 31 + 7), n2 = makeSimplex(seed * 31 + 8), n3 = makeSimplex(seed * 31 + 9);
  const storms = makeStorms(seed);
  const main = paint((lat, x, y, z) => {
    const band = 0.5 + 0.5 * Math.cos(6 * lat);
    // Storms twist the noise around their centre, so its streaks become spiral arms.
    let px = x, py = y, pz = z, boost = 0;
    for (const s of storms) {
      const dot = px * s.x + py * s.y + pz * s.z;
      if (dot < 0.7) continue;
      const d = Math.acos(Math.min(1, dot)) / s.r;          // 0 at the eye, 1 at the edge
      const fall = Math.exp(-d * d * 2.2);
      const a = s.spin * fall;
      // Rodrigues rotation of p about the storm axis by angle a.
      const c = Math.cos(a), sn = Math.sin(a), k = (1 - c) * dot;
      const cx = s.y * pz - s.z * py, cy = s.z * px - s.x * pz, cz = s.x * py - s.y * px;
      px = px * c + cx * sn + s.x * k; py = py * c + cy * sn + s.y * k; pz = pz * c + cz * sn + s.z * k;
      boost += 0.45 * fall * smooth(0.1, 0.28, d);         // dense ring, clear eye
      boost -= 0.5 * (1 - smooth(0.0, 0.1, d));
    }
    const qx = fbm(n2, px, py, pz, 3, 1.4), qy = fbm(n2, px + 4.7, py, pz, 3, 1.4);
    const v = fbm(n1, px + qx * 0.7, py + qy * 0.7, pz, 6, 2.2);
    const cover = v + 0.2 * band - 0.24 + boost;
    // Raw cover, not a finished cloud: 0.5 is the edge of a cloud. The shader adds drifting
    // noise before thresholding, so shapes grow, thin and merge over time (see cloudCover).
    return [1, Math.max(0, Math.min(1, 0.5 + cover * 0.53))];
  });
  const cirrus = paint((lat, x, y, z) => {
    // Stretching the sample along y turns blobs into east–west streaks.
    const v = fbm(n3, x * 1.2, y * 6, z * 1.2, 5, 1.8);
    const band = 0.6 + 0.4 * Math.cos(4 * lat);
    return [1, smooth(0.15, 0.6, v * band) * 0.55];
  });
  return { main, cirrus, width: CLOUD_W, height: CLOUD_H };
}
