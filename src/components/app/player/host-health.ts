'use client';

// ─── Host-health tracker — the client half of the 2026-10-26 beIN lag fix ────
// ROOT CAUSE (measured on production, channel 91 = beIN Sports 1 Arabic):
// DaddyLive's CDN shards each channel's segments across several pNN hosts.
// Some shards are per-connection THROTLED on body transfer — measured
// p19-common-sign.tiktokcdn-us.com at 2-5.7 Mbps (p95 11.3s, max 45.6s for a
// 3.3MB segment) while the stream needs ~4.1 Mbps sustained; healthy shards
// (p16) deliver the same bytes in 0.7-1.3s. TTFB is fine on both — it is the
// BODY that is slow. When a hot channel's window lands on a throttled shard
// (ch91 measured 100% p19), the Source rung CANNOT sustain real-time and the
// player rebuffers every few segments. Signed URLs are host-bound (a p19 path
// on p16 answers 403), so the hostname cannot simply be rewritten.
//
// This module passively measures EVERY segment fetch (loader + prefetcher) and
// exposes an evidence-based "slow host" flag that drives three countermeasures
// (see uncloak-loader.ts / seg-prefetch.ts / PlayerOverlay.tsx):
//   • prefetch priority — slow-host segments start EARLIEST, absorbing the
//     throttle in lead time (zero extra server cost)
//   • rescue + race — a fetch that cannot land in time also goes through the
//     /api/segdl server route (the Worker colo's pipe to the CDN measured
//     4-10x faster than the throttled browser path), bounded by a budget so
//     the Workers free-plan request quota is never burned in bulk
//   • deeper ride — the player joins 4 segments back instead of 2-3, turning
//     the 6-segment window into absorb room instead of edge-hugging
//
// Everything is adaptive: no hardcoded host lists, per-viewer evidence,
// entries decay so a shard that recovers stops being treated as slow.

import { isDirectHost } from './cdn-direct';

/** EWMA weight — a new sample moves the estimate 30% of the way */
const EWMA_ALPHA = 0.3;
/** samples before a host is eligible for flagging (avoid 1-off judgments;
 *  2 not 3 — with ~10s segments on the slow shard, 3 samples means 30s+ of
 *  stalls before the countermeasures engage; 2 slow fetches is already
 *  strong evidence, and one fast fetch among them un-flags via the EWMA) */
const MIN_SAMPLES = 2;
/** a host whose EWMA fetch time exceeds this is SLOW (measured: healthy
 * shards 0.6-1.3s; throttled shards 4.3-4.6s avg — 2.5s splits the two
 * populations with margin on both sides) */
const SLOW_MS = 2_500;
/** evidence older than this is stale (shards recover; channel mix changes) */
const DECAY_MS = 5 * 60_000;
/** slow-shard knowledge persists across sessions for this long (field report
 *  2026-10-30: "streams are still laggy especially beIN" — every NEW session
 *  re-paid the 2-samples-before-engagement window, ~15s of stalls right after
 *  opening the channel, even though the previous session KNEW the shard was
 *  slow. Persisting the slow set makes session 2+ engage on the FIRST slow
 *  segment instead of the third. 10 min: long enough to cover channel-hop
 *  sessions, short enough that a recovered shard isn't haunted by old
 *  evidence — and the first 2-3 fast fetches pull the EWMA back down.) */
const PERSIST_TTL_MS = 10 * 60_000;
const STORE_KEY = 'maxtv:host-health:v1';
/** localStorage writes are throttled — no need to hit storage on every fetch */
const PERSIST_WRITE_MS = 15_000;

/** seed the evidence map from a previous session's slow set (lazy, once) */
let seeded = false;
function seedFromStorage(): void {
  if (seeded) return;
  seeded = true;
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as { at?: number; hosts?: Record<string, { ewmaMs?: number }> };
    if (!data?.hosts || typeof data.at !== 'number') return;
    if (Date.now() - data.at > PERSIST_TTL_MS) return;
    for (const [h, v] of Object.entries(data.hosts)) {
      if (typeof v?.ewmaMs === 'number' && v.ewmaMs > SLOW_MS) {
        hosts.set(h, { ewmaMs: v.ewmaMs, fails: 0, samples: MIN_SAMPLES, lastAt: Date.now() });
      }
    }
  } catch {
    /* corrupted/unavailable storage — persistence is best-effort */
  }
}

/** persist the current slow set. Writes are throttled CONTENT-aware: the
 *  first record of a session writes an (empty) baseline and must not consume
 *  the throttle window — the slow set is written the moment it CHANGES
 *  (host turns slow / recovers), and identical sets re-write at most once
 *  per window to refresh the `at` heartbeat. */
let lastWriteAt = 0;
let lastWrittenHosts = '';
function persistSlowSet(): void {
  if (typeof window === 'undefined') return;
  const now = Date.now();
  try {
    const slow: Record<string, { ewmaMs: number }> = {};
    for (const [h, st] of hosts) {
      if (st.samples >= MIN_SAMPLES && st.ewmaMs > SLOW_MS) slow[h] = { ewmaMs: Math.round(st.ewmaMs) };
    }
    const hostsJson = JSON.stringify(slow);
    if (hostsJson === lastWrittenHosts && now - lastWriteAt < PERSIST_WRITE_MS) return;
    lastWriteAt = now;
    lastWrittenHosts = hostsJson;
    window.localStorage.setItem(STORE_KEY, JSON.stringify({ at: now, hosts: slow }));
  } catch {
    /* storage full/blocked — best-effort */
  }
}
/** how many server-route fetches per rolling minute, PER POOL. Each one is a
 *  Workers invocation on the free plan's 100k/day meter, so both pools are
 *  bounded — but they are SEPARATE on purpose (A/B soak 2026-10-26: a shared
 *  pool let prefetch rescues starve the loader's critical-path races exactly
 *  when they were needed most — the playhead stalled the full throttle window
 *  and hls.js skipped to the live edge):
 *  • critical — the LOADER's race, fired at most once per fragment request
 *    (naturally bounded by playback rate ≈ 6-10/min)
 *  • rescue — the PREFETCHER's rescue, bounded harder (it has lead time; a
 *    declined rescue just means that segment arrives via the direct path) */
