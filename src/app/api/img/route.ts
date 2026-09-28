// ─── /api/img — self-hosted image proxy (ported from ImageService.js) ───────
// Fetches upstream logos/posters once, validates they are really images,
// caches in memory (TTL + entry cap) and streams them to the client with
// long-lived cache headers. On ANY failure (timeout, dead host, non-image
// body, mixed-content http:// from an https page) it falls back to a
// generated SVG placeholder — the client never sees a broken image.
//
//   /api/img?u=<upstream url>&t=<fallback text>&c=<hex color>

import { NextResponse } from 'next/server';
import { isBlockedHost } from '@/lib/streaming/resolve';

export const dynamic = 'force-dynamic';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

const IMAGE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CACHE_MAX = 800;
const MAX_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8000;

interface CacheEntry {
  buf: Uint8Array;
  contentType: string;
  expiresAt: number;
}

// module-scope cache survives across requests in the dev server
const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry | null>>();
const negatives = new Map<string, number>(); // host+path → retry-not-before
const NEG_TTL_MS = 60 * 1000;

function escapeXml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const CATEGORY_COLORS: Record<string, string> = {
  football: '#10b981', basketball: '#f97316', motorsport: '#ef4444',
  cricket: '#0ea5e9', tennis: '#a3e635', rugby: '#8b5cf6',
  american_football: '#0369a1', baseball: '#f43f5e', hockey: '#06b6d4',
  golf: '#22c55e', darts: '#eab308', mma: '#dc2626', sports: '#ffd200',
};

/** Minimalist placeholder card (from MinimalistPosterService, simplified) */
function svgPlaceholder(text: string, colorHex: string): string {
  const color = /^#?[0-9a-f]{6}$/i.test(colorHex)
    ? `#${colorHex.replace('#', '')}`
    : CATEGORY_COLORS[text.toLowerCase()] || '#ffd200';
  const lines = text.split(/\s+/).slice(0, 3);
  const tspans = lines
    .map(
      (l, i) =>
        `<tspan x="100" dy="${i === 0 ? lines.length > 1 ? -12 : 0 : 30}" text-anchor="middle" font-size="${l.length > 14 ? 20 : 26}" font-weight="800" fill="#ffffff" font-family="Arial, Helvetica, sans-serif">${escapeXml(l.slice(0, 22))}</tspan>`
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="112" viewBox="0 0 200 112">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="${color}" stop-opacity="0.28"/>
    <stop offset="1" stop-color="#101116" stop-opacity="0.97"/>
  </linearGradient></defs>
  <rect width="200" height="112" rx="10" fill="#14151b"/>
  <rect width="200" height="112" rx="10" fill="url(#g)"/>
  <rect x="6" y="6" width="188" height="100" rx="7" fill="none" stroke="${color}" stroke-opacity="0.35" stroke-width="1.2"/>
  <text x="100" y="56" dominant-baseline="middle">${tspans || '<tspan x="100" dy="0" text-anchor="middle" font-size="22" font-weight="800" fill="#ffffff" font-family="Arial">TV</tspan>'}</text>
</svg>`;
}

function putCache(key: string, entry: CacheEntry) {
  if (cache.size >= CACHE_MAX) {
    // evict oldest entries (Map keeps insertion order)
    const it = cache.keys();
    for (let i = 0; i < 100; i++) {
      const k = it.next().value;
      if (k === undefined) break;
      cache.delete(k);
    }
  }
  cache.set(key, entry);
}

async function fetchAndCache(url: string): Promise<CacheEntry | null> {
  const hit = cache.get(url);
  if (hit && Date.now() < hit.expiresAt) return hit;

  const neg = negatives.get(url);
  if (neg && Date.now() < neg) return null;

  if (inFlight.has(url)) return inFlight.get(url)!;

  const p = (async (): Promise<CacheEntry | null> => {
    try {
      // upgrade http → https to avoid mixed-content blocking
      const target = url.startsWith('http://') ? url.replace(/^http:/, 'https:') : url;
      const res = await fetch(target, {
        headers: { 'User-Agent': UA, Accept: 'image/*,*/*;q=0.8' },
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) {
        negatives.set(url, Date.now() + NEG_TTL_MS);
        return null;
      }
      const ct = res.headers.get('content-type') || '';
      if (!ct.startsWith('image/')) {
        negatives.set(url, Date.now() + NEG_TTL_MS);
        return null;
      }
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength < 64 || buf.byteLength > MAX_BYTES) {
        negatives.set(url, Date.now() + NEG_TTL_MS);
        return null;
      }
      const entry: CacheEntry = { buf, contentType: ct, expiresAt: Date.now() + IMAGE_TTL_MS };
      putCache(url, entry);
      return entry;
    } catch {
      negatives.set(url, Date.now() + NEG_TTL_MS);
      return null;
    } finally {
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, p);
  return p;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const u = searchParams.get('u') || '';
  const t = searchParams.get('t') || '';
  const c = searchParams.get('c') || 'ffd200';

  const fallbackSvg = svgPlaceholder(t || 'TV', c);
  const fallbackHeaders = {
    'content-type': 'image/svg+xml; charset=utf-8',
    'cache-control': 'public, max-age=300',
    'x-img-fallback': '1',
  };

  if (!u || !/^https?:\/\//i.test(u)) {
    return new NextResponse(fallbackSvg, { headers: fallbackHeaders });
  }

  let host: string;
  try {
    host = new URL(u).hostname;
  } catch {
    return new NextResponse(fallbackSvg, { headers: fallbackHeaders });
  }
  if (isBlockedHost(host)) {
    return new NextResponse(fallbackSvg, { headers: fallbackHeaders });
  }

  const entry = await fetchAndCache(u);
  if (!entry) {
    return new NextResponse(fallbackSvg, { headers: fallbackHeaders });
  }

  return new NextResponse(entry.buf as unknown as BodyInit, {
    headers: {
      'content-type': entry.contentType,
      'cache-control': 'public, max-age=1800, stale-while-revalidate=600',
      'x-img-cached': cache.has(u) ? '1' : '0',
    },
  });
}
