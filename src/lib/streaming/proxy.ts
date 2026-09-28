// ─── HLS proxy engine ────────────────────────────────────────────────────────
// Ported in spirit from live-sport-plugin's HlsRewriteService + relay routes:
//   • fetches upstream manifests with the correct Referer / UA
//   • rewrites EVERY uri inside playlists to route back through /api/hls
//     (segments, keys, variant playlists) so the browser never hits CORS
//   • streams segments / init files byte-for-byte with Range support

import { UA, isBlockedHost, signUrl } from './resolve';
import { unwrapSegment } from './uncloak';

const SEGMENT_EXT = /\.(ts|m4s|mp4|aac|mp3|vtt|srt|webvtt|cmfa|cmfv|cmaf|jpg|jpeg|png)(\?|$)/i;

export function proxyUrlFor(target: string, referer: string): string {
  const sig = signUrl(target, referer);
  const params = new URLSearchParams({ url: target, r: referer, s: sig });
  return `/api/hls?${params.toString()}`;
}

// ── warm segment cache (direct-transport prefetch) ───────────────────────
// The direct transport's stutter root cause: every segment fetch pays the
// upstream CDN's latency (p95 3s+, spikes far worse) on the PLAYER's
// critical path, and the CDN's live window is only ~4 segments deep — one
// slow fetch drains the buffer. When the browser polls a playlist through
// /api/hls we speculatively fetch+unwrap the NEWEST segments in the
// background, so the player's next segment requests are served from warm
// memory (~0ms). This is the direct-transport twin of turbo's prefetch.

interface WarmEntry {
  buf: Uint8Array;
  at: number;
}

const warmG = globalThis as { __maxtvWarm?: Map<string, WarmEntry> };
if (!warmG.__maxtvWarm) warmG.__maxtvWarm = new Map();
const WARM = warmG.__maxtvWarm;
const WARM_TTL_MS = 2 * 60_000;
const WARM_MAX_BYTES = 160 * 1024 * 1024;
const WARM_MAX_ENTRIES = 90;
const WARM_PREFETCH_COUNT = 3;
const warmInflight = new Set<string>();
let warmBytes = 0;

function warmGet(url: string): Uint8Array | null {
  const e = WARM.get(url);
  if (!e) return null;
  if (Date.now() - e.at > WARM_TTL_MS) {
    WARM.delete(url);
    warmBytes -= e.buf.length;
    return null;
  }
  return e.buf;
}

function warmPut(url: string, buf: Uint8Array): void {
  if (buf.length < 1024) return; // never cache empty/error bodies
  const old = WARM.get(url);
  if (old) warmBytes -= old.buf.length;
  WARM.set(url, { buf, at: Date.now() });
  warmBytes += buf.length;
  // evict LRU (insertion order) + sweep expired
  const now = Date.now();
  for (const [k, e] of WARM) {
    if (WARM.size <= WARM_MAX_ENTRIES && warmBytes <= WARM_MAX_BYTES && now - e.at <= WARM_TTL_MS) break;
    WARM.delete(k);
    warmBytes -= e.buf.length;
  }
}

