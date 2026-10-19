// Tiny debug route — exposes what the streaming layer's routeUpstream() helper
// actually returns at runtime. REMOVE BEFORE PROD (or keep behind a secret).
// Used to diagnose why /api/hls gets 200/text-html from /api/proxy internally
// while /api/proxy returns 403 to external curl.

import { routeUpstream, UPSTREAM_BYPASS_ACTIVE } from '@/lib/streaming/upstream';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const target = url.searchParams.get('url') || 'https://edge.cowedd4855ws.sbs/premium100/index.m3u8';
  const referer = url.searchParams.get('referer') || 'https://daddyliveplayer.st/premiumtv/daddy.php?id=100';

  // What does routeUpstream return at runtime?
  const routed = routeUpstream(target, referer);

  // What env vars are set?
  const env = {
    VERCEL: process.env.VERCEL,
    VERCEL_ENV: process.env.VERCEL_ENV,
    VERCEL_URL: process.env.VERCEL_URL,
    CF_PROXY_URL: process.env.CF_PROXY_URL ? '(set)' : '(unset)',
    PROXY_BASE_URL: process.env.PROXY_BASE_URL || '(unset)',
    PORT: process.env.PORT || '(unset)',
    UPSTREAM_BYPASS_ACTIVE,
  };

  // Now fetch the routed URL to see what we actually get back
  let upstreamResult: Record<string, unknown> = {};
  try {
    const res = await fetch(routed, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        Accept: '*/*',
        Referer: referer,
      },
      signal: AbortSignal.timeout(15_000),
      redirect: 'follow',
    });
    const body = await res.text();
    upstreamResult = {
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      url: res.url,
      contentType: res.headers.get('content-type'),
      contentLength: res.headers.get('content-length'),
      bodySize: body.length,
      bodyFirst200: body.slice(0, 200),
    };
  } catch (e) {
    upstreamResult = { error: (e as Error).message };
  }

  return Response.json({
    env,
    routedUrl: routed,
    routedIsSameAsTarget: routed === target,
    upstreamResult,
  });
}
