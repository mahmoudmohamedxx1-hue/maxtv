// ─── Local Turbo — client-side low-latency playback engine (Tier 3) ───────────
// Plays the SAME live HLS source the player already uses, but through a
// browser-local pipeline instead of hls.js/MSE:
//
//   UrlSource → mediabunny HLS live reader (sliding-window polling)
//     ├─ video: VideoSampleSink (WebCodecs hw decode, optimizeForLatency)
//     │           → clock-paced pull → <canvas> render (per-rung size)
//     └─ audio: AudioBufferSink → WebAudio scheduling (the master clock)
//
// Why this shape (2026-10-25 research):
//   • mediabunny has NO built-in playback/MediaStreamTarget — playback must be
//     composed from sinks; WebAudio is the natural A/V clock.
//   • Live tracks are first-class: reads that depend on future data WAIT
//     ("live wait"), so an unbounded `samples()` iterator paces itself at the
//     live edge once it catches up.
//   • A decode-ahead frame QUEUE would hold one GPU texture per frame
//     (60 fps × 1.2 s ≈ 72 × ~3 MB ≈ 220 MB at 1080p) — instead we pull
//     JUST-IN-TIME: the render loop only takes the next sample when the
//     audio clock reaches its timestamp, so memory stays bounded by
//     mediabunny's internal decode lookahead plus one held frame.
//   • Re-encoding (WebCodecs VideoEncoder) was deliberately NOT used for
//     viewing: it adds ~0.2–1 s latency and GPU cost with zero bandwidth
//     saving (the source rendition is downloaded either way). The local rung
//     is a RENDER size — full decode quality, canvas-scaled.
//
// Latency budget: joins JOIN_OFFSET s behind the newest playlist media time
// (hls.js "fast" profile joins 2 segments ≈ 12–24 s back), so Turbo typically
// rides 1–2 s behind the live edge while standard playback rides 3–6 segments.
//
// Everything is lazy: `mediabunny` is only imported when a Turbo rung is
// actually picked, so the base bundle never pays for this module's weight.

export type LocalTurboPhase = 'starting' | 'playing' | 'stalled' | 'error';

export interface LocalTurboStats {
  phase: LocalTurboPhase;
  /** render height of the local rung (px) */
  renderHeight: number;
  /** native display height of the source track (px) */
  sourceHeight: number;
  /** live-edge media time minus the media time currently on screen (s) */
  latencySec: number;
  /** seconds of audio scheduled ahead of the playback clock */
  audioAheadSec: number;
  framesDrawn: number;
  framesDropped: number;
  audioBuffers: number;
  resyncs: number;
}

export interface LocalTurboOptions {
  /** the same m3u8 URL the player would hand to hls.js (same-origin proxy or CORS-friendly) */
  url: string;
  /** canvas the engine renders into (must be in the DOM) */
  canvas: HTMLCanvasElement;
  /** render-height rung; null/0 = native size */
  height?: number | null;
  /** seconds behind the live edge to join (default 1.2) */
  joinOffset?: number;
  volume?: number;
  muted?: boolean;
  onPhase?: (phase: LocalTurboPhase, stats: LocalTurboStats) => void;
  onStats?: (stats: LocalTurboStats) => void;
}

export interface LocalTurboHandle {
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  pause(): void;
  resume(): void;
  /** snap to the live edge (the "LIVE" button) */
  jumpToLive(): void;
  getStats(): LocalTurboStats;
  /** idempotent teardown */
  stop(): void;
}

/** how far behind the newest playlist media time we join (s) */
const JOIN_OFFSET_DEFAULT = 1.2;
/** pull a video sample this far ahead of the clock (s) — one frame-ish */
const VIDEO_LEAD = 0.03;
/** never schedule more than this much audio ahead of the clock (s) */
const MAX_AUDIO_AHEAD = 5;
/** no draw for this long while playing → "stalled" */
const STALL_AFTER_SEC = 2.5;
/** stalled this long → resync to the live edge */
const RESYNC_AFTER_SEC = 6;
/** give up (parent falls back to hls.js) after this many resyncs per minute */
const MAX_RESYNCS = 3;
/** metadata-only live-edge poll cadence (ms) */
const EDGE_POLL_MS = 5000;

/** cheap synchronous capability probe — no mediabunny import, memoized */
let probeMemo: boolean | null = null;
export function probeLocalTurbo(): boolean {
  if (probeMemo !== null) return probeMemo;
  if (typeof window === 'undefined') return false;
  probeMemo =
    typeof window.VideoDecoder === 'function' &&
    typeof window.AudioContext === 'function' &&
    typeof window.HTMLCanvasElement === 'function' &&
    !!document.createElement('canvas').getContext('2d') &&
    window.isSecureContext !== false;
  return probeMemo;
}

