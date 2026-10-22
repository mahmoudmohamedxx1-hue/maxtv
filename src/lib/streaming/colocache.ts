// ─── Colo-shared caches (Cloudflare Workers Cache API) ──────────────────────
// WHY THIS EXISTS (2026-10-23, the "loads for 4 minutes out of 5" field
// report): the Workers FREE plan spreads a household's requests across many
// short-lived isolates with NO shared memory. The turbo engine's in-memory
// segment cache is per-isolate, so a segment request that load-balanced to
// any isolate other than the one whose poller downloaded those bytes paid
// the full recovery path (playlist pair-fetch + batch re-download):
// measured 3-12s per 1.7-3.4MB segment, while the same bytes straight from
// the CDN take ~1.3s. Playback consumes video ~2x faster than that — the
// buffer can NEVER fill, and the player spends nearly all of a 5-minute
// window rebuffering.
//
// THE FIX — caches.default: the per-COLO cache, shared by every isolate
// serving this datacenter. Two layers:
//   • unwrapped MPEG-TS segments, keyed by the UPSTREAM segment URL.
//     The DaddyLive edge serves each segment under a globally unique,
//     immutable, signed CDN URL that is byte-identical in every isolate's
//     listing parse — so the key needs NO channel/sn/generation bookkeeping
//     and is restart-safe by construction (a provider restart mints
//     brand-new URLs; recycled sn numbers can never collide).
//   • DaddyLive manifest bodies, keyed by manifest URL (the L2 promotion of
//     dledge's per-isolate micro-cache: a cold isolate adopts another
//     isolate's recent pair-fetch instead of re-rolling the token+manifest
//     403 roulette on its own egress IP).
//
// Cache API calls are NOT subrequests — they never touch the free plan's
// 50/invocation budget. Off-Workers (Vercel / dev) every helper degrades to
// a no-op and behavior is byte-identical to before.

import { ON_WORKERS } from './runtime';

/** minimal structural type — workerd's caches.default (not in DOM lib) */
type CacheLike = {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
  delete(key: Request): Promise<boolean>;
};

function colo(): CacheLike | null {
  if (!ON_WORKERS) return null;
  try {
    return (caches as unknown as { default?: CacheLike }).default || null;
  } catch {
    return null;
  }
}

/** keep a fire-and-forget cache write alive past the response — piggybacks
 *  the request's waitUntil (the thin API worker stashes its ctx in a global
 *  before dispatching; see worker/api-router.ts). Falls back to a detached
 *  promise when no ctx is around (dev / already-closed invocation). */
export function keepAlive(p: Promise<unknown>): void {
  const g = globalThis as { __maxtvWorkerCtx?: { waitUntil(p: Promise<unknown>): void } };
  const ctx = g.__maxtvWorkerCtx;
  if (ctx) {
    try {
      ctx.waitUntil(p);
      return;
    } catch {
      /* invocation already closed — detached write */
    }
  }
  void p.catch(() => {});
}

// ── segments (unwrapped MPEG-TS bytes) ──────────────────────────────────────

/** upstream segment URLs are long (~200+ chars of signed query) — hash the
 *  key down so cache keys stay short and collision-free. FNV-1a is fine
 *  (collision only means a wrong-bytes hit, so mix in 64 bits + length). */
function segKey(upstreamUrl: string): Request {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < upstreamUrl.length; i++) {
    const c = upstreamUrl.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 + c * (i + 7)) * 0x85ebca6b;
    h1 >>>= 0;
    h2 >>>= 0;
  }
  return new Request(
    `https://maxtv-colo.internal/useg/${h1.toString(36)}${h2.toString(36)}-${upstreamUrl.length}`,
    { method: 'GET' }
  );
}

/** segments stay servable for the whole served window (~60-72s) plus the
 *  browser's own 45s cache horizon — 120s of colo TTL covers both with
 *  margin while keeping the per-channel footprint bounded (~24MB). */
const SEG_TTL_S = 120;

