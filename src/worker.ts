/**
 * Background thread: generates worlds, builds their meshes and paints clouds, so the page never
 * freezes. Keeps the last world, so a view-only change (style, mode, relief) skips generation.
 */
import { generateWorld, type World, type WorldParams } from './world.ts';
import { buildSurfaceData, surfaceTransfer, type BuildOptions, type SurfaceData } from './surface.ts';
import { cloudPixels, type CloudPixels } from './clouds.ts';

export interface BuildRequest { id: number; params: WorldParams; opts: BuildOptions; clouds: boolean }
export interface BuildResult {
  id: number;
  /** Only sent when it was regenerated; otherwise the page keeps the one it has. */
  world: World | null;
  surface: SurfaceData;
  clouds: CloudPixels | null;
  timings: { gen: number; mesh: number; clouds: number };
}

let last: World | null = null;
let lastKey = '';

self.onmessage = (e: MessageEvent<BuildRequest>) => {
  const { id, params, opts } = e.data;
  const t0 = performance.now();
  const key = JSON.stringify(params);
  let fresh = false;
  if (key !== lastKey || !last) { last = generateWorld(params); lastKey = key; fresh = true; }
  const t1 = performance.now();
  const surface = buildSurfaceData(last, opts);
  const t2 = performance.now();
  const clouds = e.data.clouds ? cloudPixels(params.seed, last) : null;
  const t3 = performance.now();
  const msg: BuildResult = {
    id, world: fresh ? last : null, surface, clouds,
    timings: { gen: Math.round(t1 - t0), mesh: Math.round(t2 - t1), clouds: Math.round(t3 - t2) },
  };
  // The surface and clouds are new each time, so hand their buffers over instead of copying.
  const transfer = surfaceTransfer(surface);
  if (clouds) transfer.push(clouds.main.buffer as ArrayBuffer, clouds.cirrus.buffer as ArrayBuffer);
  (self as unknown as Worker).postMessage(msg, transfer);
};
