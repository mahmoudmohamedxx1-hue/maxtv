// ─── DaddyLive EDGE paired token+manifest fetcher ────────────────────────────
// The DaddyLive premium edge (edge.cowedd4855ws.sbs) gates its playlist
// behind TWO checks, verified live on 2026-10-20:
//
//   1. ORIGIN ALLOWLIST — every request to the edge must carry
//      Origin ∈ { https://dembed.st, https://daddyliveplayer.st, https://dlive.sx }
//      Without it the edge answers 403 "forbidden" — from ANY IP, datacenter
//      or residential. (This is what actually broke the server-side
//      transports: /api/proxy, cloudflare-worker.js and the streaming layer
//      never sent an Origin header, so every fetch 403'd and the edge was
//      misdiagnosed as "blocking all datacenter IPs".)
//
//   2. IP-BOUND PLAYLIST TOKEN — GET /api/playlist-token?slug=premium<N>
//      returns a short-lived token (ttl ~120s) bound to the REQUESTER'S IP.
//      The manifest request must then carry ?t=<token> AND originate from
//      that same IP, otherwise 403 "token required".
//      → The token and the manifest MUST be fetched back-to-back from the
//        SAME serverless invocation (one invocation = one egress IP).
//        Tokens are therefore NEVER cached across invocations.
//
// Segments referenced by the manifest are absolute, long-signed TikTok-CDN
// URLs with `access-control-allow-origin: *` and no gate of their own —
// they need no token, no Origin and work from any IP. The manifest body
// itself is plain text, so caching IT briefly across invocations is safe.
//
// Fallbacks, in order:
//   1. direct paired fetch from the current runtime (default — same
//      invocation, same egress IP, works from datacenter IPs)
//   2. CF_PROXY_URL — an operator-deployed Cloudflare Worker with the
//      paired `dlslug`/`dlpath` mode (one worker invocation = one egress IP)
//
// Retries: the pair is re-fetched (token AND manifest together) a few times
// with a short jitter — hosts with rotating egress pools (some clouds NAT
// per-connection) can split the pair across IPs; a retry re-rolls the dice.
//
// 2026-10-20 — MANIFEST MICRO-CACHE: hls.js re-polls the live playlist every
// ~1 target duration (~6s on this CDN) and every poll used to burn a full
// token+manifest pair on the edge. A TTL cache of HALF the target duration
// (clamped 2–6s, parsed from #EXTINF) answers ~half of the polls from
// memory — and with multi-view panes / concurrent viewers on the same
// channel in one isolate, far more. A stale-by-≤-half-a-segment manifest is
// safe: the CDN keeps ~3–6 segments in the window and segment URLs stay
// fetchable long after leaving the playlist, so hls.js catches up on the
// next refresh. Tokens are NEVER cached; only verified 200-OK #EXTM3U
// bodies. Concurrent requests for the same manifest coalesce (single-flight),
// so a 4-pane grid or a viewer burst costs ONE pair-fetch per window.

import { UA } from './resolve';
import { ON_WORKERS } from './runtime';
import { coloGetManifest, coloPutManifest, keepAlive } from './colocache';

/** the premium edge host — updatable when the resolve layer learns a new one */
let edgeHost = 'edge.cowedd4855ws.sbs';

/** Origin values the edge accepts (allowlist, verified 2026-10-20) */
const DL_ORIGIN = 'https://dembed.st';

const CF_PROXY_URL = process.env.CF_PROXY_URL || '';

export function setDlEdgeHost(host: string): void {
  const clean = host.trim().toLowerCase();
  if (clean && clean !== edgeHost) {
    const rotation: DlEdgeRotation = { from: edgeHost, to: clean, at: Date.now() };
    edgeHost = clean;
    // rotation ALERTING — the edge hostname drifts periodically; every
    // downstream consumer (paired fetch, health probes, session recovery)
    // depends on it. Surface the change loudly at the source and keep a log
    // for /api/diagnostics + the player stats overlay.
    rotations.unshift(rotation);
    if (rotations.length > 20) rotations.length = 20;
    console.warn(
      `[maxtv] DaddyLive edge host ROTATED: ${rotation.from} → ${rotation.to} (${new Date(rotation.at).toISOString()})`
    );
  }
}

