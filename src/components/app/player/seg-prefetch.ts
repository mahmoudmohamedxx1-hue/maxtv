'use client';

// ─── Segment prefetcher — the client half of the 2026-10-22 stall fix ────────
// Field report: "it keeps every 5-3 sec to stop to load on ANY quality".
// Measured on production (2026-10-22), channel 94:
//   • /api/turbo rung segments 404'd ("segment gone", ~300B) after 2.3-6.7s
//     of futile work whenever Vercel load-balanced the request to an isolate
//     that didn't share the warm instance's memory cache — the RIDE position
//     (5 segments back) is below the upstream listing floor, so a cold
//     isolate can never on-demand-fetch it.
//   • hls.js then burned its retry budget (1-8s backoff) while the buffer
//     drained → a visible spinner every few segments, on every rung.
//   • Source-rung segments through the /api/segdl server fallback take
//     1.6-2.7s EACH and hls.js loads them strictly one at a time —
//     throughput ≈ consumption, so any hiccup stalled playback.
//
// The fix (with the server half: s-maxage edge caching on /api/turbo and
// /api/segdl): decouple FETCH time from PLAY time. After every appended
// fragment and every playlist refresh, prefetch the next few segment URLs
// into an in-memory LRU; the custom hls.js loader serves them from that
// cache the instant hls.js asks. A cold-encode 404 or a slow fallback no
// longer sits on the critical path — it retries in the background with
// seconds of lead time, and once ANY attempt succeeds (isolate roulette now
// works FOR us: different isolates encode different segments in parallel,
// unified by the edge cache) the bytes are in the browser for good.
//
// Coverage: ladder-master sources only (URL-shape gated) —
//   • /api/turbo?...mode=seg...      (data-saver rungs + native turbo)
//   • /api/segdl?u=<cdn>             (Source rung; prefetch tries the CDN
//     DIRECT + in-browser unwrap first — offloads Vercel entirely — and
//     falls back to the same-origin route)

import Hls from 'hls.js';
import { unwrapSegmentBrowser } from '@/lib/player/uncloak-browser';
import { SEGDL_MARK, isDirectHost, segdlTarget } from './cdn-direct';

const TURBO_SEG_MARK = '/api/turbo?';

/** prefetch cache TTL — a segment is only useful while its playlist window
 *  (~60-72s) still lists it; 90s covers the deepest legal look-back. */
const TTL_MS = 90_000;
/** total bytes the cache may hold (segments: 144p ≈ 0.4MB … Source ≈ 2.7MB) */
const BYTES_BUDGET = 26 * 1024 * 1024;
/** concurrent background fetches — enough to parallelize the fallback path,
 *  small enough to never compete with hls.js's own loader for sockets */
const MAX_CONCURRENT = 3;
/** attempts per URL (spread across playlist refreshes ≈ every 5s) */
const MAX_ATTEMPTS = 5;
/** how far ahead of the just-appended fragment to prefetch (skipping the
 *  one hls.js is already loading itself) */
const AHEAD = 3;

/** is this a URL the prefetcher handles? (both ladder segment shapes) */
function isPrefetchableUrl(url: string): boolean {
  if (!url) return false;
  if (url.indexOf(SEGDL_MARK) !== -1) return true;
  return url.indexOf(TURBO_SEG_MARK) !== -1 && /[?&]mode=seg/.test(url) && /[?&]n=\d+/.test(url);
}

interface Entry {
  ts: Uint8Array;
  at: number;
  bytes: number;
}

const cache = new Map<string, Entry>();
let cacheBytes = 0;
const failures = new Map<string, { n: number; nextAt: number }>();
/** in-flight prefetch promises by URL — the loader JOINS these instead of
 *  racing them with a duplicate request (the duplicate wasted a second cold
 *  encode on another isolate and delayed both) */
const inflight = new Map<string, Promise<Uint8Array | null>>();
let active = 0;

/* debug counters — surfaced on window.__maxtvPrefetch for E2E inspection */
const dbg = { hits: 0, joined: 0, prefetched: 0, fails: 0 };

/** Pop a prefetched segment for the loader. Returns null on miss/expiry.
 *  Keyed by cacheKey() — session-churn-proof for segdl URLs. */
export function takeCachedSegment(url: string): Uint8Array | null {
  const ts = peekCache(url);
  if (ts) dbg.hits++;
  return ts;
}

/** cache peek without counters (shared by takeCachedSegment + awaitSegment) */
function peekCache(url: string): Uint8Array | null {
  const e = cache.get(cacheKey(url));
  if (!e) return null;
  if (Date.now() - e.at > TTL_MS) {
    cache.delete(cacheKey(url));
    cacheBytes -= e.bytes;
    return null;
  }
  return e.ts;
}

