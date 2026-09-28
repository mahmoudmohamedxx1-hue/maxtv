// ─── Turbo transport — prefetch passthrough relay ─────────────────────────────
// The benchmark verdict (scripts/bench-transports.mjs, 2026-09-28):
//   • direct  — starts in ~0.4s but every segment fetch pays the CDN latency
//               (p95 3.1s) → the player's critical path IS the flaky edge
//   • relay   — segment serving is instant (local disk, ~190ms) but the ffmpeg
//               transcode warmup takes 20s+ and eats both CPU cores
// Turbo combines the two: NO ffmpeg (no warmup, no CPU war) + a server-side
// rolling prefetch that stays ahead of the client, so the browser only ever
// reads warm local bytes.
//
//   upstream m3u8 ──poll 1.5s──▶ sn-dedup ──▶ parallel prefetch (3 ahead)
//        ──▶ unwrap cloaked TS ──▶ memory cache ──▶ /api/turbo serves a clean
//        local playlist (own monotonic sn, discontinuity markers preserved)
//
// Codec safety: browsers can only decode h264(+AAC/MP3) in MSE. The first
// cached segment's TS PMT is parsed in pure JS; a hevc/AC3/anything-else
// source makes /api/turbo 302-redirect to the transcode relay (/api/live),
// which re-encodes to uniform h264. Mid-stream codec flips get a discontinuity
// marker; the player's existing media-error ladder handles the rare flip.

import { resolveDaddyLiveStream } from '@/lib/sports/daddylive';
import { unwrapSegment } from './uncloak';
import { UA } from './resolve';

const MAX_SESSIONS = 6;
const IDLE_KILL_MS = 45_000;
const MAX_AGE_MS = 2 * 60 * 60_000;
const POLL_MS = 1500;
const MAX_PARALLEL = 3;
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

interface Entry {
  abs: string;
  dur: number;
  sn: number;
  disc: boolean;
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
  /** local, always-monotonic segment numbers — the served playlist's identity */
  private nextN = 1;
  /** upstream sn → local n (dedup anchor; urls rotate, sn is stable) */
  private readonly byUpSn = new Map<number, number>();
  /** local n → bytes */
  private readonly segs = new Map<number, SegData>();
  private lastSn = -1;
  private lastUpMseq: number | null = null;
  private readonly snTries = new Map<number, number>();
  private readonly pending = new Set<number>();
  /** codec safety of the source (null = not sniffed yet) */
  private codecSafe: boolean | null = null;
  private lastNewAt = Date.now();
  private startup = true;
  lastServed = Date.now();
  createdAt = Date.now();

  constructor(key: string, resolveUpstream: (fresh: boolean) => Promise<Upstream | null>) {
    this.key = key;
    this.sid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.resolveUpstream = resolveUpstream;
    void this.pass();
    this.timer = setInterval(() => void this.pass(), POLL_MS);
  }