interface Clock {
  now(): number; // current media time (s)
  paused(): boolean;
}

/** audio-driven clock — sample-accurate, freezes on ctx.suspend() */
class AudioClock implements Clock {
  private baseCtxTime: number;
  private baseMedia: number;
  constructor(private ctx: AudioContext, baseMedia: number, leadIn = 0.12) {
    this.baseCtxTime = ctx.currentTime + leadIn;
    this.baseMedia = baseMedia;
  }
  now(): number {
    return this.ctx.currentTime - this.baseCtxTime + this.baseMedia;
  }
  paused(): boolean {
    return this.ctx.state !== 'running';
  }
  /** re-anchor after a resync: media time `media` plays at ctx time now+leadIn */
  rebase(media: number, leadIn = 0.12): void {
    this.baseCtxTime = this.ctx.currentTime + leadIn;
    this.baseMedia = media;
  }
  get anchorCtxTime(): number {
    return this.baseCtxTime;
  }
}

/** wall-clock fallback for streams without an audio track */
class PerfClock implements Clock {
  private startPerf = performance.now();
  private startMedia: number;
  private frozenAt: number | null = null;
  constructor(startMedia: number) {
    this.startMedia = startMedia;
  }
  now(): number {
    if (this.frozenAt !== null) return this.frozenAt;
    return (performance.now() - this.startPerf) / 1000 + this.startMedia;
  }
  paused(): boolean {
    return this.frozenAt !== null;
  }
  pause(): void {
    if (this.frozenAt === null) this.frozenAt = this.now();
  }
  resume(): void {
    if (this.frozenAt !== null) {
      this.startPerf = performance.now();
      this.startMedia = this.frozenAt;
      this.frozenAt = null;
    }
  }
  rebase(media: number): void {
    this.startPerf = performance.now();
    this.startMedia = media;
    this.frozenAt = null;
  }
}

