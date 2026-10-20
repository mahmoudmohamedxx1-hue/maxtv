// ─── Player module: shared constants & types ─────────────────────────────────
// Extracted from the old 3,085-line PlayerOverlay monolith (2026-10-20
// decomposition). Pure data + types — safe to import anywhere.

import type { Playable } from '@/lib/store';

export type Phase = 'resolving' | 'loading' | 'playing' | 'paused' | 'error' | 'offair' | 'hevc';

/** one entry in the channel-surf sidebar */
export interface SurfItem extends Playable {
  group: 'feeds' | 'live' | 'channels';
  sub?: string;
  startedAt?: number;
}

/** alternate source for a channel (same channel, different provider) */
export interface AltServer {
  id: string;
  name: string;
  source: string;
  sourceName: string;
  url: string;
  logo?: string;
  health?: string;
  /** probed native quality rungs (e.g. [240,360,480,720,1080] on amagi) —
   *  rendered in the quality menu as "via <source>" entries */
  ladder?: number[];
  /** CDN answers CORS → the alternate can play straight from the CDN */
  cors?: boolean;
  /** TRUE = verified SAME channel (quality-rung eligible). FALSE = brand-family
   *  sibling (beIN 1 → beIN XTRA) — servers-menu only, never a quality rung:
   *  picking a quality must never change the channel. */
  sameChannel?: boolean;
}

/** DaddyLive transport servers (kept in sync with src/lib/sports/daddylive.ts) —
 *  TRANSPORT-based, BENCHMARK-ORDERED (2026-09-28 bench: edge manifest p95
 *  343ms, cdn route 665ms+, mirror watch pages slowest). Array order =
 *  failover walk order. LABELS ARE STABLE PER ID so the user's "Server N"
 *  mental model never breaks. Direct CDN ("Server 2") is the DEFAULT —
 *  user-verified best of the bunch (no ffmpeg warmup, no extra hop, the
 *  browser reads the CDN manifest straight through /api/hls). */
export const DL_SERVERS = [
  { id: 'direct', label: 'Server 2', host: 'Direct CDN · straight through' },
  { id: 'edge', label: 'Server 9', host: 'Edge direct · lowest latency' },
  { id: 'turbo', label: 'Server 1', host: 'Smart cache · pre-buffered, smoothest' },
  { id: 'direct-cdn', label: 'Server 5', host: 'Direct via daddyliveplayer.st' },
  { id: 'direct-dlive', label: 'Server 3', host: 'Direct via dlive.sx' },
  { id: 'direct-dlstreams', label: 'Server 4', host: 'Direct via dlstreams.st' },
  { id: 'direct-dlive-player', label: 'Server 10', host: 'Direct via dlive.sx player' },
  { id: 'direct-dlstreams-player', label: 'Server 11', host: 'Direct via dlstreams.st player' },
  { id: 'relay', label: 'Server 6', host: 'Stable relay · bulletproof' },
  { id: 'relay-dlive', label: 'Server 7', host: 'Relay via dlive.sx' },
  { id: 'relay-dlstreams', label: 'Server 8', host: 'Relay via dlstreams.st' },
] as const;

export interface ServerOption {
  id: string;
  label: string;
  host: string;
  active?: boolean;
}

/** Deep retry budgets — the DaddyLive CDN edge flaps in 10-20s windows
 *  (playlist 404s / resets, then recovers). Default hls.js policies give up
 *  far too early and surface a fatal "off air" during those windows. */
export const RESILIENT_LOAD_POLICIES = {
  manifestLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15_000,
      maxLoadTimeMs: 30_000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 6, retryDelayMs: 500, maxRetryDelayMs: 4_000 },
    },
  },
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15_000,
      maxLoadTimeMs: 60_000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 10, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
    },
  },
} as const;

/** transcode-ladder hls tuning — the &h= data-saver feeds are re-encoded
 *  one segment at a time on a 1-vCPU serverless isolate, so the player must
 *  NOT hug the live edge like it does on native passthrough: join 5 segments
 *  (≈30s) back and keep a deep buffer. That ride distance is what turns the
 *  encode latency invisible — the warm band has ~2 polls of lead time per
 *  segment, and a slow cold encode lands in runway instead of draining the
 *  buffer into a stall (2026-10-08 "480p doesn't render/load constantly"). */
export const LADDER_HLS_CONFIG = {
  liveSyncDurationCount: 5,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  maxLiveSyncPlaybackRate: 1, // never catch-up speed — playback stays 1x
  backBufferLength: 90,
} as const;

/** transcode ladder — every height re-encoded in real time for streams whose
 *  provider ships a single rendition (DaddyLive + most free IPTV CDNs) */
export const DATA_SAVER_HEIGHTS = [144, 244, 360, 480, 720, 1080] as const;

/** the DaddyLive iframe-chain sources — when the resolved src is one of
 *  these, the embedded page takes over playback instead of hls.js */
const DL_IFRAME_PREFIXES = [
  'https://dlive.sx/stream/stream-',
  'https://dlive.sx/watch.php?',
  'https://daddyliveplayer.st/premiumtv/daddy.php?',
  'https://dembed.st/premiumtv/daddy.php?',
] as const;

export function isDlIframeSrc(src: string | null | undefined): boolean {
  return !!src && DL_IFRAME_PREFIXES.some((p) => src.startsWith(p));
}

export interface MatchLike {
  id: string;
  title: string;
  league: string;
  startTime: number;
  channels: { id: string; name: string; logo?: string }[];
  team1Logo?: string;
  team2Logo?: string;
  leagueLogo?: string;
  channelLogo?: string;
}
