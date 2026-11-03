/**
 * Claims: mark a world as yours, and browse worlds others have claimed. The server half is
 * worker/index.ts; this is the Share panel and the "Claimed by" tag under the planet's name.
 *
 * No accounts. This browser makes a random claim key once and keeps it; the server stores only
 * its hash, so whoever holds the key can unclaim. "Use on another device" copies a link that
 * carries the key (?claimkey=…), which the other browser takes and then strips from the address.
 */
import type { App } from './shell.ts';

interface Claim { world: string; title: string; owner: string; link: string; build: string; at: number; tag: string }

declare const __MUNDI_BUILD__: string;
const BUILD = typeof __MUNDI_BUILD__ === 'string' ? __MUNDI_BUILD__ : 'dev';

// View-only settings: they don't change the world, so they stay out of a claim's link.
const VIEW_KEYS = ['lens', 'relief'];

/** The world as a link fragment, without view settings: "seed=nethamol&kind=desert". */
function worldLink(): string {
  const h = new URLSearchParams(location.hash.slice(1));
  for (const k of VIEW_KEYS) h.delete(k);
  return h.toString();
}
const worldKey = () => (new URLSearchParams(location.hash.slice(1)).get('seed') ?? '').toLowerCase();

// --- This browser's claim key and name (storage may be missing in a private window) ---
const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* private window */ } },
};
let memKey: string | null = null;
function claimKey(): string {
  let k = store.get('mundi-claim-key') ?? memKey;
  if (!k) {
    k = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    store.set('mundi-claim-key', k);
    memKey = k;
  }
  return k;
}
async function myTag(): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(claimKey()));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 10);
}

// --- Turnstile, loaded the first time someone claims ---
interface Turnstile { render(el: HTMLElement, o: Record<string, unknown>): string; remove(id: string): void }
let turnstileLoad: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  turnstileLoad ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve((window as unknown as { turnstile: Turnstile }).turnstile);
    s.onerror = () => { turnstileLoad = null; reject(new Error('Turnstile did not load')); };
    document.head.appendChild(s);
  });
  return turnstileLoad;
}
let sitekey: Promise<string> | null = null;
const getSitekey = () => (sitekey ??= fetch('/api/config').then((r) => r.json()).then((c: { sitekey: string }) => c.sitekey));

/** A one-use Turnstile token. The widget stays invisible unless Cloudflare wants a click. */
async function humanToken(slot: HTMLElement): Promise<string> {
  const [ts, key] = await Promise.all([loadTurnstile(), getSitekey()]);
  slot.replaceChildren();
  return new Promise((resolve, reject) => {
    const id = ts.render(slot, {
      sitekey: key,
      appearance: 'interaction-only',
      theme: 'dark',
      callback: (t: string) => { resolve(t); setTimeout(() => ts.remove(id), 0); },
      'error-callback': () => reject(new Error('The robot check failed. Try again')),
      'timeout-callback': () => reject(new Error('The robot check timed out. Try again')),
    });
  });
}

/** The current view, centre-cropped to a small square JPEG. */
function thumbnail(canvas: HTMLCanvasElement): string {
  const size = 240, s = Math.min(canvas.width, canvas.height);
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d')!.drawImage(canvas, (canvas.width - s) / 2, (canvas.height - s) / 2, s, s, 0, 0, size, size);
  return c.toDataURL('image/jpeg', 0.82);
}

