// ─── DaddyLive sports engine ─────────────────────────────────────────────────
// Ported from github.com/rajhodedara/live-sport-plugin (MIT) — the
// DaddyLiveProvider / MatchAggregator core, adapted for Next.js route handlers:
//   • schedule scraping from the live homepage (real-time fixture list)
//   • 24/7 channel index from 24-7-channels.php
//   • stream resolution: watch page → embed iframe → _econfig / direct m3u8
//   • the exact _econfig 4-segment base64 decoder from the original repo

import * as cheerio from 'cheerio';
import type { SportsMatch, SportsChannelRef, ResolvedStream } from '../types';
import { normalizeSport, splitLeague, stripEmojis, decodeEntities, isEventStream } from './categories';
import { rankScheduleFeeds } from './feeds';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const MIRRORS = ['https://dlive.sx', 'https://dlstreams.st'];

/** the CDN-side player host — serves the SRC manifest directly */
const PLAYER_CDN = 'https://daddyliveplayer.st';

/**
 * Per-stream server switching — transport-based (2026-09-28 rework v3).
 *
 * USER FIELD-REPORT + BENCHMARK (scripts/bench-servers.mjs, live beIN):
 *   • direct ("Server 2") — user-verified the best of the bunch → DEFAULT.
 *     No ffmpeg warmup, no extra relay hop: /api/hls proxies the CDN
 *     manifest straight to the browser.
 *   • edge — deterministic edge manifest, zero page parsing, p95 ~343ms
 *     across repeated polls → the new lowest-latency route ("Server 9")
 *   • turbo — prefetch passthrough: no ffmpeg, ~2-4s start, segments served
 *     from a warm server-side cache at ~50-190ms
 *   • relay — ffmpeg remux→transcode: 20.2s warmup and eats both CPU cores
 *     (the "loads alot" complaint) → demoted to last resort
 *
 * Every entry is a genuinely different transport or resolution route:
 *   • direct (DEFAULT, "Server 2") — browser proxies the CDN manifest
 *     (/api/hls); user-verified best: no ffmpeg, no prefetch relay hop
 *   • edge — deterministic edge manifest (edge…/premium{id}/index.m3u8),
 *     zero page parsing; benchmarked the fastest + most stable route
 *   • turbo — /api/turbo prefetch relay (fast start when it works; hands
 *     off to the transcode relay automatically on unsafe codecs)
 *   • relay — /api/live ffmpeg remux→transcode, bulletproof against every
 *     upstream pathology (codec flips, timestamp chaos)
 */
export const DADDYLIVE_SERVERS = [
  { id: 'direct', label: 'Server 2', host: 'Direct CDN · default (most reliable)', path: 'direct' },
  { id: 'edge', label: 'Server 9', host: 'Edge direct · lowest latency', path: 'direct' },
  { id: 'turbo', label: 'Server 1', host: 'Turbo cache · fastest start', path: 'turbo' },
  { id: 'direct-cdn', label: 'Server 5', host: 'Direct via daddyliveplayer.st', path: 'direct', mirror: 'cdn' },
  { id: 'direct-dlive', label: 'Server 3', host: 'Direct via dlive.sx', path: 'direct', mirror: 'dlive' },
  { id: 'direct-dlstreams', label: 'Server 4', host: 'Direct via dlstreams.st', path: 'direct', mirror: 'dlstreams' },
  { id: 'direct-dlive-player', label: 'Server 10', host: 'Direct via dlive.sx player', path: 'direct', mirror: 'dlive-player' },
  { id: 'direct-dlstreams-player', label: 'Server 11', host: 'Direct via dlstreams.st player', path: 'direct', mirror: 'dlstreams-player' },
  { id: 'relay', label: 'Server 6', host: 'Stable relay · bulletproof', path: 'relay' },
  { id: 'relay-dlive', label: 'Server 7', host: 'Relay via dlive.sx', path: 'relay', mirror: 'dlive' },
  { id: 'relay-dlstreams', label: 'Server 8', host: 'Relay via dlstreams.st', path: 'relay', mirror: 'dlstreams' },
] as const;

