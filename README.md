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

Rendering ([src/render.ts](src/render.ts)) draws each cell as a flat terrace with cliff walls down
to lower neighbours, blends colours at corners so tile borders soften, and fades the grid lines as
you zoom in.

## Not yet

Trees and props, a proper water shader, smooth river splines, rain shadows, and pentagon-aware
anything (they work, they just aren't special-cased).

## License

MIT