/** fetch unwrapped segment bytes another isolate parked — null on miss */
export async function coloGetSeg(upstreamUrl: string): Promise<Uint8Array | null> {
  const c = colo();
  if (!c) return null;
  try {
    const hit = await c.match(segKey(upstreamUrl));
    if (!hit || hit.status !== 200) return null;
    const buf = new Uint8Array(await hit.arrayBuffer());
    // TS sanity gate — a corrupt/stale entry must degrade to a live fetch,
    // never reach the player's SourceBuffer
    return buf.length >= 188 && buf[0] === 0x47 ? buf : null;
  } catch {
    return null;
  }
}

/** park unwrapped segment bytes for every isolate at this colo (best effort) */
export function coloPutSeg(upstreamUrl: string, ts: Uint8Array): void {
  const c = colo();
  if (!c || ts.length < 188) return;
  try {
    const res = new Response(ts as unknown as BodyInit, {
      status: 200,
      headers: {
        'content-type': 'video/mp2t',
        'cache-control': `public, max-age=${SEG_TTL_S}`,
      },
    });
    keepAlive(c.put(segKey(upstreamUrl), res));
  } catch {
    /* best effort */
  }
}

// ── resolved upstream URL (channel+mirror → manifest URL + referer) ─────────

/** matches ensureUpstream's 2-min freshness window — a cold isolate adopts
 *  another isolate's recent resolve instead of re-running the whole
 *  resolve chain (embed pages / token+manifest pair, measured 0.5-4s per
 *  cold isolate — THE dominant cost of every request on the sprayed free
 *  plan). Purged on 3 consecutive manifest failures (edge rotation). */
const RESOLVE_TTL_S = 120;

export interface ColoResolved {
  url: string;
  referer: string;
}

function resolvedKey(channel: string, mirror: string): Request {
  return new Request(
    `https://maxtv-colo.internal/res/${encodeURIComponent(channel)}/${encodeURIComponent(mirror || '-')}`,
    { method: 'GET' }
  );
}

export async function coloGetResolved(channel: string, mirror: string): Promise<ColoResolved | null> {
  const c = colo();
  if (!c) return null;
  try {
    const hit = await c.match(resolvedKey(channel, mirror));
    if (!hit || hit.status !== 200) return null;
    const j = JSON.parse(await hit.text()) as ColoResolved;
    return typeof j?.url === 'string' && /^https:\/\//.test(j.url) && typeof j?.referer === 'string'
      ? j
      : null;
  } catch {
    return null;
  }
}

export function coloPutResolved(channel: string, mirror: string, r: ColoResolved): void {
  const c = colo();
  if (!c || !/^https?:\/\//.test(r.url)) return;
  try {
    const res = new Response(JSON.stringify(r), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'cache-control': `public, max-age=${RESOLVE_TTL_S}`,
      },
    });
    keepAlive(c.put(resolvedKey(channel, mirror), res));
  } catch {
    /* best effort */
  }
}

export function coloDeleteResolved(channel: string, mirror: string): void {
  const c = colo();
  if (!c) return;
  try {
    keepAlive(c.delete(resolvedKey(channel, mirror)));
  } catch {
    /* best effort */
  }
}

// ── DaddyLive manifest bodies ───────────────────────────────────────────────

function manKey(manifestUrl: string): Request {
  return new Request(`https://maxtv-colo.internal/man/${encodeURIComponent(manifestUrl)}`, {
    method: 'GET',
  });
}

/** fetch a manifest body another isolate pair-fetched recently — null on miss */
export async function coloGetManifest(manifestUrl: string): Promise<string | null> {
  const c = colo();
  if (!c) return null;
  try {
    const hit = await c.match(manKey(manifestUrl));
    if (!hit || hit.status !== 200) return null;
    const body = await hit.text();
    return body.includes('#EXTM3U') ? body : null;
  } catch {
    return null;
  }
}

/** park a verified #EXTM3U manifest body (TTL mirrors dledge's micro-cache —
 *  tokens are NEVER stored, only bodies, exactly like the L1 design) */
export function coloPutManifest(manifestUrl: string, body: string, ttlMs: number): void {
  const c = colo();
  if (!c) return;
  try {
    const res = new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/vnd.apple.mpegurl',
        'cache-control': `public, max-age=${Math.max(1, Math.ceil(ttlMs / 1000))}`,
      },
    });
    keepAlive(c.put(manKey(manifestUrl), res));
  } catch {
    /* best effort */
  }
}