const CRITICAL_BUDGET_PER_MIN = 12;
const RESCUE_BUDGET_PER_MIN = 6;

interface HostStat {
  /** EWMA of successful fetch durations (ms) */
  ewmaMs: number;
  /** consecutive failures (failed fetches don't skew the EWMA — they route
   *  through the breaker/fallback machinery instead) */
  fails: number;
  samples: number;
  lastAt: number;
}

const hosts = new Map<string, HostStat>();
const criticalLog: number[] = [];
const rescueLog: number[] = [];
/** debug ring buffer — last 48 record calls (host, ms, ok) for E2E/diagnosis */
export const recordLog: Array<{ host: string; ms: number; ok: boolean; at: number }> = [];

/** rolling budget — critical-path races (loader) and prefetch rescues draw
 *  from SEPARATE pools so rescues can never starve the critical path. */
export function tryAcquireRaceSlot(kind: 'critical' | 'rescue' = 'critical'): boolean {
  const log = kind === 'rescue' ? rescueLog : criticalLog;
  const cap = kind === 'rescue' ? RESCUE_BUDGET_PER_MIN : CRITICAL_BUDGET_PER_MIN;
  const now = Date.now();
  while (log.length && now - log[0] > 60_000) log.shift();
  if (log.length >= cap) return false;
  log.push(now);
  return true;
}

function hostOf(url: string): string | null {
  try {
    return isDirectHost(url) ? new URL(url).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

function prune(): void {
  const now = Date.now();
  for (const [h, s] of hosts) {
    if (now - s.lastAt > DECAY_MS) hosts.delete(h);
  }
}

/** Record a segment fetch outcome. Call from every path that fetches a
 *  direct-host segment (loader direct hit/miss, prefetcher direct attempt).
 *  `ms` is the full fetch duration; failed fetches count toward `fails`
 *  (the breaker handles systemic death — the EWMA only tracks delivery speed).
 *  ⚠ ok=false must mean a NETWORK-level failure (fetch throw / !res.ok) —
 *  an unwrap failure (off-air placeholder image) is a CONTENT condition,
 *  independent of the host: recording those poisons healthy hosts (measured:
 *  p16 flagged slow during an ad-break phase because 6 placeholder PNGs
 *  failed to unwrap). Callers pass ok=true for delivered-but-undecodable. */
export function recordHostFetch(url: string, ms: number, ok: boolean): void {
  const h = hostOf(url);
  if (!h) return;
  seedFromStorage();
  recordLog.push({ host: h, ms: Math.round(ms), ok, at: Date.now() });
  if (recordLog.length > 48) recordLog.shift();
  const now = Date.now();
  const cur = hosts.get(h);
  if (!cur) {
    hosts.set(h, { ewmaMs: ok ? ms : 0, fails: ok ? 0 : 1, samples: ok ? 1 : 0, lastAt: now });
    persistSlowSet();
    return;
  }
  cur.lastAt = now;
  if (ok) {
    cur.ewmaMs = cur.ewmaMs > 0 ? cur.ewmaMs * (1 - EWMA_ALPHA) + ms * EWMA_ALPHA : ms;
    cur.samples++;
    cur.fails = 0;
  } else {
    cur.fails++;
  }
  persistSlowSet();
}

/** Is this segment's host measured-slow? (≥MIN_SAMPLES successes with a
 *  decaying EWMA over SLOW_MS, or ≥3 consecutive failures) */
export function isSlowHost(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  seedFromStorage();
  prune();
  const s = hosts.get(h);
  if (!s) return false;
  if (s.fails >= 3) return true;
  return s.samples >= MIN_SAMPLES && s.ewmaMs > SLOW_MS;
}

/** Any slow host seen recently? (drives the deeper ride posture) */
export function anySlowHost(): boolean {
  seedFromStorage();
  prune();
  for (const s of hosts.values()) {
    if ((s.samples >= MIN_SAMPLES && s.ewmaMs > SLOW_MS) || s.fails >= 3) return true;
  }
  return false;
}

/** Debug/E2E snapshot (surfaced on window.__maxtvStability by the player) */
export function hostHealthSnapshot(): Record<
  string,
  { ewmaMs: number; samples: number; fails: number; slow: boolean }
> {
  prune();
  const out: Record<string, { ewmaMs: number; samples: number; fails: number; slow: boolean }> = {};
  for (const [h, s] of hosts) {
    out[h] = {
      ewmaMs: Math.round(s.ewmaMs),
      samples: s.samples,
      fails: s.fails,
      slow: (s.samples >= MIN_SAMPLES && s.ewmaMs > SLOW_MS) || s.fails >= 3,
    };
  }
  return out;
}

/** test/E2E hook — wipe the evidence (memory + persisted store) */
export function resetHostHealth(): void {
  hosts.clear();
  criticalLog.length = 0;
  rescueLog.length = 0;
  seeded = true; // do not re-seed from storage after an explicit reset
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.removeItem(STORE_KEY);
    } catch {
      /* best-effort */
    }
  }
}
