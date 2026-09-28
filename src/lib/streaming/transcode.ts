// ─── Real-time transcode ladder (144p → 1080p) ────────────────────────────────
// DaddyLive (and most free IPTV CDNs) ship a SINGLE rendition — there is no
// master playlist, so hls.js has no quality levels to pick from. This engine
// adds genuine rungs at every height (144p … 1080p):
//
//   upstream m3u8 ──fetch──▶ uncloak (PNG/WEBP/gzip steganography) ──▶ clean TS
//        ──▶ growing local input playlist ──▶ ffmpeg (scale + x264 ultrafast)
//        ──▶ local HLS output ──▶ /api/transcode route serves it
//
// One session per (source, height). Sessions are capped (tiny sandbox CPUs)
// and reaped after 45s without a client request.

import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { resolveDaddyLiveStream } from '@/lib/sports/daddylive';
import { unwrapSegment } from './uncloak';
import { UA, signUrl, verifySignature } from './resolve';
import { turboCachedBySn } from './turbo';

export const TRANSCODE_HEIGHTS = [144, 244, 360, 480, 720, 1080] as const;
export type TranscodeHeight = (typeof TRANSCODE_HEIGHTS)[number];

const BITRATES: Record<number, { v: number; max: number }> = {
  144: { v: 145_000, max: 180_000 },
  244: { v: 280_000, max: 340_000 },
  360: { v: 550_000, max: 650_000 },
  480: { v: 900_000, max: 1_000_000 },
  720: { v: 2_200_000, max: 2_500_000 },
  1080: { v: 3_600_000, max: 4_000_000 },
};

const MAX_SESSIONS = 4;
const IDLE_KILL_MS = 45_000;
const MAX_AGE_MS = 2 * 60 * 60_000;
const INPUT_WINDOW = 30; // generous slack — ffmpeg may lag the window tip
/** parallel upstream fetches per pass (the CDN is slow per-request: p95 3.1s —
 *  SEQUENTIAL fetches starved the transcoder, the root of "lags in 144p") */
const MAX_PARALLEL_FETCH = 3;
/** first pass bursts the NEWEST segments in parallel so ffmpeg has input
 *  within seconds instead of crawling the backlog one fetch at a time */
const STARTUP_BURST = 4;

/** sessions survive dev-server hot reloads */
const g = globalThis as { __maxtvTc?: Map<string, TranscodeSession>; __maxtvTcReaper?: NodeJS.Timeout };
if (!g.__maxtvTc) g.__maxtvTc = new Map();
const SESSIONS = g.__maxtvTc;

interface Upstream {
  /** media playlist URL (already variant-resolved for master playlists) */
  url: string;
  referer: string;
}

export class TranscodeSession {
  readonly key: string;
  readonly height: number;
  /** unique per-session id — appears in every served URL so a NEW session can
   *  never collide with browser-cached responses from a previous one */
  readonly sid: string;
  readonly dir: string;
  private ffmpeg: ChildProcess | null = null;
  private relayTimer: NodeJS.Timeout | null = null;
  private upstream: Upstream | null = null;
  private upstreamAt = 0;
  private inSeq = 0;
  /** upstream sequence number of the last fetched input segment — the dedup
   *  anchor. CDNs re-sign urls on every playlist fetch (tiktokcdn rotates
   *  x-signature/refresh_token), so url-based dedup re-fetches duplicates and
   *  fabricates gaps; the MEDIA-SEQUENCE + position is a STABLE identity. */
  private lastSn = -1;
  /** last seen upstream MEDIA-SEQUENCE — backward jump = stream restart */
  private lastUpMseq: number | null = null;
  /** per-sn fetch attempt counts */
  private readonly snTries = new Map<number, number>();
  private readonly window: { file: string; dur: number }[] = [];
  private started = false;
  private dead = false;
  /** pass mutex — overlapping relay passes double-fetch and race the window */
  private polling = false;
  /** true until the first segment lands (enables the newest-first burst) */
  private startup = true;
  /** channel id when this session serves a DaddyLive channel — enables the
   *  shared turbo prefetch cache as an input source */
  private readonly channelId: string | undefined;
  /** resolves the (mirror-pinned) upstream manifest — supplied by the caller */
  private readonly resolveUpstream: (fresh: boolean) => Promise<Upstream | null>;
  lastServed = Date.now();
  createdAt = Date.now();
  /** resolves true once ffmpeg produced its first playlist */
  ready: Promise<boolean>;
  private markReady!: (ok: boolean) => void;
  /** probed upstream height (0 = unknown yet) — the no-upscale anchor */
  private srcHeight = 0;

