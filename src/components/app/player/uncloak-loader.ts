'use client';

// ─── UncloakDirectLoader — hls.js fragment loader with CDN-direct playback ───
// The 2026-10-21 "loads every 5 seconds" root cause: every DaddyLive segment
// was proxied through a Vercel function (/api/hls → unwrap → browser), which
// added seconds of latency and burst-shaped delivery on the critical path —
// the buffer drained at every other segment window no matter which quality
// was selected (measured on production: ABR already at 144p and STILL
// rebuffering every ~15s; the same segments fetched directly from the TikTok
// CDN take 940-1700ms).
//
// This loader takes the segment URLs our /api/hls ladder playlist mints as
// `/api/segdl?u=<absolute-cdn-url>` and resolves them CLIENT-SIDE:
//   1. fetch <u> directly from the CDN (CORS-open, no token, any IP)
//   2. unwrap the PNG/WEBP steganography in-browser (uncloak-browser.ts)
//   3. hand the clean TS to hls.js
// Any failure (CORS shift, format change, decode error) falls back to the
// SAME /api/segdl URL via the normal network path — the server route fetches
// + unwraps + serves, i.e. the exact legacy behavior. Per-segment fallback,
// zero player-visible difference beyond the speed.
//
// 2026-10-22: the loader ALSO serves segments prefetched by seg-prefetch.ts
// (ladder rung + Source URLs) straight from the in-page cache — a prefetched
// segment reaches hls.js with ZERO network on the critical path.
//
// Non-segdl URLs (manifests, turbo-transcoded rungs, every other source)
// pass straight through to the default XhrLoader untouched (except the
// prefetch-cache check, which is URL-keyed and misses them harmlessly).

import Hls from 'hls.js';
import { unwrapSegmentBrowser } from '@/lib/player/uncloak-browser';
import { SEGDL_MARK, isDirectHost, segdlTarget } from './cdn-direct';
import { takeCachedSegment, joinPrefetch } from './seg-prefetch';
import { isSlowHost, recordHostFetch, tryAcquireRaceSlot } from './host-health';

/* ── direct-path circuit breaker ──────────────────────────────────────────────
 * When the direct path genuinely can't deliver (CDN drops CORS, a restrictive
 * network blocks it), every segment would otherwise pay a failed direct
 * attempt BEFORE the server fallback — an extra roundtrip on the critical
 * path, forever. Five consecutive failures trips the breaker for 2 minutes;
 * any success resets it. Intermittent flaps (one bad segment in ten) never
 * trip it because the consecutive counter resets on every success. */
const BREAKER_MAX_FAILS = 5;
const BREAKER_COOLDOWN_MS = 120_000;
const breaker = { fails: 0, openUntil: 0 };

function directPathOpen(): boolean {
  return breaker.fails < BREAKER_MAX_FAILS || Date.now() >= breaker.openUntil;
}

function recordDirect(ok: boolean): void {
  if (ok) {
    breaker.fails = 0;
    breaker.openUntil = 0;
  } else if (++breaker.fails >= BREAKER_MAX_FAILS) {
    breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
  }
}

/** is the CDN-direct path currently usable? (exported so the player can ride
 *  deeper when it's dead — the server fallback needs the runway) */
export function directPathHealthy(): boolean {
  return directPathOpen();
}

/** minimal LoaderStats-shaped object for an instantly-served segment */
function instantStats(bytes: number, start: number) {
  return {
    aborted: false,
    loaded: bytes,
    retry: 0,
    total: bytes,
    chunkCount: 1,
    bwEstimate: 0,
    loading: { start, first: start, end: start },
    parsing: { start, first: start, end: start },
    buffering: { start, first: start, end: start },
  };
}

// hls.js loader types are structural; we mirror the LoaderCallbacks /
// LoaderStats shapes by hand — hence the `any` throughout this class.

export class UncloakDirectLoader extends (Hls.DefaultConfig.loader as any) {
  private __abortCtrl: AbortController | null = null;
  /** bumped on every load()/abort() — a pending prefetch-join from a
   *  superseded request must never deliver into the new one */
  private __loadGen = 0;

