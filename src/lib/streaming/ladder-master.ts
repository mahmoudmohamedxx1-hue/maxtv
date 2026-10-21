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

export interface LadderRung {
  h: number;
  w: number;
  bandwidth: number;
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
}): string {
  const { channel, signedQuery, srv } = opts;
  const ch = encodeURIComponent(channel);
  const out: string[] = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
  ];
  for (const r of LADDER_RUNGS) {
    out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bandwidth},RESOLUTION=${r.w}x${r.h}`);
    out.push(`/api/turbo?channel=${ch}&h=${r.h}&mode=m3u8`);
  }
  out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${SOURCE_RUNG_BANDWIDTH}`);
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
