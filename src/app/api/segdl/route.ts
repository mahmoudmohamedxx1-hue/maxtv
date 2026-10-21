// ─── /api/segdl — segment delivery for the ladder's Source rung ─────────────
// The raw=1 native playlist lists segments as `/api/segdl?u=<absolute CDN
// url>`. Two resolvers exist for that URL and they produce IDENTICAL bytes:
//   1. CLIENT (the fast path): the custom hls.js loader intercepts it, fetches
//      the CDN directly and uncloaks in-browser — zero server hops.
//   2. THIS ROUTE (the fallback): fetch + unwrap + serve — used by Safari's
//      native HLS, by browsers without DecompressionStream, and whenever the
//      client-side unwrap fails. Host-ALLOWLISTED (only the TikTok CDN family
//      the DaddyLive edge uses) so this can never act as an open proxy, and
//      the response is CDN-cacheable (segments are immutable, x-expires is
//      year-2037) so repeated fallbacks are cheap.

import { decodeSegmentBytes } from '@/lib/streaming/proxy';
import { fetchTolerant } from '@/lib/streaming/tls-fetch';
import { UA } from '@/lib/streaming/resolve';

export const dynamic = 'force-dynamic';

/** hosts allowed through this route — must stay in sync with the client
 *  loader's DIRECT_HOSTS (uncloak-loader.ts) */
const ALLOWED_SUFFIXES = [
  'tiktokcdn-us.com',
  'tiktokcdn.com',
  'tiktokcdn-eu.com',
  'tiktokv.us',
];

function allowedHost(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    if (h === '') return false;
    // block obvious local targets regardless of suffix games
    if (/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
    return ALLOWED_SUFFIXES.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('u') || '';
  if (!/^https?:\/\//i.test(target) || !allowedHost(target)) {
    return new Response('bad url', { status: 400 });
  }
  const range = req.headers.get('range') || undefined;
  try {
    const res = await fetchTolerant(target, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        ...(range ? { Range: range } : {}),
      },
      timeoutMs: 15_000,
    });
    if (!res.ok && res.status !== 206) {
      const mapped = res.status === 503 ? 502 : res.status;
      return new Response(`upstream ${mapped}`, {
        status: mapped,
        headers: { 'content-type': 'text/plain' },
      });
    }
    const raw = new Uint8Array(await res.arrayBuffer());
    // clean TS (rare) or cloaked payload → unwrap with the shared engine
    const ts = raw[0] === 0x47 ? raw : decodeSegmentBytes(raw, res.headers.get('content-type') || '');
    if (!ts) {
      // genuine image / undecodable → off-air marker the player understands
      return new Response('off-air or undecodable segment', {
        status: 503,
        headers: { 'content-type': 'text/plain', 'x-offair': '1' },
      });
    }
    return new Response(ts as unknown as BodyInit, {
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        // immutable content — browser-cachable, and s-maxage makes the Vercel
        // edge cache shared: every viewer whose direct-CDN path fails lands
        // here, and the first fetch parks the unwrapped TS at the edge for
        // the rest (segment URLs are the CDN's own immutable signed URLs —
        // no recycle risk, unlike /api/turbo's sn-keyed URLs).
        'cache-control': 'public, max-age=3600, s-maxage=3600',
        'content-type': 'video/mp2t',
        'accept-ranges': 'none',
      },
    });
  } catch (e) {
    const msg = (e as Error).message || 'segdl error';
    const status = /timeout|abort/i.test(msg) ? 504 : 502;
    return new Response(`segdl error: ${msg}`, { status });
  }
}

export async function HEAD(req: Request) {
  const res = await GET(req);
  return new Response(null, { status: res.status, headers: res.headers });
}