  load(context: any, config: any, callbacks: any): void {
    const url: string = context?.url || '';
    // ⚠ hls.js ≥1.5 labels media fragments 'media-fragment' (older versions
    // sent 'fragment') — the strict 'fragment' check silently skipped the
    // direct path on every hls.js ≥1.5, routing ALL Source-rung segments
    // through the /api/segdl server fallback (2-7s per segment instead of
    // 133-412ms CDN-direct). Match both spellings; only segment URLs ever
    // carry the /api/segdl?u= mark, so the URL check stays the real gate.
    const ctxType: string = context?.type || '';
    const isFragmentLoad = ctxType === 'fragment' || ctxType.endsWith('fragment');
    const gen = ++this.__loadGen;
    if (isFragmentLoad) {
      // 2026-10-22: prefetched segment (ladder rungs + Source) → serve from
      // the in-page cache with zero network on the playhead's critical path
      const cached = takeCachedSegment(url);
      if (cached && cached.length >= 188) {
        const now = performance.now();
        callbacks.onSuccess({ url: context.url, data: cached }, instantStats(cached.length, now), context, null);
        return;
      }
    }
    const isSegdl = url.includes(SEGDL_MARK);
    // ⤴ 2026-10-26: a slow-host segment must NOT sit through a bounded
    // prefetch-join first — the in-flight prefetch is riding the same
    // throttled shard (≥10s in the A/B soak), the join would time out at 6s,
    // and the fallback would start a SECOND full-throttle fetch: 16s on the
    // critical path instead of a ~3s raced server leg. Slow hosts skip the
    // join entirely and go straight to the race below.
    const segTarget = isSegdl ? segdlTarget(url) : null;
    const slowSeg = !!(segTarget && directPathOpen() && isSlowHost(segTarget));
    if (isFragmentLoad && !slowSeg && !(isSegdl && directPathOpen())) {
      // no cached bytes yet — JOIN an in-flight prefetch for this URL
      // (bounded) instead of racing it with a duplicate request. hls.js's
      // own sequential loads and the prefetcher's ahead-window then share
      // ONE encode per segment (measured pre-fix: every rung segment fetched
      // twice, the duplicate burning a second cold encode on another
      // isolate). Healthy-CDN segdl loads skip the join — the direct fetch
      // is faster than any wait.
      void this.__joinThenLoad(context, config, callbacks, url, gen);
      return;
    }
    if (isFragmentLoad && isSegdl && directPathOpen()) {
      const target = segdlTarget(url);
      if (target && isDirectHost(target) && typeof DecompressionStream !== 'undefined') {
        // ⤴ 2026-10-26 beIN lag fix: a segment sitting on a MEASURED-SLOW CDN
        // shard (host-health EWMA > 2.5s — see host-health.ts) cannot land in
        // time on the critical path. Race the browser-direct fetch against the
        // /api/segdl server route (the Worker colo's pipe to the CDN measured
        // 4-10x faster than the throttled browser path, and the route parks the
        // unwrapped bytes in the colo Cache API for every later viewer).
        // First VALIDATED segment wins; the loser is aborted. The critical
        // pool is separate from the prefetcher's rescue pool so prefetch
        // rescues can never starve the critical path.
        if (isSlowHost(target) && tryAcquireRaceSlot('critical')) {
          void this.__loadRaced(context, config, callbacks, target, url);
          return;
        }
        void this.__loadDirect(context, config, callbacks, target);
        return;
      }
    }
    super.load(context, config, callbacks);
  }

  /** await an in-flight prefetch for `url`; serve it when it lands in time,
   *  otherwise fall through to the direct/super paths. */
  private async __joinThenLoad(
    context: any,
    config: any,
    callbacks: any,
    url: string,
    gen: number
  ): Promise<void> {
    let ts: Uint8Array | null = null;
    try {
      ts = await joinPrefetch(url, 6_000);
    } catch {
      ts = null;
    }
    if (gen !== this.__loadGen) return; // superseded (abort / new load)
    if (ts && ts.length >= 188) {
      const now = performance.now();
      callbacks.onSuccess({ url: context.url, data: ts }, instantStats(ts.length, now), context, null);
      return;
    }
    const isSegdl = url.includes(SEGDL_MARK);
    if (isSegdl) {
      const target = segdlTarget(url);
      if (directPathOpen() && target && isDirectHost(target) && typeof DecompressionStream !== 'undefined') {
        void this.__loadDirect(context, config, callbacks, target);
        return;
      }
    }
    try {
      super.load(context, config, callbacks);
    } catch {
      /* loader destroyed mid-switch — nothing to do */
    }
  }

  abort(): void {
    this.__loadGen++; // pending prefetch-joins must not deliver
    this.__abortCtrl?.abort();
    this.__abortCtrl = null;
    super.abort();
  }

