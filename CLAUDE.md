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
- Live at **https://mundi.bill.computer** (public). Deploy by hand: `./deploy.sh` builds and runs
  `wrangler deploy` (static assets plus the claims Worker in `worker/`, token from
  `~/.config/cloudflare/api-token`). Run the visual check before deploying.
- **Claims** are the only server code: `worker/index.ts` (one SQLite Durable Object) and
  `src/claims.ts` (the Share panel). `TURNSTILE_SECRET` and `ADMIN_KEY` are Worker secrets
  (`wrangler secret put`); locally they come from `.dev.vars` (gitignored). To try claims
  locally: `npm run build && npx wrangler@4 dev` (serves dist/ and the Worker; `npm run dev` has no claims).
  Remove a claim: `curl -X DELETE https://mundi.bill.computer/api/claims/<seed> -H "x-mundi-key: <ADMIN_KEY>"`.

## Primundi (the game)

`primundi.html` + `src/primundi/` is **Primundi**, Mundi as a fog-of-war game, live at
**https://primundi.bill.computer**. You are a caravan exploring and trading, not a civilisation
(vault `wiki/decisions/2026-11-06-primundi-caravan.md`, which supersedes `…-primundi.md`).
Pure, tested modules: `atlas.ts` (places from the history sim's last year, a thinned road backbone,
goods and equilibrium prices, hex crossing costs, A*), `market.ts` (lazy stocks, quotes, trade),
`caravan.ts` (people, supplies, the daily tick; supplies never kill), `encounters.ts` (text-and-dice
events: add an entry to `ENCOUNTERS`). `main.ts` is the clock (pause/1/2/3, `RATES` days per second),
travel, the cards and the map marks. Currency: orrels. Saves under `primundi.save2`. Mobile portrait
is a target: cards become a bottom sheet under 640 px.
Same build; `./deploy-primundi.sh` copies `dist/` to `dist-primundi/` with `primundi.html` as the
index and deploys it with `wrangler.primundi.toml` (static only, saves live in the browser).
It reaches into the shared code only through hooks that do nothing for Mundi: `PlanetView.onFrame`,
`constrain`, `tiltScale`, `addToPlanet` (render.ts) and the hex view's `game=1&seen=` link
parameters (hex.ts; also `town=` and `from=`). In a game's hex, `hexcaravan.ts` is the caravan on
the ground: tap the ground to walk there (A* on a 2 m grid round houses, fences, water and cliffs,
preferring streets), tap a town building or its label to walk to its door, and the hex posts
`primundi-spot` with the town card's tab to open. A town's landmark is what its model is (a market,
an inn), a notice board stands on the square, and the inn, tavern and stores are houses spread
through the town (each the furthest from those already picked). With the hex view open, each opens
as its own card with no tabs, and the bar's Town button is hidden: you walk to each one.
The planet camera's leash (`bounds` in main.ts) caps height by the revealed *area* and keeps the
view within 1.5 hexes of some revealed hex; a far reveal swings the camera there instead.
Roads draw on faintly over the fog for two hexes past what you've seen.
`finds.ts` is what there is to find in a hex (lookout, spring, forage, ruin, camp: seeded per cell,
cards in the encounter shape, `save.finds` remembers what's used); the hex view places them
(`placeFinds`), hides all but lookouts until the caravan is near, and posts `primundi-find`.
`window.primundi` is its debug handle (`travelTo(cell)`, `setSpeed(n)`, `encounter(id)`, `revealRing()`).