export type DaddyLiveServerId = (typeof DADDYLIVE_SERVERS)[number]['id'];

/** the actual entry routes behind every server id */
const ROUTES = [
  { id: 'dlive', base: MIRRORS[0], path: 'watch' },
  { id: 'dlstreams', base: MIRRORS[1], path: 'watch' },
  { id: 'cdn', base: PLAYER_CDN, path: 'cdn' },
  { id: 'dlive-player', base: MIRRORS[0], path: 'player' },
  { id: 'dlstreams-player', base: MIRRORS[1], path: 'player' },
] as const;

type RouteId = (typeof ROUTES)[number]['id'] | 'edge';

/** Map a UI server id (new transport ids or legacy route ids) → entry-route pin.
 *  null = unpinned (auto race). */
export function entryPinFor(serverId: string | null | undefined): RouteId | null {
  if (!serverId) return null;
  if (serverId === 'turbo' || serverId === 'relay' || serverId === 'direct' || serverId === 'auto') return null;
  if (serverId === 'edge') return 'edge';
  const m = serverId.match(/^(?:relay|direct|turbo)-(dlive-player|dlstreams-player|dlive|dlstreams|cdn)$/);
  if (m) return m[1] as RouteId;
  const legacy = ROUTES.find((r) => r.id === serverId);
  return legacy ? (legacy.id as RouteId) : null;
}

export function isDaddyLiveServerId(id: string | null | undefined): boolean {
  return !!id && (DADDYLIVE_SERVERS as readonly { id: string }[]).some((s) => s.id === id);
}

// ─── cache ───────────────────────────────────────────────────────────────────
interface CacheEntry<T> {
  data: T;
  expires: number;
  /** serve stale data up to this timestamp while a background refresh runs (SWR) */
  staleUntil?: number;
}

const cache = new Map<string, CacheEntry<unknown>>();
/** single-flight guards so a stale key only triggers ONE background refresh */
const inflight = new Set<string>();

function getCached<T>(key: string): T | null {
  const e = cache.get(key) as CacheEntry<T> | undefined;
  if (!e) return null;
  if (Date.now() > e.expires) {
    if (e.staleUntil && Date.now() <= e.staleUntil) return e.data; // stale-but-usable
    cache.delete(key);
    return null;
  }
  return e.data;
}

function isStale(key: string): boolean {
  const e = cache.get(key);
  return !!e && Date.now() > e.expires;
}

/** kick a single-flight background refresh for a stale-but-served entry */
function revalidateInBackground(key: string, fn: () => Promise<void>): void {
  if (inflight.has(key)) return;
  inflight.add(key);
  fn()
    .catch(() => {})
    .finally(() => inflight.delete(key));
}

function setCached<T>(key: string, data: T, ttlMs: number, staleMs = 0) {
  cache.set(
    key,
    {
      data,
      expires: Date.now() + ttlMs,
      ...(staleMs > 0 ? { staleUntil: Date.now() + ttlMs + staleMs } : {}),
    }
  );
}