export function getDlEdgeHost(): string {
  return edgeHost;
}

/** one edge-host rotation event (newest first) */
export interface DlEdgeRotation {
  from: string;
  to: string;
  at: number;
}

// ── edge-host rotation log (globalThis-persisted across warm invocations) ────
const rotG = globalThis as { __maxtvDlRotations?: DlEdgeRotation[] };
if (!rotG.__maxtvDlRotations) rotG.__maxtvDlRotations = [];
const rotations = rotG.__maxtvDlRotations;

// ── manifest micro-cache (bodies only; tokens never) ─────────────────────────
interface ManifestCacheEntry {
  body: string;
  at: number;
  ttlMs: number;
}
const CACHE_MAX_ENTRIES = 512; // ~512 channels' live playlists (a few KB each)
const cacheG = globalThis as {
  __maxtvDlManifestCache?: Map<string, ManifestCacheEntry>;
  __maxtvDlInflight?: Map<string, Promise<DlPlaylistResult | null>>;
  /** when each inflight pair-fetch started — zombie detection (an invocation
   *  killed mid-pair leaves its inflight entry forever without a timestamped
   *  escape, every later fetch for that manifest would coalesce onto a
   *  promise that never settles) */
  __maxtvDlInflightAt?: Map<string, number>;
  __maxtvDlCacheStats?: { hits: number; misses: number; coalesced: number; savedPairs: number };
};
if (!cacheG.__maxtvDlManifestCache) cacheG.__maxtvDlManifestCache = new Map();
if (!cacheG.__maxtvDlInflight) cacheG.__maxtvDlInflight = new Map();
if (!cacheG.__maxtvDlInflightAt) cacheG.__maxtvDlInflightAt = new Map();
if (!cacheG.__maxtvDlCacheStats) cacheG.__maxtvDlCacheStats = { hits: 0, misses: 0, coalesced: 0, savedPairs: 0 };
const manifestCache = cacheG.__maxtvDlManifestCache;
const inflight = cacheG.__maxtvDlInflight;
const inflightAt = cacheG.__maxtvDlInflightAt;
const cacheStats = cacheG.__maxtvDlCacheStats;

/** micro-cache TTL: ~1.6× the playlist's target duration, clamped 4–10s.
 *  hls.js polls a live playlist roughly once per target duration (measured
 *  ~3.6s polls on this CDN's ~3s segments; ~6s on 6s segments). A TTL above
 *  one poll interval but below two produces the alternating hit/miss cadence:
 *  a miss refreshes the entry, the NEXT poll hits it, the one after misses —
 *  ≈50% of edge pair-fetches eliminated for a single viewer ("halves edge
 *  requests"), and far more when several viewers/panes share a channel
 *  (single-flight coalesces their concurrent polls too). Max staleness is
 *  ~1.6 segments — safe: the CDN window holds ~3-6 segments and segment URLs
 *  stay fetchable after leaving the playlist, so hls.js catches up on the
 *  next refresh.
 *  ⤴ WORKERS 2026-10-23: clamped MUCH shorter (2.5-4s). The isolate-spray
 *  means L1 rarely serves consecutive polls anyway, and the served window's
 *  TIP can only advance when a FRESH listing is parsed — the 4-10s clamp
 *  throttled tip advancement to ~1x real-time (measured 0.87x end-to-end:
 *  the player's buffer could never get AHEAD, so every hiccup became a
 *  rebuffer). A pair costs only ~0.3-1s from a colo (measured) — paying it
 *  (nearly) every poll buys catch-up bursts that push delivery >1x. */
