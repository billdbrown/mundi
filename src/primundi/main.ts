/**
 * Primundi: Mundi as a game (primundi.html, primundi.bill.computer). You are a caravan setting out
 * from your hometown into a world hidden under storm: travel the planet, trade between markets,
 * take work, and find out what's out there (decision 2026-11-06, "you are a caravan").
 *
 * Time runs like RimWorld's (pause, three speeds) and stops by itself when something needs you.
 * The pieces: atlas.ts (places, roads, crossing costs), market.ts (prices), caravan.ts (people
 * and supplies), encounters.ts (the road). This file is the clock, the map and the cards.
 */
import * as THREE from 'three';
import { PlanetView, DEFAULT_VIEW, type ViewOptions } from '../render.ts';
import { DEFAULT_PARAMS, type World, type WorldParams } from '../world.ts';
import { BIOMES } from '../biomes.ts';
import type { BuildRequest, BuildResult, BuildStage } from '../worker.ts';
import type { HistoryRequest, HistoryResult } from '../historyWorker.ts';
import type { History } from '../civ.ts';
import { gameData, nameMaker, type GameData } from '../gamedata.ts';
import { NAME_DECIDES, paramsOf } from '../namedworld.ts';
import { nameSeed, parseSeed, randomName } from '../seedname.ts';
import { SEA, surfaceQueries, type SurfaceQueries } from '../surface.ts';
import { mountLoader, type Loader } from '../loader.ts';
import { makeRng } from '../rng.ts';
import { PlanetFog } from './fog.ts';
import { flicker } from './hexfog.ts';
import { Thunder } from './thunder.ts';
import { pickHome, BIASES, type StartBias } from './start.ts';
import { buildAtlas, findPath, GOODS, hasWater, ringCells, seasonalTemp, SNOW_TEMP, stepDays, walkable, type Atlas, type Place } from './atlas.ts';
import { bestKnownSell, quotes, rationPrice, remember, trade, type Known, type Stocks } from './market.ts';
import { AMBITION_GOAL, ORIGINS, ROLE_NAMES, TRAITS, appetite, cargoUsed, leader, living, newCaravan, pace, passDay, sight, waterCap, thirst, type Caravan, type Origin, type Role } from './caravan.ts';
import { ENCOUNTERS, applyEffect, contextAt, drawEncounter, type Choice, type Encounter, type Outcome } from './encounters.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RADIUS_KM = 640;
/** Days of game time per second of real time, at each speed. Bill will tune these by playing. */
const RATES = [0, 0.25, 0.75, 2];
/** The calendar day of the year the game starts on (northern spring). */
const START_DOY = 100;
/** Chance of an encounter on entering a hex off the road (on it, a bit less). */
const ENCOUNTER_P = 0.07;

// --- The save ---------------------------------------------------------------------------------
interface Job { item: string; giver: string; from: number; to: number; reward: number; taken: number }
interface Save {
  v: 2;
  world: string;
  bias: StartBias;
  home: number;
  caravan: Caravan;
  /** Days since setting out (fractional). */
  day: number;
  cell: number;
  route: number[];
  progress: number;
  revealed: number[];
  /** Hexes revealed by the caravan's own travels (the Cartographers' ambition). */
  charted: number;
  known: Record<number, Known>;
  stocks: Stocks;
  job: Job | null;
  jobsDone: number;
  log: { day: number; text: string }[];
  speed: number;
  draws: number;
  over: boolean;
}
const SAVE_KEY = 'primundi.save2';
function loadSave(): Save | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Save | null;
    return s && s.v === 2 && typeof s.world === 'string' && !s.over ? s : null;
  } catch { return null; }
}
let save: Save | null = null;
let lastStore = 0;
function store() { if (save) { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); lastStore = performance.now(); } }

const paramsFor = (name: string): WorldParams => {
  const p = parseSeed(name);
  const seed = p ? p.seed : nameSeed(name);
  return p?.name && NAME_DECIDES ? { ...paramsOf(p.name), seed } : { ...DEFAULT_PARAMS, seed };
};
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();

// --- The calendar -----------------------------------------------------------------------------
const doyOf = (day: number) => (START_DOY + day) % 365;
const SEASONS = ['Spring', 'Summer', 'Autumn', 'Winter'];
function dateText(day: number, north: boolean): string {
  const t = START_DOY + day, doy = t % 365, year = Math.floor(t / 365) + 1;
  // Seasons from the equinox (day 80), flipped south of the equator.
  const k = ((doy - 80 + (north ? 0 : 182.5)) % 365 + 365) % 365;
  const s = Math.floor(k / 91.25);
  return `${SEASONS[Math.min(3, s)]} ${Math.floor(k - s * 91.25) + 1}, year ${year}`;
}

// --- The launch screen ------------------------------------------------------------------------
const thunder = new Thunder();
function showLaunch() {
  const prev = loadSave();
  const el = $('launch');
  el.hidden = false;
  const nameDefault = nameMaker(Date.now() % 100000)() + "'s Caravan";
  el.innerHTML = `
    <form class="card" autocomplete="off">
      <h1>Primundi</h1>
      <p class="tag">A world under storm. Take to the road, trade, and learn its shape.</p>
      ${prev ? `<button type="button" class="go" id="continue">Continue ${esc(prev.caravan.name)} <span>on ${esc(prev.world)}, ${dateText(prev.day, true)}</span></button>
      <div class="or">or set out anew</div>` : ''}
      <fieldset><legend>Your caravan</legend>
        <input id="civ" type="text" maxlength="28" spellcheck="false" value="${esc(nameDefault)}" />
      </fieldset>
      <fieldset><legend>Who you are</legend>
        ${ORIGINS.map((o, i) => `<label class="bias"><input type="radio" name="origin" value="${o.id}" ${i === 0 ? 'checked' : ''} /> ${o.label} <span>${o.note}</span></label>`).join('')}
      </fieldset>
      <fieldset><legend>Home</legend>
        ${BIASES.map((b) => `<label class="bias"><input type="radio" name="bias" value="${b.id}" ${b.id === (prev?.bias ?? 'any') ? 'checked' : ''} /> ${b.label} <span>${b.note}</span></label>`).join('')}
      </fieldset>
      <fieldset><legend>World</legend>
        <span class="seed"><input id="seed" type="text" maxlength="40" spellcheck="false" placeholder="random" title="A name (letters) or a number: the same seed always makes the same world and home" />
        <button type="button" id="dice" title="Roll a world">⚄</button></span>
      </fieldset>
      <button type="submit" class="go" id="begin">Set out</button>
    </form>`;
  $('dice').onclick = () => { $<HTMLInputElement>('seed').value = randomName(); };
  el.querySelector('form')!.onsubmit = (e) => {
    e.preventDefault();
    thunder.unlock();
    const typed = $<HTMLInputElement>('seed').value.trim();
    const bias = (el.querySelector<HTMLInputElement>('input[name=bias]:checked')?.value ?? 'any') as StartBias;
    const origin = (el.querySelector<HTMLInputElement>('input[name=origin]:checked')?.value ?? 'traders') as Origin;
    const world = typed || randomName();
    pendingNew = { name: $<HTMLInputElement>('civ').value.trim() || nameDefault, origin, bias, world };
    save = null;
    begin(world);
  };
  if (prev) $('continue').onclick = () => { thunder.unlock(); save = prev; begin(prev.world); };
}
let pendingNew: { name: string; origin: Origin; bias: StartBias; world: string } | null = null;

