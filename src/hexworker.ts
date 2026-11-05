/**
 * Builds hex local maps off the main thread. The hex view runs two of these: one for the hex, one
 * for the backdrop of neighbouring hexes, so both build at once. Each keeps the last world, so a
 * new hex on the same world only costs the hex. A prefetch (the planet asks while the pointer
 * rests on a hex) builds and keeps the result, so opening that hex is then immediate.
 */
import { generateWorld, type World, type WorldParams } from './world.ts';
import { buildLocalMap, type LocalMap, type LocalOptions } from './hexlocal.ts';
import { findSpot, type Spot } from './debug.ts';
import { simulateHistory, type History } from './civ.ts';
import { gameData } from './gamedata.ts';
import { halfToFloat } from './relief.ts';
import type { ValleyField } from './relief.ts';

/** The planet's carved valleys for a world (relief.ts), sent once they are worked out. */
export interface ValleyJob { kind: 'valleys'; params: WorldParams; n: number; half: Uint16Array }

export interface HexJob {
  /** 'hex': the hex itself (with towns from the history); 'context': the wide, coarse backdrop. */
  kind: 'hex' | 'context';
  params: WorldParams;
  cell: number;
  spot?: Spot;
  opts: Partial<LocalOptions>;
  /** Build the world (and for 'hex' the history) only. */
  warm?: boolean;
  /** Build and keep; send nothing. */
  prefetch?: boolean;
}

let key = '', world: World | null = null, history: History | null = null;
let valleys: ValleyField | null = null, valleyKey = '';
/** Prefetched results, by job (one-shot: their buffers are handed over when sent). */
const kept = new Map<string, { m: LocalMap; ms: number }>();

const post = (msg: unknown, transfer: ArrayBuffer[]) => (self as unknown as Worker).postMessage(msg, transfer);
const buffers = (m: LocalMap) => [m.heights.buffer, m.colors.buffer, m.base.buffer, m.layers.buffer, m.houses.buffer, m.lakeMask.buffer, m.trees.buffer, ...m.rivers.map((r) => r.pts.buffer)] as ArrayBuffer[];

self.onmessage = (e: MessageEvent<HexJob | ValleyJob>) => {
  if (e.data.kind === 'valleys') {
    valleyKey = JSON.stringify(e.data.params);
    valleys = { n: e.data.n, carve: halfToFloat(e.data.half) };
    kept.clear();   // prefetched hexes were built without them
    return;
  }
  const job = e.data, { params, spot, opts } = job;
  const k = JSON.stringify(params);
  const t0 = performance.now();
  if (k !== key || !world) { world = generateWorld(params); history = null; kept.clear(); key = k; }
  if (job.kind === 'hex' && !history) history = simulateHistory(world, gameData(world));
  if (job.warm) { post({ warmed: true }, []); return; }
  const t1 = performance.now();
  const cell = spot ? findSpot(world, spot) : job.cell;
  const vf = valleyKey === k ? valleys : null;
  const jk = `${job.kind}|${cell}|${JSON.stringify(opts)}|${!!vf}`;
  let got = kept.get(jk);
  const prebuilt = !!got;
  if (!got) {
    const m = job.kind === 'hex'
      ? buildLocalMap(world, cell, opts, history ?? undefined, vf)
      // The ground around the hex, five times as wide (enough for a phone held upright, where the
      // camera stands back), coarse, without plants or towns (it is drawn blurred).
      : buildLocalMap(world, cell, { ...opts, extent: 5, res: 385, plants: false }, undefined, vf);
    got = { m, ms: performance.now() - t1 };
    if (job.prefetch) { kept.set(jk, got); if (kept.size > 6) kept.delete(kept.keys().next().value!); return; }
  } else {
    if (job.prefetch) return;
    kept.delete(jk);
  }
  if (job.kind === 'hex') post({ map: got.m, ms: { world: t1 - t0, local: got.ms }, prebuilt, valleys: !!vf }, buffers(got.m));
  else post({ context: got.m, cell, valleys: !!vf }, buffers(got.m));
};