// ─── shared fetch ────────────────────────────────────────────────────────────
async function fetchText(url: string, referer: string, timeoutMs = 9000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Referer: referer,
        Accept: 'text/html,application/xhtml+xml,application/json,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// ─── per-sport max durations (ms) for live/upcoming status ──────────────────
const DURATIONS: Record<string, number> = {
  cricket: 8 * 3600_000,
  mma: 6 * 3600_000,
  fighting: 6 * 3600_000,
  boxing: 5 * 3600_000,
  motorsport: 4 * 3600_000,
  american_football: 4 * 3600_000,
  baseball: 3.5 * 3600_000,
  basketball: 3 * 3600_000,
  tennis: 4 * 3600_000,
  golf: 6 * 3600_000,
  football: 2.5 * 3600_000,
  rugby: 2.5 * 3600_000,
  hockey: 3 * 3600_000,
  darts: 4 * 3600_000,
};

// ─── schedule scraping ───────────────────────────────────────────────────────
async function fetchScheduleUncached(): Promise<SportsMatch[]> {
  let html: string | null = null;
  for (const base of MIRRORS) {
    html = await fetchText(`${base}/`, `${base}/`);
    if (html && html.includes('schedule__event')) break;
    html = null;
  }
  if (!html) return [];

  const matches = parseScheduleHtml(html);
  // rank feeds so the primary Watch button is the channel most likely to
  // actually carry the event (the football→F1 fix)
  return rankScheduleFeeds(matches);
}

export async function getSchedule(): Promise<SportsMatch[]> {
  const key = 'dl:schedule';
  const hit = getCached<SportsMatch[]>(key);
  if (hit) {
    // stale → serve instantly, refresh once in the background
    if (isStale(key)) {
      revalidateInBackground(key, async () => {
        const fresh = await fetchScheduleUncached();
        if (fresh.length) setCached(key, fresh, 60_000, 3 * 60_000);
      });
    }
    return hit;
  }

  const fresh = await fetchScheduleUncached();
  // 1 min fresh · 3 min stale-serve (SWR) — the homepage scrape takes seconds,
  // nobody should wait for it twice
  setCached(key, fresh, 60_000, 3 * 60_000);
  return fresh;
}

export function parseScheduleHtml(html: string): SportsMatch[] {
  const $ = cheerio.load(html);
  const out: SportsMatch[] = [];
  const now = Date.now();
  const currentYear = new Date().getUTCFullYear();
  const seen = new Set<string>();

  $('.schedule__day').each((_, dayEl) => {
    const $day = $(dayEl);
    const dayTitle = $day.find('.schedule__dayTitle').first().text().trim();
    const dateMatch = dayTitle.match(/(\d+)(?:st|nd|rd|th)\s+([A-Za-z]+)(?:\s+(\d{4}))?/i);
    const year = dateMatch && dateMatch[3] ? parseInt(dateMatch[3], 10) : currentYear;
    let dayStr = '';
    if (dateMatch) dayStr = `${dateMatch[1]} ${dateMatch[2]} ${year}`;

    $day.find('.schedule__category').each((_, catEl) => {
      const $cat = $(catEl);
      const rawCat = $cat.find('.card__meta').first().text().trim();
      const cleanCat = stripEmojis(decodeEntities(rawCat));
      if (!cleanCat || /big brother/i.test(cleanCat)) return;

      $cat.find('.schedule__event').each((__, evEl) => {
        const $ev = $(evEl);
        const time = ($ev.find('.schedule__time').attr('data-time') || $ev.find('.schedule__time').text() || '').trim();
        const rawTitle = $ev.find('.schedule__eventTitle').first().text().trim();
        if (!rawTitle || !time) return;

        const channels: SportsChannelRef[] = [];
        const seenCh = new Set<string>();
        $ev.find('.schedule__channels a').each((___, a) => {
          const href = $(a).attr('href') || '';
          const idm = href.match(/id=(\d+)/);
          if (!idm || idm[1] === '00') return;
          const name = ($(a).attr('title') || $(a).text() || `Channel ${idm[1]}`).trim();
          // NOTE: "Event SD Stream" feeds are NOT dummy channels — they are
          // real per-event streams (PNG-cloaked TS the proxy unwraps). Keeping
          // them restores all the football fixtures that list no other feed.
          const id = idm[1];
          if (seenCh.has(id)) return;
          seenCh.add(id);
          channels.push({ id, name: fixMojibake(decodeEntities(name)) || `Channel ${id}` });
        });
        if (channels.length === 0) return;

        const rawEvent = stripEmojis(decodeEntities(rawTitle));
        const { league, title } = splitLeague(rawEvent);
        const category = normalizeSport(`${cleanCat} ${league} ${title}`);

        // kickoff timestamp — times are UK GMT/UTC
        let matchTime: number | null = null;
        const explicitDate = rawEvent.match(
          /(\d{1,2})\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(\d{4}))?/i
        );
        if (cleanCat.toLowerCase().includes('upcoming') && explicitDate) {
          const y = explicitDate[3] ? parseInt(explicitDate[3], 10) : year;
          const parsed = Date.parse(`${explicitDate[1]} ${explicitDate[2]} ${y} ${time}:00 UTC`);
          if (!Number.isNaN(parsed)) matchTime = parsed;
        }
        if (matchTime == null && dayStr) {
          const parsed = Date.parse(`${dayStr} ${time}:00 UTC`);
          if (!Number.isNaN(parsed)) {
            matchTime = time < '06:00' ? parsed + 24 * 3600_000 : parsed;
          }
        }
        if (matchTime == null) return;

        // skip fully-finished fixtures
        const maxDuration = DURATIONS[category] ?? 3 * 3600_000;
        if (now > matchTime + maxDuration) return;

        // de-dup fixtures listed on multiple days
        const dedup = `${title}|${matchTime}`;
        if (seen.has(dedup)) return;
        seen.add(dedup);

        out.push({
          id: `dl_${matchTime}_${title.replace(/\W+/g, '').slice(0, 40).toLowerCase()}`,
          title,
          league: league || cleanCat,
          category,
          startTime: matchTime,
          timeStr: time,
          status: now >= matchTime && now <= matchTime + maxDuration ? 'live' : 'upcoming',
          channels,
          day: dayTitle,
        });
      });
    });
  });

  out.sort((a, b) => a.startTime - b.startTime);
  return out;
}