  touch(): void {
    this.lastServed = Date.now();
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Has the source been sniffed and is it safe for direct browser playback? */
  get needsRelay(): boolean {
    return this.codecSafe === false;
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

  /** contiguous window ending at the newest cached segment (hole-free,
   *  safe-codec only) */
  private windowRange(): { base: number; list: { n: number; seg: SegData }[] } | null {
    let newest = this.nextN - 1;
    if (newest < 1) return null;
    while (newest >= 1 && !this.segs.has(newest)) newest--; // pruned tip — shouldn't happen
    if (newest < 1) return null;
    const list: { n: number; seg: SegData }[] = [];
    let n = newest;
    while (n >= 1 && list.length < WINDOW) {
      const seg = this.segs.get(n);
      // hole OR unsafe codec below — the served window stops here (the route
      // redirects to the transcode relay once the session is marked unsafe)
      if (!seg || !seg.safe) break;
      list.unshift({ n, seg });
      n--;
    }
    return list.length ? { base: n + 1, list } : null;
  }

  /** Build the served playlist. Segment lines are `t<n>.ts`; the route
   *  rewrites them to sid-stamped /api/turbo URLs. */
  readPlaylist(): string | null {
    const w = this.windowRange();
    if (!w) return null;
    const maxDur = Math.max(4, ...w.list.map((x) => x.seg.dur));
    const out: string[] = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${Math.ceil(maxDur)}`,
      `#EXT-X-MEDIA-SEQUENCE:${w.base}`,
    ];
    for (const { n, seg } of w.list) {
      if (seg.disc) out.push('#EXT-X-DISCONTINUITY');
      out.push(`#EXTINF:${seg.dur.toFixed(3)},`);
      out.push(`t${n}.ts`);
    }
    return out.join('\n') + '\n';
  }

  /** Serve one segment. The next-expected n may still be mid-fetch — wait for
   *  it briefly (the prefetcher is ahead, this only bites at startup). */
  async getSegment(n: number): Promise<Uint8Array | null> {
    const direct = this.segs.get(n);
    if (direct) return direct.ts;
    if (n === this.nextN) {
      // in flight — poll for its landing
      for (let i = 0; i < 60; i++) {
        await sleep(100);
        if (this.dead) return null;
        const s = this.segs.get(n);
        if (s) return s.ts;
      }
    }
    return null;
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

      // upstream restart detection — backward mseq jump = provider restarted
      const m = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
      const upMseq = m ? parseInt(m[1], 10) : null;
      let restarted = false;
      if (upMseq !== null && this.lastUpMseq !== null && upMseq < this.lastUpMseq) {
        restarted = true;
        this.lastSn = -1;
        this.byUpSn.clear();
        this.snTries.clear();
      }
      if (upMseq !== null) this.lastUpMseq = upMseq;

      // parse entries with stable sn identity + discontinuity flags
      const entries: Entry[] = [];
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
          entries.push({
            abs: new URL(line, this.upstream!.url).toString(),
            dur,
            sn: (upMseq ?? 0) + idx,
            disc,
          });
          disc = false;
          idx++;
        }
      }

      const fresh = entries.filter(
        (e) =>
          e.sn > this.lastSn &&
          !this.pending.has(e.sn) &&
          !this.byUpSn.has(e.sn) &&
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

      // commit in sn order — the local timeline must be monotonic even when
      // parallel downloads complete out of order
      const commits = results.filter((r) => r.ts && r.ts.length >= 188).sort((a, b) => a.e.sn - b.e.sn);
      let first = true;
      for (const r of commits) {
        if (this.byUpSn.has(r.e.sn)) continue; // lost a race (shouldn't — mutex)
        const n = this.nextN++;
        const codec = sniffCodecs(r.ts!);
        const codecFlip =
          !!codec && !!this.lastCodec && !sameCodec(this.lastCodec, codec);
        if (codec) this.lastCodec = codec;
        const safe = codec ? codecSafe(codec) : true;
        this.segs.set(n, {
          ts: r.ts!,
          dur: r.e.dur,
          disc: r.e.disc || restarted || codecFlip,
          safe,
        });
        this.byUpSn.set(r.e.sn, n);
        this.lastSn = Math.max(this.lastSn, r.e.sn);
        if (codec) {
          if (this.codecSafe === null) this.codecSafe = safe;
          else if (!safe) {
            // mid-stream flip to a codec the browser cannot decode — mark the
            // session unsafe: the window tip freezes on the last safe segment
            // and the route redirects playlist polls to the transcode relay
            // (seamless hand-off instead of a fatal MSE error)
            this.codecSafe = false;
          }
        }
        if (first) {
          this.startup = false;
          first = false;
        }
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

  private lastCodec: { video: number; audio: number } | null = null;

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
    const floor = this.nextN - 1 - KEEP;
    if (floor < 1) return;
    for (const n of this.segs.keys()) {
      if (n <= floor) this.segs.delete(n);
    }
  }

  /** expose a cached segment by its UPSTREAM sn — shared input cache for the
   *  transcode data-saver sessions (see turboCachedBySn) */
  cachedBySn(sn: number): { ts: Uint8Array; dur: number } | null {
    const n = this.byUpSn.get(sn);
    if (n === undefined) return null;
    const seg = this.segs.get(n);
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

/** get-or-create a channel turbo session */
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
  for (const s of SESSIONS.values()) {
    if (s.isDead || !s.key.startsWith(`ch${channelId}`)) continue;
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
