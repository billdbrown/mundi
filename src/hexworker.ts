/** Builds hex local maps off the main thread. Keeps the last world, so changing a variant is quick. */
import { generateWorld, type World, type WorldParams } from './world.ts';
import { buildLocalMap, type LocalOptions } from './hexlocal.ts';
import { findSpot, type Spot } from './debug.ts';

let key = '', world: World | null = null;

self.onmessage = (e: MessageEvent<{ params: WorldParams; cell: number; spot?: Spot; opts: Partial<LocalOptions> }>) => {
  const { params, spot, opts } = e.data;
  const k = JSON.stringify(params);
  const t0 = performance.now();
  if (k !== key || !world) { world = generateWorld(params); key = k; }
  const t1 = performance.now();
  const cell = spot ? findSpot(world, spot) : e.data.cell;
  const m = buildLocalMap(world, cell, opts);
  const t2 = performance.now();
  const transfer = [m.heights.buffer, m.colors.buffer, m.base.buffer, m.layers.buffer, m.lakeMask.buffer, m.trees.buffer, ...m.rivers.map((r) => r.pts.buffer)];
  (self as unknown as Worker).postMessage({ map: m, ms: { world: t1 - t0, local: t2 - t1 } }, transfer as ArrayBuffer[]);
};
