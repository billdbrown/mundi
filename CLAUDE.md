# Mundi

Procedural hex-grid planets in the browser. Vite + TypeScript + Three.js, no engine.
The README explains the generator and renderer; this file is how to work on it.

## Layout

- `src/grid.ts` Goldberg sphere grid. `src/world.ts` the generator (plates, climate, water,
  biomes). Both are pure and run under Node, so they are unit-tested.
- `src/surface.ts` World → mesh data (smooth and tile styles, water, tree spots), as plain
  transferable arrays. `src/colors.ts` cell colours per view mode. `src/clouds.ts` cloud pixels.
- `src/worker.ts` runs generation, meshing and clouds off the main thread; `src/main.ts` sends
  it requests (one in flight, later changes collapse into one follow-up).
- `src/sky.ts` shaders: water, terrain detail, cloud shadows, atmosphere. `src/flora.ts` trees
  and props. `src/gamedata.ts` continents, resources, sites, JSON export (tested).
- `src/render.ts` the view. `src/debug.ts` camera spots for tests (coast, river, lake,
  desert, mountain).

## Before and after every visual change

1. `npm run visual` first. If baselines are missing (fresh clone), `npm run visual:update`.
   They should all come back `same`; if not, something else changed and you need to know what.
2. Make the change.
3. `npm run visual` again and open `test/visual/report.html`. Look at every `changed` case,
   not just the one you meant to change.
4. When the change is right, `npm run visual:update` to accept it.

`npm test` covers the generator. Run it for any change to `world.ts` or `grid.ts`.

For a view the fixed cases don't cover, `scripts/shot.mjs` takes ad-hoc screenshots of a
running dev server (`SPOT=coast|river|mountain`, `ALT=`, `ZOOM=`).

## Conventions

- Keep `erasableSyntaxOnly` happy: no enums, no parameter properties. Node runs the `.ts`
  sources directly for tests.
- Generator changes must stay deterministic for a given seed (a test checks this).
- Remotes: `origin` is the NAS (`git@git.lan:mundi.git`), `github` is public. Push both.
