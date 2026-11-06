/**
 * The card a hex gets when clicked on the planet (main.ts): a picture of it as the hex view draws
 * it (sent from the hidden hex view, hex.ts snapshot), a few lines about the place, and Enter.
 * It sits beside the hex and follows it as the planet turns; Esc, × or a click elsewhere closes it.
 */
import { BIOMES, B } from './biomes.ts';
import { WATER_OCEAN, WATER_LAKE, type World } from './world.ts';
import { RESOURCE_NAMES, type GameData } from './gamedata.ts';

/** surface.ts RELIEF, as hexlocal.ts: the highest land, in planet radii. */
const RELIEF_RADII = 0.013;

export interface HexAbout { title: string; where: string; text: string; facts: string[] }

const pick = <T,>(c: number, a: T[]) => a[(c * 2654435761 >>> 0) % a.length];

/** Words about a cell from the planet's data: what the land is, its weather, what is there. */
export function describeHex(w: World, game: GameData | null, site: string | undefined, c: number, radiusKm: number): HexAbout {
  const g = w.grid, nb = g.neighbors[c];
  const biome = BIOMES[w.biome[c]].name;
  const ocean = w.water[c] === WATER_OCEAN, lake = w.water[c] === WATER_LAKE;
  const reliefM = RELIEF_RADII * radiusKm * 1000;
  const heightM = (k: number) => w.water[k] === WATER_OCEAN ? Math.min(-20, w.elevation[k] * 3000) : 15 + Math.pow(Math.max(0, w.elevation[k]), 1.35) * reliefM;
  const h = heightM(c);
  let lo = Infinity, hi = -Infinity, coast = false;
  // How rugged: the spread of the land's height across the cell and its neighbours (the sea's depth
  // left out, or every coast read as mountains).
  for (const k of [c, ...nb]) {
    if (w.water[k] === WATER_OCEAN) { if (!ocean) coast = true; continue; }
    const hk = heightM(k); lo = Math.min(lo, hk); hi = Math.max(hi, hk);
  }
  const spread = hi > lo ? hi - lo : 0;
  const inflow = [...nb].filter((k) => w.river[k] && w.downstream[k] === c).length;
  const tC = Math.round(50 * w.temperature[c] - 17), wet = w.moisture[c];
  const y = g.centers[c * 3 + 1], lat = Math.round(Math.asin(Math.max(-1, Math.min(1, y))) * 180 / Math.PI);
  // Across the flats: the planet's surface over the cell count, as a hexagon.
  const acrossKm = Math.sqrt((4 * Math.PI * radiusKm * radiusKm / g.neighbors.length) * 2 / Math.sqrt(3));
  const cont = game && game.continent[c] >= 0 ? game.continents[game.continent[c]].name : null;

  const s: string[] = [];
  if (ocean) {
    s.push(w.biome[c] === B.SEA_ICE ? 'Frozen sea, the ice broken by leads of dark water.'
      : h > -200 ? pick(c, ['Shallow water over a sandy shelf.', 'Shallow sea, pale where the bottom shows through.'])
        : pick(c, ['Open ocean, deep and dark.', 'Deep water, far from any shore.']));
  } else {
    const shape = spread > 1500 ? pick(c, ['Rugged, steep country', 'Broken mountain ground', 'High, folded country'])
      : spread > 500 ? pick(c, ['Hill country', 'Rolling uplands', 'Ridged, hilly ground'])
        : pick(c, ['Level ground', 'Gentle, open country', 'A broad, flat stretch']);
    const of = lake ? 'round a lake' : w.river[c] ? (inflow >= 2 ? 'where rivers meet' : 'along a river') : coast ? 'on the coast' : '';
    s.push(`${shape}${of ? ' ' + of : ''}: ${biome.toLowerCase()}${h > 2500 ? ', high up' : ''}.`);
    const warmth = tC >= 24 ? 'Hot' : tC >= 16 ? 'Warm' : tC >= 8 ? 'Mild' : tC >= 0 ? 'Cool' : 'Cold';
    const water = wet < 0.2 ? 'and dry' : wet < 0.4 ? 'and fairly dry' : wet < 0.65 ? 'with steady rain' : 'and wet';
    s.push(`${warmth} ${water}, about ${tC} °C through the year.`);
  }
  const res = game ? RESOURCE_NAMES.filter(([b]) => game.resources[c] & b).map(([, n]) => n) : [];
  if (res.length) {
    const say: Record<string, string> = { ore: 'ore in the rock', timber: 'good timber', fish: 'fishing', fertile: 'fertile soil' };
    const list = res.map((r) => say[r] ?? r);
    s.push(`Known for ${list.length > 1 ? list.slice(0, -1).join(', ') + ' and ' + list[list.length - 1] : list[0]}.`);
  }
  if (site) s.push(`The town of ${site} stands here.`);

  const facts = [
    ocean ? `${Math.round(-h).toLocaleString()} m deep` : `${Math.round(h).toLocaleString()} m up`,
    `${tC} °C`,
    `${Math.round(acrossKm)} km across`,
    `${Math.abs(lat)}° ${lat >= 0 ? 'N' : 'S'}`,
  ];
  return {
    title: site ?? biome,
    where: site ? biome + (cont ? ` · ${cont}` : '') : cont ? `on ${cont}` : ocean ? 'at sea' : '',
    text: s.join(' '),
    facts,
  };
}