// --- The world --------------------------------------------------------------------------------
const view = new PlanetView($('view'));
const viewOpts: ViewOptions = { ...DEFAULT_VIEW };
view.setOptions(viewOpts);
view.setRunning(false);
view.setClock(0);
// More map than horizon: the horizon is all storm anyway.
view.tiltScale = 0.45;
let params: WorldParams = { ...DEFAULT_PARAMS };
let world: World | null = null;
let game: GameData | null = null;
let fog: PlanetFog | null = null;
let history: History | null = null;
let atlas: Atlas | null = null;
let surf: SurfaceQueries | null = null;
let built: BuildResult | null = null;
const revealed = new Set<number>();
let loader: Loader | null = null;

const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e: MessageEvent<BuildResult | BuildStage>) => {
  if ('stage' in e.data) { loader?.step(e.data.stage); return; }
  const r = e.data;
  if (!r.world) return;
  if (r.clouds) view.setClouds(r.clouds);
  world = r.world;
  built = r;
  maybeStart();
};
let historyWorker: Worker | null = null;

function begin(worldName: string) {
  $('launch').hidden = true;
  params = paramsFor(worldName);
  loader = mountLoader(worldName, pendingNew ? pendingNew.name : save!.caravan.name);
  const word = document.querySelector('.loader .ld-word');
  if (word) word.textContent = 'PRIMUNDI';
  view.setRunning(true);
  const { mode, style, relief, blend, trees } = viewOpts;
  worker.postMessage({ id: 1, params: { ...params }, opts: { mode, style, relief, blend, trees }, clouds: true } satisfies BuildRequest);
  historyWorker ??= new Worker(new URL('../historyWorker.ts', import.meta.url), { type: 'module' });
  historyWorker.onmessage = (e: MessageEvent<HistoryResult>) => { history = e.data.history; maybeStart(); };
  historyWorker.postMessage({ id: 1, params: { ...params } } satisfies HistoryRequest);
}

/** Both the world and its history are in: set the game up. */
function maybeStart() {
  if (!world || !history || !built || atlas) return;
  const w = world, r = built;
  game = gameData(w);
  atlas = buildAtlas(w, game, history);
  surf = surfaceQueries(r.surface, w.grid);
  if (!save) save = newGame(w, atlas, pendingNew!);
  const s = save;
  // The fog goes in before the world is drawn, so its shader compiles with the planet's.
  fog = new PlanetFog(w, surf);
  view.addToPlanet(fog.mesh);
  for (const c of s.revealed) revealed.add(c);
  fog.reveal(revealed, true);
  view.setData(w, r.surface);
  marks.build();
  bounds.update(true);
  const P = w.grid.centers, c = s.cell;
  view.camera.position.set(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]).multiplyScalar(1 + (bounds.maxD - 1) * 0.85);
  view.camera.lookAt(0, 0, 0);
  speed = 0;
  lastSpeed = s.speed > 0 ? s.speed : 1;
  syncBar();
  hud();
  const l = loader!;
  loader = null;
  void l.finish();
  labels.rebuild();
  // Home, or wherever you were: down into the hex, with the town's card over it if there is one.
  openHex(s.cell);
  const here = atlas.placeAt[s.cell];
  if (here >= 0) openTown(here);
  if (s.log.length === 1) toast(s.log[0].text, 8000);
}

function newGame(w: World, a: Atlas, n: { name: string; origin: Origin; bias: StartBias; world: string }): Save {
  const home = a.places[pickHome(w, a.places, n.bias, params.seed)];
  const caravan = newCaravan(n.name, n.origin, params.seed);
  const s: Save = {
    v: 2, world: n.world, bias: n.bias, home: home.id, caravan, day: 0, cell: home.cell, route: [], progress: 0,
    revealed: [], charted: 0, known: {}, stocks: {}, job: null, jobsDone: 0, log: [], speed: 0, draws: 0, over: false,
  };
  const seen = new Set(ringCells(w, home.cell, 2));
  // You know home's market and its nearest neighbours', and where they are.
  const near = a.places.filter((p) => p.id !== home.id).map((p) => ({ p, d: angle(w, p.cell, home.cell) })).sort((x, y) => x.d - y.d).slice(0, 2);
  for (const p of [home, ...near.map((x) => x.p)]) {
    remember(s.known, p, quotes(w, p, s.stocks, 0, doyOf(0)), 0);
    for (const c of ringCells(w, p.cell, 1)) seen.add(c);
  }
  s.revealed = [...seen];
  s.log.push({ day: 0, text: `${caravan.name} sets out from ${home.name}. You know the prices here and in ${near.map((x) => x.p.name).join(' and ')}.` });
  return s;
}
function angle(w: World, a: number, b: number) {
  const P = w.grid.centers;
  return Math.acos(Math.min(1, P[a * 3] * P[b * 3] + P[a * 3 + 1] * P[b * 3 + 1] + P[a * 3 + 2] * P[b * 3 + 2]));
}
const cellAngle = () => Math.sqrt((4 * Math.PI) / world!.grid.count);
function bearing(w: World, from: number, to: number): string {
  const P = w.grid.centers;
  const a = new THREE.Vector3(P[from * 3], P[from * 3 + 1], P[from * 3 + 2]);
  const b = new THREE.Vector3(P[to * 3], P[to * 3 + 1], P[to * 3 + 2]);
  const north = new THREE.Vector3(0, 1, 0).sub(a.clone().multiplyScalar(a.y)).normalize();
  const east = new THREE.Vector3().crossVectors(north, a).normalize().negate();
  const d = b.clone().sub(a);
  const ang = Math.atan2(d.dot(east), d.dot(north));
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][((Math.round(ang / (Math.PI / 4)) % 8) + 8) % 8];
}
function log(text: string) {
  if (!save) return;
  save.log.push({ day: save.day, text });
  if (save.log.length > 200) save.log.splice(0, save.log.length - 200);
}

// --- Revealing --------------------------------------------------------------------------------
function reveal(cells: number[], byTravel = false) {
  const fresh = cells.filter((c) => !revealed.has(c) && world && c >= 0 && c < world.grid.count);
  if (!fresh.length || !fog || !save) return 0;
  for (const c of fresh) revealed.add(c);
  fog.reveal(fresh, false, byTravel ? 1.4 : 3.2);
  save.revealed = [...revealed];
  if (byTravel) { save.charted += fresh.length; save.caravan.unsoldCharts += fresh.length; }
  bounds.update(false);
  labels.rebuild();
  marks.roads();
  if (hexOpen) hexSend({ type: 'primundi-seen', cells: fresh });
  return fresh.length;
}
/** Fogged cells touching what is revealed. */
function frontier(): number[] {
  if (!world) return [];
  const out = new Set<number>();
  for (const c of revealed) for (const n of world.grid.neighbors[c]) if (!revealed.has(n)) out.add(n);
  return [...out];
}
/** What the caravan sees from a cell: further from high ground, further with a scout. */
function lookAround(c: number) {
  if (!world || !save) return;
  const high = world.elevation[c] > 0.32;
  reveal(ringCells(world, c, sight(save.caravan) + (high ? 1 : 0)), true);
}
/** A rumour: the nearest place you don't know of yet, roughly located. */
function rumour(): string {
  if (!world || !atlas || !save) return '';
  const w = world, at = save.cell;
  let best: Place | null = null, bd = Infinity;
  for (const p of atlas.places) {
    if (revealed.has(p.cell)) continue;
    const d = angle(w, at, p.cell);
    if (d < bd) { bd = d; best = p; }
  }
  if (!best || bd > cellAngle() * 30) return 'Nothing you can use.';
  reveal(ringCells(w, best.cell, 1));
  const days = Math.max(1, Math.round((bd / cellAngle()) * 0.6));
  const line = `Word of ${best.name}, ${best.town ? 'a town' : 'a village'} about ${days} days ${bearing(w, at, best.cell)}. It's on your map now.`;
  log(line);
  return line;
}

