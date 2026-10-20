// ── /api/proxy — edge-runtime upstream fetcher ──────────────────────────────
//
// The DaddyLive CDN edge (edge.cowedd4855ws.sbs) returns 403 Forbidden for
// Vercel's serverless (AWS) IPs and for many home-ISP / dev-machine IPs.
// This route runs on Vercel's edge runtime, which executes on Cloudflare's
// edge network — a DIFFERENT IP range that the DaddyLive CDN edge does NOT
// block. The streaming layer's `routeUpstream()` (src/lib/streaming/upstream.ts)
// rewrites every DaddyLive fetch to come through here when on Vercel, so the
// upstream fetch originates from a non-blocked IP.
//
// Self-hosted deployments don't honour `runtime=edge` (the dev server runs
// everything on Node), so operators on blocked IPs must instead deploy the
// standalone Cloudflare Worker (cloudflare-worker.js) and set CF_PROXY_URL.

export const runtime = 'edge';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('url');
  const referer = searchParams.get('referer');
  const origin = searchParams.get('origin');

  // ── DaddyLive paired token+manifest mode ─────────────────────────────
  // dlslug=premium<N>&dlpath=/premium<N>/index.m3u8 → fetch the playlist
  // token AND the manifest from THIS single edge invocation (same egress
  // IP — the token is IP-bound, see src/lib/streaming/dledge.ts) and return
  // the manifest body. Used by the streaming layer as a fallback egress
  // when the serverless runtime's own IPs are refused by the edge.
  const dlSlug = searchParams.get('dlslug');
  const dlPath = searchParams.get('dlpath');
  if (dlSlug && dlPath && /^premium\d+$/.test(dlSlug) && dlPath.startsWith('/')) {
    try {
      const edge = 'https://edge.cowedd4855ws.sbs';
      const dlHeaders = {
        'User-Agent': UA,
        Accept: '*/*',
        Origin: 'https://dembed.st',
        Referer: 'https://dembed.st/',
      };
      const tokRes = await fetch(`${edge}/api/playlist-token?slug=${encodeURIComponent(dlSlug)}`, {
        headers: dlHeaders,
        signal: AbortSignal.timeout(5000),
      });
      if (!tokRes.ok) return new Response(`token ${tokRes.status}`, { status: 502, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });
      const tok = ((await tokRes.json()) as { token?: string }).token;
      if (!tok) return new Response('no token', { status: 502, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });
      const sep = dlPath.includes('?') ? '&' : '?';
      const manRes = await fetch(`${edge}${dlPath}${sep}t=${encodeURIComponent(tok)}`, {
        headers: dlHeaders,
        signal: AbortSignal.timeout(8000),
      });
      const body = await manRes.text();
      return new Response(body, {
        status: manRes.status,
        headers: {
          'content-type': manRes.headers.get('content-type') || 'application/vnd.apple.mpegurl',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      });
    } catch (e) {
      return new Response(`dl pair error: ${(e as Error).message}`, { status: 502, headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' } });
    }
  }

  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response('bad url', {
      status: 400,
      headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' },
    });
  }

  try {
    // Forward Range header so byte-range segment requests on the player side
    // are honoured upstream — keeps HLS byte-range seeks cheap.
    const range = req.headers.get('range');

    const headers: HeadersInit = {
      'User-Agent': UA,
      'Accept': '*/*',
      // Origin passthrough — the DaddyLive premium edge (and a growing set
      // of ad-funded CDNs) 403 any request whose Origin is not on its
      // allowlist; a bare Referer is not enough.
      ...(origin && /^https?:\/\//i.test(origin) ? { Origin: origin } : {}),
    };
    if (referer) headers['Referer'] = referer;
    if (range) headers['Range'] = range;

    const res = await fetch(target, { headers, redirect: 'follow' });

    // Stream the body through — do NOT buffer in edge memory. Segment
    // fetches can be 2-5MB each; buffering would explode edge memory
    // under concurrent playback. The body's ReadableStream passes
    // straight through to the client response.
    const responseHeaders = new Headers({
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      // expose the final-upstream-URL header so callers (proxyHlsRequest)
      // can absolutize relative URIs inside playlists against the correct
      // base — without this, the rewriter uses the /api/proxy URL as the
      // base and produces garbage variant URLs.
      'access-control-expose-headers': 'content-range, accept-ranges, content-length, x-final-url',
    });
    // Forward content-type, content-length, content-range, accept-ranges,
    // last-modified, etag — everything the player needs for correct media
    // handling. Strip hop-by-hop / CORS headers from the upstream so they
    // don't conflict with our own.
    const forwardHeaders = [
      'content-type',
      'content-length',
      'content-range',
      'accept-ranges',
      'last-modified',
      'etag',
    ];
    for (const h of forwardHeaders) {
      const v = res.headers.get(h);
      if (v) responseHeaders.set(h, v);
    }
    // Tell the caller the FINAL URL after upstream redirects — res.url is
    // the URL the upstream itself landed on (after any 3xx chain). Callers
    // use this as the base for relative-URL absolutization inside m3u8
    // playlists (variant URLs, segment URIs, KEY URIs). Without this,
    // proxyHlsRequest rewrites variant URLs against the /api/proxy URL
    // itself, producing broken /api/<original-filename> paths.
    if (res.url) responseHeaders.set('x-final-url', res.url);

    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
    });
  } catch (e) {
    return new Response(`proxy error: ${(e as Error).message}`, {
      status: 502,
      headers: { 'content-type': 'text/plain', 'access-control-allow-origin': '*' },
    });
  }
}

export async function HEAD(req: Request) {
  const { searchParams } = new URL(req.url);
  const target = searchParams.get('url');
  const referer = searchParams.get('referer');

  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response(null, {
      status: 400,
      headers: { 'access-control-allow-origin': '*' },
    });
  }

  try {
    const headers: HeadersInit = { 'User-Agent': UA, 'Accept': '*/*' };
    if (referer) headers['Referer'] = referer;

    const res = await fetch(target, { method: 'HEAD', headers, redirect: 'follow' });
    const responseHeaders = new Headers({
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    for (const h of ['content-type', 'content-length', 'last-modified', 'etag']) {
      const v = res.headers.get(h);
      if (v) responseHeaders.set(h, v);
    }
    return new Response(null, { status: res.status, headers: responseHeaders });
  } catch (e) {
    return new Response(null, {
      status: 502,
      headers: { 'access-control-allow-origin': '*' },
    });
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400',
    },
  });
}
