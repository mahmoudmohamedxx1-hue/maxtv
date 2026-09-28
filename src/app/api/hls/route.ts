// ─── /api/hls — the HLS proxy endpoint ──────────────────────────────────────
// Signed via ?s= HMAC. Every manifest rewrite routes segment/variant/keys
// back through this same endpoint, so the browser only ever talks to us.

import { proxyHlsRequest } from '@/lib/streaming/proxy';
import { verifySignature } from '@/lib/streaming/resolve';
import { resolveDaddyLiveStream } from '@/lib/sports/daddylive';

export const dynamic = 'force-dynamic';

/* ── DaddyLive session-affinity recovery ────────────────────────────────────
 * The premium edge CDN ties a playlist session to the client IP that opened
 * it. Self-hosted / dev machines have one stable egress IP → refreshes work
 * forever. Serverless hosts (Vercel…) rotate egress IPs per invocation, so
 * after a handful of refreshes the edge answers 403 and the stream would die
 * mid-watch ("beIN plays 10-20s then off-air" on the live deployment).
 *
 * Fix: DaddyLive playlists are requested with &ch=<channelId> (and &srv=pin).
 * When the upstream 403s we transparently RE-RESOLVE the channel server-side
 * (a fresh edge session, bound to whatever IP just asked), retry once, and
 * remember the good upstream for subsequent refreshes. The browser URL never
 * changes — hls.js keeps polling the same signed link. */
interface ChUpstream {
  url: string;
  referer: string;
  at: number;
}
const upG = globalThis as { __maxtvChUp?: Map<string, ChUpstream> };
if (!upG.__maxtvChUp) upG.__maxtvChUp = new Map();
const CH_UP = upG.__maxtvChUp;
const CH_UP_TTL = 3 * 60_000;

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('url');
  const referer = searchParams.get('r') || '';
  const sig = searchParams.get('s') || '';

  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response('bad url', { status: 400 });
  }

  // Signature check — except cleanTemplateParams-safe duplicates
  if (!verifySignature(target, referer, sig)) {
    return new Response('bad signature', { status: 403 });
  }

  // DaddyLive recovery context (playlists only — segments self-heal via the
  // fresh playlist's own URLs and hls.js's fragment retry budget)
  const ch = searchParams.get('ch') || '';
  const srv = searchParams.get('srv') || '';
  const isDlPlaylist = !!ch && /^\d+$/.test(ch) && /\.m3u8?(\?|$)/i.test(target);

  try {
    const range = req.headers.get('range') || undefined;

    // prefer a recently-recovered upstream for this channel (session stickiness)
    let fetchUrl = target;
    let fetchRef = referer;
    if (isDlPlaylist && !range) {
      const hit = CH_UP.get(ch);
      if (hit && Date.now() - hit.at < CH_UP_TTL) {
        fetchUrl = hit.url;
        fetchRef = hit.referer;
      }
    }

    let result = await proxyHlsRequest(fetchUrl, fetchRef, range);

    if (isDlPlaylist && !range && (result.status === 403 || result.status === 401)) {
      // the edge killed this session (IP rotation / token expiry) — re-resolve
      // a FRESH edge session and retry transparently
      const fresh = await resolveDaddyLiveStream(ch, {
        fresh: true,
        ...(srv ? { server: srv } : {}),
      });
      if (fresh?.url && fresh.url !== fetchUrl) {
        CH_UP.set(ch, { url: fresh.url, referer: fresh.referer || referer, at: Date.now() });
        result = await proxyHlsRequest(fresh.url, fresh.referer || referer, range);
      } else if (fresh?.url) {
        // same URL back — remember it anyway so the next refresh retries cleanly
        CH_UP.set(ch, { url: fresh.url, referer: fresh.referer || referer, at: Date.now() });
        result = await proxyHlsRequest(fresh.url, fresh.referer || referer, range);
      }
    } else if (isDlPlaylist && !range && result.status === 200) {
      // remember the upstream that just worked
      CH_UP.set(ch, { url: fetchUrl, referer: fetchRef, at: Date.now() });
    }

    const headers = new Headers(result.headers);
    if (result.bodyBytes !== undefined) {
      return new Response(result.bodyBytes as unknown as BodyInit, { status: result.status, headers });
    }
    if (result.body !== undefined) {
      return new Response(result.body, { status: result.status, headers });
    }
    if (result.stream) {
      return new Response(result.stream, { status: result.status, headers });
    }
    return new Response('empty', { status: 502, headers });
  } catch (e) {
    const msg = (e as Error).message || 'proxy error';
    const status = /timeout|abort/i.test(msg) ? 504 : 502;
    return new Response(`proxy error: ${msg}`, { status });
  }
}

export async function HEAD(req: Request) {
  const res = await GET(req);
  return new Response(null, { status: res.status, headers: res.headers });
}