// --- The camera's leash -----------------------------------------------------------------------
/** The planet camera stays over what's revealed: no further out than it takes to see all of it,
 * and no further sideways than its edge. Both ease when the area grows. */
const bounds = {
  centre: new THREE.Vector3(0, 0, 1),
  angle: 0.1,
  maxD: 1.3,
  goalAngle: 0.1,
  goalD: 1.3,
  update(snap: boolean) {
    if (!world || !revealed.size) return;
    const P = world.grid.centers, sum = new THREE.Vector3();
    for (const c of revealed) sum.x += P[c * 3], sum.y += P[c * 3 + 1], sum.z += P[c * 3 + 2];
    this.centre.copy(sum.normalize());
    let a = 0;
    for (const c of revealed) a = Math.max(a, Math.acos(Math.min(1, P[c * 3] * sum.x + P[c * 3 + 1] * sum.y + P[c * 3 + 2] * sum.z)));
    const cellA = cellAngle();
    this.goalAngle = a + cellA * 0.5;
    // Field of view 40°: a height h sees about 0.36 h either side of the middle; the tilt shows more.
    this.goalD = 1 + Math.min(2.2, Math.max(0.07, (a + cellA * 1.2) * 2.6));
    if (snap) { this.angle = this.goalAngle; this.maxD = this.goalD; }
  },
  step(dt: number) {
    const k = 1 - Math.exp(-dt * 1.5);
    this.angle += (this.goalAngle - this.angle) * k;
    this.maxD += (this.goalD - this.maxD) * k;
    view.controls.maxDistance = this.maxD;
  },
};
const tmp = new THREE.Vector3(), axis = new THREE.Vector3();
let follow: THREE.Vector3 | null = null;
view.constrain = (pos) => {
  if (!world) return;
  const d = pos.length();
  const nd = Math.min(d, bounds.maxD);
  tmp.copy(pos).divideScalar(d);
  if (follow) {
    // Swing round to the caravan.
    tmp.lerp(follow, 0.12).normalize();
    if (tmp.angleTo(follow) < 0.002) follow = null;
  }
  const a = tmp.angleTo(bounds.centre);
  if (a > bounds.angle) {
    axis.crossVectors(bounds.centre, tmp);
    if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
    tmp.copy(bounds.centre).applyAxisAngle(axis.normalize(), bounds.angle);
  }
  pos.copy(tmp).multiplyScalar(nd);
};

// --- On the planet: the caravan, its route, the roads -----------------------------------------
const marks = {
  group: new THREE.Group(),
  roadLines: null as THREE.LineSegments | null,
  routeLine: null as THREE.Line | null,
  anchor: new THREE.Object3D(),
  build() {
    view.addToPlanet(this.group);
    this.group.add(this.anchor);
    this.roads();
  },
  /** Where a cell's centre sits, a little above the ground. */
  at(c: number, out = new THREE.Vector3(), lift = 0.0016) {
    const P = world!.grid.centers;
    return out.set(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]).multiplyScalar(Math.max(surf!.centerH(c), SEA) + lift);
  },
  /** The backbone roads, where both ends are revealed. */
  roads() {
    if (!atlas || !world) return;
    if (this.roadLines) { this.group.remove(this.roadLines); this.roadLines.geometry.dispose(); }
    const pts: number[] = [], a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const [x, y] of atlas.roadEdges) {
      if (!revealed.has(x) || !revealed.has(y)) continue;
      this.at(x, a, 0.0012); this.at(y, b, 0.0012);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    this.roadLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0xd8b878, transparent: true, opacity: 0.75, depthTest: false }));
    this.roadLines.renderOrder = 8;
    this.group.add(this.roadLines);
  },
  route() {
    if (this.routeLine) { this.group.remove(this.routeLine); this.routeLine.geometry.dispose(); this.routeLine = null; }
    if (!save || !save.route.length || !world) return;
    const pts: THREE.Vector3[] = [this.at(save.cell, new THREE.Vector3(), 0.0022)];
    for (const c of save.route) pts.push(this.at(c, new THREE.Vector3(), 0.0022));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    this.routeLine = new THREE.Line(g, new THREE.LineDashedMaterial({ color: 0xf2c14e, dashSize: 0.004, gapSize: 0.003, depthTest: false, transparent: true, opacity: 0.95 }));
    this.routeLine.computeLineDistances();
    this.routeLine.renderOrder = 9;
    this.group.add(this.routeLine);
  },
  /** The caravan's position this frame, between its hex and the next. */
  place() {
    if (!save || !world) return;
    const a = this.at(save.cell, new THREE.Vector3(), 0.002);
    if (save.route.length && save.progress > 0) a.lerp(this.at(save.route[0], new THREE.Vector3(), 0.002), save.progress);
    this.anchor.position.copy(a);
    this.anchor.updateMatrixWorld();
    const el = $('me'), p = this.anchor.getWorldPosition(new THREE.Vector3());
    const facing = p.clone().normalize().dot(view.camera.position.clone().sub(p)) > 0;
    const s = p.clone().project(view.camera), r = view.renderer.domElement.getBoundingClientRect();
    el.hidden = !facing || s.z > 1 || hexOpen;
    el.style.transform = `translate(${Math.round(r.left + (s.x + 1) / 2 * r.width)}px, ${Math.round(r.top + (1 - s.y) / 2 * r.height)}px)`;
    // On the move, keep the caravan in view: swing round when it nears the edge (or leaves it).
    if (save.route.length && !paused() && !follow && !dragging && (!facing || Math.abs(s.x) > 0.7 || s.y > 0.6 || s.y < -0.55)) follow = this.dirOfCaravan();
    el.classList.toggle('moving', !!save.route.length && speed > 0 && !paused());
  },
  dirOfCaravan() { return this.anchor.getWorldPosition(new THREE.Vector3()).normalize(); },
};

// --- The clock --------------------------------------------------------------------------------
let speed = 0;
/** The speed play resumes at. */
let lastSpeed = 1;
/** A card that needs an answer stops the clock (an encounter, a town, a death). */
let modal = false;
const paused = () => speed === 0 || modal || hexOpen || !save || save.over;
const north = () => !!world && !!save && world.grid.centers[save.cell * 3 + 1] >= 0;

function setSpeed(s: number) {
  if (!save || save.over) return;
  if (s > 0 && hexOpen) closeHex();
  if (s > 0 && modal) return;
  speed = s;
  if (s > 0) lastSpeed = save.speed = s;
  syncBar();
}

/** Move the game on by `dd` days: travel, the days' needs, and whatever the road brings. */
function advance(dd: number) {
  if (!world || !atlas || !save) return;
  const w = world, a = atlas, s = save, c = s.caravan;
  let guard = 0;
  while (dd > 1e-6 && !modal && guard++ < 64) {
    const toMidnight = Math.floor(s.day) + 1 - s.day;
    if (s.route.length) {
      const next = s.route[0];
      const cost = stepDays(w, a, s.cell, next, doyOf(s.day)) / pace(c);
      const left = (1 - s.progress) * cost;
      const take = Math.min(dd, left, toMidnight);
      s.progress += take / cost;
      s.day += take; dd -= take;
      if (take >= toMidnight - 1e-9) newDay(false);
      if (s.progress >= 1 - 1e-6 && !modal) enter(next);
    } else {
      const take = Math.min(dd, toMidnight);
      s.day += take; dd -= take;
      if (take >= toMidnight - 1e-9) newDay(true);
    }
  }
}

