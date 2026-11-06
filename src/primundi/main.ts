/**
 * Primundi: Mundi as a game (primundi.html, primundi.bill.computer). You start on one hex of a
 * world hidden under storm, in the hex view; the planet shows only what you have uncovered, and
 * the camera stays near it. Turn-based. Saved in the browser.
 *
 * First build (2026-11-06): launch screen, the start, the fog, the bar, and a debug Reveal so the
 * map can be grown by hand before any real mechanic does it.
 */
import * as THREE from 'three';
import { PlanetView, DEFAULT_VIEW, type ViewOptions } from '../render.ts';
import { DEFAULT_PARAMS, WATER_LAND, type World, type WorldParams } from '../world.ts';
import { BIOMES } from '../biomes.ts';
import type { BuildRequest, BuildResult, BuildStage } from '../worker.ts';
import type { HistoryRequest, HistoryResult } from '../historyWorker.ts';
import type { History } from '../civ.ts';
import { gameData, nameMaker, type GameData } from '../gamedata.ts';
import { NAME_DECIDES, paramsOf } from '../namedworld.ts';
import { nameSeed, parseSeed, randomName } from '../seedname.ts';
import { surfaceQueries } from '../surface.ts';
import { mountLoader, type Loader } from '../loader.ts';
import { PlanetFog } from './fog.ts';
import { flicker } from './hexfog.ts';
import { Thunder } from './thunder.ts';
import { pickStart, BIASES, type StartBias } from './start.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const RADIUS_KM = 640;

// --- The save ---------------------------------------------------------------------------------
interface Save {
  v: 1;
  /** The world's name (its seed), as typed or rolled. */
  world: string;
  civ: string;
  bias: StartBias;
  start: number;
  revealed: number[];
  turn: number;
}
const SAVE_KEY = 'primundi.save';
function loadSave(): Save | null {
  try {
    const s = JSON.parse(localStorage.getItem(SAVE_KEY) ?? 'null') as Save | null;
    return s && s.v === 1 && typeof s.world === 'string' ? s : null;
  } catch { return null; }
}
let save: Save | null = null;
function store() { if (save) localStorage.setItem(SAVE_KEY, JSON.stringify(save)); }

const paramsFor = (name: string): WorldParams => {
  const p = parseSeed(name);
  const seed = p ? p.seed : nameSeed(name);
  return p?.name && NAME_DECIDES ? { ...paramsOf(p.name), seed } : { ...DEFAULT_PARAMS, seed };
};

// --- The launch screen ------------------------------------------------------------------------
const thunder = new Thunder();
function showLaunch() {
  const prev = loadSave();
  const el = $('launch');
  el.hidden = false;
  const civDefault = nameMaker(Date.now() % 100000)();
  el.innerHTML = `
    <form class="card" autocomplete="off">
      <h1>Primundi</h1>
      <p class="tag">A world under storm. Settle, push out, learn its shape.</p>
      ${prev ? `<button type="button" class="go" id="continue">Continue ${esc(prev.civ)} <span>on ${esc(prev.world)}, turn ${prev.turn}</span></button>
      <div class="or">or begin again</div>` : ''}
      <fieldset><legend>Your people</legend>
        <input id="civ" type="text" maxlength="24" spellcheck="false" value="${esc(civDefault)}" />
      </fieldset>
      <fieldset><legend>World</legend>
        <span class="seed"><input id="seed" type="text" maxlength="40" spellcheck="false" placeholder="random" title="A name (letters) or a number: the same seed always makes the same world and start" />
        <button type="button" id="dice" title="Roll a world">⚄</button></span>
      </fieldset>
      <fieldset><legend>Start</legend>
        ${BIASES.map((b) => `<label class="bias"><input type="radio" name="bias" value="${b.id}" ${b.id === (prev?.bias ?? 'any') ? 'checked' : ''} /> ${b.label} <span>${b.note}</span></label>`).join('')}
      </fieldset>
      <button type="submit" class="go" id="begin">Begin</button>
    </form>`;
  $('dice').onclick = () => { $<HTMLInputElement>('seed').value = randomName(); };
  el.querySelector('form')!.onsubmit = (e) => {
    e.preventDefault();
    thunder.unlock();
    const typed = $<HTMLInputElement>('seed').value.trim();
    const bias = (el.querySelector<HTMLInputElement>('input[name=bias]:checked')?.value ?? 'any') as StartBias;
    save = { v: 1, world: typed || randomName(), civ: $<HTMLInputElement>('civ').value.trim() || civDefault, bias, start: -1, revealed: [], turn: 1 };
    store();
    begin();
  };
  if (prev) $('continue').onclick = () => { thunder.unlock(); save = prev; begin(); };
}
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// --- The world --------------------------------------------------------------------------------
const view = new PlanetView($('view'));
const viewOpts: ViewOptions = { ...DEFAULT_VIEW };
view.setOptions(viewOpts);
view.setRunning(false);
// More map than horizon: the horizon is all storm anyway.
view.tiltScale = 0.45;
let params: WorldParams = { ...DEFAULT_PARAMS };
let world: World | null = null;
let game: GameData | null = null;
let fog: PlanetFog | null = null;
let history: History | null = null;
const revealed = new Set<number>();
let loader: Loader | null = null;