function ttlFromBody(body: string): number {
  const m = body.match(/#EXTINF:([0-9.]+)/);
  const dur = m ? parseFloat(m[1]) : 0;
  if (!dur || !Number.isFinite(dur)) return ON_WORKERS ? 3000 : 6000;
  if (ON_WORKERS) return Math.min(4000, Math.max(2500, dur * 1000 * 0.8));
  return Math.min(10000, Math.max(4000, dur * 1000 * 1.6));
}

function cacheGet(url: string): ManifestCacheEntry | null {
  const hit = manifestCache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > hit.ttlMs) {
    manifestCache.delete(url);
    return null;
  }
  // LRU-ish: re-insert so recently-used entries survive eviction
  manifestCache.delete(url);
  manifestCache.set(url, hit);
  return hit;
}

function cachePut(url: string, body: string, promoteToColo = true): void {
  if (manifestCache.size >= CACHE_MAX_ENTRIES) {
    // evict the oldest entry (first key of the insertion-ordered Map)
    const oldest = manifestCache.keys().next().value;
    if (oldest !== undefined) manifestCache.delete(oldest);
  }
  const ttlMs = ttlFromBody(body);
  manifestCache.set(url, { body, at: Date.now(), ttlMs });
  // ⤴ WORKERS 2026-10-23 L2 promotion: park freshly PAIR-FETCHED bodies in
  // the COLO cache so every OTHER isolate at this datacenter (the free plan
  // sprays requests across them) adopts them instead of re-rolling the
  // token+manifest pair on its own egress IP. TTL mirrors L1 (4-10s): a
  // longer L2 TTL made the window advance in bursts and lag the live edge;
  // equal TTLs give the smooth hit/miss cadence the design intended — one
  // pair per window per colo, amortized across all isolates' polls.
  // ⚠ promoteToColo=false on the L2-HIT path: re-promoting there would
  // refresh L2's TTL on every hit and the manifest would NEVER expire (the
  // "window froze at 4 segments" bug — a permanently stale listing served
  // forever, no new segments ever parsed).
  if (promoteToColo) coloPutManifest(url, body, ttlMs);
}

/** operator/monitoring view: edge host, rotation log, cache effectiveness */
export interface DlEdgeDiagnostics {
  edgeHost: string;
  rotations: DlEdgeRotation[];
  /** true when the edge host rotated within the last 10 minutes */
  rotating: boolean;
  cache: {
    size: number;
    hits: number;
    misses: number;
    /** requests coalesced into an already-running pair-fetch */
    coalesced: number;
    /** estimated edge pair-fetches avoided (hits + coalesced) */
    savedPairs: number;
    hitRate: string;
  };
}

export function getDlEdgeDiagnostics(): DlEdgeDiagnostics {
  const total = cacheStats.hits + cacheStats.misses;
  return {
    edgeHost,
    rotations: [...rotations],
    rotating: rotations.length > 0 && Date.now() - rotations[0].at < 10 * 60_000,
    cache: {
      size: manifestCache.size,
      hits: cacheStats.hits,
      misses: cacheStats.misses,
      coalesced: cacheStats.coalesced,
      savedPairs: cacheStats.savedPairs,
      hitRate: total > 0 ? `${Math.round((cacheStats.hits / total) * 100)}%` : 'n/a',
    },
  };
}

/** True for premium-edge manifest URLs we can token-fetch:
 *  https://edge.cowedd4855ws.sbs/premium<N>/…m3u8 */
export function isDaddyLiveEdgeManifest(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== edgeHost) return false;
    return /\/premium\d+\/[^?]*\.m3u8?(\?|$)/i.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