function store(url: string, ts: Uint8Array): void {
  const key = cacheKey(url);
  if (cache.has(key)) return;
  cache.set(key, { ts, at: Date.now(), bytes: ts.byteLength });
  cacheBytes += ts.byteLength;
  dbg.prefetched++;
  // LRU eviction — Map keeps insertion order; oldest first
  while (cacheBytes > BYTES_BUDGET && cache.size > 1) {
    const oldest = cache.keys().next().value as string;
    const e = cache.get(oldest);
    if (!e) break;
    cache.delete(oldest);
    cacheBytes -= e.bytes;
  }
}

/** unwrap a raw CDN payload the way the loader does (clean TS passes through) */
async function unwrapRaw(raw: Uint8Array): Promise<Uint8Array | null> {
  if (raw.length < 188) return null;
  if (raw[0] === 0x47 && raw[188] === 0x47) return raw;
  try {
    const ts = (await unwrapSegmentBrowser(raw)) as Uint8Array | null;
    return ts && ts.length >= 188 ? ts : null;
  } catch {
    return null;
  }
}

/** turbo segment: same-origin route (edge-cached server-side after the
 *  2026-10-22 fix — any isolate's first success parks it at the edge).
 *  cache mode left DEFAULT (not no-store): on the Workers deployment segments
 *  carry max-age=45, so the prefetched bytes land in the browser HTTP cache
 *  and hls.js's own fragment load reuses them — roughly halving segment
 *  requests against the free plan's 100k/day meter. On Vercel the response
 *  is max-age=0, making the default mode a no-op vs no-store. */
async function fetchTurboSegment(url: string): Promise<Uint8Array | null> {
  const res = await fetch(url, timeoutSignal());
  if (!res.ok) throw new Error(`turbo seg ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 188) throw new Error('tiny payload');
  return buf;
}

/** segdl segment: CDN-direct + in-browser unwrap first (zero server hops,
 *  the fastest path there is), same-origin route as the fallback */
async function fetchSegdlSegment(url: string): Promise<Uint8Array | null> {
  const target = segdlTarget(url);
  if (target && isDirectHost(target) && typeof DecompressionStream !== 'undefined') {
    try {
      const res = await fetch(target, { cache: 'no-store', ...timeoutSignal() });
      if (res.ok) {
        const ts = await unwrapRaw(new Uint8Array(await res.arrayBuffer()));
        if (ts) return ts;
      }
    } catch {
      /* fall through to the server route */
    }
  }
  // default cache mode (see fetchTurboSegment — same reasoning; the segdl
  // route is no-store server-side, so this is a behavioral no-op there)
  const res = await fetch(url, timeoutSignal());
  if (!res.ok) throw new Error(`segdl ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < 188) throw new Error('tiny payload');
  return buf;
}

/** 2026-10-22 audit hardening: an unbounded prefetch fetch that hangs (dead
 *  socket, blackholed CDN route) would hold its MAX_CONCURRENT slot and its
 *  inflight entry until the browser's own multi-minute TCP timeout — the
 *  whole prefetcher could stall behind it. A 20s abort bound turns that into
 *  an ordinary failure (recordFailure backoff + retry on the next trigger).
 *  Feature-detected: old browsers without AbortSignal.timeout simply skip
 *  the bound and keep the legacy behavior. */
function timeoutSignal(): { signal: AbortSignal } | Record<string, never> {
  try {
    return typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? { signal: AbortSignal.timeout(20_000) }
      : {};
  } catch {
    return {};
  }
}

function recordFailure(url: string): void {
  const cur = failures.get(url) || { n: 0, nextAt: 0 };
  cur.n++;
  cur.nextAt = Date.now() + 2_500 * cur.n; // backoff: 2.5s, 5s, 7.5s …
  failures.set(url, cur);
  dbg.fails++;
  if (failures.size > 300) {
    const it = failures.keys();
    for (let i = 0; i < 100; i++) {
      const v = it.next();
      if (v.done) break;
      failures.delete(v.value);
    }
  }
}

function prefetch(url: string): void {
  if (cache.has(cacheKey(url)) || inflight.has(url)) return;
  const f = failures.get(url);
  if (f && (f.n >= MAX_ATTEMPTS || Date.now() < f.nextAt)) return;
  if (active >= MAX_CONCURRENT) return; // next trigger (poll/frag) retries
  active++;
  const isSegdl = url.indexOf(SEGDL_MARK) !== -1;
  const p = (isSegdl ? fetchSegdlSegment(url) : fetchTurboSegment(url))
    .then((ts) => {
      if (ts && ts.length >= 188) {
        store(url, ts);
        failures.delete(url);
        return ts;
      }
      recordFailure(url);
      return null;
    })
    .catch(() => {
      recordFailure(url);
      return null;
    })
    .finally(() => {
      inflight.delete(url);
      active--;
    });
  inflight.set(url, p);
}

/** Join an in-flight prefetch for this URL (bounded wait). Returns the bytes
 *  when they land in time, null on miss/timeout/failure — the loader then
 *  falls through to its own network path. This is what turns hls.js's own
 *  sequential requests and the prefetcher's ahead-window into ONE encode per
 *  segment instead of racing duplicates on separate isolates. */
