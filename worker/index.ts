/**
 * mundi.bill.computer's only server code: claims. Everything else is static files (dist/), served
 * by Cloudflare before this Worker runs; only /api/* reaches it (run_worker_first in wrangler.toml).
 *
 * A claim says "this world is Bill's": exclusive per world name, logged, shown in a feed with a
 * thumbnail. No accounts: the claimer's browser makes a random key, and only its hash is stored,
 * so whoever holds the key can unclaim. ADMIN_KEY (a secret) can unclaim anything.
 *
 * All state lives in one SQLite Durable Object (Registry). One instance is plenty: claims are rare.
 *
 *   GET    /api/config              Turnstile site key
 *   GET    /api/feed                recently claimed worlds
 *   GET    /api/claims/:world       who claimed it, or null
 *   POST   /api/claims/:world       claim it  {owner, link, title, thumb, key, turnstile}
 *   DELETE /api/claims/:world       unclaim it  (header X-Mundi-Key)
 *   GET    /api/thumbs/:world       the claim's thumbnail (JPEG)
 */
import { cleanLink, cleanOwner, isRude, RATE, THUMB_MAX, worldKey } from './rules.ts';

export interface Env {
  ASSETS: Fetcher;
  REGISTRY: DurableObjectNamespace;
  TURNSTILE_SITEKEY: string;
  TURNSTILE_SECRET?: string;
  ADMIN_KEY?: string;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, extra: object = {}) => json({ error, ...extra }, status);

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (url.pathname === '/api/config') return json({ sitekey: env.TURNSTILE_SITEKEY });
    const stub = env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
    // The visitor's address goes along for the rate limit; the Registry stores only a hash of it.
    const fwd = new Request(req);
    fwd.headers.set('x-mundi-ip', req.headers.get('cf-connecting-ip') ?? 'unknown');
    return stub.fetch(fwd);
  },
};

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The first hex digits of the key's hash: lets a browser recognise its own claims, proves nothing. */
const tagOf = (keyHash: string) => keyHash.slice(0, 10);

interface ClaimRow { world: string; title: string; owner: string; link: string; build: string; key_hash: string; at: number; [k: string]: SqlStorageValue }

