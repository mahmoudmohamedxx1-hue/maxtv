// ─── Turbo transport v2 — serverless-proof prefetch relay ─────────────────────
// The benchmark verdict (scripts/bench-transports.mjs, 2026-09-28):
//   • direct  — starts in ~0.4s but every segment fetch pays the CDN latency
//               (p95 3.1s) → the player's critical path IS the flaky edge
//   • relay   — segment serving is instant (local disk, ~190ms) but the ffmpeg
//               transcode warmup takes 20s+ and eats both CPU cores
// Turbo combines the two: NO ffmpeg (no warmup, no CPU war) + a server-side
// rolling prefetch that stays ahead of the client, so the browser only ever
// reads warm local bytes.
//
// v2 (2026-10-01) — the Vercel field report: "servers are the same slow and
// lag". Root cause: serverless isolates FREEZE between HTTP requests, so the
// 1.5s polling interval never fired — the served media-sequence sat frozen at
// its startup value (measured: mseq=1 across 5 polls) and playback stalled
// out ~20s in. Three structural fixes:
//
//   1. INLINE KICK — every playlist request awaits one pass (bounded) before
//      serving, so the session advances on the player's own poll cadence
//      (~6s) even when the isolate froze in between. No timer required.
//   2. UPSTREAM-SN IDENTITY — segments are numbered by the UPSTREAM
//      media-sequence, not a per-session counter. Any instance serving the
//      same channel now produces IDENTICAL playlist coordinates (same mseq,
//      same sn space), so a Vercel load-balance hop between instances is a
//      no-op for the player instead of a fatal session reset.
//   3. CROSS-INSTANCE ON-DEMAND — a segment request landing on an instance
//      that doesn't have those bytes (cache miss by instance flap) triggers
//      an inline refresh + direct upstream fetch instead of a 404.
//
//   upstream m3u8 ──kick on every playlist poll──▶ sn-dedup ──▶ parallel
//        prefetch (3 ahead) ──▶ unwrap cloaked TS ──▶ memory cache ──▶
//        /api/turbo serves a clean local playlist (upstream sn, up to 12
//        segments ≈ 60-72s of runway, discontinuity markers preserved)
//
// Codec safety: browsers can only decode h264(+AAC/MP3) in MSE. The first
// cached segment's TS PMT is parsed in pure JS; a hevc/AC3/anything-else
// source makes /api/turbo 302-redirect to the transcode relay (/api/live),
// which re-encodes to uniform h264. Mid-stream codec flips get a discontinuity
// marker; the player's existing media-error ladder handles the rare flip.

import { resolveDaddyLiveStream } from '@/lib/sports/daddylive';
import { unwrapSegment } from './uncloak';
import { UA } from './resolve';
import { ffmpegAbsent, ffmpegExecutable, SERVERLESS } from './ffmpeg-cap';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const MAX_SESSIONS = 6;
const IDLE_KILL_MS = 45_000;
const MAX_AGE_MS = 2 * 60 * 60_000;
/** only used on hosts where the isolate stays warm (dev / self-hosted) —
 *  on serverless the inline kick does the advancing */
const POLL_MS = 1500;
const MAX_PARALLEL = 4;
const STARTUP_BURST = 4;
/** segments listed in the served live window — 12 × ~5s = 60s of runway.
 *  Playback never speeds up anymore (maxLiveSyncPlaybackRate pinned to 1
 *  after the "plays like 2x" bug), so stalls accumulate drift behind the
 *  edge — a deep window means that drift has room instead of falling off
 *  the back of the playlist. */
const WINDOW = 12;
/** segments kept in the memory cache (flap absorb depth ≈ KEEP × segdur) */
const KEEP = 24;
/** upstream must be dead this long before we give up (client keeps playing
 *  cached content meanwhile — far more tolerant than direct) */
const STALL_KILL_MS = 60_000;
const SEG_FETCH_TIMEOUT_MS = 12_000;
const MAX_SN_TRIES = 10;
/** bound for the inline kick a playlist/segment request waits on */
const KICK_MS = 2_500;

/** sessions survive dev-server hot reloads */
const g = globalThis as {
  __maxtvTurbo?: Map<string, TurboSession>;
  __maxtvTurboReaper?: NodeJS.Timeout;
};
if (!g.__maxtvTurbo) g.__maxtvTurbo = new Map();
const SESSIONS = g.__maxtvTurbo;

interface Upstream {
  url: string;
  referer: string;
}

interface SegData {
  ts: Uint8Array;
  dur: number;
  disc: boolean;
  /** this segment's codec is browser-safe (h264 + AAC/MP3) — unsafe
   *  segments stay in the cache (the transcode relay reuses them) but are
   *  NEVER listed in the served window: the browser's MSE cannot decode
   *  them and a single one would kill the whole SourceBuffer */
  safe: boolean;
}