/** The caravan steps into a hex. */
function enter(cell: number) {
  if (!world || !atlas || !save) return;
  const w = world, a = atlas, s = save;
  s.cell = cell;
  s.route.shift();
  s.progress = 0;
  // A route through the storm was a guess: now that more is seen, think again.
  const guessed = s.route.some((c) => !revealed.has(c));
  lookAround(cell);
  if (guessed && s.route.length) {
    const p = plan(s.route[s.route.length - 1]);
    if (p && p.path.length > 1) s.route = p.path.slice(1);
  }
  marks.route();
  const pid = a.placeAt[cell];
  if (hasWater(w, a, cell)) s.caravan.water = waterCap(s.caravan);
  if (pid >= 0) {
    const p = a.places[pid];
    remember(s.known, p, quotes(w, p, s.stocks, s.day, doyOf(s.day)), Math.floor(s.day));
    if (s.route.length) { toast(`Through ${p.name}. You note the prices.`); log(`Passed through ${p.name}.`); }
  }
  if (!s.route.length) {
    speed = 0;
    follow = marks.dirOfCaravan();
    if (pid >= 0) openTown(pid); else toast('Arrived.');
    syncBar();
    return;
  }
  // The road.
  if (pid < 0) {
    const rng = makeRng((params.seed * 7919 + ++s.draws * 104729) >>> 0);
    if (rng() < ENCOUNTER_P * (a.road[cell] ? 0.7 : 1)) {
      const snow = seasonalTemp(w, cell, doyOf(s.day)) < SNOW_TEMP;
      const nearTown = ringCells(w, cell, 3).some((x) => a.placeAt[x] >= 0);
      const names = nameMaker(params.seed * 31 + s.draws);
      const ctx = contextAt(w, cell, !!a.road[cell], snow, nearTown, s.caravan, rng, names);
      const e = drawEncounter(ctx);
      if (e) showEncounter(e, ctx);
    }
  }
}

const warned = { water: false, rations: false };
function newDay(resting: boolean) {
  if (!world || !atlas || !save) return;
  const s = save, c = s.caravan;
  const atWater = hasWater(world, atlas, s.cell);
  for (const n of passDay(c, atWater, resting)) { toast(n); log(n); }
  const wd = c.water / Math.max(1, thirst(c)), rd = c.rations / Math.max(1, appetite(c));
  if (wd <= 2 && !atWater && !warned.water && c.water > 0) { warned.water = true; speed = 0; toast(`Water for ${Math.floor(wd)} more days.`, 5000); }
  if (wd > 3) warned.water = false;
  if (rd <= 3 && !warned.rations && c.rations > 0) { warned.rations = true; speed = 0; toast(`Rations for ${Math.floor(rd)} more days.`, 5000); }
  if (rd > 4) warned.rations = false;
  hud();
  syncBar();
}

// --- Travel -----------------------------------------------------------------------------------
/** Days the planner guesses for a hex it hasn't seen: average going. The truth may be a swamp. */
const UNKNOWN_DAYS = 0.75;
/** A route from the caravan to a cell. Over known land it knows the going; into the storm it
 * guesses, and the route is thought again as the caravan sees more (enter). */
function plan(to: number): { path: number[]; days: number; guess: boolean } | null {
  if (!world || !atlas || !save) return null;
  const w = world, a = atlas, doy = doyOf(save.day);
  // Water you can see stops you; water in the storm you only find by walking up to it.
  if (revealed.has(to) && !walkable(w, to)) return null;
  const cost = (x: number, y: number) => (revealed.has(y) ? stepDays(w, a, x, y, doy) : UNKNOWN_DAYS);
  const path = findPath(w, save.cell, to, cost, (c) => revealed.has(c) || walkable(w, c));
  if (!path) return null;
  let days = 0, guess = false;
  for (let i = 1; i < path.length; i++) { days += cost(path[i - 1], path[i]); if (!revealed.has(path[i])) guess = true; }
  return { path, days: days / pace(save.caravan), guess };
}
function travelTo(to: number) {
  if (!save) return;
  const p = plan(to);
  if (!p || p.path.length < 2) return;
  save.route = p.path.slice(1);
  save.progress = 0;
  marks.route();
  closePanel();
  if (hexOpen) closeHex();
  if (speed === 0) speed = lastSpeed;
  syncBar();
  store();
}
function stopTravel() {
  if (!save) return;
  save.route = []; save.progress = 0;
  marks.route();
  syncBar();
}

// --- Lightning and thunder along the fog's edge -----------------------------------------------
const storm = { next: 2.5, t: -1, dir: new THREE.Vector3() };
let frontierCache: number[] = [], frontierAt = -1;
view.onFrame.push((dt, _d, sun, time) => {
  if (!fog || !world) return;
  bounds.step(dt);
  fog.update(view.camera.position, sun, dt, time);
  if (!paused()) {
    advance(Math.min(0.25, dt) * RATES[speed]);
    hud();
    if (performance.now() - lastStore > 5000) store();
  }
  if (save) view.setDay(doyOf(save.day));
  storm.next -= dt;
  if (storm.next <= 0) {
    storm.next = 6 + Math.random() * 14;
    if (frontierAt !== revealed.size) { frontierCache = frontier(); frontierAt = revealed.size; }
    const edge = frontierCache;
    if (edge.length) {
      // Strike a little way into the bank, beyond a frontier cell.
      const c = edge[Math.floor(Math.random() * edge.length)], P = world.grid.centers;
      storm.dir.set(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]).sub(bounds.centre).multiplyScalar(0.35)
        .add(new THREE.Vector3(P[c * 3], P[c * 3 + 1], P[c * 3 + 2])).normalize();
      storm.t = 0;
      const dist = view.camera.position.distanceTo(storm.dir);
      const near = Math.max(0, Math.min(1, 1 - dist / 0.35));
      const scr = storm.dir.clone().project(view.camera);
      thunder.roll(near * 0.8, 0.6 + dist * 9, scr.x * 0.7);
    }
  }
  if (storm.t >= 0) {
    storm.t += dt;
    fog.setFlash(storm.dir, flicker(storm.t));
    if (storm.t > 0.7) { storm.t = -1; fog.setFlash(storm.dir, 0); }
  }
  marks.place();
  labels.place();
});

