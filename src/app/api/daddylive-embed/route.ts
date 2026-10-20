// ── /api/daddylive-embed — server-side proxy that strips ads from the DaddyLive embed page ──
//
// Fetches dembed.st/premiumtv/daddy.php?id=N server-side (no Sec-Fetch-Dest → 200),
// strips ONLY external ad scripts (by domain), injects function overrides so the
// page thinks it's embedded (bypasses isEmbedded/inAdSandbox checks), rewrites
// the token fetch to a same-origin proxy, and serves a clean page.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

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
    // Don't strip inline scripts — the page's main JS is inline and
    // contains the JW Player setup, token logic, and m3u8 URL.
    for (const domain of AD_DOMAINS) {
      const re = new RegExp(
        `<script[^>]*src=["'][^"']*${domain}[^"']*["'][^>]*><\\/script>`,
        'gi'
      );
      html = html.replace(re, '');
    }

    // ── Inject function overrides + clean CSS before </head> ──────────
    // Override isEmbedded() to return true (page thinks it's in an iframe)
    // Override inAdSandbox() to return false (page thinks it's not sandboxed)
    // This prevents blockPlayer('This player only works when embedded.')
    // and blockPlayer('Remove sandbox') from firing.
    const overrideAndCss = `<script>
      window.isEmbedded = function() { return true; };
      window.inAdSandbox = function() { return false; };
    </script>
    <style>*{margin:0;padding:0;box-sizing:border-box}html,body{width:100%;height:100%;overflow:hidden;background:#000}#player,#thatframe{width:100%!important;height:100%!important}#msg{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:9999;color:#fff;font:16px/1.5 system-ui,sans-serif;text-align:center}</style>`;

    html = html.replace('</head>', overrideAndCss + '</head>');

    return new Response(html, {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (e) {
    return new Response(`embed error: ${(e as Error).message}`, { status: 502 });
  }
}