const worker = new Worker(new URL('../worker.ts', import.meta.url), { type: 'module' });
worker.onmessage = (e: MessageEvent<BuildResult | BuildStage>) => {
  if ('stage' in e.data) { loader?.step(e.data.stage); return; }
  const r = e.data;
  if (!r.world) return;
  if (r.clouds) view.setClouds(r.clouds);
  started(r.world, r);
};

function begin() {
  $('launch').hidden = true;
  params = paramsFor(save!.world);
  loader = mountLoader(save!.world, `${save!.civ} · turn ${save!.turn}`);
  const word = document.querySelector('.loader .ld-word');
  if (word) word.textContent = 'PRIMUNDI';
  view.setRunning(true);
  const { mode, style, relief, blend, trees } = viewOpts;
  worker.postMessage({ id: 1, params: { ...params }, opts: { mode, style, relief, blend, trees }, clouds: true } satisfies BuildRequest);
  loadHistory();
}

function started(w: World, r: BuildResult) {
  world = w;
  game = gameData(w);
  const s = save!;
  if (s.start < 0) {
    s.start = pickStart(w, game, s.bias, params.seed);
    s.revealed = [s.start, ...w.grid.neighbors[s.start]];
    store();
  }
  // The fog goes in before the world is drawn, so its shader compiles with the planet's.
  fog = new PlanetFog(w, surfaceQueries(r.surface, w.grid));
  view.addToPlanet(fog.mesh);
  for (const c of s.revealed) revealed.add(c);
  fog.reveal(revealed, true);
  view.setData(w, r.surface);
  bounds.update(true);
  // Over the start, looking down at it.
  const P = w.grid.centers, c = s.start;
  view.camera.position.set(P[c * 3], P[c * 3 + 1], P[c * 3 + 2]).multiplyScalar(1 + (bounds.maxD - 1) * 0.85);
  view.camera.lookAt(0, 0, 0);
  syncBar();
  // Straight down into the start hex; the planet's shaders go on compiling behind it.
  const l = loader!;
  loader = null;
  void l.finish();
  openHex(s.start);
  labels.rebuild();
}

// Other peoples, from the history (civ.ts): its hearths, placed in the fog. Rudimentary for now.
let historyWorker: Worker | null = null;
function loadHistory() {
  historyWorker ??= new Worker(new URL('../historyWorker.ts', import.meta.url), { type: 'module' });
  historyWorker.onmessage = (e: MessageEvent<HistoryResult>) => { history = e.data.history; labels.rebuild(); };
  historyWorker.postMessage({ id: 1, params: { ...params } } satisfies HistoryRequest);
}