export type TurboVerdict = 'ready' | 'relay' | 'dead';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TurboSession {
  readonly key: string;
  readonly sid: string;
  private readonly resolveUpstream: (fresh: boolean) => Promise<Upstream | null>;
  private timer: NodeJS.Timeout | null = null;
  private upstream: Upstream | null = null;
  private upstreamAt = 0;
  private polling = false;
  private dead = false;
  /** ⤴ v2: identity = the UPSTREAM sn. `segs` is keyed by it, so any
   *  instance serving this channel computes identical playlist coordinates. */
  private readonly segs = new Map<number, SegData>();
  /** ascending cached sns (append-order = sn-order; commits are sorted) */
  private windowSns: number[] = [];
  /** newest sn committed (window tip) */
  private newestSn = 0;
  /** upstream sn → segment URL (for cross-instance on-demand fetches) */
  private readonly urlBySn = new Map<number, string>();
  private lastSn = 0;
  private lastUpMseq: number | null = null;
  /** mseq of the most recent upstream playlist parse — the floor below which
   *  a FRESH instance (Vercel load-balance hop) cannot on-demand fetch: the
   * upstream listing is only ~4-6 segments deep, so sns below floor+1 have
   * scrolled out of existence everywhere but this instance's cache. */
  private lastUpFloor = 0;
  /** wall-clock of the last successful upstream playlist parse (drift-margin
   *  gating — see windowRange). */
  private lastParseAt = 0;
  private readonly snTries = new Map<number, number>();
  private readonly pending = new Set<number>();
  /** codec safety of the source (null = not sniffed yet) */
  private codecSafe: boolean | null = null;
  /** the source was browser-unsafe from its FIRST sniffed segment (a pure
   *  HEVC/mpeg2 feed, not a mid-stream flip). When no transcoder exists
   *  (serverless) such feeds are SERVED ANYWAY: Safari + Chrome-with-HEVC
   *  play them natively, and incapable browsers walk the alternate-feed
   *  ladder — infinitely better than 302-ing into a dead relay. */
  private hevcFromStart = false;
  private lastNewAt = Date.now();
  private startup = true;
  lastServed = Date.now();
  createdAt = Date.now();

  constructor(key: string, resolveUpstream: (fresh: boolean) => Promise<Upstream | null>) {
    this.key = key;
    this.sid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.resolveUpstream = resolveUpstream;
    void this.pass();
    // on serverless the isolate usually freezes between requests and this
    // timer only fires in bursts — harmless (the inline kick is the real
    // engine). On warm hosts it keeps the prefetch rolling.
    this.timer = setInterval(() => void this.pass(), POLL_MS);
  }

  touch(): void {
    this.lastServed = Date.now();
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Has the source been sniffed and is it safe for direct browser playback?
   *  FALSE only when a relay could actually save the stream (ffmpeg present,
   *  or a mid-stream flip away from a working buffer). Pure-HEVC feeds on
   *  serverless serve through instead — see hevcFromStart. */
  get needsRelay(): boolean {
    return this.codecSafe === false && !this.serveUnsafe;
  }

  /** the sniffed feed uses a browser-UNSAFE codec (HEVC phase) — exposed so
   *  /api/sports/stream can warn HEVC-incapable browsers BEFORE they buffer
   *  into a codec error and the failover engine silently walks them onto a
   *  different channel's feed (the beIN 5 → beIN XTRA field report). */
  get unsafeCodec(): boolean {
    return this.codecSafe === false;
  }

  /** serve browser-unsafe segments through to capable browsers (no relay).
   *  2026-10-03: also true on SERVERLESS even when the bundled binary exists —
   *  the continuous /api/live relay can't survive isolate freezes, so an
   *  HEVC phase serves through natively; incapable browsers get the explicit
   *  HEVC panel (with the new "play converted" segment-ladder option). */
  private get serveUnsafe(): boolean {
    return this.hevcFromStart && (SERVERLESS || ffmpegAbsent() === true);
  }

  /**
   * v2 INLINE KICK — run (or join) one polling pass NOW, bounded. This is what
   * makes turbo work on serverless: the player's playlist poll itself drives
   * the prefetch forward, no background timer required.
   */
  async kick(timeoutMs: number = KICK_MS): Promise<void> {
    if (this.dead) return;
    if (this.polling) {
      const t0 = Date.now();
      while (this.polling && !this.dead && Date.now() - t0 < timeoutMs) await sleep(60);
      return;
    }
    await Promise.race([this.pass(), sleep(timeoutMs)]);
  }

  /** Wait (bounded) until the session can serve a playlist. Re-enterable —
   *  later requests re-check live state instead of a one-shot promise. */
  async waitReady(timeoutMs = 7_000): Promise<TurboVerdict> {
    const t0 = Date.now();
    for (;;) {
      if (this.dead) return 'dead';
      if (this.needsRelay) return 'relay';
      const w = this.windowRange();
      if (w && w.list.length >= 2) return 'ready';
      if (Date.now() - t0 >= timeoutMs) {
        if (this.needsRelay) return 'relay';
        if (w && w.list.length >= 1) return 'ready';
        return 'dead';
      }
      await sleep(120);
    }
  }

  /** contiguous window ending at the newest cached segment (hole-free;
   *  codec-safe only — unless the whole feed is unsafe and we're serving it
   *  through to HEVC-capable browsers).
   *
   *  CROSS-INSTANCE DRIFT MARGIN: while upstream is live, the window never
   *  reaches below the current upstream floor + 1 — those sns are still
   *  listed upstream, so ANY instance can on-demand fetch them (a segment
   *  request that load-balances to a cold instance must never depend on
   *  bytes only a warm instance cached). When upstream has just flapped, the
   *  margin lifts and the deep cache becomes servable again — that runway
   *  is what rides out CDN flaps in the first place. */
  private windowRange(forceUnsafe = false): { base: number; list: { sn: number; seg: SegData }[] } | null {
    const n = this.windowSns.length;
    if (!n) return null;
    const allowUnsafe = forceUnsafe || this.serveUnsafe;
    const upstreamLive = this.lastParseAt > 0 && Date.now() - this.lastParseAt < 15_000;
    // CROSS-INSTANCE DRIFT MARGIN (native): never serve below upstream's
    // current floor + 1 — those sns are still listed upstream, so ANY
    // instance can on-demand fetch them.
    // &h= LADDER (forceUnsafe): transcoded segments are per-instance caches
    // ANYWAY (a cold instance re-transcodes from raw bytes it can fetch) —
    // but the transcode latency (~1.5-4s/segment) means the player rides
    // several segments behind the edge, and a shallow sliding window jumps
    // out from under it (measured: buffer [6,12] while the 3-deep window
    // slid past → total stall). Serve DEEPER — 6 below the upstream floor
    // from the local cache — so the slow ladder has runway. An instance hop
    // below the floor 404s and hls.js skip-aheads, same as native.
    const hopFloor = upstreamLive && this.lastUpFloor > 0
      ? forceUnsafe
        ? Math.max(this.newestSn - KEEP + 2, this.lastUpFloor - 6)
        : this.lastUpFloor + 1
      : 0;
    const list: { sn: number; seg: SegData }[] = [];
    let i = n - 1;
    let expect = this.windowSns[i];
    while (i >= 0 && list.length < WINDOW) {
      const sn = this.windowSns[i];
      if (sn !== expect) break; // hole — the window stops here
      if (hopFloor && sn < hopFloor) break; // below the cross-instance-safe floor
      const seg = this.segs.get(sn);
      if (!seg || (!allowUnsafe && !seg.safe)) break; // pruned / codec-unsafe boundary
      list.unshift({ sn, seg });
      expect = sn - 1;
      i--;
    }
    return list.length ? { base: list[0].sn, list } : null;
  }

  /** Build the served playlist. Segment lines are `t<upSn>.ts`; the route
   *  rewrites them to /api/turbo URLs. MEDIA-SEQUENCE = oldest served sn —
   *  derived purely from upstream state, so every instance agrees on it.
   *  `tcHeight` (data-saver ladder): list ALL segments — the per-segment
   *  transcode re-encodes even browser-unsafe (HEVC) ones to clean h264. */
  readPlaylist(tcHeight?: number): string | null {
    const w = this.windowRange(tcHeight !== undefined);
    if (!w) return null;
    const maxDur = Math.max(4, ...w.list.map((x) => x.seg.dur));
    const out: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`,
      `#EXT-X-MEDIA-SEQUENCE:${w.base}`,
    ];
    for (const { sn, seg } of w.list) {
      if (seg.disc) out.push('#EXT-X-DISCONTINUITY');
      out.push(`#EXTINF:${seg.dur.toFixed(3)},`);
      out.push(`t${sn}.ts`);
    }
    return out.join('\n') + '\n';
  }

  /** Serve one segment by UPSTREAM sn. Cache miss (instance flap / eviction)
   *  → inline refresh + direct upstream fetch instead of a 404, so a segment
   *  URL minted by instance A still resolves on instance B. The second
   *  kick/fetch round exists for freshly-spawned sessions on a cold instance:
   *  the first bounded kick can lose the race with the constructor's initial
   *  playlist fetch, and losing it used to mean a hard 404. */
  async getSegment(n: number): Promise<Uint8Array | null> {
    const direct = this.segs.get(n);
    if (direct) return direct.ts;
    const t0 = Date.now();
    // refresh our view of the upstream window, then re-check
    await this.kick(Math.min(KICK_MS, 1_800));
    let seg = this.segs.get(n);
    if (seg) return seg.ts;
    // we (or a sibling instance) listed this sn — its URL may still be
    // known; fetch it on demand
    const referer = this.upstream?.referer || '';
    let url = this.urlBySn.get(n);
    if (url) {
      const ts = await this.fetchSeg(url, referer);
      if (ts && ts.length >= 188) {
        this.commit(n, ts, this.urlDur.get(n) || 6, false);
        return ts;
      }
    }
    // cold-start second chance — only while we're still inside hls.js's
    // time-to-first-byte budget (no point retrying after a 12s segment hang)
    if (Date.now() - t0 < 4_000) {
      await this.kick(2_000);
      seg = this.segs.get(n);
      if (seg) return seg.ts;
      url = this.urlBySn.get(n);
      if (url) {
        const ts = await this.fetchSeg(url, referer);
        if (ts && ts.length >= 188) {
          this.commit(n, ts, this.urlDur.get(n) || 6, false);
          return ts;
        }
      }
    }
    return null;
  }

  // ── per-segment transcode ladder (the serverless data-saver) ────────────

  /** transcoded segment cache — key `${sn}:${h}` (bounded, LRU by sn order) */
  private readonly tcSegs = new Map<string, Uint8Array>();
  /** last fire-and-forget warm for a height — throttles the after() warm so
   *  playlist poll bursts can't pile transcodes onto the CPU */
  private readonly tcWarmAt = new Map<number, number>();

  /** Serve one segment re-encoded to `h` pixels tall (h264+AAC, browser-safe
   *  even when the source is in an HEVC phase). One-shot ffmpeg per segment
   *  — the only transcode shape that works on serverless (each invocation
   *  fetches + converts one bounded segment and returns). IN-FLIGHT DEDUPE:
   *  a concurrent warm + player request for the same segment share ONE
   *  promise (the "switch quality → buffering → channel death" fix: warm
   *  tasks used to flood both transcode slots and starve the player's own
   *  segment loads). Falls back to the ORIGINAL bytes when the binary is
   *  missing/crashes — an h264 source keeps playing (just full-size); an
   *  HEVC source surfaces the player's codec ladder instead of a hard 404. */
  getTranscodedSegment(n: number, h: number): Promise<Uint8Array | null> {
    const key = `${this.key}|${n}:${h}`;
    const hit = this.tcSegs.get(`${n}:${h}`);
    if (hit) return Promise.resolve(hit);
    const inflight = tcInflight.get(key);
    if (inflight) return inflight;
    const p = (async () => {
      const raw = await this.getSegment(n);
      if (!raw) return null;
      const out = await transcodeSegment(raw, h, true); // player-facing: priority
      if (!out) return raw; // graceful: original bytes beat a 404
      this.tcSegs.set(`${n}:${h}`, out);
      if (this.tcSegs.size > 64) {
        const it = this.tcSegs.keys();
        for (let i = 0; i < 24; i++) {
          const v = it.next();
          if (v.done) break;
          this.tcSegs.delete(v.value);
        }
      }
      return out;
    })().finally(() => tcInflight.delete(key));
    tcInflight.set(key, p);
    return p;
  }

  /** fire-and-forget warm of the newest segments at `h` — after serving an
   *  &h= playlist, so the first segment requests hit warm bytes when the
   *  isolate stays alive long enough (local/self-hosted; on Vercel the
   *  after() callback keeps the invocation alive for it). THROTTLED to one
   *  batch per 2s and deduped against in-flight transcodes so poll bursts
   * can't starve the player (priority stays with player-facing requests). */
  warmTranscodes(h: number, count = 2): void {
    const now = Date.now();
    const last = this.tcWarmAt.get(h) || 0;
    if (now - last < 2_000) return;
    this.tcWarmAt.set(h, now);
    const w = this.windowRange(true);
    if (!w) return;
    // WARMS THE PLAYER'S START POSITION, not the window tip: hls.js begins
    // liveSyncDurationCount (3) segments behind the newest listed segment,
    // so warming [tip-3, tip-2] is what makes the FIRST segment load fast;
    // every later segment passes through those positions on successive
    // polls and gets warmed ~2 polls before the player reaches it.
    const from = Math.max(0, w.list.length - count - 2);
    const to = Math.max(from, w.list.length - 2);
    const sns = w.list.slice(from, to).map((x) => x.sn);
    for (const sn of sns) {
      const key = `${this.key}|${sn}:${h}`;
      if (this.tcSegs.has(`${sn}:${h}`) || tcInflight.has(key)) continue;
      const p = (async () => {
        const raw = await this.getSegment(sn);
        if (!raw) return null;
        const out = await transcodeSegment(raw, h, false); // warm: low priority
        if (out) this.tcSegs.set(`${sn}:${h}`, out);
        return out;
      })().finally(() => tcInflight.delete(key));
      tcInflight.set(key, p);
      void p.catch(() => {});
    }
  }

  /** wait until a servable window exists for the transcode ladder — unlike
   *  waitReady, codec safety is IRRELEVANT (unsafe segments get converted),
   *  so an HEVC-from-start feed is immediately usable at &h=. */
  async waitReadyTC(timeoutMs = 7_000): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      if (this.dead) return false;
      const w = this.windowRange(true);
      if (w && w.list.length >= 1) return true;
      if (Date.now() - t0 >= timeoutMs) return !!w;
      await this.kick(600);
    }
  }

  // ── upstream engine ────────────────────────────────────────────────────────

  private async ensureUpstream(): Promise<Upstream | null> {
    if (this.upstream && Date.now() - this.upstreamAt < 2 * 60_000) return this.upstream;
    const u = await this.resolveUpstream(!!this.upstream);
    if (u) {
      this.upstream = u;
      this.upstreamAt = Date.now();
    }
    return u;
  }

  private async pass(): Promise<void> {
    if (this.dead || this.polling) return;
    this.polling = true;
    try {
      const up = await this.ensureUpstream();
      if (!up) return;

      let text = await fetchText(up.url, up.referer);
      if (!text || !text.includes('#EXTM3U')) return;

      // master playlist → first variant (absolutized)
      if (text.includes('#EXT-X-STREAM-INF')) {
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith('#EXT-X-STREAM-INF') && lines[i + 1] && !lines[i + 1].startsWith('#')) {
            const variant = new URL(lines[i + 1].trim(), up.url).toString();
            this.upstream = { url: variant, referer: up.referer };
            this.upstreamAt = Date.now();
            text = await fetchText(variant, up.referer);
            break;
          }
        }
        if (!text || !text.includes('#EXTM3U')) return;
      }

      // upstream restart detection — backward mseq jump = provider restarted.
      // ⤴ v2: PURGE the cache (sn values would collide with new content) and
      // let the next commits build a fresh window at the new upstream mseq.
      const m = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
      const upMseq = m ? parseInt(m[1], 10) : null;
      let restarted = false;
      if (upMseq !== null && this.lastUpMseq !== null && upMseq < this.lastUpMseq) {
        restarted = true;
        this.lastSn = 0;
        this.segs.clear();
        this.windowSns = [];
        this.newestSn = 0;
        this.urlBySn.clear();
        this.urlDur.clear();
        this.snTries.clear();
      }
      if (upMseq !== null) {
        this.lastUpMseq = upMseq;
        this.lastUpFloor = upMseq;
        this.lastParseAt = Date.now();
      }

      // parse entries — sn identity = upstream mseq + index (stable across
      // polls AND across instances; that's the whole v2 trick)
      const entries: { abs: string; dur: number; sn: number; disc: boolean }[] = [];
      let dur = 6;
      let disc = false;
      let idx = 0;
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line === '#EXT-X-DISCONTINUITY') {
          disc = true;
        } else if (line.startsWith('#EXTINF:')) {
          dur = parseFloat(line.slice(8)) || 6;
        } else if (line && !line.startsWith('#')) {
          const sn = (upMseq ?? 0) + idx;
          entries.push({ abs: new URL(line, this.upstream!.url).toString(), dur, sn, disc });
          // remember URL + duration for on-demand (cross-instance) fetches
          this.urlBySn.set(sn, entries[entries.length - 1].abs);
          this.urlDur.set(sn, dur);
          disc = false;
          idx++;
        }
      }
      // bound the URL maps (insertion order ≈ age)
      if (this.urlBySn.size > 60) {
        const it = this.urlBySn.keys();
        for (let i = 0; i < 20; i++) {
          const v = it.next();
          if (v.done) break;
          this.urlBySn.delete(v.value);
          this.urlDur.delete(v.value);
        }
      }

      const fresh = entries.filter(
        (e) =>
          e.sn > this.lastSn &&
          !this.pending.has(e.sn) &&
          !this.segs.has(e.sn) &&
          (this.snTries.get(e.sn) ?? 0) < MAX_SN_TRIES
      );
      // startup: burst the NEWEST segments (live edge, fastest first frame);
      // afterwards: oldest-first catch-up so the timeline stays ordered
      const batch = this.startup ? fresh.slice(-STARTUP_BURST) : fresh.slice(0, MAX_PARALLEL);
      if (!batch.length) {
        if (this.startup && Date.now() - this.createdAt > 9_000) this.startup = false;
        return;
      }

      for (const e of batch) {
        this.pending.add(e.sn);
        this.snTries.set(e.sn, (this.snTries.get(e.sn) ?? 0) + 1);
      }
      const results = await Promise.all(
        batch.map(async (e) => ({ e, ts: await this.fetchSeg(e.abs, this.upstream!.referer) }))
      );
      for (const r of results) this.pending.delete(r.e.sn);

      // commit in sn order — the window array must stay ascending
      const commits = results.filter((r) => r.ts && r.ts.length >= 188).sort((a, b) => a.e.sn - b.e.sn);
      for (const r of commits) {
        if (this.segs.has(r.e.sn)) continue; // lost a race (shouldn't — mutex)
        this.commit(r.e.sn, r.ts!, r.e.dur, r.e.disc || restarted);
        this.lastSn = Math.max(this.lastSn, r.e.sn);
        this.startup = false;
        this.lastNewAt = Date.now();
      }

      // bound the bookkeeping map (insertion order ≈ age)
      if (this.snTries.size > 900) {
        const it = this.snTries.keys();
        for (let i = 0; i < 400; i++) {
          const v = it.next();
          if (v.done) break;
          this.snTries.delete(v.value);
        }
      }
      this.prune();
    } catch {
      /* transient — next pass retries */
    } finally {
      this.polling = false;
      // honest death — no new content for 60s (dead upstream / unreachable
      // playlist). The client keeps playing the cached window meanwhile; far
      // more tolerant than direct, but not immortal.
      if (!this.dead && Date.now() - this.lastNewAt > STALL_KILL_MS) {
        this.kill(new Error('upstream stalled'));
      }
    }
  }

  /** insert a fetched segment into the cache + window */
  private commit(sn: number, ts: Uint8Array, dur: number, disc: boolean): void {
    const codec = sniffCodecs(ts);
    const codecFlip = !!codec && !!this.lastCodec && !sameCodec(this.lastCodec, codec);
    if (codec) this.lastCodec = codec;
    const safe = codec ? codecSafe(codec) : true;
    this.segs.set(sn, { ts, dur, disc: disc || codecFlip, safe });
    if (sn > this.newestSn) {
      this.windowSns.push(sn);
      this.newestSn = sn;
    } else {
      // out-of-order commit (on-demand fetch of an older sn) — keep ascending
      const at = this.windowSns.findIndex((s) => s > sn);
      if (at === -1) this.windowSns.push(sn);
      else if (this.windowSns[at - 1] !== sn) this.windowSns.splice(at, 0, sn);
    }
    if (codec) {
      if (this.codecSafe === null) {
        this.codecSafe = safe;
        if (!safe) this.hevcFromStart = true; // pure-unsafe feed (e.g. HEVC)
      } else if (!safe && this.codecSafe) {
        // mid-stream flip to a codec the browser cannot decode — mark the
        // session unsafe: the window tip freezes on the last safe segment
        // and the route redirects playlist polls to the transcode relay
        // (seamless hand-off instead of a fatal MSE error)
        this.codecSafe = false;
      }
    }
  }

  private lastCodec: { video: number; audio: number } | null = null;
  private readonly urlDur = new Map<number, number>();

  private async fetchSeg(url: string, referer: string): Promise<Uint8Array | null> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
        signal: AbortSignal.timeout(SEG_FETCH_TIMEOUT_MS),
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 188) return null;
      if (buf[0] === 0x47) return buf; // clean TS
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const isRiff = buf[0] === 0x52 && buf[1] === 0x49;
      const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
      const isTik = buf[0] === 84 && buf[1] === 73 && buf[2] === 75 && buf[3] === 84;
      if (isPng || isRiff || isGzip || isTik) {
        try {
          const ts = unwrapSegment(buf);
          return ts && ts.length > 0 ? ts : null;
        } catch {
          return null;
        }
      }
      return null; // genuine image / undecodable
    } catch {
      return null;
    }
  }

  /** drop segments that fell out of the absorb window */
  private prune(): void {
    const floor = this.newestSn - KEEP;
    if (this.newestSn === 0) return;
    for (const sn of this.segs.keys()) {
      if (sn <= floor) this.segs.delete(sn);
    }
    if (this.windowSns.length && this.windowSns[0] <= floor) {
      this.windowSns = this.windowSns.filter((s) => s > floor);
    }
  }

  /** expose a cached segment by its UPSTREAM sn — shared input cache for the
   *  transcode data-saver sessions (see turboCachedBySn) */
  cachedBySn(sn: number): { ts: Uint8Array; dur: number } | null {
    const seg = this.segs.get(sn);
    return seg ? { ts: seg.ts, dur: seg.dur } : null;
  }

  kill(reason?: Error): void {
    if (this.dead) return;
    this.dead = true;
    if (this.timer) clearInterval(this.timer);
    SESSIONS.delete(this.key);
    if (reason) console.warn(`[turbo] session ${this.key} stopped: ${reason.message}`);
  }
}

