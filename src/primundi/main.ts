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
import { DEFAULT_PARAMS, WATER_LAND, type World, type WorldParams } from '../world.ts';
import { BIOMES } from '../biomes.ts';
import type { BuildRequest, BuildResult, BuildStage } from '../worker.ts';
import type { HistoryRequest, HistoryResult } from '../historyWorker.ts';
import type { History } from '../civ.ts';
import { gameData, nameMaker, type GameData } from '../gamedata.ts';
import { randomName } from '../seedname.ts';
import { SEA, surfaceQueries, type SurfaceQueries } from '../surface.ts';
import { mountLoader, type Loader } from '../loader.ts';
import { describeHex } from '../hexcard.ts';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { MAX_QUESTS, canHandIn, questPitch, questStatus, questTarget, questTitle } from './quests.ts';
import { makeRng } from '../rng.ts';
import { PlanetFog } from './fog.ts';
import { flicker } from './hexfog.ts';
import { Thunder } from './thunder.ts';
import { BIASES, type StartBias } from './start.ts';
import { buildAtlas, GOODS, ringCells, type Atlas, type Place } from './atlas.ts';
import { bestKnownSell, quotes, rationPrice, remember } from './market.ts';
import { AMBITION_GOAL, ORIGINS, ROLE_NAMES, TRAITS, appetite, cargoUsed, leader, living, waterCap, thirst, type Origin, type Role } from './caravan.ts';
import { FIND_NAMES, findReady, findsIn, type FindKind } from './finds.ts';
import { FOLK_LABEL, type FolkKind } from './life.ts';
import { ENCOUNTERS, QUEST_ENCOUNTERS, contextAt, drawEncounter, type Ctx, type Encounter } from './encounters.ts';
import {
  START_DOY, RATES, doyOf, worldParams, migrateSave, makeGame, newGame, cellAngleOf, bearing, setRoute, findHere, jobHere, pending, resolve,
  jobsOffered, shortHere, chartRate, folkHere, meetFolk, passFolk, buyRations, sellCharts, takeJob, handIn, giveUp, standRound, buyMap, hire, buyBeast, appoint,
  reveal as simReveal, advance as simAdvance, plan as simPlan,
  buy as simBuy, sell as simSell, rest as simRest,
  type Game, type Pending, type Save, type Ui,
} from './sim.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RADIUS_KM = 640;

const SAVE_KEY = 'primundi.save2';
function loadSave(): Save | null {
  try { return migrateSave(JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Save | null); } catch { return null; }
}
let save: Save | null = null;
/** The game in play (sim.ts): the rules, given the world, the save and the screen below (`ui`). */
let g: Game | null = null;
let lastStore = 0;
function store() { if (save) { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); lastStore = performance.now(); } }

const paramsFor = worldParams;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const fmt = (n: number) => Math.round(n).toLocaleString();