export class Registry {
  sql: SqlStorage;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.env = env;
    this.sql = state.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS claims (
        world TEXT PRIMARY KEY, title TEXT NOT NULL, owner TEXT NOT NULL, link TEXT NOT NULL,
        build TEXT NOT NULL, key_hash TEXT NOT NULL, at INTEGER NOT NULL, thumb BLOB);
      CREATE INDEX IF NOT EXISTS claims_at ON claims (at);
      CREATE TABLE IF NOT EXISTS log (
        id INTEGER PRIMARY KEY, world TEXT NOT NULL, owner TEXT NOT NULL, action TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS hits (ip TEXT NOT NULL, at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS hits_ip ON hits (ip, at);`);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/api/feed' && req.method === 'GET') return this.feed();
    const m = url.pathname.match(/^\/api\/(claims|thumbs)\/([^/]+)$/);
    const world = m && worldKey(decodeURIComponent(m[2]));
    if (!m || !world) return fail(404, 'Not found');
    if (m[1] === 'thumbs') return this.thumb(world);
    if (req.method === 'GET') return this.get(world);
    if (req.method === 'POST') return this.claim(world, req);
    if (req.method === 'DELETE') return this.unclaim(world, req);
    return fail(405, 'Method not allowed');
  }

  row(world: string): ClaimRow | undefined {
    return this.sql.exec<ClaimRow>('SELECT world, title, owner, link, build, key_hash, at FROM claims WHERE world = ?', world).toArray()[0];
  }

  public(r: ClaimRow) {
    return { world: r.world, title: r.title, owner: r.owner, link: r.link, build: r.build, at: r.at, tag: tagOf(r.key_hash) };
  }

  feed(): Response {
    const rows = this.sql.exec<ClaimRow>('SELECT world, title, owner, link, build, key_hash, at FROM claims ORDER BY at DESC LIMIT 30').toArray();
    return json({ claims: rows.map((r) => this.public(r)) });
  }

  get(world: string): Response {
    const r = this.row(world);
    return json(r ? this.public(r) : null);   // null: unclaimed (a 200, so browsers don't log an error)
  }

  thumb(world: string): Response {
    const r = this.sql.exec<{ thumb: ArrayBuffer | null }>('SELECT thumb FROM claims WHERE world = ?', world).toArray()[0];
    if (!r?.thumb) return new Response('No thumbnail', { status: 404 });
    // The client adds ?v=<claimed at>, so a re-claim gets a fresh URL and this can cache for long.
    return new Response(r.thumb, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'public, max-age=86400' } });
  }

  async claim(world: string, req: Request): Promise<Response> {
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return fail(400, 'Bad request'); }
    const str = (k: string) => (typeof body[k] === 'string' ? body[k] as string : '');

    const owner = cleanOwner(str('owner'));
    if (!owner) return fail(400, 'Names are 1-24 letters, digits and spaces');
    const link = cleanLink(str('link'), world);
    if (!link) return fail(400, 'That link does not describe this world');
    const title = str('title').slice(0, 24) || world;
    if (isRude(owner)) return fail(400, 'Please pick another name');
    if (isRude(world) || isRude(title)) return fail(400, 'This world can’t be claimed');
    const key = str('key');
    if (!/^[0-9a-f]{32,128}$/.test(key)) return fail(400, 'Bad key');
    const build = str('build').slice(0, 40) || 'unknown';

    let thumb: Uint8Array | null = null;
    const t = str('thumb');
    if (t) {
      const mm = t.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
      if (!mm) return fail(400, 'Bad thumbnail');
      thumb = Uint8Array.from(atob(mm[1]), (c) => c.charCodeAt(0));
      if (thumb.length > THUMB_MAX) return fail(413, 'Thumbnail too large');
    }

    if (this.row(world)) return fail(409, 'Already claimed', { claim: this.public(this.row(world)!) });

    // Rate limit before the (slower) Turnstile check, so a flood costs us little.
    const now = Date.now();
    const ip = await sha256(`mundi:${req.headers.get('x-mundi-ip')}`);
    this.sql.exec('DELETE FROM hits WHERE at < ?', now - 86_400_000);
    const count = (since: number) => this.sql.exec<{ n: number }>('SELECT count(*) AS n FROM hits WHERE ip = ? AND at > ?', ip, since).one().n;
    if (count(now - 3_600_000) >= RATE.perHour || count(now - 86_400_000) >= RATE.perDay) {
      return fail(429, 'Too many claims for now. Try again later');
    }

    if (!(await this.human(str('turnstile'), req.headers.get('x-mundi-ip')))) return fail(403, 'The robot check failed. Try again');
    // Turnstile took a moment: someone may have claimed it meanwhile (the object is single-threaded,
    // but awaiting a fetch lets other requests in).
    if (this.row(world)) return fail(409, 'Already claimed', { claim: this.public(this.row(world)!) });

    this.sql.exec('INSERT INTO hits (ip, at) VALUES (?, ?)', ip, now);
    this.sql.exec('INSERT INTO claims (world, title, owner, link, build, key_hash, at, thumb) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      world, title, owner, link, build, await sha256(key), now, thumb);
    this.sql.exec('INSERT INTO log (world, owner, action, at) VALUES (?, ?, ?, ?)', world, owner, 'claim', now);
    return json(this.public(this.row(world)!), 201);
  }

  async unclaim(world: string, req: Request): Promise<Response> {
    const r = this.row(world);
    if (!r) return fail(404, 'Unclaimed');
    const key = req.headers.get('x-mundi-key') ?? '';
    const admin = !!this.env.ADMIN_KEY && key === this.env.ADMIN_KEY;
    if (!admin && (await sha256(key)) !== r.key_hash) return fail(403, 'Only the claimer can unclaim this world');
    this.sql.exec('DELETE FROM claims WHERE world = ?', world);
    this.sql.exec('INSERT INTO log (world, owner, action, at) VALUES (?, ?, ?, ?)', world, r.owner, admin ? 'removed' : 'unclaim', Date.now());
    return json({ ok: true });
  }

  /** Cloudflare Turnstile: true when the visitor passed the check. */
  async human(token: string, ip: string | null): Promise<boolean> {
    if (!this.env.TURNSTILE_SECRET) return false;   // not set up: refuse rather than run unguarded
    if (!token) return false;
    const form = new FormData();
    form.append('secret', this.env.TURNSTILE_SECRET);
    form.append('response', token);
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const out = await res.json() as { success?: boolean };
    return out.success === true;
  }
}
