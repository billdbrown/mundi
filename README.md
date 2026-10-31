# Mundi

**Live: https://mundi.bill.computer**

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

Everything heavy (generation, meshing, cloud painting) runs in a Web Worker
([src/worker.ts](src/worker.ts)), so the page never freezes; dragging a slider only ever builds
the latest settings.

Two terrain styles. **Realistic** (default, [src/surface.ts](src/surface.ts)) splits each cell
into a fine triangle grid with heights blended across cells, gentle noise in lowlands and ridged
crags on high ground. **Hex tiles** draws flat terraces with cliff walls. On top:

- water that knows its depth: turquoise shallows to deep blue, drifting ripples, sun glint, surf
  ([src/sky.ts](src/sky.ts)); lakes as calm open water
- rivers as ribbons of the water surface that widen downstream, meander, carve valleys, split
  into deltas, and gain thin streams as you zoom in
- rain shadows and ocean-current effects on climate; snow, rock and sand shaded per vertex; a
  detail shader for rocky ground
- instanced trees by biome in groves and clearings, plus rocks, cacti and icebergs
  ([src/flora.ts](src/flora.ts))
- two cloud layers with cyclones, cloud shadows on the ground, an atmosphere glow
- optional day and night: a fixed, orbiting sun with an orange terminator

## For games

[src/gamedata.ts](src/gamedata.ts) names the continents, marks resources per cell (ore, timber,
fish, fertile land) and suggests settlement sites, spread apart, near water and good land.
**Export JSON** downloads every cell (lat/lon, neighbours, biome, climate, rivers, plate,
continent, resources) with the continents and sites. **Settlement sites** shows them on the globe.

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

Seasons, region borders, and roads between sites.

## License

MIT
