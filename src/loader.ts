/**
 * The loading screen for the first world: the planet's name, a progress bar and the generator's
 * real steps as they happen (the worker reports them). It holds until the first frame is drawn,
 * then fades to reveal the globe.
 *
 * The bar and the ring are animated with CSS transforms, which the browser runs off the main
 * thread, so they keep moving while the page is frozen compiling shaders for the first frame.
 *
 * Two layouts, chosen live with ?loader=list|bar (temporary, until Bill picks one):
 * list ticks off every step; bar shows one line at a time.
 */
import type { GenStep } from './world.ts';

export type LoadStep = 'boot' | GenStep | 'mesh' | 'clouds' | 'light';

/** Each step's label and its typical length in ms (measured 2026-11-01, 36,002 cells). */
const STEPS: { id: LoadStep; label: string; ms: number }[] = [
  { id: 'boot', label: 'Forming a planet', ms: 150 },
  { id: 'plates', label: 'Breaking the crust into plates', ms: 51 },
  { id: 'mountains', label: 'Pushing up mountain ranges', ms: 39 },
  { id: 'seas', label: 'Filling the oceans', ms: 11 },
  { id: 'erosion', label: 'Carving valleys with rivers', ms: 172 },
  { id: 'temperature', label: 'Warming the tropics', ms: 6 },
  { id: 'winds', label: 'Setting the winds blowing', ms: 19 },
  { id: 'currents', label: 'Stirring the ocean currents', ms: 16 },
  { id: 'rivers', label: 'Running rivers to the sea', ms: 12 },
  { id: 'biomes', label: 'Growing forests and deserts', ms: 5 },
  { id: 'mesh', label: 'Sculpting the terrain', ms: 878 },
  { id: 'clouds', label: 'Gathering clouds', ms: 1454 },
  { id: 'light', label: 'Lighting the sky', ms: 20000 },   // shader compile: long on a first visit, instant after
];
const TOTAL = STEPS.reduce((s, x) => s + x.ms, 0);
/** Fraction of the bar at the start of each step. */
const START = new Map<LoadStep, number>();
STEPS.reduce((acc, s) => { START.set(s.id, acc / TOTAL); return acc + s.ms; }, 0);

/** Shortest time a line stays up in the bar layout, so quick steps can still be read. */
const DWELL = 220;

export interface Loader {
  step(id: LoadStep): void;
  /** Fill the bar, fade out, remove. Resolves once it is gone. */
  finish(): Promise<void>;
  /** Resolves once it is gone. */
  gone: Promise<void>;
}

/** A page's own loading screen: its word and look (a class on the loader), and tips that take
 * turns under the bar (Primundi, 2026-11-09). With tips it shows one line, not the list. */
export interface LoaderLook { word?: string; cls?: string; tips?: string[] }
export function mountLoader(name: string, kind: string, look: LoaderLook = {}): Loader {
  const layout = look.tips?.length || new URLSearchParams(location.search).get('loader') === 'bar' ? 'bar' : 'list';
  const el = document.createElement('div');
  el.className = `loader loader-${layout}${look.cls ? ` ${look.cls}` : ''}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <div class="ld">
      <div class="ld-orb"><i></i></div>
      <div class="ld-word">${look.word ?? 'MUNDI'}</div>
      <div class="ld-name"></div>
      <div class="ld-kind"></div>
      <div class="ld-bar"><i></i></div>
      ${layout === 'bar'
        ? '<div class="ld-line" aria-live="polite"></div>'
        : `<ol class="ld-list">${STEPS.map((s) => `<li data-step="${s.id}">${s.label}</li>`).join('')}</ol>`}
      ${look.tips?.length ? '<p class="ld-tip"></p>' : ''}
    </div>`;
  el.querySelector('.ld-name')!.textContent = name;
  el.querySelector('.ld-kind')!.textContent = kind;
  document.body.appendChild(el);
  const bar = el.querySelector<HTMLElement>('.ld-bar i')!;
  // Tips: one at a time, from a random one, every few seconds.
  const tipEl = el.querySelector<HTMLElement>('.ld-tip');
  let tipTimer = 0;
  if (tipEl && look.tips?.length) {
    const tips = look.tips;
    let k = Math.floor(Math.random() * tips.length);
    const show = () => { tipEl.classList.remove('on'); window.setTimeout(() => { tipEl.textContent = tips[k++ % tips.length]; tipEl.classList.add('on'); }, 250); };
    show();
    tipTimer = window.setInterval(show, 5200);
  }

  // Jump to where this step starts, then glide to where it ends over its usual length.
  // Only ever forward, and stop short of the end until finish().
  let shown = 0;
  const glide = (from: number, to: number, ms: number) => {
    from = Math.max(from, shown);
    bar.style.transition = 'none';
    bar.style.transform = `scaleX(${from})`;
    void bar.offsetWidth;
    bar.style.transition = `transform ${ms}ms cubic-bezier(.3,.6,.5,1)`;
    bar.style.transform = `scaleX(${to})`;
    shown = from;
  };

  // Bar layout: one line at a time, each held at least DWELL ms; a backlog skips to the latest.
  const line = el.querySelector<HTMLElement>('.ld-line');
  let lineAt = 0, pending: string | null = null, timer = 0;
  const showLine = (text: string) => {
    if (!line) return;
    const wait = DWELL - (performance.now() - lineAt);
    if (wait > 0) {
      pending = text;
      if (!timer) timer = window.setTimeout(() => { timer = 0; const t = pending!; pending = null; lineAt = 0; showLine(t); }, wait);
      return;
    }
    line.textContent = text + '…';
    lineAt = performance.now();
  };

  let current: LoadStep | null = null;
  const step = (id: LoadStep) => {
    const i = STEPS.findIndex((s) => s.id === id);
    if (i < 0 || id === current) return;
    current = id;
    const s = STEPS[i], a = START.get(id)!, b = a + s.ms / TOTAL;
    glide(a, Math.min(0.97, b), s.ms * 1.3);
    showLine(s.label);
    el.querySelectorAll<HTMLElement>('.ld-list li').forEach((li, j) => {
      li.classList.toggle('done', j < i);
      li.classList.toggle('on', j === i);
    });
  };
  step('boot');

  let markGone!: () => void;
  const gone = new Promise<void>((r) => { markGone = r; });
  const finish = () => new Promise<void>((resolve) => {
    // Let a queued line show before the bar completes.
    const hold = line && (pending || timer) ? DWELL : 0;
    window.setTimeout(() => {
      el.querySelectorAll('.ld-list li').forEach((li) => { li.classList.remove('on'); li.classList.add('done'); });
      bar.style.transition = 'transform 200ms ease-out';
      bar.style.transform = 'scaleX(1)';
      window.setTimeout(() => {
        el.classList.add('gone');
        window.setTimeout(() => { clearInterval(tipTimer); el.remove(); resolve(); markGone(); }, 600);
      }, 260);
    }, hold);
  });

  return { step, finish, gone };
}