// ─── 24/7 channel index ─────────────────────────────────────────────────────
export interface DaddyLiveChannel {
  id: string;
  name: string;
  country?: string;
}

/** Repair common Shift-JIS mojibake left by the channel pages ("Espa単ol" → "Español"). */
function fixMojibake(name: string): string {
  return name.replace(/Espa単ol/g, 'Español');
}

async function fetch247Uncached(): Promise<DaddyLiveChannel[]> {
  let html: string | null = null;
  for (const base of MIRRORS) {
    html = await fetchText(`${base}/24-7-channels.php`, `${base}/`);
    if (html && html.includes('class="card"')) break;
    html = null;
  }
  if (!html) return [];

  const $ = cheerio.load(html);
  const out: DaddyLiveChannel[] = [];
  const seen = new Set<string>();
  // NOTE: dead ids are NOT dropped here — consumers filter with the scan seed
  // (DEAD_DL_CHANNEL_IDS) + runtime verdicts, so channels that resurrect on
  // the CDN come back automatically instead of being hidden until a re-scan.
  $('a.card').each((_, el) => {
    const href = $(el).attr('href') || '';
    const idm = href.match(/id=(\d+)/);
    if (!idm) return;
    const id = idm[1];
    if (seen.has(id)) return;
    seen.add(id);
    const name = ($(el).find('.card__title').first().text() || $(el).attr('data-title') || `Channel ${id}`).trim();
    if (!name || isEventStream(name)) return;
    out.push({ id, name: fixMojibake(decodeEntities(name)) });
  });

  return out;
}

export async function get247Channels(): Promise<DaddyLiveChannel[]> {
  const key = 'dl:247';
  const hit = getCached<DaddyLiveChannel[]>(key);
  if (hit) {
    if (isStale(key)) {
      revalidateInBackground(key, async () => {
        const fresh = await fetch247Uncached();
        if (fresh.length) setCached(key, fresh, 10 * 60_000, 10 * 60_000);
      });
    }
    return hit;
  }

  const fresh = await fetch247Uncached();
  setCached(key, fresh, 10 * 60_000, 10 * 60_000);
  return fresh;
}

// ─── stream resolution (watch page → embed → manifest) ──────────────────────