/** The card element and its placement. */
export class HexCard {
  readonly el: HTMLElement;
  cell = -1;
  private img: HTMLImageElement;
  private body: HTMLElement;
  private enter: HTMLButtonElement;
  /** The picture being waited for (a hex view hash). */
  wantHash = '';

  constructor(onEnter: (cell: number) => void, onClose: () => void) {
    const el = document.createElement('div');
    el.id = 'hexcard';
    el.hidden = true;
    el.innerHTML = `<button class="x" type="button" title="Close (Esc)">×</button>
      <div class="shot"><img alt="" /><span class="wait">Drawing the hex…</span></div>
      <div class="body"></div>
      <button class="enter" type="button">Enter hex <span>›</span></button>`;
    document.body.appendChild(el);
    this.el = el;
    this.img = el.querySelector('img')!;
    this.body = el.querySelector('.body')!;
    this.enter = el.querySelector('.enter')!;
    this.enter.onclick = () => { if (this.cell >= 0) onEnter(this.cell); };
    (el.querySelector('.x') as HTMLElement).onclick = () => onClose();
    // Clicks on the card stay on it (not a click on the planet behind).
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  show(cell: number, about: HexAbout) {
    this.cell = cell;
    this.body.innerHTML = `<h3>${about.title}</h3>${about.where ? `<div class="where">${about.where}</div>` : ''}
      <p>${about.text}</p><div class="facts">${about.facts.map((f) => `<span>${f}</span>`).join('')}</div>`;
    this.el.classList.remove('ready');
    this.img.removeAttribute('src');
    this.el.hidden = false;
    this.el.classList.remove('in'); void this.el.offsetWidth; this.el.classList.add('in');
  }
  picture(url: string) {
    this.img.onload = () => this.el.classList.add('ready');
    this.img.src = url;
  }
  hide() { this.el.hidden = true; this.cell = -1; this.wantHash = ''; }
  get open() { return !this.el.hidden; }
  focusEnter() { this.enter.focus({ preventScroll: true }); }

  /** Beside the hex's screen point: to its right, or its left where there's no room; the little
   * pointer on the card's side faces the hex. Hidden while the hex is round the back. */
  place(at: { x: number; y: number; front: boolean } | null) {
    if (!at || !at.front) { this.el.style.visibility = 'hidden'; return; }
    this.el.style.visibility = '';
    const w = this.el.offsetWidth, h = this.el.offsetHeight, gap = 26, m = 10;
    const vw = innerWidth, vh = innerHeight;
    const narrow = vw < 600;
    let x: number, y: number, side: 'left' | 'right' | 'none';
    if (narrow) { x = (vw - w) / 2; y = vh - h - m; side = 'none'; }
    else {
      side = at.x + gap + w + m <= vw ? 'left' : 'right';
      x = side === 'left' ? at.x + gap : at.x - gap - w;
      y = Math.min(vh - h - m, Math.max(m, at.y - h * 0.38));
    }
    this.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    this.el.dataset.side = side;
    this.el.style.setProperty('--tip', `${Math.round(Math.min(h - 18, Math.max(18, at.y - y)))}px`);
  }
}