// --- Labels: places you know of ---------------------------------------------------------------
const labels = {
  els: [] as { cell: number; el: HTMLElement }[],
  rebuild() {
    const box = $('labels');
    box.innerHTML = '';
    this.els = [];
    if (!world || !save || !atlas) return;
    for (const p of atlas.places) {
      if (!revealed.has(p.cell)) continue;
      const el = document.createElement('div');
      const job = save.job?.to === p.id;
      el.className = `lbl ${p.id === save.home ? 'own' : p.town ? 'town' : 'village'}${job ? ' job' : ''}`;
      el.textContent = p.name;
      box.appendChild(el);
      this.els.push({ cell: p.cell, el });
    }
  },
  place() {
    for (const { cell, el } of this.els) {
      const p = view.screenOf(cell);
      if (!p || !p.front) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -150%)`;
    }
  },
};

// --- The hex view (hex.html in game mode), in this page ---------------------------------------
let hexFrame: HTMLIFrameElement | null = null, hexReady = false, hexOpen = false, hexCell = -1, hexPending: string | null = null;
let valleysSent = false;
function hexHash(cell: number) {
  const h = new URLSearchParams();
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) h.set(k, String(params[k]));
  h.set('radius', String(RADIUS_KM));
  h.set('embed', '1');
  h.set('game', '1');
  h.set('cell', String(cell));
  const near = world ? ringCells(world, cell, 4) : [cell];
  h.set('seen', near.filter((c) => revealed.has(c)).join('.'));
  return h.toString();
}
function hexSend(msg: Record<string, unknown>) { hexFrame?.contentWindow?.postMessage(msg, location.origin); }
function openHex(c: number) {
  if (!world || c < 0 || !revealed.has(c)) return;
  if (!hexFrame) {
    const f = document.createElement('iframe');
    f.id = 'hexframe';
    f.title = 'Hex view';
    f.src = `hex.html#${hexHash(c)}`;
    document.body.appendChild(f);
    hexFrame = f;
  }
  const hash = hexHash(c);
  if (hexReady) hexSend({ type: 'mundi-hex-open', hash }); else hexPending = hash;
  hexOpen = true; hexCell = c;
  hexFrame.classList.add('open');
  hexFrame.contentWindow?.focus();
  info.hidden = true;
  view.setRunning(false);
  syncBar();
}
function closeHex() {
  if (!hexOpen) return;
  hexOpen = false;
  hexFrame?.classList.remove('open');
  hexSend({ type: 'mundi-hex-close' });
  view.setRunning(true);
  // The planet's full shaders may still be compiling on a first visit; until then it draws a plain
  // stand-in without the fog, which would show what the fog hides. Cover it meanwhile.
  document.body.classList.add('gathering');
  void view.whenGateReady().then(() => document.body.classList.remove('gathering'));
  syncBar();
}
addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === 'mundi-hex-ready') {
    hexReady = true;
    if (hexPending) { hexSend({ type: 'mundi-hex-open', hash: hexPending }); hexPending = null; }
    sendValleys();
  }
  if (e.data.type === 'primundi-thunder') thunder.roll(Math.min(1, e.data.near * 0.9), 0.5 + (1 - e.data.near) * 2.5, Math.random() * 1.2 - 0.6);
});
function sendValleys() {
  if (!hexReady || !world || valleysSent) return;
  const vc = view.valleyCarve();
  if (!vc) { setTimeout(sendValleys, 1000); return; }
  valleysSent = true;
  hexFrame?.contentWindow?.postMessage({ type: 'mundi-hex-valleys', hash: hexHash(hexCell), n: vc.n, half: vc.half }, location.origin, [vc.half.buffer]);
}

// --- Picking on the planet --------------------------------------------------------------------
const info = $('info');
let selected = -1;
const canvas = view.renderer.domElement;
canvas.addEventListener('pointermove', (e) => {
  if (e.buttons || !world || e.pointerType === 'touch') { info.hidden = true; return; }
  const c = view.pick(e.clientX, e.clientY);
  if (c < 0) { info.hidden = true; view.highlight(selected); return; }
  view.highlight(c);
  info.innerHTML = hoverText(c);
  info.style.left = `${e.clientX}px`; info.style.top = `${e.clientY}px`;
  info.hidden = false;
});
canvas.addEventListener('pointerleave', () => { info.hidden = true; view.highlight(selected); });
let downAt: [number, number] | null = null, dragging = false;
canvas.addEventListener('pointerdown', (e) => { downAt = e.button === 0 ? [e.clientX, e.clientY] : null; dragging = true; follow = null; });
addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('pointerup', (e) => {
  if (!downAt || !world || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 8) return;
  if (panelKind === 'encounter' || panelKind === 'appoint' || panelKind === 'over') return;
  const c = view.pick(e.clientX, e.clientY);
  if (c < 0) { closePanel(); selected = -1; view.highlight(-1); return; }
  selected = c;
  view.highlight(c);
  showHexCard(c);
});
canvas.addEventListener('dblclick', (e) => {
  if (modal) return;
  const c = view.pick(e.clientX, e.clientY);
  if (c >= 0) travelTo(c);
});
function hoverText(c: number): string {
  if (!world || !atlas) return '';
  if (!revealed.has(c)) return frontier().includes(c) ? '<b>Storm</b><br><span>the edge of what you know</span>' : '<b>Storm</b>';
  const pid = atlas.placeAt[c];
  const name = pid >= 0 ? `<b>${esc(atlas.places[pid].name)}</b><br>` : '';
  return `${name}${BIOMES[world.biome[c]].name}${world.river[c] ? ' · river' : ''}${atlas.road[c] ? ' · road' : ''}`;
}

// --- Cards ------------------------------------------------------------------------------------
const panel = $('card');
let panelKind = '';
function showPanel(kind: string, html: string, isModal = false) {
  panel.innerHTML = html;
  panel.hidden = false;
  panel.dataset.kind = kind;
  panel.scrollTop = 0;
  panelKind = kind;
  modal = isModal;
  syncBar();
}
function closePanel() {
  panel.hidden = true;
  panelKind = '';
  modal = false;
  syncBar();
}
const close = '<button class="x" data-act="close" title="Close">×</button>';