// ── per-segment one-shot transcode (serverless data-saver ladder) ───────────
// Runs the build-time static ffmpeg (BtbN n8.1) once per segment: bounded
// input (≤25s), tmp files in os.tmpdir() (writable on lambdas), concurrency
// capped at 2 so a burst of segment requests can't fork-bomb a 1-vCPU
// isolate. Benchmarks (2026-10-03): h264 720p → 360p ≈ 1.9s per 10s segment,
// HEVC 1080p → 480p ≈ 4.8s per 10s segment — comfortably inside the 5s
// TARGETDURATION budget at ≤480p.

/** in-flight transcodes (dedupe: one promise per session|sn|height — a warm
 *  task and the player's request for the same segment share it) */
const tcInflight = new Map<string, Promise<Uint8Array | null>>();

/** heights the serverless segment ladder offers — capped at 480 because that
 *  is what a 1-vCPU isolate can encode FASTER than realtime (benchmarks
 *  above: ≤480p ≈ 1.9-4.8s per 10s segment). 720/1080 encodes run 5-7s+ per
 *  ~6s segment — slower than the stream plays, so the buffer can only drain:
 *  the 2026-10-08 field report ("everything loads constantly since the last
 *  version; before it I watched an entire match without a single loading")
 *  was a persisted 1080p pick routing every channel through that doomed
 *  re-encode. Full-height playback does NOT need this ladder anyway: the
 *  native passthrough already serves the source's own 720p/1080p untouched,
 *  and real ladders surface as hls levels / "More qualities" alternates.
 *  Asking &h=720|1080 here now falls through to the native playlist (h=0)
 *  instead of a re-encode that can never keep up. */
