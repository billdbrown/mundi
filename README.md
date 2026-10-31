# worldgen

Procedural planets on a hex grid, in the browser. Three.js, TypeScript, no engine.

```
npm install
npm run dev      # http://localhost:5173
npm test         # grid and generator checks
```

The URL hash holds every parameter, so a world you like is just a link.

## How a world is made

1. **Grid.** An icosahedron is subdivided and its dual taken (a Goldberg polyhedron). Every
   cell is a hexagon except twelve pentagons, which no sphere tiling can avoid.
   `10·n² + 2` cells for subdivision `n`. ([src/grid.ts](src/grid.ts))
2. **Plates.** Random seed cells grow into plates by random flood fill. Some are continental,
   enough to roughly cover the requested land share. Each plate spins about its own axis.
3. **Elevation.** Plate base height, smoothed into shelves. Where plates meet, their relative
   motion decides what happens: continent hitting continent raises the big ranges, ocean diving
   under continent raises coastal ranges and digs trenches, separation opens rifts and ridges.
   Simplex noise breaks up the coastlines. Sea level is set by quantile, so the ocean slider is exact.
4. **Climate.** Temperature from latitude and altitude, giving ice caps and snowy peaks.
   Moisture from distance to the sea plus Earth's wet/dry latitude bands.
5. **Water.** A priority flood from the sea gives every land cell a downhill route out; basins
   the flood has to fill become lakes. Flow accumulates downstream and the big flows are rivers.
6. **Biomes.** A Whittaker-style table on temperature and moisture, plus beaches, mountains,
   sea ice. ([src/biomes.ts](src/biomes.ts))

## Rendering

Two terrain styles. **Realistic** (default, [src/surface.ts](src/surface.ts)) blends heights across
cells and splits each triangle with a little noise, so coasts and ridges don't trace hex edges.
**Hex tiles** draws flat terraces with cliff walls. Both get:

- a water mesh that knows its depth: turquoise shallows to deep blue, ripples, sun glint, foam
  where it meets land ([src/sky.ts](src/sky.ts))
- instanced low-poly trees chosen by biome ([src/flora.ts](src/flora.ts))
- a cloud layer banded like Earth's, fading as you zoom in, and an atmosphere glow
- rivers that curve through cells and widen downstream

## Checking changes

```
npm test                 # generator: grid invariants, determinism, ocean share, drainage, ice caps
npm run visual           # renders 12 fixed views and compares them with baselines
npm run visual:update    # accept the current renders as the new baselines
npm run visual -- --only coast
```

`visual` freezes animation, renders each case in a headless Edge, and writes
`test/visual/report.html` with baseline, current and diff side by side plus generation and mesh
timings. It exits non-zero if any view changed by more than 0.1% of pixels. Renders repeat
exactly on one machine, so the comparison can be strict.

Baselines are **not committed**: they depend on the GPU that drew them, and at about 6 MB a set
they would bloat the history. Run `npm run visual:update` once on a fresh clone, before changing
anything.

## Not yet

Rain shadows behind mountains, cloud shadows, a day/night side, and more tree variety.

## License

MIT