  constructor(
    key: string,
    height: number,
    resolveUpstream: (fresh: boolean) => Promise<Upstream | null>,
    channelId?: string
  ) {
    this.key = key;
    this.height = height;
    this.channelId = channelId;
    this.resolveUpstream = resolveUpstream;
    this.sid = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    this.dir = path.join(os.tmpdir(), `maxtv-tc-${key.replace(/[^a-z0-9]/gi, '')}`);
    this.ready = new Promise<boolean>((res) => {
      this.markReady = res;
    });
    fs.mkdirSync(this.dir, { recursive: true });
    // first relay pass, then the loop
    void this.relayPass().then(() => void this.startFfmpeg());
    this.relayTimer = setInterval(() => void this.relayPass(), 2000);
  }

  touch(): void {
    this.lastServed = Date.now();
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** probe the upstream source's real height (cached). Single-rendition HLS
   *  media playlists don't declare resolution — the only way to know is to
   *  ffprobe a fetched segment. 0 while unknown. */
  private async sourceHeight(): Promise<number> {
    if (this.srcHeight > 0) return this.srcHeight;
    const f = this.window[this.window.length - 1]?.file || this.window[0]?.file;
    if (!f) return 0;
    const h = await probeHeight(path.join(this.dir, f));
    if (h && h > 0) this.srcHeight = h;
    return this.srcHeight;
  }

  /** wait (bounded) for the input engine to land a segment, then report the
   *  source height — powers the client's no-upscale guard (mode=probe).
   *  Returns 0 when it can't be learned in budget. */
  async waitAndProbeSourceHeight(budgetMs = 6000): Promise<number> {
    const t0 = Date.now();
    while (Date.now() - t0 < budgetMs && !this.dead) {
      if (this.window.length) {
        const h = await this.sourceHeight();
        if (h > 0) return h;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    return this.srcHeight;
  }

  // ── upstream relay ────────────────────────────────────────────────────────
  private async ensureUpstream(): Promise<Upstream | null> {
    if (this.upstream && Date.now() - this.upstreamAt < 2 * 60_000) return this.upstream;
    // recovery resolves must be FRESH — a stale-serve cache answer would keep
    // pointing at the broken edge we're trying to escape
    const u = await this.resolveUpstream(!!this.upstream);
    if (u) {
      this.upstream = u;
      this.upstreamAt = Date.now();
    }
    return u;
  }

  private async relayPass(): Promise<void> {
    if (this.dead || this.polling) return;
    this.polling = true;
    try {
      const up = await this.ensureUpstream();
      if (!up) return;

      let text = await fetchText(up.url, up.referer);
      if (!text || !text.includes('#EXTM3U')) {
        this.playlistFailures = (this.playlistFailures ?? 0) + 1;
        return;
      }
      this.playlistFailures = 0;

      // upstream restart detection — a backward MEDIA-SEQUENCE jump means the
      // provider restarted the stream: re-listed segments are fresh again
      const m = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/);
      const upMseq = m ? parseInt(m[1], 10) : null;
      if (upMseq !== null && this.lastUpMseq !== null && upMseq < this.lastUpMseq) {
        this.lastSn = -1;
        this.snTries.clear();
      }
      if (upMseq !== null) this.lastUpMseq = upMseq;

      // master playlist → follow the first variant (absolutized)
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

      // collect entries with stable sequence numbers (urls rotate — sn is identity)
      const entries: { abs: string; dur: number; sn: number }[] = [];
      let dur = 6;
      let idx = 0;
      for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('#EXTINF:')) {
          dur = parseFloat(line.slice(8)) || 6;
        } else if (line && !line.startsWith('#')) {
          entries.push({ abs: new URL(line, this.upstream!.url).toString(), dur, sn: (upMseq ?? 0) + idx });
          idx++;
        }
      }

      const fresh = entries.filter(
        (e) => e.sn > this.lastSn && (this.snTries.get(e.sn) ?? 0) < 10
      );
      // startup: burst the NEWEST segments in parallel (ffmpeg gets input in
      // seconds); afterwards: oldest-first catch-up, capped, in parallel
      const batch = this.startup ? fresh.slice(-STARTUP_BURST) : fresh.slice(0, MAX_PARALLEL_FETCH);
      if (!batch.length) {
        if (this.startup && Date.now() - this.createdAt > 9_000) this.startup = false;
        this.checkStalls(0);
        return;
      }

      for (const e of batch) {
        this.snTries.set(e.sn, (this.snTries.get(e.sn) ?? 0) + 1);
      }
      // fetch in PARALLEL — a slow CDN must not serialize the input engine;
      // reuse bytes the turbo prefetcher already holds when available
      const fetched = await Promise.all(
        batch.map(async (e) => {
          const shared = this.channelId ? turboCachedBySn(this.channelId, e.sn) : null;
          const ts = shared ? shared.ts : await this.fetchAndUnwrap(e.abs, this.upstream!.referer);
          return { e, ts };
        })
      );

      // land in sn order — the input playlist's timeline must stay monotonic
      // even when parallel downloads complete out of order
      let got = 0;
      for (const r of fetched.sort((a, b) => a.e.sn - b.e.sn)) {
        if (!r.ts || r.ts.length < 188) continue;
        if (await this.landSegment(r.ts, r.e.dur)) {
          this.lastSn = Math.max(this.lastSn, r.e.sn);
          got++;
        }
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
      if (got > 0) this.startup = false;
      this.checkStalls(got);
    } catch {
      /* transient — next pass retries */
    } finally {
      this.polling = false;
      // honest death — no new input for 40s means the upstream is gone (dead
      // playlist, all segments 404ing). Kill so the player failovers instead
      // of staring at a frozen window.
      if (!this.dead && this.started && Date.now() - this.lastInputAt > 40_000) {
        this.kill(new Error('upstream stalled'));
      }
    }
  }

  /** stall watchdogs — ffmpeg output wedge (input stall death is handled in
   *  relayPass's finally so early-return paths can't hide it) */
  private checkStalls(got: number): void {
    // ffmpeg OUTPUT stall watchdog: input keeps landing but out.m3u8 is
    // stale → the decoder chain broke (providers flip codecs MID-STREAM,
    // which ffmpeg cannot reconfigure live). Kill for an honest, fast
    // failover instead of a zombie session serving a frozen window.
    if (this.started && got > 0 && Date.now() - this.lastInputAt < 10_000) {
      const outAge = this.outputAgeMs();
      if (outAge > 15_000) {
        this.kill(new Error('ffmpeg output stalled (mid-stream codec flip?)'));
      }
    }
  }

  private lastInputAt = Date.now();
  private playlistFailures = 0;

  /** age of out.m3u8 (Infinity when missing) — the ffmpeg liveness signal */
  private outputAgeMs(): number {
    try {
      const st = fs.statSync(path.join(this.dir, 'out.m3u8'));
      return Date.now() - st.mtimeMs;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  private async fetchAndUnwrap(url: string, referer: string): Promise<Uint8Array | null> {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length < 188) return null;

      // uncloak image-steganography segments; pass clean TS through
      const isPng = buf[0] === 0x89 && buf[1] === 0x50;
      const isRiff = buf[0] === 0x52 && buf[1] === 0x49;
      const isGzip = buf[0] === 0x1f && buf[1] === 0x8b;
      const isTik = buf[0] === 84 && buf[1] === 73 && buf[2] === 75 && buf[3] === 84;
      if (isPng || isRiff || isGzip || isTik) {
        try {
          const ts = unwrapSegment(buf);
          return ts && ts.length > 0 ? ts : null; // off-air placeholder image
        } catch {
          return null;
        }
      }
      if (buf[0] === 0x47) return buf;
      return null;
    } catch {
      return null;
    }
  }

  /** write one segment to the input window + atomically refresh in.m3u8 */
  private async landSegment(ts: Uint8Array, dur: number): Promise<boolean> {
    const n = ++this.inSeq;
    const file = `in-${n}.ts`;
    await fsp.writeFile(path.join(this.dir, file), ts);
    this.window.push({ file, dur });
    while (this.window.length > INPUT_WINDOW) {
      const old = this.window.shift()!;
      void fsp.rm(path.join(this.dir, old.file), { force: true }).catch(() => {});
    }
    await this.writeInputPlaylist();
    this.lastInputAt = Date.now();
    return true;
  }

  private async writeInputPlaylist(): Promise<void> {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-TARGETDURATION:${Math.ceil(Math.max(6, ...this.window.map((w) => w.dur)))}`];
    for (const w of this.window) lines.push(`#EXTINF:${w.dur.toFixed(3)},`, w.file);
    // ATOMIC (tmp + rename): ffmpeg polls this file — a partial write can
    // corrupt its parse of the playlist and wedge the demuxer
    const tmp = path.join(this.dir, 'in.m3u8.tmp');
    await fsp.writeFile(tmp, lines.join('\n') + '\n');
    await fsp.rename(tmp, path.join(this.dir, 'in.m3u8'));
  }

  // ── ffmpeg ────────────────────────────────────────────────────────────────
  private async startFfmpeg(): Promise<void> {
    if (this.dead || this.window.length === 0) {
      // nothing landed — retry on the next relay pass
      if (!this.dead) {
        setTimeout(() => {
          if (!this.started && !this.dead) void this.startFfmpeg();
        }, 3000);
      }
      return;
    }
    this.started = true;
    // height 0 = RELAY: transcode to uniform h264. The premium provider
    // flips codecs MID-STREAM (h264 ↔ hevc) and rotates timestamps — stream-
    // copy breaks on both (browsers can't switch codecs in one MSE, hevc is
    // undecodable in most browsers). A uniform x264 ladder is immune to every
    // upstream pathology and caps at 720p to stay CPU-sane.
    // Explicit ladder rungs NEVER encode UP: the request is clamped to the
    // probed source height (a 1080p ask on a 720p source encodes at 720 —
    // upscaling only burns CPU and can't add detail).
    const effHeight =
      this.height === 0
        ? await relayTargetHeight(this.dir, this.window[0].file)
        : Math.min(this.height, (await this.sourceHeight()) || this.height);
    const br = BITRATES[effHeight] || BITRATES[360];
    const args = [
      '-hide_banner', '-loglevel', 'error',
      '-fflags', '+genpts+igndts+discardcorrupt',
      '-i', path.join(this.dir, 'in.m3u8'),
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `scale=-2:${effHeight}`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'main',
      '-b:v', String(br.v), '-maxrate', String(br.max), '-bufsize', String(br.max * 2),
      '-g', '48', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '64k', '-ac', '2',
      '-f', 'hls',
      '-hls_time', this.height === 0 ? '2' : '2',
      '-hls_list_size', this.height === 0 ? '12' : '8',
      '-hls_flags', 'delete_segments+append_list',
      '-hls_segment_filename', path.join(this.dir, 'seg%05d.ts'),
      path.join(this.dir, 'out.m3u8'),
    ];
    try {
      this.ffmpeg = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      // CRITICAL: drain stderr or the 64KB pipe buffer fills (discontinuity /
      // timestamp warnings on dirty inputs) and ffmpeg BLOCKS — the output
      // playlist freezes while the relay keeps feeding it. This was the root
      // cause of the historic "transcode stalls after ~15s" bug.
      this.ffmpeg.stderr?.on('data', () => {});
      this.ffmpeg.on('error', () => this.kill(new Error('ffmpeg spawn failed')));
      this.ffmpeg.on('close', () => {
        if (!this.dead) this.kill(new Error('ffmpeg exited'));
      });
    } catch {
      this.kill(new Error('ffmpeg unavailable'));
      return;
    }
    // resolve readiness once the first playlist exists (poll up to 25s)
    const t0 = Date.now();
    const poll = setInterval(() => {
      if (this.dead) {
        clearInterval(poll);
        this.markReady(false);
        return;
      }
      if (fs.existsSync(path.join(this.dir, 'out.m3u8'))) {
        clearInterval(poll);
        this.markReady(true);
      } else if (Date.now() - t0 > (this.height === 0 ? 30_000 : 25_000)) {
        clearInterval(poll);
        this.kill(new Error('transcode warmup timeout'));
      }
    }, 500);
  }

  // ── serving ───────────────────────────────────────────────────────────────
  async readPlaylist(): Promise<string | null> {
    try {
      const p = path.join(this.dir, 'out.m3u8');
      const text = await fsp.readFile(p, 'utf-8');
      if (!text.includes('#EXTM3U')) return null;
      return text;
    } catch {
      return null;
    }
  }

  async readSegment(n: number): Promise<Buffer | null> {
    // ffmpeg names segments seg00001.ts…
    const p = path.join(this.dir, `seg${String(n).padStart(5, '0')}.ts`);
    for (let i = 0; i < 40; i++) {
      try {
        return await fsp.readFile(p);
      } catch {
        if (this.dead) return null;
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    return null;
  }

  kill(reason?: Error): void {
    if (this.dead) return;
    this.dead = true;
    try {
      this.markReady(false);
    } catch { /* already resolved */ }
    if (this.relayTimer) clearInterval(this.relayTimer);
    if (this.ffmpeg && this.ffmpeg.pid) {
      try {
        this.ffmpeg.kill('SIGKILL');
      } catch { /* ignore */ }
    }
    SESSIONS.delete(this.key);
    void fsp.rm(this.dir, { recursive: true, force: true }).catch(() => {});
    if (reason) console.warn(`[transcode] session ${this.key} stopped: ${reason.message}`);
  }
}

// ── session management ───────────────────────────────────────────────────────

function startReaper(): void {
  if (g.__maxtvTcReaper) return;
  g.__maxtvTcReaper = setInterval(() => {
    const now = Date.now();
    for (const s of SESSIONS.values()) {
      if (now - s.lastServed > IDLE_KILL_MS || now - s.createdAt > MAX_AGE_MS || s.isDead) {
        s.kill(new Error('idle'));
      }
    }
  }, 15_000);
  // don't hold the event loop open in dev
  (g.__maxtvTcReaper as unknown as { unref?: () => void }).unref?.();
}

/** DaddyLive channel session — mirrors are re-resolved when the upstream dies.
 *  height 0 = relay transport (uniform h264); serverPin optionally pins the
 *  entry route used for (re-)resolution (relay UI server ids). */
export function getChannelSession(channelId: string, height: number, serverPin?: string): TranscodeSession {
  const pin = pinForServer(serverPin);
  const key = `ch${channelId}${pin ? `m${pin}` : ''}h${height}`;
  const existing = SESSIONS.get(key);
  if (existing && !existing.isDead) {
    existing.touch();
    return existing;
  }
  evictIfFull();
  const s = new TranscodeSession(
    key,
    height,
    async (fresh: boolean) => {
      const r = await resolveDaddyLiveStream(channelId, {
        ...(pin ? { server: pin } : {}),
        ...(fresh ? { fresh: true } : {}),
      });
      if (!r?.url) return null;
      return { url: r.url, referer: r.referer || 'https://daddyliveplayer.st/' };
    },
    channelId // enables the shared turbo prefetch cache as an input source
  );
  SESSIONS.set(key, s);
  startReaper();
  return s;
}

/** Map a relay UI server id ('relay-dlive' / 'direct-cdn' / …) → entry-route pin */
function pinForServer(serverId: string | undefined): string | undefined {
  switch (serverId) {
    case undefined:
    case '':
    case 'relay':
    case 'direct':
    case 'auto':
      return undefined;
    case 'relay-dlive':
    case 'direct-dlive':
      return 'dlive';
    case 'relay-dlstreams':
    case 'direct-dlstreams':
      return 'dlstreams';
    case 'relay-cdn':
    case 'direct-cdn':
      return 'cdn';
    default:
      return serverId;
  }
}

/** arbitrary signed source session (IPTV direct URLs) */
export function getSourceSession(url: string, referer: string, height: number): TranscodeSession {
  const key = `src${signUrl(url, referer).slice(0, 16)}h${height}`;
  const existing = SESSIONS.get(key);
  if (existing && !existing.isDead) {
    existing.touch();
    return existing;
  }
  evictIfFull();
  const s = new TranscodeSession(key, height, async () => ({ url, referer }));
  SESSIONS.set(key, s);
  startReaper();
  return s;
}

/** peek at a LIVE channel session without creating one (mode=probe) */
export function findChannelSession(channelId: string, height: number, serverPin?: string): TranscodeSession | null {
  const pin = pinForServer(serverPin);
  const s = SESSIONS.get(`ch${channelId}${pin ? `m${pin}` : ''}h${height}`);
  return s && !s.isDead ? s : null;
}

/** peek at a LIVE source session without creating one (mode=probe) */
export function findSourceSession(url: string, referer: string, height: number): TranscodeSession | null {
  const s = SESSIONS.get(`src${signUrl(url, referer).slice(0, 16)}h${height}`);
  return s && !s.isDead ? s : null;
}

function evictIfFull(): void {
  if (SESSIONS.size < MAX_SESSIONS) return;
  const oldest = [...SESSIONS.values()].sort((a, b) => a.lastServed - b.lastServed)[0];
  oldest?.kill(new Error('evicted'));
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** probe the video codec + height of a segment file (ffprobe, ~100ms) */
function probeVideoCodec(file: string): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const p = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.on('close', () => resolve(out.trim().split('\n')[0] || null));
      p.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

/** relay target height: the source's own height, capped at 720 — and at 480
 *  on tiny CPUs (2 cores): a 720p x264 encode alone oversubscribes them,
 *  which showed up as the relay stalling behind realtime */
async function relayTargetHeight(dir: string, firstFile: string): Promise<number> {
  const cpuCap = (os.cpus().length || 2) <= 2 ? 480 : 720;
  const h = await probeHeight(path.join(dir, firstFile));
  if (!h || h <= 0) return cpuCap;
  return Math.min(h, cpuCap);
}

function probeHeight(file: string): Promise<number | null> {
  return new Promise((resolve) => {
    try {
      const p = spawn('ffprobe', [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=height', '-of', 'csv=p=0', file,
      ], { stdio: ['ignore', 'pipe', 'ignore'] });
      let out = '';
      p.stdout.on('data', (d) => (out += String(d)));
      p.on('close', () => {
        const n = parseInt(out.trim().split('\n')[0] || '', 10);
        resolve(Number.isFinite(n) && n > 0 ? n : null);
      });
      p.on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function fetchText(url: string, referer: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
      signal: AbortSignal.timeout(12000),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** encode a direct source for the client → /api/transcode?src=…&r=…&s=… */
export function encodeSource(url: string, referer: string): { src: string; r: string; s: string } {
  return {
    src: Buffer.from(url, 'utf-8').toString('base64url'),
    r: referer,
    s: signUrl(url, referer),
  };
}

export function decodeSource(src: string, r: string, s: string): { url: string; referer: string } | null {
  try {
    const url = Buffer.from(src, 'base64url').toString('utf-8');
    if (!/^https?:\/\//i.test(url)) return null;
    if (!verifySignature(url, r || '', s)) return null;
    return { url, referer: r || '' };
  } catch {
    return null;
  }
}
