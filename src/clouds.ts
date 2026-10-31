/**
 * Cloud cover as raw RGBA pixels (equirectangular), so it can be computed in the worker and
 * uploaded as a DataTexture. Row 0 is the south pole: DataTextures put row 0 at v = 0, and
 * SphereGeometry puts v = 0 at the south pole.
 */
import { makeSimplex, fbm } from './noise.ts';

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

/**
 * Main deck: domain-warped noise, banded like Earth's (cloudy at the equator and 60°, clear at
 * 30°), grey underneath where it is thick. Cirrus: thin streaks stretched east–west.
 */
export function cloudPixels(seed: number): CloudPixels {
  const n1 = makeSimplex(seed * 31 + 7), n2 = makeSimplex(seed * 31 + 8), n3 = makeSimplex(seed * 31 + 9);
  const main = paint((lat, x, y, z) => {
    const band = 0.5 + 0.5 * Math.cos(6 * lat);
    const qx = fbm(n2, x, y, z, 3, 1.4), qy = fbm(n2, x + 4.7, y, z, 3, 1.4);
    const v = fbm(n1, x + qx * 0.7, y + qy * 0.7, z, 6, 2.2);
    const cover = v + 0.2 * band - 0.24;
    return [1 - 0.28 * smooth(0.25, 0.7, cover), smooth(0.0, 0.42, cover)];
  });
  const cirrus = paint((lat, x, y, z) => {
    // Stretching the sample along y turns blobs into east–west streaks.
    const v = fbm(n3, x * 1.2, y * 6, z * 1.2, 5, 1.8);
    const band = 0.6 + 0.4 * Math.cos(4 * lat);
    return [1, smooth(0.15, 0.6, v * band) * 0.55];
  });
  return { main, cirrus, width: CLOUD_W, height: CLOUD_H };
}