export const SEG_LADDER_HEIGHTS = [144, 244, 360, 480] as const;

const TC_TIMEOUT_MS = 25_000;
const TC_MAX_CONCURRENT = 2;
let tcActive = 0;
/** waiters for a transcode slot — PLAYER-FACING requests unshift (they get
 *  the next free slot); warm tasks append. Without the priority split the
 *  after() warm batches flooded both slots and the player's own segment
 *  loads queued behind them until hls.js timed out and the channel died. */
const tcQueue: Array<{ resolve: () => void; priority: boolean }> = [];

async function tcSlot(priority: boolean): Promise<() => void> {
  while (tcActive >= TC_MAX_CONCURRENT || (priority && tcQueue.some((w) => w.priority))) {
    if (priority) {
      // don't let two player requests queue-jump each other — keep order
      // among priorities, but always ahead of warm tasks
      const warmIdx = tcQueue.findIndex((w) => !w.priority);
      const mine = { resolve: () => {}, priority };
      if (warmIdx === -1) await new Promise<void>((r) => { mine.resolve = r; tcQueue.push(mine); });
      else await new Promise<void>((r) => { mine.resolve = r; tcQueue.splice(warmIdx, 0, mine); });
    } else {
      await new Promise<void>((r) => tcQueue.push({ resolve: r, priority }));
    }
  }
  tcActive++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    tcActive--;
    tcQueue.shift()?.resolve();
  };
}