// --- The calendar -----------------------------------------------------------------------------
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
    <form class="launch-card" autocomplete="off">
      <div class="wordmark">PRIMUNDI</div>
      <h1>A world under storm</h1>
      <p class="tag">Take a caravan out into it. Trade, take work, and learn its shape.</p>
      ${prev ? `<button type="button" class="resume" id="continue"><span class="ot"><b>Continue ${esc(prev.caravan.name)}</b><small>${esc(prev.world)} · ${dateText(prev.day, true)}</small></span><span class="arrow">→</span></button>
      <div class="or">or set out anew</div>` : ''}
      <label class="field"><span class="lab">Your caravan</span>
        <input id="civ" type="text" maxlength="28" spellcheck="false" value="${esc(nameDefault)}" /></label>
      <div class="field"><span class="lab">Who you are</span>
        <div class="tiles">${ORIGINS.map((o, i) => `<label class="tile"><input type="radio" name="origin" value="${o.id}" ${i === 0 ? 'checked' : ''} /><b>${o.label}</b><small>${o.note}</small><em>${o.ambition}</em></label>`).join('')}</div></div>
      <div class="field"><span class="lab">Home</span>
        <div class="seg">${BIASES.map((b) => `<label><input type="radio" name="bias" value="${b.id}" ${b.id === (prev && prev.bias !== 'any' ? prev.bias : 'gentle') ? 'checked' : ''} /><span>${b.label}</span></label>`).join('')}</div>
        <small class="bias-note" id="bias-note"></small></div>
      <div class="field"><span class="lab">World</span>
        <span class="seed"><input id="seed" type="text" maxlength="40" spellcheck="false" placeholder="a random world" title="A name (letters) or a number: the same seed always makes the same world and home" />
        <button type="button" id="dice" title="Roll a world">⚄</button></span></div>
      <button type="submit" class="go" id="begin">Set out</button>
    </form>`;
  const note = () => { const v = el.querySelector<HTMLInputElement>('input[name=bias]:checked')?.value; $('bias-note').textContent = BIASES.find((b) => b.id === v)?.note ?? ''; };
  el.querySelectorAll('input[name=bias]').forEach((i) => i.addEventListener('change', note));
  note();
  $('dice').onclick = () => { $<HTMLInputElement>('seed').value = randomName(); };
  el.querySelector('form')!.onsubmit = (e) => {
    e.preventDefault();
    thunder.unlock();
    const typed = $<HTMLInputElement>('seed').value.trim();
    const bias = (el.querySelector<HTMLInputElement>('input[name=bias]:checked')?.value ?? 'gentle') as StartBias;
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
  if (!save) save = newGame(w, atlas, params.seed, pendingNew!);
  g = makeGame(w, atlas, game, params.seed, save, ui);
  // One set of revealed hexes, shared with the rules.
  g.revealed = revealed;
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
  // Home, or wherever you were: down into the hex. In a town its buildings are the menus.
  openHex(s.cell);
  if (s.log.length === 1) toast(s.log[0].text, 8000);
}

const cellAngle = () => cellAngleOf(world!);

// --- Revealing --------------------------------------------------------------------------------
function reveal(cells: number[], byTravel = false) { return g ? simReveal(g, cells, byTravel) : 0; }
/** Hexes just revealed (sim.ts has added them): the fog, the camera's leash, labels, roads. */
function revealedOnScreen(fresh: number[], byTravel: boolean) {
  fog?.reveal(fresh, false, byTravel ? 1 : 3.2);
  bounds.update(false);
  labels.rebuild();
  marks.roads();
  if (hexOpen) hexSend({ type: 'primundi-seen', cells: fresh });
  // Word of somewhere far off (a rumour, a map): the camera can't pan across the fog to it, so it
  // swings there to show you (once you're back on the map, if you're down in a hex).
  if (!byTravel && world) {
    const P = world.grid.centers, v = new THREE.Vector3();
    for (const c of fresh) v.x += P[c * 3], v.y += P[c * 3 + 1], v.z += P[c * 3 + 2];
    v.normalize();
    if (v.angleTo(marks.dirOfCaravan()) > cellAngle() * 4) { if (hexOpen) lookLater = v; else follow = v; }
  }
}
/** Fogged cells touching what is revealed. */
function frontier(): number[] {
  if (!world) return [];
  const out = new Set<number>();
  for (const c of revealed) for (const n of world.grid.neighbors[c]) if (!revealed.has(n)) out.add(n);
  return [...out];
}

// --- The camera's leash -----------------------------------------------------------------------
/** The planet camera stays over what's revealed. How far out it may go is set by how much you've
 * seen (its area, as a disc), not how spread out it is: a rumour or a bought map far off doesn't
 * open up the whole globe. Sideways, the middle of the view stays near some hex you've seen, so
 * the fog between two patches is no road for the camera. Both ease when the area grows. */
const bounds = {
  centre: new THREE.Vector3(0, 0, 1),
  /** How far the middle of the view may stray from the nearest revealed hex (radians). */
  reach: 0.05,
  maxD: 1.3,
  goalD: 1.3,
  /** The revealed hexes' centres, unit vectors, for the nearest-hex test each frame. */
  dirs: new Float32Array(0),
  update(snap: boolean) {
    if (!world || !revealed.size) return;
    const P = world.grid.centers, sum = new THREE.Vector3();
    this.dirs = new Float32Array(revealed.size * 3);
    let i = 0;
    for (const c of revealed) {
      sum.x += P[c * 3], sum.y += P[c * 3 + 1], sum.z += P[c * 3 + 2];
      this.dirs[i++] = P[c * 3]; this.dirs[i++] = P[c * 3 + 1]; this.dirs[i++] = P[c * 3 + 2];
    }
    this.centre.copy(sum.normalize());
    const cellA = cellAngle();
    // The revealed area as a disc: its radius.
    const r = cellA * Math.sqrt(revealed.size / Math.PI);
    this.reach = cellA * 1.5;
    // Field of view 40°: a height h sees about 0.36 h either side of the middle; the tilt shows more.
    this.goalD = 1 + Math.min(2.2, Math.max(0.07, (r + cellA * 1.2) * 2.6));
    if (snap) this.maxD = this.goalD;
  },
  /** The revealed hex nearest a direction (unit vector `v`), into `out`; the angle to it. */
  nearest(v: THREE.Vector3, out: THREE.Vector3): number {
    const D = this.dirs;
    let best = -2, bi = 0;
    for (let i = 0; i < D.length; i += 3) { const d = D[i] * v.x + D[i + 1] * v.y + D[i + 2] * v.z; if (d > best) { best = d; bi = i; } }
    out.set(D[bi], D[bi + 1], D[bi + 2]);
    return Math.acos(Math.min(1, best));
  },
  step(dt: number) {
    const k = 1 - Math.exp(-dt * 1.5);
    this.maxD += (this.goalD - this.maxD) * k;
    view.controls.maxDistance = this.maxD;
  },
};
const tmp = new THREE.Vector3(), axis = new THREE.Vector3(), near = new THREE.Vector3();
let follow: THREE.Vector3 | null = null;
/** Somewhere to swing to once the hex view closes (word of a far place, heard in a town). */
let lookLater: THREE.Vector3 | null = null;
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
  // (Not while swinging to something: the way there may cross fog.)
  if (bounds.dirs.length && !follow) {
    const a = bounds.nearest(tmp, near);
    if (a > bounds.reach) {
      axis.crossVectors(near, tmp);
      if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
      const edge = near.clone().applyAxisAngle(axis.normalize(), bounds.reach);
      // A drag past the edge stops at it; stranded out over the fog (a swing let go), ease back.
      if (a - bounds.reach < cellAngle() * 0.5) tmp.copy(edge);
      else tmp.lerp(edge, 0.12).normalize();
    }
  }
  pos.copy(tmp).multiplyScalar(nd);
};

// --- On the planet: the caravan, its route, the roads -----------------------------------------
const marks = {
  group: new THREE.Group(),
  roadLines: [] as Line2[],
  routeLine: null as Line2 | null,
  roadMat: new LineMaterial({ color: 0xe0c48c, linewidth: 2.2, dashed: true, dashSize: 0.0042, gapSize: 0.0022, transparent: true, opacity: 0.9, depthTest: false }),
  roadUnder: new LineMaterial({ color: 0x1a140c, linewidth: 4.4, transparent: true, opacity: 0.35, depthTest: false }),
  /** A road's next leg on into the fog. */
  roadFaint: new LineMaterial({ color: 0x8a6a3c, linewidth: 2, dashed: true, dashSize: 0.0042, gapSize: 0.0022, transparent: true, opacity: 0.6, depthTest: false }),
  routeMat: new LineMaterial({ color: 0xf2c14e, linewidth: 3, dashed: true, dashSize: 0.005, gapSize: 0.003, transparent: true, opacity: 1, depthTest: false }),
  /** A smooth line through cells (Catmull-Rom through their inland points). */
  smooth(cells: number[], lift: number): number[] {
    const pts = cells.map((c) => this.at(c, new THREE.Vector3(), lift));
    if (pts.length < 2) return [];
    const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal', 0.5);
    const out: number[] = [];
    for (const v of curve.getPoints(Math.max(2, (pts.length - 1) * 6))) out.push(v.x, v.y, v.z);
    return out;
  },
  line(pos: number[], mat: LineMaterial, order: number) {
    const g = new LineGeometry();
    g.setPositions(pos);
    const l = new Line2(g, mat);
    l.computeLineDistances();
    l.renderOrder = order;
    this.group.add(l);
    return l;
  },
  resize() {
    const r = view.renderer.domElement;
    for (const m of [this.roadMat, this.roadUnder, this.roadFaint, this.routeMat]) m.resolution.set(r.clientWidth, r.clientHeight);
  },
  anchor: new THREE.Object3D(),
  build() {
    view.addToPlanet(this.group);
    this.group.add(this.anchor);
    this.roads();
  },
  inland: null as Float32Array | null,
  /** Where a cell's centre sits, a little above the ground. On a coast, nudged inland: the drawn
   * shore wanders across the hex, and a road along it would otherwise seem to walk on the water. */
  at(c: number, out = new THREE.Vector3(), lift = 0.0016) {
    const w = world!, P = w.grid.centers;
    if (!this.inland) {
      const N = w.grid.count, k = 0.42;
      this.inland = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        let x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
        const nb = w.grid.neighbors[i];
        if (w.water[i] === WATER_LAND && nb.some((n) => w.water[n] !== WATER_LAND)) {
          let sx = 0, sy = 0, sz = 0, n = 0;
          for (const j of nb) if (w.water[j] === WATER_LAND) { sx += P[j * 3]; sy += P[j * 3 + 1]; sz += P[j * 3 + 2]; n++; }
          if (n) { x += (sx / n - x) * k; y += (sy / n - y) * k; z += (sz / n - z) * k; }
        }
        const l = Math.hypot(x, y, z);
        this.inland[i * 3] = x / l; this.inland[i * 3 + 1] = y / l; this.inland[i * 3 + 2] = z / l;
      }
    }
    const I = this.inland;
    return out.set(I[c * 3], I[c * 3 + 1], I[c * 3 + 2]).multiplyScalar(Math.max(surf!.centerH(c), SEA) + lift);
  },
  /** The backbone roads, where both ends are revealed. */
  roads() {
    if (!atlas || !world) return;
    for (const l of this.roadLines) { this.group.remove(l); l.geometry.dispose(); }
    this.roadLines = [];
    this.resize();
    // Each road town to town, as smooth runs over what you've seen: a dashed track on a soft shadow.
    // Where it goes into the fog it carries on one hex, then fades over the next, so you can see
    // which way it leads.
    for (const path of atlas.roadPaths) {
      const n = path.length;
      for (let i = 0; i < n; i++) {
        if (!revealed.has(path[i])) continue;
        let j = i;
        while (j + 1 < n && revealed.has(path[j + 1])) j++;
        const a = Math.max(0, i - 1), b = Math.min(n - 1, j + 1);
        if (b > a) { const pos = this.smooth(path.slice(a, b + 1), 0.0012); this.roadLines.push(this.line(pos, this.roadUnder, 7), this.line(pos, this.roadMat, 8)); }
        // (Faintly over the fog itself, from the last hex you've seen on through the next two.)
        if (i >= 1) this.roadLines.push(this.line(this.smooth(path.slice(Math.max(0, i - 2), i + 1), 0.0012), this.roadFaint, 21));
        if (j + 1 < n) this.roadLines.push(this.line(this.smooth(path.slice(j, j + 3), 0.0012), this.roadFaint, 21));
        i = j;
      }
    }
  },
  route() {
    if (this.routeLine) { this.group.remove(this.routeLine); this.routeLine.geometry.dispose(); this.routeLine = null; }
    if (!save || !save.route.length || !world) return;
    this.resize();
    this.routeLine = this.line(this.smooth([save.cell, ...save.route], 0.0022), this.routeMat, 9);
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
/** The calendar's seasons are home's: they don't flip when the caravan crosses the equator. */
const north = () => !!world && !!save && !!atlas && world.grid.centers[atlas.places[save.home].cell * 3 + 1] >= 0;

/** Someone on the road, offered as you pass: the hex and who. */
let folkOffered: { cell: number; id: string } | null = null;
const FOLK_TEXT: Record<FolkKind, (name: string, home: string) => string> = {
  traders: (n, h) => `Carts on the road ahead: ${n}'s caravan, out of ${h}.`,
  pilgrims: (n, h) => `A file of pilgrims from ${h} on the road ahead, ${n} at the front.`,
  broken: (n, h) => `A cart stopped on the road ahead, a wheel off. Someone from ${h} waves.`,
};
/** What the rules (sim.ts) do to the screen. */
const ui: Ui = {
  toast: (text, ms) => toast(text, ms),
  revealed: (fresh, byTravel) => revealedOnScreen(fresh, byTravel),
  blocked: () => modal,
  halt: () => { speed = 0; },
  changed: () => { hud(); syncBar(); },
  routeChanged: () => marks.route(),
  jobsChanged: () => labels.rebuild(),
  encounter: (e, ctx, quest) => showEncounter(e, ctx, quest),
  arrive(cell, pid) {
    if (!world || !atlas || !save) return;
    follow = marks.dirOfCaravan();
    // A town: into its hex, walking in to the square; its buildings are the menus.
    if (pid >= 0) { openHex(cell); toast(`${atlas.places[pid].name}. Tap the market, the inn or the notice board to go there.`, 6000); }
    // Out in the country with something here to find: into the hex, to look for it.
    else if (g && folkHere(g, cell).length) { openHex(cell); toast('Arrived. Someone else is on the road here.', 5000); }
    else if (findsIn(world, atlas, cell, params.seed).some((k) => findReady(k, save!.finds[`${cell}:${k}`], save!.day))) { openHex(cell); toast('Arrived. There is something to find here: walk the hex.', 5000); }
    else toast('Arrived.');
    syncBar();
  },
  questHex(q) {
    // The band's camp or the old site is somewhere in the hex: into it, to find it on foot.
    follow = marks.dirOfCaravan();
    speed = 0;
    openHex(q.cell!);
    toast(q.kind === 'bounty' ? 'Their camp is somewhere in this hex. Walk out to it.' : 'The old site is somewhere in this hex. Walk out to it.', 6000);
  },
  findUsed: (kind) => hexSend({ type: 'primundi-used', kind }),
  folk(cell, f) {
    // Someone on the road ahead: stop and meet them (in the hex, walking up), or go on.
    if (!atlas) return;
    speed = 0;
    folkOffered = { cell, id: f.id };
    showPanel('encounter', `${head(roadKicker(), esc(FOLK_LABEL[f.kind] + ' on the road'))}<p class="tale">${esc(FOLK_TEXT[f.kind](f.name, atlas.places[f.from].name))}</p>
      <div class="opts">${opt('meet', 'Stop and meet them', 'Into the hex, to walk up to them', '')}${opt('pressOn', 'Go on', '', '')}</div>`, true);
  },
  folkMet: (id) => hexSend({ type: 'primundi-folk-done', id }),
  jobDone: (q) => hexSend({ type: 'primundi-job-done', id: q.id }),
};