function awaitSegment(url: string, timeoutMs = 6_000): Promise<Uint8Array | null> {
  const hit = peekCache(url);
  if (hit) {
    dbg.joined++;
    return Promise.resolve(hit);
  }
  const p = inflight.get(url);
  if (!p) return Promise.resolve(null);
  return Promise.race([
    p.then((ts) => {
      if (ts && ts.length >= 188) dbg.joined++;
      return ts && ts.length >= 188 ? ts : null;
    }),
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);
}

/** the loader's entry point — join an in-flight prefetch, bounded. */
export function joinPrefetch(url: string, timeoutMs = 6_000): Promise<Uint8Array | null> {
  return awaitSegment(url, timeoutMs);
}

/** Cache identity for a segment URL.
 *  ⚠ segdl URLs embed the CDN's SIGNED URL — and the DaddyLive edge re-mints
 *  the whole segment URL space on every session recovery (/api/hls 403 →
 *  re-resolve → fresh signed URLs for the SAME objects). Keying by the full
 *  URL made every prefetched byte unreachable the moment a recovery fired
 *  mid-watch (measured: prefetched 26 / served 14 with periodic stalls —
 *  the churn window). The CDN OBJECT PATH (host + path, signature stripped)
 *  is stable across sessions and identifies the content: same object via a
 *  fresh session = same cache entry. Turbo URLs are n-keyed and stable —
 *  they key on themselves. */
function cacheKey(url: string): string {
  if (url.indexOf(SEGDL_MARK) !== -1) {
    const target = segdlTarget(url);
    if (target) {
      try {
        const u = new URL(target);
        return `${u.hostname}${u.pathname}`;
      } catch {
        /* fall through to the raw URL */
      }
    }
  }
  return url;
}

function prefetchUrls(urls: string[]): void {
  for (const u of urls) {
    if (isPrefetchableUrl(u)) prefetch(u);
  }
}

/**
 * Wire the prefetcher into a live hls.js instance (ladder sources only —
 * the URL gates make it a no-op for everything else). Call right after
 * `new Hls(...)`; the listeners die with the instance on destroy().
 */
export function attachSegPrefetch(hls: Hls): void {
  /** last appended sn per level — anchors the ahead-window */
  const lastSn = new Map<number, number>();

  const isTurboRung = (level: number): boolean => {
    const l = hls.levels?.[level];
    return !!l && !/raw=1/.test((l.url || []).join(''));
  };

  const prefetchAround = (level: number): void => {
    const details = hls.levels?.[level]?.details;
    if (!details?.fragments?.length) return;
    const frags = details.fragments;
    const last = lastSn.get(level);
    if (last !== undefined) {
      const i = frags.findIndex((f) => f.sn === last);
      if (i >= 0) {
        // skip +1 — hls.js is already loading it; prefetch +2..+4
        prefetchUrls(frags.slice(i + 2, i + 2 + AHEAD).map((f) => f.url));
        return;
      }
    }
    // fresh level (quality switch join): prefetch the ride band the switch
    // will land on — the join fragment itself plus the segments above it,
    // so the encode lead-time is spent BEFORE the flushed playhead arrives.
    // THROUGH THE TIP (no end bound): warmBandSwitch flushes the playhead to
    // live-edge−12s of the SOURCE buffer, but the rung's encode lags the
    // Source edge, so the landing position can be the rung's very TIP.
    // Measured 2026-10-22 (ch92, 360p pick): the band stopped at tip−1 —
    // hls.js JOINED that one, then its TIP request 404'd on a cold isolate
    // → retry backoff on an empty buffer → 22s stall cascade + ABR crash.
    // NEWEST-FIRST: the top of the band is both the likeliest landing spot
    // and the only segment that can still be mid-encode — it must win the
    // first MAX_CONCURRENT slots; the deeper ride positions fill in after.
    const ride = isTurboRung(level) ? 5 : 3;
    const join = Math.max(0, frags.length - ride);
    const band = frags.slice(Math.max(0, join - 1)).reverse();
    prefetchUrls(band.map((f) => f.url));
  };

  hls.on(Hls.Events.FRAG_BUFFERED, (_e, d) => {
    const frag = d.frag;
    if (!frag) return;
    const sn = typeof frag.sn === 'number' ? frag.sn : -1;
    if (sn < 0) return; // initSegment — not a media fragment
    lastSn.set(frag.level, sn);
    prefetchAround(frag.level);
  });
  // every live playlist refresh: top up the ahead-window and retry whatever
  // failed (isolate roulette + edge cache make later attempts cheap wins)
  hls.on(Hls.Events.LEVEL_UPDATED, (_e, d) => {
    prefetchAround(d.level);
  });

  if (typeof window !== 'undefined') {
    (window as unknown as { __maxtvPrefetch?: typeof dbg }).__maxtvPrefetch = dbg;
  }
}
