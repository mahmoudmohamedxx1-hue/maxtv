// ── /api/daddylive-embed — server-side proxy that strips ads from the DaddyLive embed page ──
//
// The dlive.sx/stream/stream-N.php page has 20 ad scripts (thirstacock,
// llvpn, profitableratecpmnetwork, histats) that create overlay/popunder
// ads covering the video player. This route fetches the INNER page
// (dembed.st/premiumtv/daddy.php?id=N) directly server-side (no
// Sec-Fetch-Dest → 200, verified), strips the ad/sandbox checks, and
// serves a CLEAN HTML page with just the JW Player.
//
// The page's JS is rewritten so the token fetch goes through a same-origin
// proxy (/api/daddylive-embed?token=...) that sets Origin=dembed.st
// server-side. The m3u8 fetch goes DIRECTLY from the user's browser to
// edge.cowedd4855ws.sbs (user's residential IP — the token should be
// accepted from a residential IP).

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const channel = url.searchParams.get('channel');

  if (!channel || !/^\d+$/.test(channel)) {
    return new Response('bad channel', { status: 400 });
  }

  // Check if this is a token-proxy request
  const tokenSlug = url.searchParams.get('token');
  if (tokenSlug) {
    // Proxy the token fetch with Origin=dembed.st
    try {
      const tokenUrl = `https://edge.cowedd4855ws.sbs/api/playlist-token?slug=${encodeURIComponent(tokenSlug)}`;
      const res = await fetch(tokenUrl, {
        headers: {
          'User-Agent': UA,
          'Origin': 'https://dembed.st',
          'Referer': 'https://dembed.st/',
        },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await res.text();
      return new Response(body, {
        status: res.status,
        headers: {
          'content-type': res.headers.get('content-type') || 'application/json',
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      });
    } catch (e) {
      return new Response(`token proxy error: ${(e as Error).message}`, { status: 502 });
    }
  }

  // Fetch the dembed.st embed page server-side (no Sec-Fetch-Dest → 200)
  const embedUrl = `https://dembed.st/premiumtv/daddy.php?id=${encodeURIComponent(channel)}`;
  try {
    const res = await fetch(embedUrl, {
      headers: {
        'User-Agent': UA,
        'Referer': 'https://dlive.sx/',
      },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return new Response(`embed fetch failed: ${res.status}`, { status: 502 });
    }

    let html = await res.text();

    // ── Strip ad scripts ──────────────────────────────────────────────
    html = html.replace(/<script[^>]*src=["'][^"']*(?:thirst|llvpn|profit|histats|scatter|ads?|doubleclick|googlesyndication|taboola|outbrain)[^"']*["'][^>]*><\/script>/gi, '');
    html = html.replace(/<script[^>]*>[\s\S]*?(?:popunder|popup|_0x[0-9a-f]+.*?ads?|profitable|histats)[\s\S]*?<\/script>/gi, '');
    html = html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');

    // ── Strip sandbox/ad-block detection ──────────────────────────────
    html = html.replace(/if\s*\(\s*!isEmbedded\(\)\s*\)\s*\{[^}]*blockPlayer[^}]*\}/gi, '');
    html = html.replace(/else\s*if\s*\(\s*inAdSandbox\(\)\s*\)\s*\{[^}]*blockPlayer[^}]*\}/gi, '');

    // ── Rewrite token fetch URL to same-origin proxy ─────────────────
    html = html.replace(
      /EDGE\s*\+\s*['"]\/api\/playlist-token\?slug=['"]/g,
      '"/api/daddylive-embed?token=" + '
    );

    // ── Add clean CSS ─────────────────────────────────────────────────
    html = html.replace(
      '</head>',
      '<style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden;background:#000}#player,#thatframe{width:100%!important;height:100%!important}#msg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;color:#fff;font:16px/1.5 system-ui,sans-serif;text-align:center}</style></head>'
    );

    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    return new Response(`embed error: ${(e as Error).message}`, { status: 502 });
  }
}
