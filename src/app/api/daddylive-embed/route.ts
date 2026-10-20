// ── /api/daddylive-embed — server-side proxy that strips ads from the DaddyLive embed page ──
//
// Fetches dembed.st/premiumtv/daddy.php?id=N server-side (no Sec-Fetch-Dest → 200),
// strips ONLY external ad scripts (by domain), keeps the page's inline JS intact,
// rewrites the token fetch to a same-origin proxy, and serves a clean page.

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

// Known ad/analytics domains to strip (by URL match in <script src="...">)
const AD_DOMAINS = [
  'thirstacock', 'llvpn', 'profitableratecpmnetwork', 'histats',
  'scatteramarth', 'doubleclick', 'googlesyndication', 'taboola',
  'outbrain', 'adservice', 'popads', 'propellerads', 'adsterra',
];

export async function GET(req: Request) {
  const url = new URL(req.url);

  // ── Token proxy: fetch token with Origin=dembed.st server-side ─────
  const tokenSlug = url.searchParams.get('token');
  if (tokenSlug) {
    try {
      const tokenUrl = `https://edge.cowedd4855ws.sbs/api/playlist-token?slug=${encodeURIComponent(tokenSlug)}`;
      const res = await fetch(tokenUrl, {
        headers: { 'User-Agent': UA, 'Origin': 'https://dembed.st', 'Referer': 'https://dembed.st/' },
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
      return new Response(`token error: ${(e as Error).message}`, { status: 502 });
    }
  }

  // ── Channel embed: fetch dembed.st page, strip ads, serve clean ─────
  const channel = url.searchParams.get('channel');
  if (!channel || !/^\d+$/.test(channel)) {
    return new Response('bad channel', { status: 400 });
  }

  const embedUrl = `https://dembed.st/premiumtv/daddy.php?id=${encodeURIComponent(channel)}`;
  try {
    const res = await fetch(embedUrl, {
      headers: { 'User-Agent': UA, 'Referer': 'https://dlive.sx/' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return new Response(`embed fetch failed: ${res.status}`, { status: 502 });
    }

    let html = await res.text();

    // ── Strip ONLY external ad scripts (by domain) ──────────────────
    // Don't strip inline scripts — the page's main JS (JW Player setup,
    // token logic, m3u8 URL) is inline and obfuscated with _0x vars.
    // Only remove <script src="..."> tags from known ad domains.
    for (const domain of AD_DOMAINS) {
      const re = new RegExp(
        `<script[^>]*src=["'][^"']*${domain}[^"']*["'][^>]*><\\/script>`,
        'gi'
      );
      html = html.replace(re, '');
    }

    // Remove <noscript> ad fallbacks
    html = html.replace(/<noscript>[\s\S]*?<\/noscript>/gi, '');

    // ── Strip sandbox/ad-block detection checks ──────────────────────
    // Remove the isEmbedded() + inAdSandbox() blockPlayer calls so the
    // page doesn't block when loaded from maxtvs.vercel.app.
    html = html.replace(
      /if\s*\(\s*!isEmbedded\(\)\s*\)\s*\{[\s\S]*?blockPlayer[\s\S]*?\}/g,
      ''
    );
    html = html.replace(
      /else\s*if\s*\(\s*inAdSandbox\(\)\s*\)\s*\{[\s\S]*?blockPlayer[\s\S]*?\}/g,
      ''
    );

    // ── Rewrite token fetch URL to same-origin proxy ─────────────────
    // The page's JS has: fetch(EDGE + '/api/playlist-token?slug=' + ...)
    // Rewrite to: fetch('/api/daddylive-embed?token=' + ...)
    // The proxy fetches with Origin=dembed.st server-side.
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
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return new Response(`embed error: ${(e as Error).message}`, { status: 502 });
  }
}