/** shared: turn upstream bytes into clean TS (or null when undecodable) */
function decodeSegmentBytes(raw: Uint8Array, upstreamCt: string): Uint8Array | null {
  if (raw.length < 188) return null;
  const isPng = raw[0] === 0x89 && raw[1] === 0x50;
  const isRiff = raw[0] === 0x52 && raw[1] === 0x49 && raw[2] === 0x46 && raw[3] === 0x46;
  const isGzip = raw[0] === 0x1f && raw[1] === 0x8b;
  const isTik = raw[0] === 84 && raw[1] === 73 && raw[2] === 75 && raw[3] === 84; // "TIKT"
  if (raw[0] === 0x47) return raw; // clean TS passthrough
  if (isPng || isRiff || isGzip || isTik || upstreamCt.startsWith('image/')) {
    try {
      const ts = unwrapSegment(raw);
      return ts && ts.length > 0 ? ts : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** background fetch + unwrap one segment into the warm cache */
async function warmPrefetch(url: string, referer: string): Promise<void> {
  if (WARM.has(url)) {
    // LRU touch
    const e = WARM.get(url)!;
    WARM.delete(url);
    WARM.set(url, e);
    return;
  }
  if (warmInflight.has(url)) return;
  warmInflight.add(url);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: '*/*', ...(referer ? { Referer: referer } : {}) },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return;
    const raw = new Uint8Array(await res.arrayBuffer());
    const ts = decodeSegmentBytes(raw, res.headers.get('content-type') || '');
    if (ts) warmPut(url, ts);
  } catch {
    /* best effort — the player's own fetch retries anyway */
  } finally {
    warmInflight.delete(url);
  }
}

async function upstreamFetch(url: string, referer: string, range?: string, method: 'GET' | 'HEAD' = 'GET') {
  return fetch(url, {
    method,
    headers: {
      'User-Agent': UA,
      Accept: '*/*',
      ...(referer ? { Referer: referer } : {}),
      ...(range ? { Range: range } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
}

/** Make a line absolute against the playlist URL */
function absolutize(line: string, baseUrl: string): string {
  const trimmed = line.trim();
  if (!trimmed) return trimmed;
  try {
    return new URL(trimmed, baseUrl).toString();
  } catch {
    return trimmed;
  }
}

/** Rewrite an m3u8 playlist body so every referenced uri routes via /api/hls.
 *  Live media playlists additionally trigger a speculative prefetch of the
 *  NEWEST segments (see the warm cache above) so the player never waits on
 *  the CDN's critical path. */
export function rewritePlaylist(body: string, playlistUrl: string, referer: string): string {
  const lines = body.split('\n');
  const out: string[] = [];
  const segmentTargets: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // URI="..." attributes (keys, maps, media renditions, subtitles)
    if (line.startsWith('#') && line.includes('URI="')) {
      out.push(
        line.replace(/URI="([^"]+)"/g, (_, uri) => {
          const abs = absolutize(uri, playlistUrl);
          return `URI="${proxyUrlFor(abs, referer)}"`;
        })
      );
      continue;
    }

    // plain uri lines
    if (line && !line.startsWith('#')) {
      const abs = absolutize(line, playlistUrl);
      segmentTargets.push(abs);
      out.push(proxyUrlFor(abs, referer));
      continue;
    }

    out.push(line);
  }

  // speculatively warm the newest segments (last K) — the player will ask
  // for them within seconds; a cache hit serves them at memory speed.
  // ONLY media playlists (never masters — their non-# lines are variant
  // playlists, not segments — and never VOD/ENDLIST).
  if (segmentTargets.length && !/#EXT-X-STREAM-INF|#EXT-X-ENDLIST/.test(body)) {
    for (const t of segmentTargets.slice(-WARM_PREFETCH_COUNT)) void warmPrefetch(t, referer);
  }
  return out.join('\n');
}

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body?: string;
  bodyBytes?: Uint8Array;
  stream?: ReadableStream<Uint8Array>;
}

/**
 * Main proxy entry — called by /api/hls route handler with validated inputs.
 */