  private async __loadDirect(
    context: any,
    config: any,
    callbacks: any,
    target: string
  ): Promise<void> {
    const start = performance.now();
    const ctrl = new AbortController();
    this.__abortCtrl = ctrl;
    let directOk = false;
    // delivery vs decode: a 200 whose payload fails to unwrap is a CONTENT
    // condition (off-air placeholder), not a host failure — it must not poison
    // host-health or the breaker (measured: an ad-break phase flagged the
    // FAST shard slow via 6 placeholder PNGs)
    let delivered = false;
    try {
      const res = await fetch(target, {
        cache: 'no-store',
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`cdn ${res.status}`);
      const raw = new Uint8Array(await res.arrayBuffer());
      delivered = true;
      const firstByte = performance.now();
      if (raw.length < 188) throw new Error('empty segment');
      // clean TS passes through; cloaked payloads unwrap in-browser
      const ts =
        raw[0] === 0x47 && raw[188] === 0x47 ? raw : ((await unwrapSegmentBrowser(raw)) as Uint8Array | null);
      if (!ts || ts.length < 188) throw new Error('unwrap failed');
      const end = performance.now();

      const stats = {
        aborted: false,
        loaded: ts.length,
        retry: 0,
        total: ts.length,
        chunkCount: 1,
        bwEstimate: 0,
        loading: { start, first: firstByte, end },
        parsing: { start: end, first: end, end },
        buffering: { start: end, first: end, end },
      };
      // segment response — hls.js accepts Uint8Array fragment payloads
      directOk = true;
      recordDirect(true);
      recordHostFetch(target, end - start, true);
      callbacks.onSuccess({ url: context.url, data: ts }, stats, context, null);
    } catch {
      /* fall through to the server fallback below */
      // aborted loads (channel/quality change) are not direct-path failures;
      // a DELIVERED but undecodable payload is a content condition, not a
      // transport failure — neither counts against the host
      if (!ctrl.signal.aborted && !delivered) {
        recordDirect(false);
        recordHostFetch(target, performance.now() - start, false);
      }
    } finally {
      if (this.__abortCtrl === ctrl) this.__abortCtrl = null;
    }
    if (!directOk && !ctrl.signal.aborted) {
      // any failure → the server-side segdl route (fetch + unwrap + serve —
      // the exact legacy proxy behavior, on the same URL the player holds)
      try {
        super.load(context, config, callbacks);
      } catch {
        /* loader destroyed mid-switch — nothing to do */
      }
    }
  }

  /** SLOW-HOST RACE — direct fetch vs the /api/segdl server route, first
   *  validated segment wins, loser aborted. The server leg rides the Worker
   *  colo's fat pipe to the CDN (measured 4-10x faster than a throttled
   *  shard's browser path) and its response is colo-cached (Cache API) so
   *  every later viewer of the same segment is near-instant. Only fires for
   *  hosts with ≥3 slow measurements, inside the per-minute race budget. */
  private async __loadRaced(
    context: any,
    config: any,
    callbacks: any,
    target: string,
    segdlUrl: string
  ): Promise<void> {
    const start = performance.now();
    const ctrl = new AbortController();
    this.__abortCtrl = ctrl;
    let settled = false;
    const finish = (ts: Uint8Array, via: 'direct' | 'server') => {
      if (settled || ctrl.signal.aborted) return;
      settled = true;
      ctrl.abort(); // kill the losing fetch
      const now = performance.now();
      const stats = {
        aborted: false,
        loaded: ts.length,
        retry: 0,
        total: ts.length,
        chunkCount: 1,
        bwEstimate: 0,
        loading: { start, first: start + (now - start) / 2, end: now },
        parsing: { start: now, first: now, end: now },
        buffering: { start: now, first: now, end: now },
      };
      if (via === 'direct') {
        recordDirect(true);
        recordHostFetch(target, now - start, true);
      } else {
        // server leg won: the direct shard was (again) too slow — count it as
        // slow-host evidence so the flag stays warm, but NOT as a direct-path
        // breaker failure (the direct path technically works, it's just slow)
        recordHostFetch(target, now - start + 2_500, true);
      }
      callbacks.onSuccess({ url: context.url, data: ts }, stats, context, null);
    };

    // leg 1 — browser-direct (same validation as __loadDirect)
    const directLeg = (async () => {
      try {
        const res = await fetch(target, { cache: 'no-store', signal: ctrl.signal, redirect: 'follow' });
        if (!res.ok) throw new Error(`cdn ${res.status}`);
        const raw = new Uint8Array(await res.arrayBuffer());
        if (raw.length < 188) throw new Error('empty segment');
        const ts =
          raw[0] === 0x47 && raw[188] === 0x47 ? raw : ((await unwrapSegmentBrowser(raw)) as Uint8Array | null);
        if (ts && ts.length >= 188) finish(ts, 'direct');
      } catch {
        /* the other leg decides */
      }
    })();

    // leg 2 — the server route (same-origin /api/segdl URL the player holds)
    const serverLeg = (async () => {
      try {
        const res = await fetch(segdlUrl, { cache: 'no-store', signal: ctrl.signal });
        if (!res.ok) throw new Error(`segdl ${res.status}`);
        const ts = new Uint8Array(await res.arrayBuffer());
        if (ts.length >= 188 && ts[0] === 0x47) finish(ts, 'server');
      } catch {
        /* the other leg decides */
      }
    })();

    // wait for BOTH legs (the winner's finish() aborts the loser, so the
    // loser settles immediately; allSettled never hangs on a dead leg)
    await Promise.allSettled([directLeg, serverLeg]);
    // neither leg produced a valid segment in time → behave exactly like a
    // direct failure: full server fallback through the normal loader path
    if (!settled && !ctrl.signal.aborted) {
      try {
        super.load(context, config, callbacks);
      } catch {
        /* loader destroyed mid-switch — nothing to do */
      }
    }
  }
}