// --- Revealing --------------------------------------------------------------------------------
function reveal(cells: number[]) {
  const fresh = cells.filter((c) => !revealed.has(c) && world && c >= 0 && c < world.grid.count);
  if (!fresh.length || !fog) return;
  for (const c of fresh) revealed.add(c);
  fog.reveal(fresh);
  save!.revealed = [...revealed];
  store();
  bounds.update(false);
  labels.rebuild();
  if (hexOpen) hexSend({ type: 'primundi-seen', cells: fresh });
}
/** Fogged cells touching what is revealed. */
function frontier(): number[] {
  if (!world) return [];
  const out = new Set<number>();
  for (const c of revealed) for (const n of world.grid.neighbors[c]) if (!revealed.has(n)) out.add(n);
  return [...out];
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
    const cellA = Math.sqrt((4 * Math.PI) / world.grid.count);
    this.goalAngle = a + cellA * 0.5;
    // Field of view 40°: a height h sees about 0.36 h either side of the middle; the tilt shows more.
    this.goalD = 1 + Math.max(0.07, (a + cellA * 1.2) * 2.6);
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
view.constrain = (pos) => {
  if (!world) return;
  const d = pos.length();
  const nd = Math.min(d, bounds.maxD);
  tmp.copy(pos).divideScalar(d);
  const a = tmp.angleTo(bounds.centre);
  if (a > bounds.angle) {
    axis.crossVectors(bounds.centre, tmp);
    if (axis.lengthSq() < 1e-12) axis.set(0, 1, 0);
    tmp.copy(bounds.centre).applyAxisAngle(axis.normalize(), bounds.angle);
  }
  pos.copy(tmp).multiplyScalar(nd);
};

// --- Lightning and thunder along the fog's edge -----------------------------------------------
const storm = { next: 2.5, t: -1, dir: new THREE.Vector3() };
view.onFrame.push((dt, _d, sun, time) => {
  if (!fog || !world) return;
  bounds.step(dt);
  fog.update(view.camera.position, sun, dt, time);
  storm.next -= dt;
  if (storm.next <= 0) {
    storm.next = 6 + Math.random() * 14;
    const edge = frontier();
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
  labels.place();
});

// --- Labels: your settlement, and peoples you have found --------------------------------------
const labels = {
  els: [] as { cell: number; el: HTMLElement }[],
  rebuild() {
    const box = $('labels');
    box.innerHTML = '';
    this.els = [];
    if (!world || !save) return;
    const add = (cell: number, text: string, cls: string) => {
      const el = document.createElement('div');
      el.className = `lbl ${cls}`;
      el.textContent = text;
      box.appendChild(el);
      this.els.push({ cell, el });
    };
    add(save.start, save.civ, 'own');
    if (history) {
      for (const s of history.settlements) {
        if (s.parent >= 0 || !revealed.has(s.cell) || s.cell === save.start) continue;
        add(s.cell, s.name, 'other');
      }
    }
  },
  place() {
    for (const { cell, el } of this.els) {
      const p = view.screenOf(cell);
      if (!p || !p.front) { el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -140%)`;
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
  // The revealed cells near it (the backdrop reaches a few rings out).
  const near = new Set([cell]);
  let ring = [cell];
  for (let r = 0; r < 4 && world; r++) {
    const next: number[] = [];
    for (const c of ring) for (const n of world.grid.neighbors[c]) if (!near.has(n)) { near.add(n); next.push(n); }
    ring = next;
  }
  h.set('seen', [...near].filter((c) => revealed.has(c)).join('.'));
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
let selected = -1, revealArmed = false;
view.renderer.domElement.addEventListener('pointermove', (e) => {
  if (e.buttons || !world || e.pointerType === 'touch') { info.hidden = true; return; }
  const c = view.pick(e.clientX, e.clientY);
  if (c < 0) { info.hidden = true; view.highlight(selected); return; }
  view.highlight(c);
  info.innerHTML = describe(c);
  info.style.left = `${e.clientX}px`; info.style.top = `${e.clientY}px`;
  info.hidden = false;
});
view.renderer.domElement.addEventListener('pointerleave', () => { info.hidden = true; view.highlight(selected); });
let downAt: [number, number] | null = null;
view.renderer.domElement.addEventListener('pointerdown', (e) => { downAt = e.button === 0 ? [e.clientX, e.clientY] : null; });
view.renderer.domElement.addEventListener('pointerup', (e) => {
  if (!downAt || !world || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
  const c = view.pick(e.clientX, e.clientY);
  if (c < 0) return;
  if (revealArmed && !revealed.has(c)) {
    if (frontier().includes(c)) reveal([c]);
    return;
  }
  if (revealed.has(c)) { selected = c; view.highlight(c); syncBar(); }
});
view.renderer.domElement.addEventListener('dblclick', (e) => {
  const c = view.pick(e.clientX, e.clientY);
  if (c >= 0 && revealed.has(c)) openHex(c);
});
function describe(c: number): string {
  if (!world) return '';
  if (!revealed.has(c)) return revealArmed && frontier().includes(c) ? '<b>Storm</b><br><span>click to reveal</span>' : '<b>Storm</b><br><span>unexplored</span>';
  const w = world;
  const lake = w.water[c] !== WATER_LAND;
  const home = c === save?.start ? `<b>${esc(save.civ)}</b><br>` : '';
  return `${home}<b>${BIOMES[w.biome[c]].name}</b>${w.river[c] ? ' · river' : ''}${lake ? '' : `<br><span>double-click to go down</span>`}`;
}

// --- The bar ----------------------------------------------------------------------------------
function syncBar() {
  $('b-hex').classList.toggle('on', hexOpen);
  $('b-planet').classList.toggle('on', !hexOpen);
  $('b-reveal').classList.toggle('on', revealArmed);
  $('b-sound').classList.toggle('off', thunder.muted);
  $('b-sound').title = thunder.muted ? 'Sound off' : 'Sound on';
  $('turn').textContent = String(save?.turn ?? 1);
  $('civname').textContent = save?.civ ?? '';
  document.body.classList.toggle('in-hex', hexOpen);
  document.body.classList.toggle('revealing', revealArmed);
}
$('b-hex').onclick = () => openHex(selected >= 0 ? selected : hexCell >= 0 ? hexCell : save?.start ?? -1);
$('b-planet').onclick = () => closeHex();
$('b-end').onclick = () => {
  if (!save) return;
  save.turn++;
  store();
  syncBar();
  $('b-end').classList.add('flash');
  setTimeout(() => $('b-end').classList.remove('flash'), 400);
};
$('b-reveal').onclick = () => {
  if (hexOpen) {
    // In the hex: clear one fogged neighbour of this hex, to watch it go.
    const nb = world ? world.grid.neighbors[hexCell].filter((n) => !revealed.has(n)) : [];
    if (nb.length) reveal([nb[Math.floor(Math.random() * nb.length)]]);
    return;
  }
  revealArmed = !revealArmed;
  syncBar();
};
$('b-sound').onclick = () => { thunder.unlock(); thunder.setMuted(!thunder.muted); syncBar(); };
$('b-menu').onclick = () => {
  if (!confirm('Leave this game? It stays saved, and you can continue it from the menu.')) return;
  location.reload();
};

// --- Debug handle -----------------------------------------------------------------------------
(window as unknown as Record<string, unknown>).primundi = {
  view, thunder,
  get world() { return world; },
  get save() { return save; },
  get fog() { return fog; },
  reveal: (cells: number[]) => reveal(cells),
  revealRing: () => reveal(frontier()),
  openHex, closeHex,
};

showLaunch();
syncBar();