const ago = (at: number) => {
  const m = (Date.now() - at) / 60000;
  if (m < 1) return 'just now';
  if (m < 60) return `${Math.floor(m)} min ago`;
  if (m < 1440) return `${Math.floor(m / 60)} h ago`;
  const d = Math.floor(m / 1440);
  return d < 30 ? `${d} d ago` : new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function mountClaims(app: App, share: HTMLElement, toast: (msg: string) => void) {
  // A key link from another browser: take the key, then drop it from the address bar.
  const q = new URLSearchParams(location.search);
  const imported = q.get('claimkey');
  if (imported && /^[0-9a-f]{64}$/.test(imported)) {
    store.set('mundi-claim-key', imported);
    memKey = imported;
    q.delete('claimkey');
    history.replaceState(null, '', (q.size ? '?' + q : location.pathname) + location.hash);
    setTimeout(() => toast('This browser now holds your claim key'), 600);
  }

  // The share button gets a panel under it.
  const wrap = document.createElement('div');
  wrap.className = 'sharewrap';
  share.replaceWith(wrap);
  wrap.appendChild(share);
  share.title = 'Share this planet, claim it, or see worlds others have claimed';
  share.setAttribute('aria-haspopup', 'dialog');
  const panel = document.createElement('div');
  panel.className = 'share-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <button class="sp-copy" id="sp-copy">⧉ Copy link to this planet</button>
    <section class="sp-claim">
      <h4 id="sp-title"></h4>
      <p class="sp-status" id="sp-status"></p>
      <form class="sp-form" id="sp-form" hidden>
        <input id="sp-name" maxlength="24" placeholder="Your name" autocomplete="nickname" spellcheck="false" />
        <button type="submit" id="sp-go">★ Claim</button>
      </form>
      <div class="sp-ts" id="sp-ts"></div>
      <div class="sp-acts" id="sp-acts"></div>
    </section>
    <section class="sp-feed">
      <h4>Recently claimed</h4>
      <div class="sp-grid" id="sp-grid"><p class="sp-quiet">…</p></div>
    </section>
    <button class="sp-keylink" id="sp-keylink" title="Copy a link that gives another browser your claim key, so you can unclaim from there">Use my claims on another device</button>`;
  wrap.appendChild(panel);
  const $ = <T extends HTMLElement>(id: string) => panel.querySelector<T>('#' + id)!;

  // The tag under the planet's name.
  const badge = document.createElement('button');
  badge.className = 'pclaim';
  badge.hidden = true;
  document.querySelector('.ui .brand')?.appendChild(badge);
  badge.onclick = () => open(true);

  $<HTMLInputElement>('sp-name').value = store.get('mundi-claim-name') ?? '';

  // --- Claim status of the world on screen ---
  const cache = new Map<string, Claim | null>();
  let current: Claim | null | undefined;   // undefined: not known (offline or loading)
  let mine = '';
  void myTag().then((t) => { mine = t; render(); });

  const fetchClaim = async (world: string): Promise<Claim | null> => {
    if (cache.has(world)) return cache.get(world)!;
    const r = await fetch(`/api/claims/${encodeURIComponent(world)}`);
    if (!r.ok || !r.headers.get('content-type')?.includes('json')) throw new Error(String(r.status));
    const c = await r.json() as Claim | null;
    cache.set(world, c);
    return c;
  };
  const refresh = async () => {
    const world = worldKey();
    if (!world) return;
    try {
      const c = await fetchClaim(world);
      if (worldKey() === world) { current = c; render(); }
    } catch { current = undefined; render(); }
  };

  const render = () => {
    const world = worldKey(), name = app.name();
    $('sp-title').textContent = name;
    const form = $('sp-form'), status = $('sp-status'), acts = $('sp-acts');
    acts.replaceChildren();
    badge.hidden = !current;
    if (current === undefined) {
      form.hidden = true;
      status.textContent = world ? 'Claims are unavailable right now.' : '';
      return;
    }
    if (current === null) {
      form.hidden = false;
      status.textContent = 'Nobody has claimed this world. Claim it to make it yours and add it to the list below.';
      return;
    }
    form.hidden = true;
    const yours = current.tag === mine;
    const same = current.link === worldLink();
    badge.textContent = `★ Claimed by ${current.owner}`;
    badge.title = same ? `Claimed ${ago(current.at)}` : `${current.owner} claimed this name with other settings`;
    status.innerHTML = `${yours ? 'You claimed' : `Claimed by <b>${esc(current.owner)}</b>`} ${ago(current.at)}.` +
      (same ? '' : ` ${yours ? 'You' : 'They'} chose other settings, so it looks different from this.`);
    if (!same) acts.appendChild(button(yours ? 'Open your version' : 'Open their version', () => go(current!.link)));
    if (yours) acts.appendChild(button('Unclaim', unclaim, 'danger'));
  };
  const button = (label: string, f: () => void, cls = '') => {
    const b = document.createElement('button');
    b.textContent = label; b.className = cls; b.onclick = f;
    return b;
  };
  const go = (link: string) => { open(false); location.hash = link; };

  // --- Claim and unclaim ---
  let busy = false;
  $('sp-form').onsubmit = async (e) => {
    e.preventDefault();
    if (busy || app.busy()) { if (app.busy()) toast('Wait for the planet to finish drawing'); return; }
    const owner = $<HTMLInputElement>('sp-name').value.trim();
    if (!owner) { $('sp-name').focus(); return; }
    store.set('mundi-claim-name', owner);
    const world = worldKey(), link = worldLink();
    busy = true; $('sp-go').textContent = 'Claiming…';
    try {
      const thumb = thumbnail(app.renderer.renderer.domElement);
      const turnstile = await humanToken($('sp-ts'));
      const r = await fetch(`/api/claims/${encodeURIComponent(world)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ owner, link, title: app.name(), thumb, key: claimKey(), turnstile, build: BUILD }),
      });
      const out = await r.json() as Claim & { error?: string; claim?: Claim };
      if (r.status === 409 && out.claim) { cache.set(world, out.claim); toast(`${out.claim.owner} got there first`); }
      else if (!r.ok) toast(out.error ?? 'Could not claim this world');
      else { cache.set(world, out); toast(`${app.name()} is yours`); loadFeed(); }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Could not claim this world');
    } finally {
      busy = false; $('sp-go').textContent = '★ Claim';
      $('sp-ts').replaceChildren();
      await refresh();
    }
  };
  async function unclaim() {
    const world = worldKey();
    if (!current || !confirm(`Unclaim ${current.title}? Anyone will be able to claim it.`)) return;
    const r = await fetch(`/api/claims/${encodeURIComponent(world)}`, { method: 'DELETE', headers: { 'x-mundi-key': claimKey() } });
    if (r.ok) { cache.set(world, null); toast('Unclaimed'); loadFeed(); }
    else toast(((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'Could not unclaim');
    await refresh();
  }

  // --- The feed ---
  const loadFeed = async () => {
    const grid = $('sp-grid');
    try {
      const { claims } = await (await fetch('/api/feed')).json() as { claims: Claim[] };
      if (!claims.length) { grid.innerHTML = '<p class="sp-quiet">No worlds claimed yet.</p>'; return; }
      grid.innerHTML = claims.map((c, i) => `
        <button class="sp-card" data-i="${i}" title="${esc(c.title)}, claimed by ${esc(c.owner)} ${ago(c.at)}">
          <img src="/api/thumbs/${encodeURIComponent(c.world)}?v=${c.at}" alt="" loading="lazy" />
          <b>${esc(c.title)}</b><span>${esc(c.owner)} · ${ago(c.at)}</span>
        </button>`).join('');
      grid.querySelectorAll<HTMLButtonElement>('.sp-card').forEach((b) => {
        const c = claims[Number(b.dataset.i)];
        cache.set(c.world, c);
        b.onclick = () => go(c.link);
      });
    } catch {
      grid.innerHTML = '<p class="sp-quiet">The list is unavailable right now.</p>';
    }
  };

  // --- Panel ---
  const open = (on: boolean) => {
    panel.hidden = !on;
    share.classList.toggle('on', on);
    share.setAttribute('aria-expanded', String(on));
    if (on) { render(); void refresh(); void loadFeed(); }
  };
  share.onclick = (e) => { e.stopPropagation(); open(panel.hidden === true); };
  document.addEventListener('pointerdown', (e) => {
    const t = e.target as Element;
    if (!panel.hidden && !t.closest('.sharewrap') && !t.closest('.pclaim')) open(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
  $('sp-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Link copied: anyone with it sees this planet'); }
    catch { toast('Copy the address bar to share this planet'); }
  };
  $('sp-keylink').onclick = async () => {
    const url = `${location.origin}/?claimkey=${claimKey()}${location.hash}`;
    try { await navigator.clipboard.writeText(url); toast('Key link copied. Open it on the other device; keep it private'); }
    catch { prompt('Open this link on the other device. Keep it private:', url); }
  };

  // A new world: look up whether it's claimed.
  let lastWorld = '';
  app.onDrawn(() => {
    if (worldKey() !== lastWorld) { lastWorld = worldKey(); current = cache.has(lastWorld) ? cache.get(lastWorld) : undefined; render(); }
    void refresh();
  });
}