/**
 * Decodes DaddyLive / DLHD obfuscated _econfig payload.
 * Ported verbatim from live-sport-plugin DaddyLiveProvider.decodeEconfig():
 *   1. base64 decode raw string
 *   2. split into 4 equal segments (ceil(len/4))
 *   3. drop the decoy canary char at index 3 of each segment
 *   4. base64 decode segments, reorder [2, 0, 3, 1]
 *   5. join + base64 decode → JSON { stream_url, ... }
 */
export function decodeEconfig(raw: string): Record<string, string> | null {
  if (!raw) return null;
  try {
    const order = [2, 0, 3, 1];
    const decodedB64 = Buffer.from(raw, 'base64').toString('utf-8');
    const len = decodedB64.length;
    if (len < 4) return null;

    const partLen = Math.ceil(len / 4);
    const parts: string[] = [];
    let offset = 0;
    for (let i = 0; i < 4; i++) {
      parts.push(decodedB64.substr(offset, partLen));
      offset += partLen;
    }

    const ordered: string[] = [];
    for (let i = 0; i < order.length; i++) {
      let str = parts[i];
      str = str.slice(0, 3) + str.slice(4);
      ordered[order[i]] = Buffer.from(str, 'base64').toString('utf-8');
    }

    const combined = ordered.join('');
    const json = Buffer.from(combined, 'base64').toString('utf-8');
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Un-escape a manifest URL lifted out of inline JSON / HTML attributes */
function cleanManifestUrl(url: string): string {
  return url
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/[\\"']+$/, '');
}

/** Known DaddyLive embed hosts — ranked before unknown iframes */
const KNOWN_EMBED_HOSTS = [
  'daddyliveplayer.st',
  'daddyliveplayer.to',
  'streame.center',
  'streamplay.indianpremiumtvs',
  'wizly.xyz',
  'dailysport2.xyz',
];

const MAX_EMBED_DEPTH = 2;

interface HtmlResolveResult extends ResolvedStream {
  strategy?: string;
}

async function resolveFromHtml(html: string, pageUrl: string, depth: number): Promise<HtmlResolveResult | null> {
  if (!html) return null;

  // 1. _econfig (DaddyLive player)
  const econfigMatch = html.match(/_econfig\s*=\s*['"]([^'"]+)['"]/);
  if (econfigMatch?.[1]) {
    const conf = decodeEconfig(econfigMatch[1]);
    const u = conf?.stream_url || conf?.stream_url_nop2p;
    if (u) return { url: cleanManifestUrl(u), referer: pageUrl, strategy: 'econfig' };
  }

  // 1b. current player format: const SRC = "https://…m3u8"
  const srcMatch = html.match(/(?:const|var|let)\s+SRC\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i);
  if (srcMatch?.[1]) return { url: cleanManifestUrl(srcMatch[1]), referer: pageUrl, strategy: 'src' };

  // 2. direct m3u8 regex (allows JSON-escaped separators)
  const directMatch = html.match(/(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
  if (directMatch?.[1]) return { url: cleanManifestUrl(directMatch[1]), referer: pageUrl, strategy: 'direct' };

  const escapedMatch = html.match(/(https?:\\\/\\\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i);
  if (escapedMatch?.[1]) return { url: cleanManifestUrl(escapedMatch[1]), referer: pageUrl, strategy: 'escaped' };

  const configMatch = html.match(/streamUrl:\s*["']([^"']+)["']/i);
  if (configMatch?.[1]) return { url: cleanManifestUrl(configMatch[1]), referer: pageUrl, strategy: 'config' };

  if (depth >= MAX_EMBED_DEPTH) return null;

  // 3. JSON player hop (vertex.st style api/player.php?id=N)
  const channelId =
    html.match(/loadPlayerChannel\(\s*(\d+)\s*\)/)?.[1] ||
    html.match(/data-channel-id=["']?(\d+)/i)?.[1] ||
    null;
  const phpRef = html.match(/([^"']*player\.php)/i)?.[1];
  if (phpRef) {
    let phpUrl: URL | null = null;
    try {
      phpUrl = new URL(phpRef, pageUrl);
    } catch {
      phpUrl = null;
    }
    if (phpUrl) {
      if (!/[?&]id=/.test(phpUrl.search) && channelId) phpUrl.searchParams.set('id', channelId);
      const pr = await fetchText(phpUrl.toString(), pageUrl, 7000);
      if (pr) {
        let target: string | null = null;
        try {
          const j = JSON.parse(pr);
          target = j.url || j.stream_url || j.stream_url_nop2p || j.embed || j.link || null;
        } catch {
          target = pr.match(/(https?:\/\/[^\s"'<>\\]+)/i)?.[1] || null;
        }
        if (target) {
          const nested = await resolveFromUrl(target, pageUrl, depth + 1);
          if (nested) return nested;
        }
      }
    }
  }

  // 4. nested iframes (recursive, ranked)
  const iframes = [...html.matchAll(/<iframe[^>]+src=["']?([^"'\s>]+)["']?/gi)].map((m) => m[1]);
  if (iframes.length) {
    const abs = iframes
      .map((raw) => {
        if (raw.startsWith('//')) return 'https:' + raw;
        if (raw.startsWith('/')) {
          try {
            return new URL(raw, pageUrl).toString();
          } catch {
            return raw;
          }
        }
        return raw;
      })
      .filter((u) => /^https?:/i.test(u));

    abs.sort((a, b) => rankHost(b, pageUrl) - rankHost(a, pageUrl));
    for (const nestedUrl of abs.slice(0, 3)) {
      const nested = await resolveFromUrl(nestedUrl, pageUrl, depth + 1);
      if (nested) return nested;
    }
  }

  return null;
}

function rankHost(u: string, pageUrl: string): number {
  try {
    const h = new URL(u).hostname;
    // same-host iframes are wrappers, prefer other hosts
    const pageHost = new URL(pageUrl).hostname;
    if (h === pageHost) return 0;
    const idx = KNOWN_EMBED_HOSTS.findIndex((k) => h.includes(k));
    return idx >= 0 ? 100 - idx : 10;
  } catch {
    return 0;
  }
}

async function resolveFromUrl(embedUrl: string, referer: string, depth: number): Promise<HtmlResolveResult | null> {
  if (!/^https?:/i.test(embedUrl)) return null;
  const html = await fetchText(embedUrl, referer, 9000);
  if (!html) return null;
  return resolveFromHtml(html, embedUrl, depth);
}

/** Build the entry URL for a channel under a given server strategy. */
function entryUrlFor(base: string, channelId: string, path: 'watch' | 'player' | 'cdn'): string {
  if (path === 'player') return `${base}/stream/stream-${channelId}.php`;
  if (path === 'cdn') return `${PLAYER_CDN}/premiumtv/daddy.php?id=${channelId}`;
  return `${base}/watch.php?id=${channelId}`;
}

/** Resolve a DaddyLive channel id (numeric) to a playable manifest.
 *  `opts.server` pins a specific entry route (per-stream server switching);
 *  the others remain fallbacks so playback always succeeds. `opts.fresh`
 *  skips the cache read — used by relay/transcode recovery, where a
 *  stale-serve answer would keep pointing at the edge we're escaping.
 *
 *  SPEED: the three genuinely independent routes (both watch mirrors + the
 *  CDN player page) are raced IN PARALLEL and the first winner is used —
 *  a slow mirror no longer stalls the resolve behind sequential 9s timeouts.
 *  Resolves are cached 5 min fresh + 5 min stale-serve (SWR). */
export async function resolveDaddyLiveStream(
  channelId: string,
  opts: { server?: string; fresh?: boolean } = {}
): Promise<(ResolvedStream & { server?: string; serverId?: string }) | null> {
  const pin = entryPinFor(opts.server);
  const key = `dl:stream:${channelId}:${pin || 'auto'}`;
  const hit = opts.fresh
    ? null
    : getCached<ResolvedStream & { server?: string; serverId?: string }>(key);
  if (hit) {
    // stale → serve instantly, refresh once in the background
    if (isStale(key)) {
      revalidateInBackground(key, async () => {
        const fresh = await resolveUncached(channelId, pin);
        if (fresh) setCached(key, fresh, 5 * 60_000, 5 * 60_000);
      });
    }
    return hit;
  }

  const result = await resolveUncached(channelId, pin);
  if (result) setCached(key, result, 5 * 60_000, 5 * 60_000);
  return result;
}

/** first non-null result wins; resolves null only when every task fails */
function firstSuccess<T>(tasks: Promise<T | null>[]): Promise<T | null> {
  return new Promise((resolve) => {
    let pending = tasks.length;
    if (!pending) return resolve(null);
    let done = false;
    for (const t of tasks) {
      t
        .then((r) => {
          if (!done && r) {
            done = true;
            resolve(r);
          }
        })
        .catch(() => {})
        .finally(() => {
          pending--;
          if (pending === 0 && !done) {
            done = true;
            resolve(null);
          }
        });
    }
  });
}

/** try one entry route → manifest (null when the route yields nothing) */
async function tryRoute(
  srv: { id: string; base: string; path: 'watch' | 'player' | 'cdn' },
  channelId: string
): Promise<(ResolvedStream & { server?: string; serverId?: string }) | null> {
  const entry = entryUrlFor(srv.path === 'cdn' ? PLAYER_CDN : srv.base, channelId, srv.path);
  const wrapper = await fetchText(entry, srv.path === 'cdn' ? `${PLAYER_CDN}/` : `${srv.base}/`, 9000);
  if (!wrapper) return null;
  const result = await resolveFromHtml(wrapper, entry, 0);
  if (result?.url && /^https?:\/\//i.test(result.url)) {
    // learn the live CDN edge so runtime health probes hit the right host
    try {
      const h = new URL(result.url).hostname;
      if (/^edge\.|\.sbs$|\.st$/.test(h) && h !== new URL(PLAYER_CDN).hostname) cdnEdge.host = h;
    } catch { /* ignore */ }
    return {
      ...result,
      server: srv.path === 'cdn' ? 'daddyliveplayer.st' : new URL(srv.base).hostname,
      serverId: srv.id,
    };
  }
  return null;
}

async function resolveUncached(
  channelId: string,
  pin: RouteId | null
): Promise<(ResolvedStream & { server?: string; serverId?: string }) | null> {
  if (pin === 'edge') {
    // deterministic edge manifest — no page parsing at all; the benchmark's
    // fastest and most stable route (falls through to the race when down)
    const edge = await tryEdgeDirect(channelId);
    if (edge) return edge;
  }
  if (pin) {
    const route = ROUTES.find((r) => r.id === pin);
    // honour an explicit user pick first — exactly the route they asked for
    if (route) {
      const direct = await tryRoute(route, channelId);
      if (direct) return direct;
    }
  }
  // race the three independent entry points (both mirrors' watch pages + CDN)
  const raceRoutes = ROUTES.filter((s) => s.path === 'watch' || s.path === 'cdn');
  const winner = await firstSuccess(raceRoutes.map((s) => tryRoute(s, channelId)));
  if (winner) return winner;
  // next: the player pages (same mirrors, different entry path)
  for (const s of ROUTES) {
    if (s.path !== 'player') continue;
    const r = await tryRoute(s, channelId);
    if (r) return r;
  }
  // last resort — the premium edge serves deterministic manifest paths; when
  // every mirror page is down the edge itself is often still alive
  const edge = await tryEdgeDirect(channelId);
  if (edge) return edge;
  return null;
}

/** direct manifest probe on the learned CDN edge — survives mirror outages */
async function tryEdgeDirect(
  channelId: string
): Promise<(ResolvedStream & { server?: string; serverId?: string }) | null> {
  const referer = `${PLAYER_CDN}/premiumtv/daddy.php?id=${channelId}`;
  const url = `https://${cdnEdge.host}/premium${channelId}/index.m3u8`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: referer, Accept: '*/*' },
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
    });
    if (res.ok) {
      return { url, referer, strategy: 'edge-direct', server: cdnEdge.host, serverId: 'edge' };
    }
  } catch {
    /* edge down too */
  }
  return null;
}

// ─── runtime channel health probe ────────────────────────────────────────────
// The premium CDN serves some channel ids as permanent 404s and that set
// drifts over time (a hard-coded dead list goes stale). A cheap ranged GET
// on the manifest — raced in parallel, cached 5 min per id — keeps channel
// rails free of dead entries AND resurrects ids that come back on their own.
// Verdicts accumulate per-id (append-only maps with a TTL), so the rolling
// background refresh in the channels route builds up full-catalog knowledge
// across requests instead of being wiped on every cache cycle.

const cdnEdge = { host: 'edge.cowedd4855ws.sbs' };
/** id → timestamp of last clean verdict */
const probeOk = new Map<string, number>();
const probeDead = new Map<string, number>();
const PROBE_TTL = 5 * 60_000;

async function probeOne(id: string): Promise<boolean> {
  // three strikes — the CDN edges flap (round-robin nodes + connection
  // throttling on bursts), so one or two failed GETs prove nothing.
  // A clean 404/410 is definitive and skips the retries.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 500 + Math.random() * 500));
    try {
      const res = await fetch(`https://${cdnEdge.host}/premium${id}/index.m3u8`, {
        headers: { 'User-Agent': UA, Referer: `${PLAYER_CDN}/` },
        signal: AbortSignal.timeout(3500),
        redirect: 'follow',
      });
      if (res.ok) return true;
      if (res.status === 404 || res.status === 410) return false;
    } catch { /* network hiccup → retry */ }
  }
  return false;
}

/** Probe DaddyLive channel ids against the premium CDN manifests.
 *  Returns the set of ids that are ALIVE (manifest reachable right now).
 *  Verdicts are cached per id for 5 min — fresh ones answer instantly,
 *  stale/unknown ones get re-probed — so resurrected ids come back and
 *  newly-dead ones drop out without ever resetting the whole cache.
 *  Probes run in small chunks — the CDN throttles large connection bursts. */
export async function probeDaddyLiveChannels(ids: string[]): Promise<Set<string>> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return new Set();
  const now = Date.now();
  const fresh = (m: Map<string, number>, id: string) => {
    const t = m.get(id);
    return t !== undefined && now - t < PROBE_TTL;
  };
  const alive = unique.filter((id) => fresh(probeOk, id));
  const unknown = unique.filter((id) => !fresh(probeOk, id) && !fresh(probeDead, id));
  if (unknown.length) {
    const verdicts = await probeAll(unknown);
    const verifiedAt = Date.now();
    unknown.forEach((id, i) => {
      if (verdicts[i]) {
        probeOk.set(id, verifiedAt);
        alive.push(id);
      } else {
        probeDead.set(id, verifiedAt);
      }
    });
  }
  return new Set(alive);
}

/** ids with a fresh (≤ 5 min) ALIVE verdict — lets callers filter responses
 *  by runtime knowledge WITHOUT triggering new probes. */
export function freshAliveIds(): Set<string> {
  const now = Date.now();
  const out = new Set<string>();
  for (const [id, t] of probeOk) {
    if (now - t < PROBE_TTL) out.add(id);
  }
  return out;
}

async function probeAll(ids: string[]): Promise<boolean[]> {
  const out: boolean[] = [];
  for (let i = 0; i < ids.length; i += 8) {
    const chunk = ids.slice(i, i + 8);
    const v = await Promise.all(chunk.map(probeOne));
    out.push(...v);
  }
  return out;
}
