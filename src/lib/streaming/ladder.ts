// ─── Ladder probe — CORS + multi-quality variant discovery ────────────────────
// One manifest fetch answers three questions for the player:
//   • master? — does the source ship an ABR master playlist (multiple qualities)
//   • heights — the variant ladder (1080/720/480/360/240 …)
//   • cors    — can the browser hit the CDN DIRECTLY (no proxy hop)?
//
// Why this matters (2026-10-01 field report): the ffmpeg data-saver ladder is
// dead on serverless (Vercel ships no ffmpeg), and DaddyLive CDNs are
// single-rendition — so the quality menu collapsed to one "720p" row. The
// ladder the user actually gets now is NATIVE: alternate sources (beIN XTRA on
// amagi, Rakuten/Wurl, Pluto …) ship real 6-rung master playlists, and the
// proxy already passes variants through untouched. This probe makes those
// rungs VISIBLE in the quality menu before the user hops, and lets CORS-open
// sources play straight from the CDN (the freestream-tv architecture: zero
// proxy latency, native ABR).

import { fetchTolerant } from './tls-fetch';
import { UA } from './resolve';

export interface LadderInfo {
  /** true when the manifest is a master playlist with ≥1 variant */
  master: boolean;
  /** variant heights, ascending (deduped). [] for single-rendition sources */
  heights: number[];
  /** variant bitrate (bps) by height */
  bitrate: Record<number, number>;
  /** the CDN answers CORS for browser origins → direct play is possible */
  cors: boolean;
}

const PROBE_TIMEOUT_MS = 4_000;
const CACHE_TTL_MS = 10 * 60_000;
const CACHE_MAX = 200;

interface CacheEntry {
  info: LadderInfo;
  at: number;
}

const g = globalThis as { __maxtvLadder?: Map<string, CacheEntry> };
if (!g.__maxtvLadder) g.__maxtvLadder = new Map();
const CACHE = g.__maxtvLadder;

const probeInflight = new Map<string, Promise<LadderInfo>>();

/** cache-only read — returns null when not probed (yet). Lets callers fire a
 *  probe and read whatever landed after a bounded wait, without blocking. */
export function peekLadder(url: string, referer = ''): LadderInfo | null {
  const hit = CACHE.get(`${url}|${referer}`);
  return hit && Date.now() - hit.at < CACHE_TTL_MS ? hit.info : null;
}

/** parse a manifest body into ladder info (pure — exported for tests) */
export function parseLadder(body: string): { master: boolean; heights: number[]; bitrate: Record<number, number> } {
  const heights: number[] = [];
  const bitrate: Record<number, number> = {};
  if (!body.includes('#EXT-X-STREAM-INF')) return { master: false, heights, bitrate };
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const attrs = lines[i];
    const uri = lines[i + 1]?.trim();
    if (!uri || uri.startsWith('#')) continue;
    const h = Number(/RESOLUTION=\d+x(\d+)/i.exec(attrs)?.[1] || 0);
    const bw = Number(/BANDWIDTH=(\d+)/.exec(attrs)?.[1] || 0);
    if (h > 0) {
      if (!heights.includes(h)) heights.push(h);
      if (bw > 0 && (!bitrate[h] || bw < bitrate[h])) bitrate[h] = bw;
    }
  }
  heights.sort((a, b) => a - b);
  return { master: heights.length > 0, heights, bitrate };
}

/**
 * Fetch a manifest and extract its quality ladder + CORS posture.
 * Never throws — a failed probe is indistinguishable from "no ladder" for the
 * caller, and `cors` defaults false (proxy is always the safe path).
 */
export async function probeLadder(
  url: string,
  referer = '',
  origin = ''
): Promise<LadderInfo> {
  const key = `${url}|${referer}`;
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.info;
  const existing = probeInflight.get(key);
  if (existing) return existing;

  const job = (async (): Promise<LadderInfo> => {
    let info: LadderInfo = { master: false, heights: [], bitrate: {}, cors: false };
    try {
      const res = await fetchTolerant(url, {
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          ...(referer ? { Referer: referer } : {}),
          // CORS posture: mirror what the browser sends — CDNs only answer
          // access-control-allow-origin when an Origin is present
          ...(origin ? { Origin: origin } : {}),
        },
        timeoutMs: PROBE_TIMEOUT_MS,
      });
      if (res.ok) {
        const acao = res.headers.get('access-control-allow-origin') || '';
        const cors = acao === '*' || (origin ? acao.includes(new URL(origin).hostname) : false);
        const body = await res.text();
        if (body.includes('#EXTM3U')) {
          const parsed = parseLadder(body);
          info = { ...parsed, cors };
        }
      }
    } catch {
      /* probe is best-effort */
    }
    CACHE.set(key, { info, at: Date.now() });
    if (CACHE.size > CACHE_MAX) {
      // drop the oldest quarter (insertion order ≈ age)
      const it = CACHE.keys();
      for (let i = 0; i < 50; i++) {
        const v = it.next();
        if (v.done) break;
        CACHE.delete(v.value);
      }
    }
    return info;
  })();

  probeInflight.set(key, job);
  try {
    return await job;
  } finally {
    probeInflight.delete(key);
  }
}
