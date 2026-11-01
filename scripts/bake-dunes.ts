/**
 * Bake the dune tiles (src/dunesim.ts) into public/dunes.bin: one 256x256 tile per dune type,
 * as the four channels of an RGBA half-float texture (heights in cell widths). Slow (a few
 * minutes), so it runs once, by hand, and the result is committed.
 *
 *   node scripts/bake-dunes.ts
 *
 * Channels: R barchans, G transverse ridges, B linear (seif) ridges, A network (star-like).
 * The tiles wrap, and the wind blows toward +x in all of them.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { DataUtils } from 'three';
import { simulateDunes } from '../src/dunesim.ts';

const SIZE = 256, D = Math.PI / 180;
const kinds = [
  { name: 'barchan', sand: 0.8, winds: [0], bare: 0.08, sweeps: 600 },
  { name: 'transverse', sand: 5, winds: [0], sweeps: 600 },
  { name: 'linear', sand: 2.5, winds: [60 * D, -60 * D], bare: 0.25, sweeps: 500 },
  { name: 'network', sand: 5, winds: [0, 120 * D, 240 * D], bare: 0.3, sweeps: 500 },
];
const out = new Uint16Array(SIZE * SIZE * 4);
kinds.forEach((k, ch) => {
  const t = performance.now();
  const h = simulateDunes({ size: SIZE, sand: k.sand, winds: k.winds, sweeps: k.sweeps, hop: 3, bare: k.bare, seed: 11 + ch });
  let max = 0;
  for (let i = 0; i < h.length; i++) { out[i * 4 + ch] = DataUtils.toHalfFloat(h[i]); max = Math.max(max, h[i]); }
  console.log(`${k.name}: ${((performance.now() - t) / 1000).toFixed(1)} s, max height ${max.toFixed(2)} cells`);
});
mkdirSync('public', { recursive: true });
writeFileSync('public/dunes.bin', Buffer.from(out.buffer));
console.log('wrote public/dunes.bin');