/** extract the slug ("premium<N>") from an edge manifest URL */
function slugFor(url: string): string | null {
  const m = url.match(/\/(premium\d+)\//i);
  return m ? m[1] : null;
}

export interface DlPlaylistResult {
  ok: boolean;
  status: number;
  body?: string;
  finalUrl: string;
  /** true when served from the micro-cache (no edge request was made) */
  cached?: boolean;
}

interface DlFetchOptions {
  /** total attempts for the token+manifest pair (default 4 — NAT pools that
   *  split the pair across egress IPs fail ~50%/attempt in the worst case;
   *  4 attempts leaves <7% compound failure, and hls.js's own manifest
   *  retry budget absorbs the rest) */
  attempts?: number;
  /** per-request timeout in ms (default 5000) */
  timeoutMs?: number;
  /** background health PROBE — bypass the micro-cache both ways: probes of
   *  hundreds of channels would otherwise evict the manifests actively
   *  watched streams rely on (the E2E-observed 3% hit-rate thrash) */
  skipCache?: boolean;
}

/** one token fetch — returns the token string or null */
async function fetchToken(
  slug: string,
  timeoutMs: number
): Promise<string | null> {
  try {
    const res = await fetch(`https://${edgeHost}/api/playlist-token?slug=${encodeURIComponent(slug)}`, {
      headers: dlHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { token?: string };
    return typeof j.token === 'string' && j.token ? j.token : null;
  } catch {
    return null;
  }
}

/** one manifest fetch with ?t=token — returns status + body */
async function fetchManifest(
  url: string,
  token: string,
  timeoutMs: number
): Promise<{ status: number; body: string } | null> {
  try {
    const u = new URL(url);
    u.searchParams.set('t', token);
    const res = await fetch(`https://${edgeHost}${u.pathname}${u.search}`, {
      headers: dlHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      cache: 'no-store',
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/** headers the edge expects: UA + allowlisted Origin (+ Referer for realism) */
function dlHeaders(): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: '*/*',
    Origin: DL_ORIGIN,
    Referer: `${DL_ORIGIN}/`,
  };
}

/**
 * Fetch a DaddyLive premium-edge playlist with a fresh paired token.
 * The token is fetched and used from the SAME invocation (same egress IP);
 * on any 403 the WHOLE pair is retried. Never caches tokens.
 *
 * When CF_PROXY_URL is set, the pair is delegated to the operator's
 * Cloudflare Worker (`?dlslug=&dlpath=` paired mode — one worker invocation
 * = one egress IP for both legs).
 *
 * Returns { ok: true, body } on a 200 #EXTM3U, { ok: false, status } on a
 * definitive upstream answer (404/410 = dead channel), or null when the
 * edge could not be reached at all.
 */
export async function fetchDaddyLivePlaylist(
  manifestUrl: string,
  opts: DlFetchOptions = {}
): Promise<DlPlaylistResult | null> {
  if (!isDaddyLiveEdgeManifest(manifestUrl)) return null;
  const slug = slugFor(manifestUrl);
  if (!slug) return null;

  const attempts = Math.max(1, opts.attempts ?? 4);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const u = new URL(manifestUrl);
  const manifestPath = u.pathname + u.search;

  // ── micro-cache fast path (bodies only — tokens are never cached) ───────
  // Probes (skipCache) bypass both directions: a probe answer is one-shot.
  if (!opts.skipCache) {
    const hit = cacheGet(manifestUrl);
    if (hit) {
      cacheStats.hits++;
      cacheStats.savedPairs++;
      return { ok: true, status: 200, body: hit.body, finalUrl: manifestUrl, cached: true };
    }
    // ⤴ WORKERS 2026-10-23 L2 (colo-shared): no in-memory entry on THIS
    // isolate, but a sibling isolate at this colo may have pair-fetched
    // within the TTL — adopt its body and repopulate our L1 so the next
    // poll is a pure memory hit. Still no tokens: bodies only, exactly
    // like L1. This kills the cold-isolate token+manifest 403 roulette
    // (the free plan sprays polls across isolates; each used to re-pay
    // the pair on its own egress IP).
    if (ON_WORKERS) {
      const coloBody = await coloGetManifest(manifestUrl);
      if (coloBody) {
        // repopulate THIS isolate's L1 only — NEVER re-promote to L2 (that
        // would refresh the L2 TTL on every hit and freeze the manifest
        // stale forever)
        cachePut(manifestUrl, coloBody, false);
        cacheStats.hits++;
        cacheStats.savedPairs++;
        return { ok: true, status: 200, body: coloBody, finalUrl: manifestUrl, cached: true };
      }
    }
    // single-flight: a pair-fetch for this exact manifest is already running
    // (multi-view panes, concurrent viewers) — ride its result instead of
    // hitting the edge with a duplicate token request. ⤴ ZOMBIE GUARD: only
    // coalesce onto a pair younger than any legitimate pair can be — a pair
    // abandoned by invocation death never settles and would freeze this
    // isolate's manifest fetch forever.
    const running = inflight.get(manifestUrl);
    if (running) {
      const startedAt = inflightAt.get(manifestUrl) ?? 0;
      if (startedAt && Date.now() - startedAt < 12_000) {
        cacheStats.coalesced++;
        cacheStats.savedPairs++;
        return running;
      }
      inflight.delete(manifestUrl);
      inflightAt.delete(manifestUrl);
    }
  }
  const pairFetch = runPairFetch(manifestUrl, slug, manifestPath, attempts, timeoutMs, !!opts.skipCache).finally(() => {
    inflight.delete(manifestUrl);
    inflightAt.delete(manifestUrl);
  });
  if (!opts.skipCache) {
    inflight.set(manifestUrl, pairFetch);
    inflightAt.set(manifestUrl, Date.now());
    cacheStats.misses++;
  }
  // ⤴ Workers: sponsor the pair past the response (workerd cancels
  // unsponsored I/O at invocation end — see colocache.keepAlive)
  keepAlive(pairFetch.catch(() => {}));
  return pairFetch;
}

/** the real token+manifest pair (or CF-worker delegation), single-flighted */
async function runPairFetch(
  manifestUrl: string,
  slug: string,
  manifestPath: string,
  attempts: number,
  timeoutMs: number,
  skipStore: boolean
): Promise<DlPlaylistResult | null> {
  let lastStatus = 0;

  // ── CF-worker delegated pair ─────────────────────────────────────────────
  if (CF_PROXY_URL) {
    const base = CF_PROXY_URL.replace(/\/$/, '');
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 90 + Math.random() * 160));
      try {
        const res = await fetch(
          `${base}?dlslug=${encodeURIComponent(slug)}&dlpath=${encodeURIComponent(manifestPath)}`,
          {
            headers: { 'User-Agent': UA, Accept: '*/*' },
            signal: AbortSignal.timeout(timeoutMs + 4000),
            redirect: 'follow',
            cache: 'no-store',
          }
        );
        const body = await res.text();
        lastStatus = res.status;
        if (res.status === 200 && body.includes('#EXTM3U')) {
          if (!skipStore) cachePut(manifestUrl, body);
          return { ok: true, status: 200, body, finalUrl: manifestUrl };
        }
        if (res.status === 404 || res.status === 410) {
          return { ok: false, status: res.status, finalUrl: manifestUrl };
        }
      } catch {
        lastStatus = 0;
      }
    }
    return { ok: false, status: lastStatus, finalUrl: manifestUrl };
  }

  // ── direct pair from this invocation ─────────────────────────────────────
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 90 + Math.random() * 160));

    const token = await fetchToken(slug, Math.min(timeoutMs, 3000));
    if (!token) {
      lastStatus = 403;
      continue;
    }
    const res = await fetchManifest(manifestUrl, token, timeoutMs);
    if (!res) {
      lastStatus = 0;
      continue;
    }
    lastStatus = res.status;
    if (res.status === 200 && res.body.includes('#EXTM3U')) {
      if (!skipStore) cachePut(manifestUrl, res.body);
      return { ok: true, status: 200, body: res.body, finalUrl: manifestUrl };
    }
    // 404/410 = the channel genuinely does not exist on this edge — definitive
    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, finalUrl: manifestUrl };
    }
    // 403 = token/IP mismatch (egress IP rotated between the pair) → retry pair
  }
  return { ok: false, status: lastStatus, finalUrl: manifestUrl };
}