function showHexCard(c: number) {
  if (!world || !atlas || !save) return;
  const w = world;
  if (!revealed.has(c)) {
    const edge = frontier().includes(c);
    const p = plan(c);
    showPanel('hex', `${close}<h2>Storm</h2>
      <p>${edge ? 'The edge of what you know. Beyond it, anything.' : 'Deep in the storm. Nobody you know has been there.'}</p>
      ${p ? `<p class="dim">Perhaps ${daysText(p.days)}, if the going is fair. You'll find out.</p><div class="acts"><button class="go" data-act="travel" data-cell="${c}">Head into the storm</button></div>` : '<p class="dim">No way there that you can find.</p>'}`);
    return;
  }
  const pid = atlas.placeAt[c], place = pid >= 0 ? atlas.places[pid] : null;
  const tC = Math.round(50 * seasonalTemp(w, c, doyOf(save.day)) - 17);
  const here = c === save.cell;
  const p = here ? null : plan(c);
  const known = place ? save.known[place.id] : undefined;
  showPanel('hex', `${close}
    <h2>${place ? esc(place.name) : BIOMES[w.biome[c]].name}</h2>
    ${place ? `<p class="dim">${placeLine(place)}</p>` : ''}
    <p>${place ? BIOMES[w.biome[c]].name + ' · ' : ''}${w.river[c] ? 'a river · ' : ''}${atlas.road[c] ? 'on the road · ' : ''}about ${tC} °C now</p>
    ${place && known && !here ? `<p class="dim">You know its prices from ${agoText(save.day - known.day)}.</p>` : place && !here ? '<p class="dim">You don\'t know its prices.</p>' : ''}
    ${save.job?.to === pid ? `<p class="job">You have a ${esc(save.job.item)} to deliver here.</p>` : ''}
    <div class="acts">
      ${here ? `${place ? `<button class="go" data-act="town">Enter ${esc(place.name)}</button>` : ''}<button data-act="look">Look around</button>`
        : p ? `<button class="go" data-act="travel" data-cell="${c}">Travel here · ${p.guess ? 'perhaps ' : ''}${daysText(p.days)}</button>` : '<span class="dim">No way there that you know of.</span>'}
    </div>`);
}
const daysText = (d: number) => (d < 1 ? 'under a day' : d < 1.5 ? 'a day' : `${Math.round(d)} days`);
const agoText = (d: number) => (d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)} days ago`);
function placeLine(p: Place) {
  return `${p.town ? 'Town' : 'Village'} of ${fmt(p.pop)}${p.realm ? ` · ${esc(p.realm)}` : ''}${p.id === save?.home ? ' · <b>home</b>' : ''}`;
}

// The town: market, supplies, work, rest. Bannerlord's menu, over the hex view or the planet.
let townTab = 'market';
function openTown(pid: number, tab = townTab) {
  if (!world || !atlas || !save) return;
  townTab = tab;
  const w = world, a = atlas, s = save, c = s.caravan, p = a.places[pid];
  const day = s.day, doy = doyOf(day);
  const q = quotes(w, p, s.stocks, day, doy);
  remember(s.known, p, q, Math.floor(day));
  const home = p.id === s.home;
  const tabs = [['market', 'Market'], ['supplies', 'Supplies'], ['work', 'Work'], ['rest', home ? 'Home' : 'Rest & hire']];
  let body = '';
  if (tab === 'market') {
    body = `<p class="dim">${cargoUsed(c)} of ${c.capacity} loads carried · ${fmt(c.orrels)} orrels</p>
      <table class="mkt"><thead><tr><th></th><th>Buy</th><th>Sell</th><th>Have</th><th class="else">Best you know</th></tr></thead><tbody>
      ${GOODS.map((g, i) => {
        const best = bestKnownSell(a, s.known, i, p.id);
        // Green: worth carrying there (it fetches more than it costs here; relics, more than here pays).
        const better = best && best.price > (q[i].buy || q[i].sell);
        return `<tr><td>${g.name}</td>
          <td>${q[i].buy ? `<button data-act="buy" data-g="${i}" ${q[i].stock < 1 || c.orrels < q[i].buy || cargoUsed(c) >= c.capacity ? 'disabled' : ''}>${q[i].buy}</button>` : '<span class="dim">·</span>'}</td>
          <td><button data-act="sell" data-g="${i}" ${c.cargo[i] < 1 ? 'disabled' : ''}>${q[i].sell}</button></td>
          <td>${c.cargo[i] || ''}</td>
          <td class="else">${best ? `<span class="${better ? 'up' : 'dim'}">${best.price}</span> <span class="dim">${esc(best.place.name)}, ${agoText(day - best.day)}</span>` : ''}</td></tr>`;
      }).join('')}
      </tbody></table>
      <p class="dim small">Buy and sell one at a time; shift-click for five. Prices move as you trade, and settle back over a fortnight.</p>`;
  } else if (tab === 'supplies') {
    const rp = rationPrice(w, p, s.stocks, day, doy), eat = appetite(c);
    const rd = c.rations / Math.max(1, eat);
    const chart = Math.round(c.unsoldCharts * chartRate(p));
    body = `<p>Rations for <b>${Math.floor(rd)} days</b>. Water: your skins are filled here, free (${Math.floor(waterCap(c) / Math.max(1, thirst(c)))} days' worth).</p>
      <div class="acts">${[5, 10, 20].map((d) => { const cost = Math.ceil(rp * eat * d); return `<button data-act="rations" data-n="${d}" ${c.orrels < cost ? 'disabled' : ''}>+${d} days · ${cost} orrels</button>`; }).join('')}</div>
      <h3>Charts</h3>
      <p>${c.unsoldCharts ? `You have mapped ${fmt(c.unsoldCharts)} hexes no one here has bought. ${esc(p.name)} will pay ${fmt(chart)} orrels for the charts.` : 'You have no new charts to sell.'}</p>
      ${c.unsoldCharts ? `<div class="acts"><button class="go" data-act="charts">Sell charts · ${fmt(chart)} orrels</button></div>` : ''}`;
  } else if (tab === 'work') {
    const j = s.job;
    if (j && j.to === p.id) {
      body = `<p>${esc(j.giver)}'s ${esc(j.item)} is for someone here. They have been expecting it.</p>
        <div class="acts"><button class="go" data-act="deliver">Deliver it · ${j.reward} orrels</button></div>`;
    } else if (j) {
      body = `<p>You are carrying ${esc(j.giver)}'s ${esc(j.item)} to <b>${esc(a.places[j.to].name)}</b>, ${bearing(w, s.cell, a.places[j.to].cell)} of here, for ${j.reward} orrels.</p>
        <div class="acts"><button data-act="abandon">Give it up</button></div>`;
    } else {
      const offer = jobAt(p);
      body = offer
        ? `<p><b>${esc(offer.giver)}</b> needs a ${esc(offer.item)} carried to <b>${esc(a.places[offer.to].name)}</b>, ${bearing(w, p.cell, a.places[offer.to].cell)} of here. ${revealed.has(a.places[offer.to].cell) ? '' : 'They mark it on your map.'}</p>
           <p>They'll pay <b>${offer.reward} orrels</b> on delivery.</p>
           <div class="acts"><button class="go" data-act="job">Take the job</button></div>`
        : '<p>Nobody here has work for a caravan just now.</p>';
    }
  } else {
    const cost = home ? 0 : living(c).length;
    const hires: [Role, number][] = p.town ? [['hand', 30], ['guard', 55], ['scout', 70]] : [['hand', 30], ['guard', 55]];
    body = `<p>${home ? 'Your own people put you up. Resting here costs nothing.' : `A yard and a roof for the caravan: ${cost} orrels a night.`}</p>
      <div class="acts"><button data-act="rest" data-n="1" ${c.orrels < cost ? 'disabled' : ''}>Rest a day</button><button data-act="rest" data-n="3" ${c.orrels < cost * 3 ? 'disabled' : ''}>Rest three days</button></div>
      <h3>Hire</h3>
      ${living(c).length >= 9 ? '<p class="dim">The caravan is as big as it can feed.</p>' : `<div class="acts">${hires.map(([r, o]) => `<button data-act="hire" data-role="${r}" data-n="${o}" ${c.orrels < o ? 'disabled' : ''}>A ${ROLE_NAMES[r].toLowerCase()} · ${o}</button>`).join('')}</div>`}
      <h3>Beasts</h3>
      <div class="acts"><button data-act="beast" ${c.orrels < 45 ? 'disabled' : ''}>A pack beast (+4 loads) · 45</button></div>`;
  }
  showPanel('town', `${close}
    <h2>${esc(p.name)}</h2><p class="dim">${placeLine(p)}</p>
    <nav class="tabs">${tabs.map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</nav>
    ${body}
    <div class="acts foot"><button data-act="look">Look around</button><button data-act="close">Leave</button></div>`);
  panel.dataset.pid = String(pid);
  hud();
}
function chartRate(p: Place) { return (save?.caravan.origin === 'cartographers' ? 1.5 : 0.6) * (p.town ? 1 : 0.5); }

/** The work a place offers this month, if any: carry something somewhere 4–14 hexes off. */
function jobAt(p: Place): Job | null {
  if (!world || !atlas || !save) return null;
  const w = world, a = atlas, month = Math.floor(save.day / 30);
  const rng = makeRng((params.seed * 131 + p.id * 977 + month * 7) >>> 0);
  if (rng() < 0.15) return null;
  const cellA = cellAngle();
  const cands = a.places.filter((o) => o.id !== p.id && game!.continent[o.cell] === game!.continent[p.cell]).filter((o) => { const d = angle(w, o.cell, p.cell) / cellA; return d >= 4 && d <= 14; });
  if (!cands.length) return null;
  const to = cands[Math.floor(rng() * cands.length)];
  const path = findPath(w, p.cell, to.cell, (x, y) => stepDays(w, a, x, y, doyOf(save!.day)), () => true, 30);
  if (!path) return null;
  let days = 0;
  for (let i = 1; i < path.length; i++) days += stepDays(w, a, path[i - 1], path[i], doyOf(save.day));
  const items = ['sealed letter', 'parcel of seed', 'small locked box', 'bolt of fine cloth', 'bundle of deeds', 'wrapped icon', 'crate of medicines'];
  const giver = nameMaker(params.seed + p.id * 13 + month)();
  return { item: items[Math.floor(rng() * items.length)], giver, from: p.id, to: to.id, reward: Math.round(20 + days * 7), taken: save.day };
}

// The road.
function showEncounter(e: Encounter, ctx: ReturnType<typeof contextAt>) {
  speed = 0;
  const choices = e.choices(ctx);
  showPanel('encounter', `<h2>${esc(e.title)}</h2><p>${esc(e.text(ctx))}</p>
    <div class="acts col">${choices.map((ch, i) => `<button class="${i === 0 ? 'go' : ''}" data-act="choose" data-i="${i}">${esc(ch.label)}${ch.hint ? `<span>${esc(ch.hint)}</span>` : ''}</button>`).join('')}</div>`, true);
  pendingChoices = { e, ctx, choices };
}
let pendingChoices: { e: Encounter; ctx: ReturnType<typeof contextAt>; choices: Choice[] } | null = null;
function choose(i: number) {
  if (!pendingChoices || !save) return;
  const { e, ctx, choices } = pendingChoices;
  pendingChoices = null;
  const out: Outcome = choices[i].resolve(ctx);
  const lines = applyEffect(save.caravan, out.effect, ctx.name, save.day);
  let extra = '';
  if (out.effect.reveal) { const n = reveal(ringCells(world!, save.cell, out.effect.reveal), true); if (n) lines.push(`${n} hexes mapped`); }
  if (out.effect.rumour) extra = rumour();
  if (out.effect.days) passDays(out.effect.days);
  log(`${e.title}: ${out.text}`);
  showPanel('encounter', `<h2>${esc(e.title)}</h2><p>${esc(out.text)}</p>${extra ? `<p>${esc(extra)}</p>` : ''}
    ${lines.length ? `<p class="fx">${lines.map(esc).join(' · ')}</p>` : ''}
    <div class="acts"><button class="go" data-act="after">Go on</button></div>`, true);
  hud();
}
/** Whole days spent in place (a storm, a fever, a rest). */
function passDays(n: number, resting = true) {
  if (!save) return;
  for (let i = 0; i < Math.round(n * 2); i++) {
    const before = Math.floor(save.day);
    save.day += 0.5;
    if (Math.floor(save.day) > before) newDay(resting);
  }
}
function afterEncounter() {
  if (!save) return;
  const c = save.caravan;
  if (!living(c).length) return gameOver();
  if (!leader(c)) return showAppoint();
  closePanel();
  if (save.route.length) setSpeed(lastSpeed);
  store();
}
function showAppoint() {
  if (!save) return;
  const c = save.caravan;
  const dead = c.members.find((m) => !m.alive && m.role === 'leader');
  showPanel('appoint', `<h2>Who leads now?</h2><p>${dead ? `${esc(dead.name)} is dead. ` : ''}The caravan needs someone to follow.</p>
    <div class="acts col">${c.members.map((m, i) => m.alive ? `<button data-act="appoint" data-i="${i}">${esc(m.name)}<span>${ROLE_NAMES[m.role]} · ${TRAITS[m.trait]}</span></button>` : '').join('')}</div>`, true);
}
function gameOver() {
  if (!save) return;
  save.over = true;
  speed = 0;
  store();
  showPanel('over', `<h2>The road ends</h2><p>Nobody is left of ${esc(save.caravan.name)}. The storm closes over the way you came.</p>
    <p class="dim">${dateText(save.day, north())}. ${fmt(save.charted)} hexes charted, ${save.jobsDone} jobs done, ${fmt(save.caravan.earned)} orrels earned.</p>
    <div class="acts"><button class="go" data-act="menu">Begin again</button></div>`, true);
}

function showJournal() {
  if (!save || !atlas) return;
  const s = save, c = s.caravan, o = ORIGINS.find((x) => x.id === c.origin)!;
  const prog = c.origin === 'traders' ? c.earned : s.charted, goal = AMBITION_GOAL[c.origin];
  showPanel('journal', `${close}<h2>${esc(c.name)}</h2>
    <p class="dim">${o.label} · from ${esc(atlas.places[s.home].name)} · ${dateText(s.day, north())}</p>
    <h3>Ambition</h3><p>${o.ambition}: ${fmt(Math.min(prog, goal))} of ${fmt(goal)}${prog >= goal ? ' · <b>done</b>. The road goes on.' : ''}</p>
    <div class="meter"><i style="width:${Math.min(100, (prog / goal) * 100)}%"></i></div>
    <p class="dim small">Just a direction. Go where you like.</p>
    ${s.job ? `<h3>Work</h3><p>${esc(s.job.giver)}'s ${esc(s.job.item)} to ${esc(atlas.places[s.job.to].name)}, for ${s.job.reward} orrels.</p>` : ''}
    <h3>The caravan</h3>
    <ul class="people">${c.members.filter((m) => m.alive).map((m) => `<li><b>${esc(m.name)}</b> ${ROLE_NAMES[m.role]}${m.health !== 'well' ? ` · <i>${m.health}</i>` : ''}<span>${TRAITS[m.trait]}</span></li>`).join('')}</ul>
    ${c.members.some((m) => !m.alive) ? `<p class="dim small">Lost: ${c.members.filter((m) => !m.alive).map((m) => esc(m.name)).join(', ')}.</p>` : ''}
    <h3>Lately</h3>
    <ul class="log">${s.log.slice(-30).reverse().map((l) => `<li><span>${dateText(l.day, north())}</span>${esc(l.text)}</li>`).join('')}</ul>`);
}

panel.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b || !save || !world || !atlas) return;
  const s = save, c = s.caravan, act = b.dataset.act, pid = Number(panel.dataset.pid);
  const many = (e as MouseEvent).shiftKey ? 5 : 1;
  switch (act) {
    case 'close': closePanel(); break;
    case 'travel': travelTo(Number(b.dataset.cell)); break;
    case 'look': closePanel(); openHex(s.cell); break;
    case 'town': if (atlas.placeAt[s.cell] >= 0) openTown(atlas.placeAt[s.cell], 'market'); break;
    case 'tab': openTown(pid, b.dataset.tab); break;
    case 'buy': case 'sell': {
      const g = Number(b.dataset.g), p = atlas.places[pid];
      let n = act === 'buy' ? Math.min(many, c.capacity - cargoUsed(c)) : Math.min(many, c.cargo[g]);
      if (n <= 0) break;
      if (act === 'buy') {
        // No more than the purse allows.
        while (n > 0) { const st = JSON.parse(JSON.stringify(s.stocks)) as Stocks; if (trade(world, p, st, s.day, doyOf(s.day), g, n) <= c.orrels) break; n--; }
        if (n <= 0) break;
      }
      const cost = trade(world, p, s.stocks, s.day, doyOf(s.day), g, act === 'buy' ? n : -n);
      c.orrels -= cost;
      if (act === 'buy') { c.basis[g] += cost; c.cargo[g] += n; }
      else {
        // The Traders' ambition counts profit: what it sold for, less what it cost.
        const paid = c.cargo[g] ? (c.basis[g] / c.cargo[g]) * n : 0;
        c.basis[g] -= paid; c.cargo[g] -= n;
        c.earned += -cost - paid;
      }
      openTown(pid, 'market');
      store();
      break;
    }
    case 'rations': {
      const p = atlas.places[pid], d = Number(b.dataset.n);
      const cost = Math.ceil(rationPrice(world, p, s.stocks, s.day, doyOf(s.day)) * appetite(c) * d);
      if (c.orrels < cost) break;
      c.orrels -= cost;
      c.rations += appetite(c) * d;
      openTown(pid, 'supplies');
      store();
      break;
    }
    case 'charts': {
      const p = atlas.places[pid], pay = Math.round(c.unsoldCharts * chartRate(p));
      c.orrels += pay; c.earned += pay; c.unsoldCharts = 0;
      log(`Sold charts in ${p.name} for ${pay} orrels.`);
      openTown(pid, 'supplies');
      store();
      break;
    }
    case 'job': {
      const j = jobAt(atlas.places[pid]);
      if (!j) break;
      s.job = j;
      const to = atlas.places[j.to];
      reveal(ringCells(world, to.cell, 1));
      log(`Took ${j.giver}'s ${j.item} to carry to ${to.name}.`);
      labels.rebuild();
      openTown(pid, 'work');
      store();
      break;
    }
    case 'deliver': {
      const j = s.job!;
      c.orrels += j.reward; c.earned += j.reward;
      s.jobsDone++;
      log(`Delivered ${j.giver}'s ${j.item} to ${atlas.places[j.to].name}: ${j.reward} orrels.`);
      s.job = null;
      labels.rebuild();
      openTown(pid, 'work');
      store();
      break;
    }
    case 'abandon': if (s.job) { log(`Gave up the ${s.job.item} for ${atlas.places[s.job.to].name}.`); s.job = null; labels.rebuild(); openTown(pid, 'work'); store(); } break;
    case 'rest': {
      const n = Number(b.dataset.n), cost = pid === s.home ? 0 : living(c).length * n;
      if (c.orrels < cost) break;
      c.orrels -= cost;
      passDays(n, true);
      c.water = waterCap(c);
      toast(`${n === 1 ? 'A day' : `${n} days`} of rest.`);
      openTown(pid, 'rest');
      store();
      break;
    }
    case 'hire': {
      const o = Number(b.dataset.n), role = b.dataset.role as Role;
      if (c.orrels < o) break;
      c.orrels -= o;
      const nm = nameMaker(params.seed * 17 + s.day * 3 + c.members.length)();
      const traits = Object.keys(TRAITS) as (keyof typeof TRAITS)[];
      c.members.push({ name: nm, role, trait: traits[Math.floor(Math.random() * traits.length)], health: 'well', alive: true, joined: s.day });
      log(`${nm} joined as a ${ROLE_NAMES[role].toLowerCase()}, in ${atlas.places[pid].name}.`);
      openTown(pid, 'rest');
      store();
      break;
    }
    case 'beast': if (c.orrels >= 45) { c.orrels -= 45; c.capacity += 4; openTown(pid, 'rest'); store(); } break;
    case 'choose': choose(Number(b.dataset.i)); break;
    case 'after': afterEncounter(); break;
    case 'appoint': {
      const m = c.members[Number(b.dataset.i)];
      for (const x of c.members) if (x.alive && x.role === 'leader') x.role = 'hand';
      m.role = 'leader';
      log(`${m.name} leads the caravan now.`);
      closePanel();
      store();
      break;
    }
    case 'menu': localStorage.removeItem(SAVE_KEY); location.reload(); break;
  }
  hud();
});