function setSpeed(s: number) {
  if (!save || save.over) return;
  if (s > 0 && hexOpen) closeHex();
  if (s > 0 && modal) return;
  speed = s;
  if (s > 0) lastSpeed = save.speed = s;
  syncBar();
}

function advance(dd: number) { if (g) simAdvance(g, dd); }





function plan(to: number) { return g ? simPlan(g, to) : null; }
function travelTo(to: number) {
  if (!save) return;
  if (!g || !setRoute(g, to)) return;
  closePanel();
  hint('clock', 'Time runs while you travel. Pause any time, or go faster.', 'speeds');
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
    const jobPlaces = new Set(save.jobs.map((q) => atlas!.placeAt[questTarget(q, atlas!)]).filter((x) => x >= 0));
    for (const q of save.jobs) {
      if (q.done || q.cell == null) continue;
      const el = document.createElement('div');
      el.className = 'pin';
      el.textContent = q.kind === 'bounty' ? 'Bandits' : q.kind === 'survey' ? 'Survey' : 'Old site';
      box.appendChild(el);
      this.els.push({ cell: q.cell, el });
    }
    for (const p of atlas.places) {
      if (!revealed.has(p.cell)) continue;
      const el = document.createElement('div');
      const job = jobPlaces.has(p.id);
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
/** The cell the caravan last came in from (the hex view walks it in from that side). */
let hexFrame: HTMLIFrameElement | null = null, hexReady = false, hexOpen = false, hexCell = -1, hexPending: string | null = null;
let valleysSent = false;
function hexHash(cell: number) {
  const h = new URLSearchParams();
  for (const k of Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[]) h.set(k, String(params[k]));
  h.set('radius', String(RADIUS_KM));
  h.set('embed', '1');
  h.set('game', '1');
  h.set('cell', String(cell));
  const pid = atlas ? atlas.placeAt[cell] : -1;
  if (pid >= 0) h.set('town', pid === save?.home ? 'home' : 'town');
  const cameFrom = g ? g.from : -1;
  if (cameFrom >= 0 && cameFrom !== cell) h.set('from', String(cameFrom));
  if (save) {
    const jobs = save.jobs.filter((q) => !q.done && q.cell === cell && (q.kind === 'bounty' || q.kind === 'relic'));
    if (jobs.length) h.set('jobs', jobs.map((q) => `${q.kind}~${q.id}`).join('.'));
  }
  if (world && atlas && save) {
    const f = findsIn(world, atlas, cell, params.seed);
    if (f.length) h.set('finds', f.join('.'));
    if (g) { const folk = folkHere(g, cell); if (folk.length) h.set('folk', folk.map((x) => `${x.kind}~${x.id}`).join('.')); }
    const used = f.filter((k) => !findReady(k, save!.finds[`${cell}:${k}`], save!.day));
    if (used.length) h.set('used', used.join('.'));
  }
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
  if (lookLater) { follow = lookLater; lookLater = null; }
  syncBar();
  hint('map', 'The world map. Tap a town or a hex to see it, then Travel here. Roads are a little safer than open country.', undefined, 9000);
}
addEventListener('message', (e) => {
  if (e.origin !== location.origin || !e.data) return;
  if (e.data.type === 'mundi-hex-ready') {
    hexReady = true;
    if (hexPending) { hexSend({ type: 'mundi-hex-open', hash: hexPending }); hexPending = null; }
    sendValleys();
  }
  // The caravan reached something to find in the hex: its card; or came within sight of one.
  if (e.data.type === 'primundi-find' && hexOpen && save && hexCell === save.cell && !modal) showFind(String(e.data.kind) as FindKind);
  if (e.data.type === 'primundi-spotted' && hexOpen && FIND_NAMES[e.data.kind as FindKind]) toast(SPOTTED[e.data.kind as FindKind], 4000);
  // The caravan reached a job's camp or site in the hex.
  if (e.data.type === 'primundi-job' && hexOpen && world && atlas && save && hexCell === save.cell && !modal) {
    const q = save.jobs.find((x) => x.id === e.data.id && !x.done);
    if (q && g && (q.kind === 'bounty' || q.kind === 'relic')) showPending(jobHere(g, q, QUEST_ENCOUNTERS));
  }
  // The caravan walked up to someone on the road.
  if (e.data.type === 'primundi-meet' && hexOpen && g && save && hexCell === save.cell && !modal) {
    const f = folkHere(g, save.cell).find((x) => x.id === e.data.id);
    if (f) showPending(meetFolk(g, f));
  }
  // The caravan reached a building's door in the town's hex: that part of the town.
  if (e.data.type === 'primundi-spot' && hexOpen && atlas && save) {
    const pid = atlas.placeAt[hexCell];
    if (pid >= 0 && hexCell === save.cell && !modal) openTown(pid, String(e.data.tab));
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
// One card at a time, in Mundi's glass (style.css: the hex card, the drawer). Town and journal
// cards dock at the side; the road's cards come up in the middle with the world dimmed behind.
const panel = $('card');
let panelKind = '';
function showPanel(kind: string, html: string, isModal = false) {
  panel.innerHTML = html;
  panel.hidden = false;
  panel.dataset.kind = kind;
  panel.scrollTop = 0;
  panel.classList.remove('in');
  void panel.offsetWidth;
  panel.classList.add('in');
  panelKind = kind;
  modal = isModal;
  document.body.classList.toggle('scene', kind === 'encounter' || kind === 'appoint' || kind === 'over');
  syncBar();
}
function closePanel() {
  const was = panelKind;
  panel.hidden = true;
  panelKind = '';
  // Done with the first building in town: where next.
  if (was === 'town' && save && save.day < 1 && (cargoUsed(save.caravan) > 0 || save.jobs.length)) {
    hint('set-out', 'When you are ready to set out, the globe button opens the world map.', 'b-planet');
  }
  modal = false;
  document.body.classList.remove('scene');
  syncBar();
}
const close = '<button class="x" data-act="close" title="Close">×</button>';
/** A card's head: a small kicker line, the title, a line under it. */
const head = (kicker: string, title: string, sub = '') =>
  `<header class="ch"><div class="kick">${kicker}</div><h2>${title}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}</header>`;
const chips = (xs: string[]) => (xs.length ? `<div class="facts">${xs.map((x) => `<span>${x}</span>`).join('')}</div>` : '');
/** A tappable row: a title and a note on the left, a figure on the right. */
const opt = (act: string, title: string, note = '', right = '', attrs = '', disabled = false) =>
  `<button class="opt" data-act="${act}" ${attrs} ${disabled ? 'disabled' : ''}><span class="ot"><b>${title}</b>${note ? `<small>${note}</small>` : ''}</span>${right ? `<span class="or">${right}</span>` : ''}</button>`;
const ORREL = '<i class="orrel"></i>';

function showHexCard(c: number) {
  if (!world || !atlas || !save) return;
  const w = world;
  if (!revealed.has(c)) {
    const edge = frontier().includes(c);
    const p = plan(c);
    showPanel('hex', `${close}${head('The storm', 'Unknown country', edge ? 'The edge of what you know' : 'Nobody you know has been there')}
      <p>${edge ? 'Beyond the last hex you have seen, the cloud sits on the ground. Anything could be under it.' : 'Deep in the storm. You can head that way, and find out what lies between as you go.'}</p>
      ${p ? `<p class="dim">Perhaps ${daysText(p.days)}, if the going is fair.</p><button class="go" data-act="travel" data-cell="${c}">Head into the storm</button>` : '<p class="dim">No way there that you can find.</p>'}`);
    return;
  }
  const pid = atlas.placeAt[c], place = pid >= 0 ? atlas.places[pid] : null;
  const about = describeHex(w, game, undefined, c, RADIUS_KM);
  const here = c === save.cell;
  const p = here ? null : plan(c);
  const known = place ? save.known[place.id] : undefined;
  const facts = [...(place ? [`${fmt(place.pop)} people`] : []), ...(atlas.road[c] ? ['road'] : []), ...about.facts.slice(0, 2)];
  if (place && !here) facts.push(known ? `prices from ${agoText(save.day - known.day)}` : 'prices unknown');
  showPanel('hex', `${close}${head(place ? `${place.town ? 'Town' : 'Village'}${place.realm ? ` · ${esc(place.realm)}` : ''}` : about.where || 'Hex',
      place ? esc(place.name) : about.title, place ? about.title + (place.id === save.home ? ' · <b>your home</b>' : '') : here ? 'You are here' : '')}
    <p>${about.text}</p>${chips(facts)}
    ${findHints(c)}
    ${save.jobs.filter((q) => questTarget(q, atlas!) === c).map((q) => `<p class="note">◆ ${esc(questTitle(q, atlas!))} · ${esc(questStatus(q, atlas!, save!.caravan.cargo))}</p>`).join('')}
    ${here ? `${place ? `<button class="go" data-act="town">Enter ${esc(place.name)}</button>` : ''}<button class="ghost" data-act="look">Look around</button>`
      : p ? `<button class="go" data-act="travel" data-cell="${c}">Travel here<span>${p.guess ? 'perhaps ' : ''}${daysText(p.days)}</span></button>` : '<p class="dim">No way there that you know of.</p>'}`);
}
/** What can be made out of a hex's finds from a distance: reasons to walk into it. */
function findHints(c: number): string {
  if (!world || !atlas || !save) return '';
  const HINT: Record<FindKind, string> = {
    lookout: 'High ground: you could see a long way from the top.',
    spring: 'A line of green in dry country: water, perhaps.',
    forage: 'Game sign, and thickets in fruit.',
    ruin: 'Something old stands out there.',
    camp: 'Smoke stains on a rock: someone camped here once.',
  };
  const s = save;
  const open = findsIn(world, atlas, c, params.seed).filter((k) => findReady(k, s.finds[`${c}:${k}`], s.day));
  return open.map((k) => `<p class="note">◇ ${HINT[k]}</p>`).join('');
}
const daysText = (d: number) => (d < 1 ? 'under a day' : d < 1.5 ? 'a day' : `${Math.round(d)} days`);
const agoText = (d: number) => (d < 1 ? 'today' : d < 2 ? 'yesterday' : `${Math.floor(d)} days ago`);

// The town: market, supplies, work, rest. Bannerlord's menu, over the town's own hex.
let townTab = 'market';
/** What each part of a town is, walking it. */
const BUILDING: Record<string, string> = { market: 'The market', supplies: 'The stores', work: 'The notice board', tavern: 'The tavern', rest: 'The inn' };
function openTown(pid: number, tab = townTab) {
  if (!world || !atlas || !save) return;
  townTab = tab;
  const w = world, a = atlas, s = save, c = s.caravan, p = a.places[pid];
  const day = s.day, doy = doyOf(day);
  const q = quotes(w, p, s.stocks, day, doy);
  remember(s.known, p, q, Math.floor(day));
  const home = p.id === s.home;
  const due = s.jobs.filter((x) => canHandIn(x, p.id, c.cargo)).length;
  const tabs = [['market', 'Market'], ['supplies', 'Supplies'], ['work', due ? `Work · ${due}` : 'Work'], ['tavern', 'Tavern'], ['rest', home ? 'Home' : 'Inn']];
  const purse = chips([`${ORREL}${fmt(c.orrels)}`, `${cargoUsed(c)} of ${c.capacity} loads`]);
  let body = '';
  if (tab === 'market') {
    const short = shortHere(g!, p.id);
    body = `${purse}<div class="mkt">
      ${GOODS.map((g, i) => {
        const best = bestKnownSell(a, s.known, i, p.id);
        const here = q[i].buy || q[i].sell;
        const better = best && best.price > here;
        const k = q[i].buy ? q[i].buy / g.base : 1;
        const hint = k < 0.7 ? '<em class="cheap">cheap here</em>' : k > 1.4 ? '<em class="dear">dear here</em>' : '';
        const buyable = !short.has(i) && q[i].buy && q[i].stock >= 1 && c.orrels >= q[i].buy && cargoUsed(c) < c.capacity;
        return `<div class="mrow${c.cargo[i] ? ' held' : ''}">
          <div class="g"><b>${g.name}</b>${hint}${better ? `<small class="up">fetches ${best!.price} in ${esc(best!.place.name)}, ${agoText(day - best!.day)}</small>` : ''}</div>
          <button class="sell" data-act="sell" data-g="${i}" ${c.cargo[i] < 1 ? 'disabled' : ''} title="Sell one (shift: five)"><span>sell</span>${q[i].sell}</button>
          <span class="have" title="You carry">${c.cargo[i] || '·'}</span>
          ${short.has(i) ? '<span class="nobuy" title="Wanted on the notice board: there is none to be had here">none to be had</span>' : q[i].buy ? `<button class="buy" data-act="buy" data-g="${i}" ${buyable ? '' : 'disabled'} title="Buy one (shift: five)"><span>buy</span>${q[i].buy}</button>` : '<span class="nobuy">not sold</span>'}
        </div>`;
      }).join('')}</div>
      <p class="dim small">Prices move as you trade and settle back over a fortnight. Shift-click trades five.</p>`;
  } else if (tab === 'supplies') {
    const rp = rationPrice(w, p, s.stocks, day, doy), eat = appetite(c);
    const rd = c.rations / Math.max(1, eat);
    const chart = Math.round(c.unsoldCharts * chartRate(g!, p));
    body = `${purse}<h3>Provisions</h3>
      <p>Food for <b>${Math.floor(rd)} days</b>. The skins are filled at the well, free: ${Math.floor(waterCap(c) / Math.max(1, thirst(c)))} days of water.</p>
      <div class="opts">${[5, 10, 20].map((d) => { const cost = Math.ceil(rp * eat * d); return opt('rations', `${d} days of food`, `for ${living(c).length} people`, `${ORREL}${cost}`, `data-n="${d}"`, c.orrels < cost); }).join('')}</div>
      <h3>Charts</h3>
      ${c.unsoldCharts ? `<p>You have mapped ${fmt(c.unsoldCharts)} hexes nobody here has seen drawn.</p><div class="opts">${opt('charts', 'Sell your charts', `${p.town ? 'A town pays well' : 'A village pays half'}`, `${ORREL}${fmt(chart)}`)}</div>`
        : '<p class="dim">Nothing new to sell. Every hex you uncover on the road is worth something here.</p>'}`;
  } else if (tab === 'work') {
    const handIn = s.jobs.filter((x) => canHandIn(x, p.id, c.cargo));
    const offers = jobsOffered(g!, p);
    const dir = (cell: number) => bearing(w, p.cell, cell);
    body = `${handIn.length ? `<h3>To hand in</h3>${handIn.map((q) => `<div class="job-card due"><b>${esc(questTitle(q, a))}</b><small>for ${esc(q.giver)}</small>
        <button class="go" data-act="handin" data-q="${q.id}">Hand it in<span>${q.reward} orrels</span></button></div>`).join('')}` : ''}
      ${hexOpen ? '' : '<h3>The notice board</h3>'}
      ${offers.length ? offers.map((q) => `<div class="job-card"><blockquote>${esc(questPitch(q, a, dir))}<cite>${esc(q.giver)}</cite></blockquote>
        <div class="job-foot"><span>${q.reward} orrels${q.kind === 'deliver' ? ' on delivery' : ''}</span>
        <button class="go" data-act="take" data-q="${q.id}" ${s.jobs.length >= MAX_QUESTS ? 'disabled' : ''}>Take it</button></div></div>`).join('')
        : `<p class="dim">Nothing else posted in ${esc(p.name)} this month.</p>`}
      ${s.jobs.length ? `<p class="dim small">You hold ${s.jobs.length} of ${MAX_QUESTS} jobs. The journal lists them.</p>` : ''}`;
  } else if (tab === 'tavern') {
    const mapped = s.maps.includes(p.id), mapCost = p.town ? 40 : 25;
    body = `${purse}<h3>Talk</h3>
      <div class="opts">${opt('round', 'Stand a round', 'Someone always knows of a place you don\'t', `${ORREL}8`, '', c.orrels < 8)}
      ${opt('localmap', 'Buy a map of the country round', mapped ? 'You have it' : 'Four days\' walk in every direction', `${ORREL}${mapCost}`, `data-n="${mapCost}"`, mapped || c.orrels < mapCost)}</div>
      <h3>${esc(p.name)} remembers</h3>
      ${p.story.length ? `<ul class="log">${p.story.slice(-4).reverse().map((x) => { const i = x.indexOf(': '); return `<li><span>Year ${x.slice(0, i)}</span>${esc(x.slice(i + 2))}</li>`; }).join('')}</ul>` : '<p class="dim">Nothing anyone tells twice.</p>'}`;
  } else {
    const cost = home ? 0 : living(c).length;
    const hires: [Role, number, string][] = [['hand', 30, 'Carries, cooks, keeps watch'], ['guard', 55, 'Fights when it comes to it'], ...(p.town ? [['scout', 70, 'Sees a hex further'] as [Role, number, string]] : [])];
    body = `${purse}${hexOpen ? '' : `<h3>${home ? 'Home' : 'The inn'}</h3>`}
      <p>${home ? 'Your own people put you up. Resting here costs nothing.' : `A yard for the beasts and a roof for the people, ${cost} orrels a night.`} Rest mends the hurt and lifts spirits.</p>
      <div class="opts">${opt('rest', 'Rest a day', '', home ? 'free' : `${ORREL}${cost}`, 'data-n="1"', c.orrels < cost)}${opt('rest', 'Rest three days', '', home ? 'free' : `${ORREL}${cost * 3}`, 'data-n="3"', c.orrels < cost * 3)}</div>
      <h3>Hire</h3>
      ${living(c).length >= 9 ? '<p class="dim">The caravan is as big as it can feed.</p>' : `<div class="opts">${hires.map(([r, o, note]) => opt('hire', `A ${ROLE_NAMES[r].toLowerCase()}`, note, `${ORREL}${o}`, `data-role="${r}" data-n="${o}"`, c.orrels < o)).join('')}</div>`}
      <h3>Beasts</h3>
      <div class="opts">${opt('beast', 'A pack beast', 'Carries four more loads', `${ORREL}45`, '', c.orrels < 45)}</div>`;
  }
  // Walking the town's hex, each building is its own card: you go to the market for the market.
  // (The whole card with its tabs is still here for when there's no hex view open.)
  if (hexOpen) {
    const where = BUILDING[tab] ?? tab;
    showPanel('town', `${close}${head(`${esc(p.name)}${home ? ' · your home' : ''}`, tab === 'rest' && home ? 'Home' : where)}
      ${tab === 'tavern' ? `<p class="about">${townCharacter(p)}</p>` : ''}
      <div class="tab-body">${body}</div>`);
  } else showPanel('town', `${close}${head(`${p.town ? 'Town' : 'Village'}${p.realm ? ` · ${esc(p.realm)}` : ''}`, esc(p.name), `${fmt(p.pop)} people${home ? ' · <b>your home</b>' : ''}`)}
    <p class="about">${townCharacter(p)}</p>
    <nav class="tabs">${tabs.map(([k, l]) => `<button data-act="tab" data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</nav>
    <div class="tab-body">${body}</div>`);
  panel.dataset.pid = String(pid);
  hud();
}


/** A line of who a place is: where it sits, what it's known for, where it came from. */
function townCharacter(p: Place): string {
  if (!world || !atlas || !game) return '';
  const w = world, c = p.cell, nb = w.grid.neighbors[c];
  const coast = nb.some((n) => w.water[n] === 1), river = !!w.river[c], lake = nb.some((n) => w.water[n] === 2);
  const high = w.elevation[c] > 0.3;
  const kind = p.capital ? 'the seat of its realm' : p.pop > 6000 ? 'a city' : p.town ? 'a market town' : p.pop < 300 ? 'a hamlet' : 'a village';
  const where = coast ? (river ? 'where a river meets the sea' : 'on the coast') : lake ? 'on a lakeshore' : river ? 'on a river' : high ? 'up in the hills' : `in the ${BIOMES[w.biome[c]].name.toLowerCase()}`;
  // Known for: whatever is cheapest here against its usual price.
  let best = -1, bk = 0.8;
  for (let g = 0; g < GOODS.length - 1; g++) { const k = p.price[g] / GOODS[g].base; if (k < bk) { bk = k; best = g; } }
  const known = best >= 0 ? `, known for its ${GOODS[best].name.toLowerCase()}` : '';
  const origin = p.parent ? ` Settled from ${esc(p.parent)} in year ${p.founded}.` : p.founded <= 200 ? ' One of the first places people settled.' : ` Founded in year ${p.founded}.`;
  return `${kind[0].toUpperCase() + kind.slice(1)} ${where}${known}.${origin}`;
}

// The road: a card in the middle, the world dimmed behind it.
function roadKicker() {
  if (!world || !save) return 'On the road';
  return `On the road · ${BIOMES[world.biome[save.cell]].name} · ${dateText(save.day, north())}`;
}
const SPOTTED: Record<FindKind, string> = {
  lookout: 'High ground: a cairn on the top.', spring: 'You spot a spring.', forage: 'Berries and a game trail nearby.',
  ruin: 'Old stones, through the trees: ruins.', camp: 'Someone camped here once.',
};
function showFind(kind: FindKind) {
  if (!g) return;
  const p = findHere(g, kind);
  if (!p) { toast(kind === 'spring' ? 'You drew from it lately. It needs a few days.' : 'Nothing more here for now.'); return; }
  showPending(p);
}
function showEncounter(e: Encounter, ctx: Ctx, quest?: string) { showPending(pending(e, ctx, quest)); }
function showPending(p: Pending) {
  speed = 0;
  showPanel('encounter', `${head(roadKicker(), esc(p.e.title))}<p class="tale">${esc(p.e.text(p.ctx))}</p>
    <div class="opts">${p.choices.map((ch, i) => opt('choose', esc(ch.label), ch.hint ? esc(ch.hint) : '', '', `data-i="${i}"`)).join('')}</div>`, true);
  pendingChoices = p;
}
let pendingChoices: Pending | null = null;
/** What changed, as chips: good news green, bad news red. */
function fxChips(lines: string[]) {
  if (!lines.length) return '';
  const bad = /^−|hurt|sick|dead|lost|down/;
  return `<div class="facts fx">${lines.map((l) => `<span class="${bad.test(l) ? 'bad' : l.startsWith('+') || /up|joins|mapped|job done/.test(l) ? 'good' : ''}">${esc(l)}</span>`).join('')}</div>`;
}
function choose(i: number) {
  if (!pendingChoices || !g) return;
  const p = pendingChoices;
  pendingChoices = null;
  const { out, lines, extra } = resolve(g, p, i);
  showPanel('encounter', `${head(roadKicker(), esc(p.e.title))}<p class="tale">${esc(out.text)}</p>${extra ? `<p>${esc(extra)}</p>` : ''}
    ${fxChips(lines)}<button class="go" data-act="after">Go on</button>`, true);
  hud();
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
  showPanel('appoint', `${head('The caravan', 'Who leads now?', dead ? `${esc(dead.name)} is dead` : '')}
    <p class="tale">The caravan stands about in the road. Someone has to say which way.</p>
    <div class="opts">${c.members.map((m, i) => m.alive ? opt('appoint', esc(m.name), `${ROLE_NAMES[m.role]} · ${TRAITS[m.trait]}`, '', `data-i="${i}"`) : '').join('')}</div>`, true);
}
function gameOver() {
  if (!save) return;
  save.over = true;
  speed = 0;
  store();
  showPanel('over', `${head(dateText(save.day, north()), 'The road ends')}<p class="tale">Nobody is left of ${esc(save.caravan.name)}. The storm closes over the way you came.</p>
    ${chips([`${fmt(save.charted)} hexes charted`, `${save.jobsDone} jobs done`, `${fmt(save.caravan.earned)} orrels earned`])}
    <button class="go" data-act="menu">Begin again</button>`, true);
}

let journalTab = 'work';
function showJournal(tab = journalTab) {
  if (!save || !atlas || !world) return;
  journalTab = tab;
  const s = save, c = s.caravan, a = atlas, w = world, o = ORIGINS.find((x) => x.id === c.origin)!;
  const prog = c.origin === 'traders' ? c.earned : s.charted, goal = AMBITION_GOAL[c.origin];
  const mood = c.morale > 70 ? 'in good heart' : c.morale > 40 ? 'steady' : c.morale > 20 ? 'low' : 'close to giving up';
  const tabs = [['work', s.jobs.length ? `Work · ${s.jobs.length}` : 'Work'], ['caravan', 'Caravan'], ['story', 'Story']];
  let body = '';
  if (tab === 'work') {
    body = `<h3>Ambition</h3>
      <p>${o.ambition}${prog >= goal ? ': <b>done</b>. The road goes on.' : ''}</p>
      <div class="meter"><i style="width:${Math.min(100, (prog / goal) * 100)}%"></i></div>
      <p class="dim small">${fmt(Math.min(prog, goal))} of ${fmt(goal)}. A direction, not a rule.</p>
      <h3>Jobs · ${s.jobs.length} of ${MAX_QUESTS}</h3>
      ${s.jobs.length ? s.jobs.map((q) => {
        const t = questTarget(q, a), p = plan(t);
        const where = t === s.cell ? 'here' : `${p ? `${p.guess ? 'perhaps ' : ''}${daysText(p.days)}` : 'no known way'} ${bearing(w, s.cell, t)}`;
        const ready = a.placeAt[s.cell] >= 0 && canHandIn(q, a.placeAt[s.cell], c.cargo);
        return `<div class="job-card${q.done || ready ? ' due' : ''}"><b>${esc(questTitle(q, a))}</b>
          <small>${esc(questStatus(q, a, c.cargo))} · ${where} · ${q.reward} orrels · for ${esc(q.giver)} of ${esc(a.places[q.from].name)}</small>
          <div class="job-foot"><button class="ghost" data-act="giveup" data-q="${q.id}">Give up</button>
          ${t !== s.cell && p ? `<button class="go" data-act="course" data-q="${q.id}">Set out</button>` : ''}</div></div>`;
      }).join('') : '<p class="dim">No jobs in hand. Town notice boards have work.</p>'}`;
  } else if (tab === 'caravan') {
    body = `<p class="dim small">${living(c).length} people, ${mood}. ${cargoUsed(c)} of ${c.capacity} loads carried.</p>
      <ul class="people">${c.members.filter((m) => m.alive).map((m) => `<li><span class="who"><b>${esc(m.name)}</b><small>${TRAITS[m.trait]}</small></span><span class="role${m.role === 'leader' ? ' lead' : ''}">${ROLE_NAMES[m.role]}</span>${m.health !== 'well' ? `<span class="hp">${m.health}</span>` : ''}</li>`).join('')}</ul>
      ${c.members.some((m) => !m.alive) ? `<p class="dim small">Lost on the road: ${c.members.filter((m) => !m.alive).map((m) => esc(m.name)).join(', ')}.</p>` : ''}
      ${c.cargo.some((x) => x) ? `<h3>Cargo</h3>${chips(c.cargo.map((n, g) => (n ? `${n} ${GOODS[g].name.toLowerCase()}` : '')).filter(Boolean))}` : ''}`;
  } else {
    body = `<ul class="log">${s.log.slice(-40).reverse().map((l) => `<li><span>${dateText(l.day, north())}</span>${esc(l.text)}</li>`).join('')}</ul>`;
  }
  showPanel('journal', `${close}${head(`Journal · ${o.label}`, esc(c.name), `From ${esc(a.places[s.home].name)} · ${dateText(s.day, north())}`)}
    <nav class="tabs">${tabs.map(([k, l]) => `<button data-act="jtab" data-tab="${k}" class="${k === tab ? 'on' : ''}">${l}</button>`).join('')}</nav>
    <div class="tab-body">${body}</div>`);
}

panel.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  if (!b || !save || !world || !atlas) return;
  const s = save, act = b.dataset.act, pid = Number(panel.dataset.pid);
  const many = (e as MouseEvent).shiftKey ? 5 : 1;
  switch (act) {
    case 'close': closePanel(); break;
    case 'travel': travelTo(Number(b.dataset.cell)); break;
    case 'look': closePanel(); openHex(s.cell); break;
    // Into the town's hex, to walk to what you want there.
    case 'town': if (atlas.placeAt[s.cell] >= 0) { closePanel(); openHex(s.cell); } break;
    case 'tab': openTown(pid, b.dataset.tab); break;
    case 'buy': case 'sell': {
      const gi = Number(b.dataset.g);
      if (act === 'buy') simBuy(g!, pid, gi, many); else simSell(g!, pid, gi, many);
      openTown(pid, 'market');
      if (act === 'buy') hint('hud', `Bought. ${HUD_KEY} Tap it any time for a reminder.`, 'hud');
      store();
      break;
    }
    case 'rations': if (buyRations(g!, pid, Number(b.dataset.n))) { openTown(pid, 'supplies'); store(); } break;
    case 'charts': sellCharts(g!, pid); openTown(pid, 'supplies'); store(); break;
    case 'take': if (takeJob(g!, pid, b.dataset.q ?? '')) { openTown(pid, 'work'); store(); } break;
    case 'handin': if (handIn(g!, pid, b.dataset.q ?? '')) { openTown(pid, 'work'); store(); } break;
    case 'giveup': {
      const q = s.jobs.find((x) => x.id === b.dataset.q);
      if (!q || !confirm(`Give up "${questTitle(q, atlas)}"?`)) break;
      giveUp(g!, q.id);
      showJournal('work');
      store();
      break;
    }
    case 'course': {
      const q = s.jobs.find((x) => x.id === b.dataset.q);
      if (q) travelTo(questTarget(q, atlas));
      break;
    }
    case 'jtab': showJournal(b.dataset.tab); break;
    case 'round': { const r = standRound(g!); if (r) { toast(r, 6000); openTown(pid, 'tavern'); store(); } break; }
    case 'localmap': {
      const got = buyMap(g!, pid);
      if (got < 0) break;
      toast(`The map shows ${got} hexes you hadn't seen.`);
      openTown(pid, 'tavern');
      store();
      break;
    }
    case 'rest': {
      const n = Number(b.dataset.n);
      if (!simRest(g!, pid, n)) break;
      toast(`${n === 1 ? 'A day' : `${n} days`} of rest.`);
      openTown(pid, 'rest');
      store();
      break;
    }
    case 'hire': if (hire(g!, pid, b.dataset.role as Role, Number(b.dataset.n))) { openTown(pid, 'rest'); store(); } break;
    case 'beast': if (buyBeast(g!)) { openTown(pid, 'rest'); store(); } break;
    case 'choose': choose(Number(b.dataset.i)); break;
    case 'after': afterEncounter(); break;
    case 'meet': if (folkOffered) { const c0 = folkOffered.cell; folkOffered = null; closePanel(); openHex(c0); toast('Walk up to them: tap their label.', 5000); } break;
    case 'pressOn': if (folkOffered) { passFolk(g!, folkOffered.id); folkOffered = null; } afterEncounter(); break;
    case 'appoint': {
      appoint(g!, Number(b.dataset.i));
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
  // The Town button (the whole card at once) is off for now: you walk to each building in the hex.
  $('b-town').hidden = true;
  $('b-stop').hidden = !save?.route.length;
  document.body.classList.toggle('in-hex', hexOpen);
}
$('hud').onclick = () => toast(HUD_KEY, 6000);
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

/** A first-time hint: once per game, a toast and a pulse on the thing it's about. */
function hint(id: string, text: string, target?: string, ms = 8000) {
  if (!save) return;
  save.hints ??= [];
  if (save.hints.includes(id)) return;
  save.hints.push(id);
  toast(text, ms);
  if (target) {
    const el = document.getElementById(target);
    if (el) { el.classList.add('pm-pulse'); setTimeout(() => el.classList.remove('pm-pulse'), ms); }
  }
  store();
}
/** What the readouts along the top are. */
const HUD_KEY = 'Up top: orrels, days of water, days of food, loads carried of what the beasts can take, and people.';

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
  view, thunder, bounds,
  get world() { return world; },
  get atlas() { return atlas; },
  get save() { return save; },
  get fog() { return fog; },
  get speed() { return speed; },
  reveal: (cells: number[]) => reveal(cells),
  revealRing: () => reveal(frontier()),
  travelTo, setSpeed, advance, openTown, openHex, closeHex, plan,
  /** What there is to find in a hex (finds.ts). */
  findsIn: (c: number) => (world && atlas ? findsIn(world, atlas, c, params.seed) : []),
  /** Others on the road in a hex this week, not yet met (life.ts). */
  folkHere: (c: number) => (g ? folkHere(g, c) : []),
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
addEventListener('resize', () => marks.resize());