/** one-shot ffmpeg: TS bytes in → scaled h264 TS bytes out (null on failure).
 *  `priority` marks a player-facing request (slot queue front). */
async function transcodeSegment(ts: Uint8Array, h: number, priority: boolean): Promise<Uint8Array | null> {
  const exe = ffmpegExecutable();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maxtv-tc-'));
  const inPath = path.join(dir, 'in.ts');
  const outPath = path.join(dir, 'out.ts');
  try {
    fs.writeFileSync(inPath, ts);
    const release = await tcSlot(priority);
    try {
      await new Promise<void>((res, rej) => {
        const p = spawn(
          exe,
          [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-i', inPath,
            // ⚠ -copyts — CRITICAL: preserve the source's CONTINUOUS
            // timestamps. Each segment is transcoded in its own one-shot
            // process; without copyts every output restarts its PTS at ~1.4s,
            // so consecutive segments carry IDENTICAL timestamps — the MSE
            // appends collide and playback freezes a couple of segments in
            // (measured: buffer [6,12] forever while the window slid on).
            // With copyts the provider's encoder clock passes through and
            // consecutive segments stay monotonic.
            '-copyts',
            '-vf', `scale=-2:${h}`,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-ac', '2',
            '-f', 'mpegts', outPath,
          ],
          { stdio: 'ignore' }
        );
        const t = setTimeout(() => {
          p.kill('SIGKILL');
          rej(new Error('transcode timeout'));
        }, TC_TIMEOUT_MS);
        p.on('error', (e) => {
          clearTimeout(t);
          rej(e);
        });
        p.on('close', (code) => {
          clearTimeout(t);
          code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`));
        });
      });
      const out = fs.readFileSync(outPath);
      return out.length >= 188 ? new Uint8Array(out) : null;
    } finally {
      release();
    }
  } catch {
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ── session management ────────────────────────────────────────────────────────

function startReaper(): void {
  if (g.__maxtvTurboReaper) return;
  g.__maxtvTurboReaper = setInterval(() => {
    const now = Date.now();
    for (const s of SESSIONS.values()) {
      if (now - s.lastServed > IDLE_KILL_MS || now - s.createdAt > MAX_AGE_MS || s.isDead) {
        s.kill(new Error('idle'));
      }
    }
  }, 15_000);
  (g.__maxtvTurboReaper as unknown as { unref?: () => void }).unref?.();
}

/** Map a relay/turbo UI server id → entry-route pin (mirrors transcode.ts) */
function pinForServer(serverId: string | undefined): string | undefined {
  switch (serverId) {
    case undefined:
    case '':
    case 'turbo':
    case 'relay':
    case 'direct':
    case 'auto':
      return undefined;
    case 'relay-dlive':
    case 'direct-dlive':
    case 'turbo-dlive':
      return 'dlive';
    case 'relay-dlstreams':
    case 'direct-dlstreams':
    case 'turbo-dlstreams':
      return 'dlstreams';
    case 'relay-cdn':
    case 'direct-cdn':
    case 'turbo-cdn':
      return 'cdn';
    default:
      return serverId;
  }
}

/** get-or-create a channel turbo session (also used to PRE-WARM during
 *  /api/sports/stream resolve — the poller starts filling while the player
 *  is still setting up hls.js) */
export function getTurboSession(channelId: string, serverPin?: string): TurboSession {
  const pin = pinForServer(serverPin);
  const key = `ch${channelId}${pin ? `m${pin}` : ''}`;
  const existing = SESSIONS.get(key);
  if (existing && !existing.isDead) {
    existing.touch();
    return existing;
  }
  if (SESSIONS.size >= MAX_SESSIONS) {
    const oldest = [...SESSIONS.values()].sort((a, b) => a.lastServed - b.lastServed)[0];
    oldest?.kill(new Error('evicted'));
  }
  const s = new TurboSession(key, async (fresh: boolean) => {
    const r = await resolveDaddyLiveStream(channelId, {
      ...(pin ? { server: pin } : {}),
      ...(fresh ? { fresh: true } : {}),
    });
    if (!r?.url) return null;
    return { url: r.url, referer: r.referer || 'https://daddyliveplayer.st/' };
  });
  SESSIONS.set(key, s);
  startReaper();
  return s;
}

/** peek without creating (segment requests must never spawn sessions) */
export function peekTurboSession(channelId: string, serverPin?: string): TurboSession | null {
  const pin = pinForServer(serverPin);
  const key = `ch${channelId}${pin ? `m${pin}` : ''}`;
  const s = SESSIONS.get(key);
  return s && !s.isDead ? s : null;
}

/**
 * Shared input cache — lets the transcode data-saver sessions (144p/244p/…)
 * reuse bytes the turbo prefetcher already holds for this channel instead of
 * re-hitting the slow CDN. This is the "even 144p lags" fix: the transcoder's
 * input side becomes instant whenever the user hopped down from native play.
 */
export function turboCachedBySn(channelId: string, sn: number): { ts: Uint8Array; dur: number } | null {
  // ⚠ EXACT channel match — session keys are `ch{id}` / `ch{id}m{pin}`. A
  // bare startsWith(`ch${channelId}`) matched OTHER channels whose id extends
  // this one (ch95 → ch950 France 2 … ch959 W9; ch97 → Starz; ch100 →
  // ch1010 beIN 5 Turkey), so a data-saver transcode input could pull a
  // DIFFERENT channel's cached bytes and serve its content under this
  // channel's name (2026-10-03 "bein 5/7 arabic is not arabic" audit).
  // Same channel via ANY mirror pin is fine — identical upstream content.
  const own = `ch${channelId}`;
  for (const s of SESSIONS.values()) {
    if (s.isDead) continue;
    if (s.key !== own && !s.key.startsWith(`${own}m`)) continue;
    const hit = s.cachedBySn(sn);
    if (hit) return hit;
  }
  return null;
}

// ── TS PMT codec sniffing (pure JS, no ffprobe) ──────────────────────────────

export interface TsCodecs {
  video: number;
  audio: number;
}

function sameCodec(a: TsCodecs, b: TsCodecs): boolean {
  return a.video === b.video && a.audio === b.audio;
}

/** stream types browsers can decode in MSE: h264 video + AAC/MP3 audio */
function codecSafe(c: TsCodecs): boolean {
  const safeVideo = c.video === 0x1b || c.video === 0x42;
  const safeAudio = c.audio === 0x03 || c.audio === 0x04 || c.audio === 0x0f || c.audio === 0x11 || c.audio === 0;
  return safeVideo && safeAudio;
}

/** Parse the PAT → PMT out of a TS buffer; null when nothing parseable. */
export function sniffCodecs(buf: Uint8Array): TsCodecs | null {
  const packets = Math.min(Math.floor(buf.length / 188), 120);
  let pmtPid = -1;
  let out: TsCodecs | null = null;
  for (let i = 0; i < packets; i++) {
    const p = i * 188;
    if (buf[p] !== 0x47) continue;
    const pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
    if ((buf[p + 1] & 0x40) === 0) continue; // need payload_unit_start
    let off = p + 4;
    if (buf[p + 3] & 0x20) off += 1 + buf[p + 4]; // adaptation field
    if (off + 8 > p + 188) continue;
    off += 1 + buf[off]; // pointer_field
    if (off + 8 > p + 188) continue;
    if (pid === 0 && pmtPid === -1) {
      // PAT
      const secLen = ((buf[off + 1] & 0x0f) << 8) | buf[off + 2];
      const end = Math.min(off + 3 + secLen - 4, p + 188);
      let q = off + 8;
      while (q + 4 <= end) {
        const prog = (buf[q] << 8) | buf[q + 1];
        const ppid = ((buf[q + 2] & 0x1f) << 8) | buf[q + 3];
        if (prog !== 0) {
          pmtPid = ppid;
          break;
        }
        q += 4;
      }
    } else if (pid === pmtPid && pmtPid >= 0) {
      // PMT
      const secLen = ((buf[off + 1] & 0x0f) << 8) | buf[off + 2];
      const end = Math.min(off + 3 + secLen - 4, p + 188);
      const pil = ((buf[off + 10] & 0x0f) << 8) | buf[off + 11];
      let q = off + 12 + pil;
      let video = 0;
      let audio = 0;
      while (q + 5 <= end) {
        const type = buf[q];
        const esLen = ((buf[q + 3] & 0x0f) << 8) | buf[q + 4];
        if (isVideoType(type) && !video) video = type;
        if (isAudioType(type) && !audio) audio = type;
        q += 5 + esLen;
      }
      if (video || audio) out = { video, audio };
    }
    if (out) break;
  }
  return out;
}

function isVideoType(t: number): boolean {
  return [0x01, 0x02, 0x10, 0x1b, 0x24, 0x42, 0xd1, 0x06].includes(t);
}

function isAudioType(t: number): boolean {
  return [0x03, 0x04, 0x0f, 0x11, 0x81, 0x87, 0x80, 0x90, 0x06].includes(t);
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function fetchText(url: string, referer: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
      signal: AbortSignal.timeout(10_000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}
