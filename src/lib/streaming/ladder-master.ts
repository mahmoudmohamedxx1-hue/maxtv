// ─── Native server quality ladder (v1.3) ─────────────────────────────────────
// DaddyLive channels ship ONE rendition — the old player had no real quality
// menu (picking 144p detached the whole source onto a transcode playlist and
// back; the user saw the channel "change then return", and the per-segment
// re-attach rebuffered every time). This module synthesizes a MASTER playlist
// that presents every rung as a native HLS variant, so hls.js does what it is
// built for: ABR across rungs + instant in-place quality switches:
//
//   #EXTM3U
//   #EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=256x144
//   /api/turbo?channel=91&h=144&mode=m3u8      ← server-transcoded (save data)
//   … 244 / 360 / 480 …
//   #EXT-X-STREAM-INF:BANDWIDTH=4500000
//   /api/hls?url=…&ch=91&raw=1                 ← native feed, direct segments
//
// The Source rung's playlist (raw=1) lists segments as /api/segdl?u=<cdn>
// URLs — the browser's custom hls.js loader (uncloak-loader.ts) fetches the
// CDN directly and uncloaks in-page (ultra-low lag); any other consumer
// (Safari native HLS, the loader's fallback) resolves the same URLs through
// the server route with the legacy unwrap.
//
// BANDWIDTH values are deliberately CONSERVATIVE (slightly above the measured
// turbo outputs: 144p ≈ 680kbps measured, declared 800k): when a rung is
// declared cheaper than it really delivers, ABR overshoots into stalls — the
// exact bug this ladder replaces. Overshooting the declaration makes ABR
// demand headroom before stepping up: stability first, data saved below.

// ⤴ WORKERS 2026-10-23: the &h= rungs are per-segment ffmpeg re-encodes —
// impossible on Cloudflare Workers (no processes, stubbed child_process).
// Serving a master that advertises them made hls.js ABR start on a rung
// whose every segment 404'd forever ("loads for 4 minutes, never plays" —
// the field report). Workers masters carry ONLY the native Source rung.
import { ON_WORKERS } from './runtime';

export interface LadderRung {
  h: number;
  w: number;
  bandwidth: number;
}

/* ── native-height cache ────────────────────────────────────────────────────
 * Single-rendition media playlists never declare resolution, so the Source
 * rung used to surface in the player's quality menu as a bare "Source" — the
 * user never saw the channel's real 720p/1080p entry ("there is no 720p and
 * 1080p which are the native quality"). /api/turbo?mode=native probes the
 * real height once per channel (ffmpeg -i on a window segment) and parks it
 * here; every subsequent ladder master then carries RESOLUTION on the Source
 * rung, so hls.js reports a real level height and the menu labels it
 * "720p"/"1080p" from the very first manifest parse. Per-isolate memory —
 * cold isolates re-learn it on the first probe (the client also fires one
 * probe per channel open). */
const nhG = globalThis as { __maxtvNativeH?: Map<string, number> };
if (!nhG.__maxtvNativeH) nhG.__maxtvNativeH = new Map();

export function rememberNativeHeight(channel: string, h: number): void {
  if (h > 0) nhG.__maxtvNativeH!.set(channel, h);
}

export function knownNativeHeight(channel: string): number {
  return nhG.__maxtvNativeH!.get(channel) || 0;
}

/** even 16:9 width for a ladder height (x264 requires even dimensions) */
function evenW(h: number): number {
  const w = Math.round((h * 16) / 9);
  return w % 2 ? w + 1 : w;
}

/** turbo &h= rungs served in the master (the serverless data-saver engine).
 *  720/1080 stay OFF the transcode ladder — 1-vCPU encodes run slower than
 *  realtime up there (proven 2026-10-08); the native Source rung covers them. */
export const LADDER_RUNGS: readonly LadderRung[] = [
  { h: 144, w: 256, bandwidth: 800_000 },
  { h: 244, w: 432, bandwidth: 1_100_000 },
  { h: 360, w: 640, bandwidth: 1_600_000 },
  { h: 480, w: 854, bandwidth: 2_400_000 },
] as const;

/** declared bandwidth of the native Source rung — measured ~4.1-4.3 Mbps on
 *  beIN (2.58MB per 5s segment); declaring a bit above keeps ABR honest
 *  about stepping up to it on marginal links. */
export const SOURCE_RUNG_BANDWIDTH = 4_500_000;

export function isLadderHeight(h: number): boolean {
  return LADDER_RUNGS.some((r) => r.h === h);
}

/** Build the synthetic master. Needs no upstream fetch — the rung URLs are
 *  fully derivable from the request (the manifest url/r/s ride along, and
 *  the Source variant reuses the SAME signed params + raw=1). Serving the
 *  master is therefore instant and cache-friendly. */
export function buildLadderMaster(opts: {
  channel: string;
  /** the signed /api/hls base params (url=…&r=…&s=…) as a querystring
   *  WITHOUT the leading '?' — the Source rung appends &ch/&srv/&raw=1 */
  signedQuery: string;
  srv?: string;
  /** probed native height of the source (0/undefined = unknown) — when
   *  known, the Source rung carries RESOLUTION so the player's quality menu
   * shows the real "720p"/"1080p" entry instead of a bare "Source" */
  nativeH?: number;
}): string {
  const { channel, signedQuery, srv, nativeH } = opts;
  const ch = encodeURIComponent(channel);
  const out: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
  ];
  // ⤴ WORKERS: no ffmpeg → no transcode rungs (see the import note above).
  // A single-variant master is valid HLS: hls.js exposes one level, the
  // quality menu shows "Source"/native, and ABR/prefs/data-saver picks that
  // cannot be satisfied simply no-op — the player already treats a missing
  // rung as "stay where you are".
  const rungs = ON_WORKERS ? [] : LADDER_RUNGS;
  for (const r of rungs) {
    out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.w}x${r.h}`);
    out.push(`/api/turbo?channel=${ch}&h=${r.h}&mode=m3u8`);
  }
  out.push(
    `#EXT-X-STREAM-INF:BANDWIDTH=${SOURCE_RUNG_BANDWIDTH}${
      nativeH && nativeH > 0 ? `,RESOLUTION=${evenW(nativeH)}x${nativeH}` : ''
    }`
  );
  out.push(
    `/api/hls?${signedQuery}&ch=${ch}${srv ? `&srv=${encodeURIComponent(srv)}` : ''}&raw=1`
  );
  return out.join('\n') + '\n';
}

/** True when a playlist body is a single-rendition MEDIA playlist (no
 *  variants) — used to decide whether the ladder is worth serving at all
 *  (a provider master with its own ABR rungs is served as-is instead). */
export function isMediaPlaylist(body: string): boolean {
  return body.includes('#EXTM3U') && !body.includes('#EXT-X-STREAM-INF');
}