/** resolve when `predicate` flips true (or the engine dies). Polls at rAF. */
function waitUntil(deadlineMs: number, predicate: () => boolean, alive: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const tick = () => {
      if (!alive()) return resolve();
      if (predicate()) return resolve();
      if (performance.now() > deadlineMs) return resolve(); // safety valve
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

export async function startLocalTurbo(opts: LocalTurboOptions): Promise<LocalTurboHandle> {
  const mb = await import('mediabunny');
  type VideoGen = AsyncGenerator<import('mediabunny').VideoSample, void, unknown>;
  type AudioGen = AsyncGenerator<import('mediabunny').WrappedAudioBuffer, void, unknown>;
  const joinOffset = opts.joinOffset ?? JOIN_OFFSET_DEFAULT;

  // ── state ──────────────────────────────────────────────────────────────────
  let disposed = false;
  let phase: LocalTurboPhase = 'starting';
  let stats: LocalTurboStats = {
    phase,
    renderHeight: 0,
    sourceHeight: 0,
    latencySec: 0,
    audioAheadSec: 0,
    framesDrawn: 0,
    framesDropped: 0,
    audioBuffers: 0,
    resyncs: 0,
  };
  let resyncTimestamps: number[] = [];
  let lastDrawAt = performance.now();
  let lastEdgeTs = 0;
  let cursor: number; // media time both iterators restart from

  const input = new mb.Input({ source: new mb.UrlSource(opts.url), formats: mb.HLS_FORMATS });
  const videoTrack = await input.getPrimaryVideoTrack();
  if (!videoTrack) {
    input.dispose();
    throw new Error('no video track');
  }
  const audioTrack = (await videoTrack.getPrimaryPairableAudioTrack()) ?? (await input.getPrimaryAudioTrack());
  if (!(await videoTrack.canDecode())) {
    input.dispose();
    throw new Error('video codec not decodable in this browser');
  }

  const srcW = await videoTrack.getDisplayWidth();
  const srcH = await videoTrack.getDisplayHeight();
  const rotation = await videoTrack.getRotation();
  const flip = await videoTrack.getFlip();
  const nativeHeight = srcH || 720;
  const renderHeight = opts.height && opts.height > 0 ? Math.min(opts.height, nativeHeight) : nativeHeight;
  const scale = renderHeight / nativeHeight;
  const swap = rotation === 90 || rotation === 270;
  const canvasW = Math.max(2, Math.round(((swap ? srcH : srcW) || 1280) * scale / 2) * 2);
  const canvasH = Math.max(2, Math.round(((swap ? srcW : srcH) || 720) * scale / 2) * 2);

  const canvas = opts.canvas;
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) {
    input.dispose();
    throw new Error('canvas 2d unavailable');
  }

  // ── audio graph / clock ────────────────────────────────────────────────────
  let audioCtx: AudioContext | null = null;
  let gain: GainNode | null = null;
  let clock: Clock;
  let audioSink: InstanceType<typeof mb.AudioBufferSink> | null = null;
  let scheduledUntil = -Infinity;
  const liveNodes = new Set<AudioBufferSourceNode>();

  const applyVolume = () => {
    if (gain) gain.gain.value = opts.muted ? 0 : (opts.volume ?? 1);
  };

  if (audioTrack) {
    audioCtx = new AudioContext({ latencyHint: 'interactive' });
    gain = audioCtx.createGain();
    gain.connect(audioCtx.destination);
    applyVolume();
    try {
      await audioCtx.resume(); // engine starts from a user gesture (menu pick)
    } catch {
      /* some browsers still delay — nodes schedule once running */
    }
    audioSink = new mb.AudioBufferSink(audioTrack);
  }

  // ── join point: newest media time minus the offset ─────────────────────────
  const packetSink = new mb.EncodedPacketSink(videoTrack);
  const probeEdge = async (): Promise<number> => {
    const last = await packetSink.getPacket(Infinity, { skipLiveWait: true, metadataOnly: true });
    return last ? last.timestamp : 0;
  };
  const firstTs = await videoTrack.getFirstTimestamp();
  const edge0 = await probeEdge();
  if (!edge0) {
    input.dispose();
    audioCtx?.close().catch(() => {});
    throw new Error('live edge not found (empty playlist window)');
  }

  const joinAt = (offset: number): number => Math.max(edge0 - offset, firstTs ?? 0);
  cursor = joinAt(joinOffset);

  // clock anchor: media time `cursor` plays "now"
  if (audioCtx) {
    clock = new AudioClock(audioCtx, cursor);
  } else {
    clock = new PerfClock(cursor);
  }
  // (cast helper — narrowed after the branch)
  const audioClock = audioCtx ? (clock as AudioClock) : null;
  const perfClock = audioCtx ? null : (clock as PerfClock);

  // ── render ─────────────────────────────────────────────────────────────────
  const draw = (sample: { draw: (c: CanvasRenderingContext2D, dx: number, dy: number, dw: number, dh: number) => void }) => {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.save();
    if (rotation || flip) {
      ctx.translate(canvasW / 2, canvasH / 2);
      if (rotation) ctx.rotate((rotation * Math.PI) / 180);
      if (flip) ctx.scale(-1, 1);
      ctx.translate(-canvasW / 2, -canvasH / 2);
    }
    sample.draw(ctx, 0, 0, canvasW, canvasH);
    ctx.restore();
    lastDrawAt = performance.now();
    stats.framesDrawn++;
  };

  const setPhase = (p: LocalTurboPhase) => {
    if (disposed || phase === p) return;
    phase = p;
    stats.phase = p;
    opts.onPhase?.(p, { ...stats });
  };
  const emitStats = () => {
    stats.latencySec = lastEdgeTs ? Math.max(0, lastEdgeTs - clock.now()) : stats.latencySec;
    stats.audioAheadSec = Math.max(0, scheduledUntil - clock.now());
    stats.renderHeight = renderHeight;
    stats.sourceHeight = nativeHeight;
    opts.onStats?.({ ...stats });
  };

  // ── loops (restarted on resync) ────────────────────────────────────────────
  const videoSink = new mb.VideoSampleSink(videoTrack, { optimizeForLatency: true });
  let videoGen: VideoGen | null = null;
  let audioGen: AudioGen | null = null;

  const killScheduledAudio = () => {
    for (const node of liveNodes) {
      try {
        node.stop();
      } catch {
        /* already ended */
      }
      node.disconnect();
    }
    liveNodes.clear();
    scheduledUntil = -Infinity;
  };

  const audioLoopFn = async () => {
    if (!audioSink || !audioCtx || !gain) return;
    while (!disposed) {
      // pace: don't schedule more than MAX_AUDIO_AHEAD ahead of the clock
      if (scheduledUntil - clock.now() > MAX_AUDIO_AHEAD) {
        await waitUntil(performance.now() + 500, () => scheduledUntil - clock.now() <= MAX_AUDIO_AHEAD || disposed, () => !disposed);
        if (disposed) return;
      }
      const gen = audioSink.buffers(cursor);
      audioGen = gen;
      try {
        for await (const { buffer, timestamp } of gen) {
          if (disposed) return;
          const at = audioCtx.currentTime + Math.max(0, timestamp - clock.now());
          const node = audioCtx.createBufferSource();
          node.buffer = buffer;
          node.connect(gain);
          node.start(at);
          liveNodes.add(node);
          node.onended = () => liveNodes.delete(node);
          scheduledUntil = Math.max(scheduledUntil, timestamp);
          stats.audioBuffers++;
          cursor = Math.max(cursor, timestamp); // advance the shared cursor
          if (scheduledUntil - clock.now() > MAX_AUDIO_AHEAD) {
            await gen.return(undefined as never).catch(() => {});
            break;
          }
        }
        // iterator exhausted the window or errored → let the watchdog resync
        if (!disposed) setPhase('stalled');
        return;
      } catch (e) {
        if (disposed) return;
        if (e instanceof mb.InputDisposedError) return;
        setPhase('stalled');
        return;
      } finally {
        audioGen = null;
      }
    }
  };

  const videoLoopFn = async () => {
    if (disposed) return;
    const gen = videoSink.samples(cursor);
    videoGen = gen;
    try {
      for await (const s of gen) {
        if (disposed) return;
        // wait until the clock reaches this frame's display time
        if (clock.now() < s.timestamp - VIDEO_LEAD) {
          await waitUntil(
            performance.now() + 30_000,
            () => disposed || clock.now() >= s.timestamp - VIDEO_LEAD,
            () => !disposed
          );
          if (disposed) {
            s.close();
            return;
          }
        }
        if (s.timestamp + 0.75 < clock.now()) {
          // fell behind (stall recovery) — skip stale frames silently
          stats.framesDropped++;
        } else {
          draw(s);
          if (phase !== 'playing') setPhase('playing');
        }
        s.close();
      }
      if (!disposed) setPhase('stalled');
    } catch (e) {
      if (!disposed && !(e instanceof mb.InputDisposedError)) setPhase('stalled');
    } finally {
      videoGen = null;
    }
  };

  const startLoops = () => {
    void videoLoopFn();
    void audioLoopFn();
  };

  // ── watchdog: stall detection + resync ─────────────────────────────────────
  const resync = (offset: number) => {
    if (disposed) return;
    const now = performance.now();
    resyncTimestamps = resyncTimestamps.filter((t) => now - t < 60_000);
    if (resyncTimestamps.length >= MAX_RESYNCS) {
      setPhase('error');
      return;
    }
    resyncTimestamps.push(now);
    stats.resyncs++;

    // stop current iterators at their next await point
    void videoGen?.return(undefined as never).catch(() => {});
    void audioGen?.return(undefined as never).catch(() => {});
    killScheduledAudio();

    const edge = lastEdgeTs || edge0;
    cursor = Math.max(edge - offset, firstTs ?? 0);
    if (audioClock) audioClock.rebase(cursor);
    perfClock?.rebase(cursor);
    lastDrawAt = performance.now();
    startLoops();
  };

  const watchdog = setInterval(() => {
    if (disposed) return;
    const sinceDraw = (performance.now() - lastDrawAt) / 1000;
    if (phase === 'playing' && sinceDraw > STALL_AFTER_SEC && !clock.paused()) {
      setPhase('stalled');
    }
    if (phase === 'stalled' && sinceDraw > RESYNC_AFTER_SEC && !clock.paused()) {
      resync(joinOffset);
    }
    emitStats();
  }, 1000);

  const edgePoll = setInterval(() => {
    if (disposed) return;
    void probeEdge()
      .then((t) => {
        if (t) lastEdgeTs = t;
      })
      .catch(() => {});
  }, EDGE_POLL_MS);
  lastEdgeTs = edge0;

  startLoops();
  emitStats();

  // ── handle ─────────────────────────────────────────────────────────────────
  return {
    setVolume(volume: number) {
      opts.volume = volume;
      applyVolume();
    },
    setMuted(muted: boolean) {
      opts.muted = muted;
      applyVolume();
    },
    pause() {
      perfClock?.pause();
      audioCtx?.suspend().catch(() => {});
    },
    resume() {
      perfClock?.resume();
      audioCtx?.resume().catch(() => {});
    },
    jumpToLive() {
      resync(0.4);
    },
    getStats() {
      return { ...stats };
    },
    stop() {
      if (disposed) return;
      disposed = true;
      clearInterval(watchdog);
      clearInterval(edgePoll);
      void videoGen?.return(undefined as never).catch(() => {});
      void audioGen?.return(undefined as never).catch(() => {});
      killScheduledAudio();
      try {
        input.dispose();
      } catch {
        /* ignore */
      }
      if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvasW, canvasH);
    },
  };
}