export async function proxyHlsRequest(
  target: string,
  referer: string,
  range?: string
): Promise<ProxyResult> {
  let host: string;
  try {
    host = new URL(target).hostname;
  } catch {
    return { status: 400, headers: { 'content-type': 'text/plain' }, body: 'bad url' };
  }
  if (isBlockedHost(host)) {
    return { status: 403, headers: { 'content-type': 'text/plain' }, body: 'blocked host' };
  }

  // ── warm-cache fast path ────────────────────────────────────────────────
  // Segment requests check the speculative prefetch cache FIRST — a hit skips
  // the upstream round-trip entirely (the direct transport's critical-path
  // latency drops from the CDN's p95 ~3s to ~0ms). Range requests and
  // manifest-ish URLs (m3u8) always go upstream.
  if (!range && !/\.m3u8?(\?|$)/i.test(target)) {
    const warmHit = warmGet(target);
    if (warmHit) {
      return {
        status: 200,
        headers: {
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
          'content-type': 'video/mp2t',
          'accept-ranges': 'none',
          'x-warm': 'hit',
        },
        bodyBytes: warmHit,
      };
    }
  }

  const res = await upstreamFetch(target, referer, range);
  if (!res.ok && res.status !== 206) {
    // propagate the upstream status so the player can react — but NEVER a
    // bare 503: that code is reserved for OUR deliberate x-offair marker
    // (the player goes straight to the off-air screen on it, so a transient
    // upstream 503 flap must surface as a retryable 502 instead)
    const mapped = res.status === 400 || res.status === 503 ? 502 : res.status;
    return {
      status: mapped,
      headers: { 'content-type': 'text/plain', 'x-upstream-status': String(res.status) },
      body: `upstream ${res.status}`,
    };
  }

  const contentType = res.headers.get('content-type') || '';
  const finalUrl = res.url || target;
  const urlLikeManifest = /\.m3u8?(\?|$)/i.test(finalUrl) || /\.m3u8?$/i.test(target);
  const ctIsManifest = contentType.includes('mpegurl');
  const ctIsText = contentType.startsWith('text/');

  const headers: Record<string, string> = {
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
  };

  // manifest path: url looks like a playlist, content-type says mpegurl, or
  // the CDN serves it as text (php endpoints etc). Verify by body content.
  if ((urlLikeManifest || ctIsManifest || ctIsText) && res.body) {
    const body = await res.text();
    if (body.includes('#EXTM3U')) {
      // CRITICAL: absolutize against the FINAL url (after redirects), not the
      // original target — CDNs like Tubi/STIRR 302 to a tokenised host and the
      // manifest's relative URIs resolve against that host, not the entry URL.
      const rewritten = rewritePlaylist(body, finalUrl, referer);
      headers['content-type'] = ctIsManifest ? contentType : 'application/vnd.apple.mpegurl';
      return { status: 200, headers, body: rewritten };
    }
    // text body that is not a playlist → upstream error page
    return {
      status: 502,
      headers: { 'content-type': 'text/plain', 'x-upstream-status': String(res.status) },
      body: `upstream returned ${contentType || 'non-playlist'}`,
    };
  }

  // segments / binary — unwrap image-cloaked TS (PNG pixel steganography,
  // WEBP EXIF, IEND append, TIKTIK markers, raw gzip), stream clean TS
  const upstreamCt = res.headers.get('content-type') || '';

  if (res.body) {
    const reader = res.body.getReader();
    const first = await reader.read();
    if (first.done || !first.value || first.value.length === 0) {
      return { status: res.status, headers };
    }
    const head = first.value;
    const isPng = head[0] === 0x89 && head[1] === 0x50;
    const isRiff = head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46;
    const isGzip = head[0] === 0x1f && head[1] === 0x8b;
    const isTik =
      head[0] === 84 && head[1] === 73 && head[2] === 75 && head[3] === 84; // "TIKT"
    const needsUnwrap = isPng || isRiff || isGzip || isTik || upstreamCt.startsWith('image/');

    if (needsUnwrap) {
      // consume the whole body then unwrap (full port of the player chain)
      const parts: Uint8Array[] = [head];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) parts.push(value);
      }
      const total = parts.reduce((n, p) => n + p.length, 0);
      const buf = new Uint8Array(total);
      let o = 0;
      for (const p of parts) {
        buf.set(p, o);
        o += p.length;
      }
      try {
        const ts = unwrapSegment(buf);
        if (ts && ts.length > 0) {
          headers['content-type'] = 'video/mp2t';
          delete headers['content-range'];
          headers['accept-ranges'] = 'none';
          return { status: 200, headers, bodyBytes: ts };
        }
      } catch {
        /* fall through to off-air */
      }
      // genuine image / undecodable → fail fast so the player shows the
      // off-air notice instead of buffering forever
      return {
        status: 503,
        headers: { 'content-type': 'text/plain', 'x-offair': '1' },
        body: 'off-air or undecodable segment',
      };
    }

    // clean TS / fMP4 — stream through, first chunk first
    const rest = new ReadableStream<Uint8Array>({
      async start(c) {
        c.enqueue(head);
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) c.enqueue(value);
          }
          c.close();
        } catch (e) {
          c.error(e as Error);
        }
      },
      cancel(reason) {
        void reader.cancel(reason);
      },
    });
    const passthrough = ['content-type', 'accept-ranges', 'etag'];
    for (const h of passthrough) {
      const v = res.headers.get(h);
      if (v) headers[h] = v;
    }
    if (!headers['content-type']) headers['content-type'] = 'video/mp2t';
    return { status: res.status, headers, stream: rest };
  }
  return { status: res.status, headers };
}

export { SEGMENT_EXT };