// --- The readouts and the bar -----------------------------------------------------------------
function hud() {
  if (!save) return;
  const c = save.caravan;
  $('hud').hidden = false;
  $('date').textContent = dateText(save.day, north());
  $('s-orrels').textContent = fmt(c.orrels);
  const wd = c.water / Math.max(1, thirst(c)), rd = c.rations / Math.max(1, appetite(c));
  $('s-water').textContent = `${Math.floor(wd)}d`;
  $('s-rations').textContent = `${Math.floor(rd)}d`;
  $('s-cargo').textContent = `${cargoUsed(c)}/${c.capacity}`;
  $('s-people').textContent = String(living(c).length);
  $('s-water').parentElement!.classList.toggle('low', wd <= 2);
  $('s-rations').parentElement!.classList.toggle('low', rd <= 3);
  $('s-people').parentElement!.title = `${living(c).length} people · morale ${c.morale > 70 ? 'high' : c.morale > 40 ? 'steady' : c.morale > 20 ? 'low' : 'very low'}`;
}
function syncBar() {
  $('b-hex').classList.toggle('on', hexOpen);
  $('b-planet').classList.toggle('on', !hexOpen);
  $('b-sound').classList.toggle('off', thunder.muted);
  $('b-sound').title = thunder.muted ? 'Sound off' : 'Sound on';
  $('civname').textContent = save?.caravan.name ?? '';
  for (let i = 0; i < 4; i++) $(`b-s${i}`).classList.toggle('on', (paused() ? 0 : speed) === i);
  $('bar').classList.toggle('held', modal || hexOpen);
  const pid = save && atlas ? atlas.placeAt[save.cell] : -1;
  $('b-town').hidden = !(pid >= 0 && !(save!.route.length && save!.progress > 0));
  $('b-stop').hidden = !save?.route.length;
  document.body.classList.toggle('in-hex', hexOpen);
}
$('b-hex').onclick = () => { if (save) { closePanel(); openHex(save.cell); } };
$('b-planet').onclick = () => closeHex();
for (let i = 0; i < 4; i++) $(`b-s${i}`).onclick = () => setSpeed(i);
$('b-journal').onclick = () => (panelKind === 'journal' ? closePanel() : !modal && showJournal());
$('b-town').onclick = () => { if (save && atlas && atlas.placeAt[save.cell] >= 0 && !modal) openTown(atlas.placeAt[save.cell], 'market'); };
$('b-stop').onclick = () => { stopTravel(); setSpeed(0); };
$('civname').parentElement!.onclick = () => { if (!hexOpen) follow = marks.dirOfCaravan(); };
$('b-sound').onclick = () => { thunder.unlock(); thunder.setMuted(!thunder.muted); syncBar(); };
$('b-menu').onclick = () => {
  if (!confirm('Leave this game? It stays saved, and you can continue it from the menu.')) return;
  store();
  location.reload();
};
addEventListener('keydown', (e) => {
  if (!save || (e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.code === 'Space') { e.preventDefault(); setSpeed(paused() ? lastSpeed : 0); }
  if (e.key === '1' || e.key === '2' || e.key === '3') setSpeed(Number(e.key));
});
addEventListener('pagehide', () => store());

let toastTimer = 0;
function toast(text: string, ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t.classList.remove('on'), ms);
}

// --- Debug handle -----------------------------------------------------------------------------
(window as unknown as Record<string, unknown>).primundi = {
  view, thunder,
  get world() { return world; },
  get atlas() { return atlas; },
  get save() { return save; },
  get fog() { return fog; },
  get speed() { return speed; },
  reveal: (cells: number[]) => reveal(cells),
  revealRing: () => reveal(frontier()),
  travelTo, setSpeed, advance, openTown, openHex, closeHex, plan,
  encounter: (id?: string) => {
    if (!world || !atlas || !save) return;
    const rng = makeRng(Date.now() >>> 0);
    const ctx = contextAt(world, save.cell, !!atlas.road[save.cell], false, false, save.caravan, rng, nameMaker(Date.now() % 9999));
    const e = id ? (ENCOUNTERS_BY_ID[id] ?? drawEncounter(ctx)) : drawEncounter(ctx);
    if (e) showEncounter(e, ctx);
  },
};
const ENCOUNTERS_BY_ID = Object.fromEntries(ENCOUNTERS.map((e) => [e.id, e]));

showLaunch();
syncBar();
