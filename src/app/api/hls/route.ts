// ─── /api/hls — the HLS proxy endpoint ──────────────────────────────────────
// Signed via ?s= HMAC. Every manifest rewrite routes segment/variant/keys
// back through this same endpoint, so the browser only ever talks to us.

import { proxyHlsRequest } from '@/lib/streaming/proxy';
import { verifySignature } from '@/lib/streaming/resolve';
import { resolveDaddyLiveStream } from '@/lib/sports/daddylive';
import { setProxyOriginFromRequest } from '@/lib/streaming/upstream';
import { buildLadderMaster, knownNativeHeight } from '@/lib/streaming/ladder-master';
import { peekTurboSession } from '@/lib/streaming/turbo';

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
  // Capture the incoming request's origin so the streaming layer can build
  // ABSOLUTE /api/proxy URLs that bypass Vercel's deployment-URL SSO redirect.
  setProxyOriginFromRequest(req);
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

  // ── v1.3 NATIVE QUALITY LADDER ────────────────────────────────────────
  // &lad=1 — serve the SYNTHETIC MASTER (turbo rungs 144-480 + the native
  // Source rung). Built purely from this request's signed params: no
  // upstream fetch, instant, cache-friendly. hls.js turns the quality menu
  // into real in-place ABR switches — no more source re-attach bounces.
  const lad = searchParams.get('lad') === '1';
  // &raw=1 — the master's Source-rung variant: the plain media playlist with
  // segments rewritten to /api/segdl URLs (client-direct uncloak + server
  // fallback) instead of the signed proxy — the ultra-low-lag path.
  const rawSegs = searchParams.get('raw') === '1';
  // ⚠ LADDER KEEP-ALIVE: a player parked on the Source rung polls THIS route
  // and never touches /api/turbo — its turbo session (the 144-480 rungs'
  // transcode engine, prewarmed at resolve time) used to go idle-reaped after
  // 45s. When ABR later hopped down to a rung, a FRESH session spawned with a
  // discontinuous window and playback stalled at the dead edge until the
  // player walked channels (2026-10-21 ladder field test). Every successful
  // serve of this channel's playlist — master OR Source variant — touches the
  // channel's live turbo session, keeping the rungs warm for the whole watch.
  const touchTurbo = () => {
    try {
      peekTurboSession(ch, srv || undefined)?.touch();
    } catch {
      /* session bookkeeping must never break the serve */
    }
  };
  if (lad && isDlPlaylist) {
    touchTurbo();
    // rebuild the SIGNED query (url/r/s) for the Source rung — the same
    // params this request validated, so the variant passes signature checks
    const signedQuery = `url=${encodeURIComponent(target)}&r=${encodeURIComponent(referer)}&s=${encodeURIComponent(sig)}`;
    // probed native height (per-isolate cache, learned by /api/turbo?mode=native)
    // — embeds RESOLUTION on the Source rung so the player's quality menu
    // shows the channel's real "720p"/"1080p" entry instead of a bare "Source"
    const nativeH = knownNativeHeight(ch) || undefined;
    return new Response(buildLadderMaster({ channel: ch, signedQuery, srv: srv || undefined, nativeH }), {
      status: 200,
      headers: {
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
        'content-type': 'application/vnd.apple.mpegurl',
        'x-maxtv-ladder': 'master',
      },
    });
  }

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

    let result = await proxyHlsRequest(fetchUrl, fetchRef, range, { directSegs: rawSegs });

    if (isDlPlaylist && !range && (result.status === 403 || result.status === 401)) {
      // the edge killed this session (IP rotation / token expiry) — re-resolve
      // a FRESH edge session and retry transparently
      const fresh = await resolveDaddyLiveStream(ch, {
        fresh: true,
        ...(srv ? { server: srv } : {}),
      });
      if (fresh?.url && fresh.url !== fetchUrl) {
        CH_UP.set(ch, { url: fresh.url, referer: fresh.referer || referer, at: Date.now() });
        result = await proxyHlsRequest(fresh.url, fresh.referer || referer, range, { directSegs: rawSegs });
      } else if (fresh?.url) {
        // same URL back — remember it anyway so the next refresh retries cleanly
        CH_UP.set(ch, { url: fresh.url, referer: fresh.referer || referer, at: Date.now() });
        result = await proxyHlsRequest(fresh.url, fresh.referer || referer, range, { directSegs: rawSegs });
      }
    } else if (isDlPlaylist && !range && result.status === 200) {
      // remember the upstream that just worked
      CH_UP.set(ch, { url: fetchUrl, referer: fetchRef, at: Date.now() });
      // ladder keep-alive — the Source-rung poll proves the channel is being
      // watched; keep its turbo rungs' session warm (see touchTurbo above)
      touchTurbo();
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
