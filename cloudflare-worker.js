/**
 * MaxTV Cloudflare Worker Proxy
 *
 * The DaddyLive premium edge (edge.cowedd4855ws.sbs) gates its playlists
 * behind an Origin allowlist (dembed.st / daddyliveplayer.st / dlive.sx)
 * plus an IP-bound playlist token. This Worker can proxy those fetches from
 * Cloudflare's edge — including a PAIRED mode that fetches token+manifest
 * from inside one Worker invocation (the token is bound to the egress IP,
 * so both legs must come from the same invocation).
 *
 * Deploy:
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. Name it "maxtv-proxy" and deploy
 * 3. Click "Edit Code", paste this entire script, click "Deploy"
 * 4. Copy the Worker URL (e.g., https://maxtv-proxy.yourname.workers.dev)
 * 5. Set CF_PROXY_URL env var in Vercel to that URL
 *
 * Usage:
 *   ?url=<target>&referer=<referer>&origin=<origin>   → plain proxied fetch
 *   ?dlslug=premium<N>&dlpath=/premium<N>/index.m3u8   → paired token+manifest
 */
export default {
  async fetch(request) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        }
      });
    }

    const reqUrl = new URL(request.url);
    const targetUrl = reqUrl.searchParams.get('url');
    const referer = reqUrl.searchParams.get('referer');
    const origin = reqUrl.searchParams.get('origin');

    // ── DaddyLive paired token+manifest mode ─────────────────────────
    // One Worker invocation → one egress IP → the token and the manifest
    // share an IP, which the edge requires.
    const dlSlug = reqUrl.searchParams.get('dlslug');
    const dlPath = reqUrl.searchParams.get('dlpath');
    if (dlSlug && dlPath && /^premium\d+$/.test(dlSlug) && dlPath.startsWith('/')) {
      const EDGE = 'https://edge.cowedd4855ws.sbs';
      const dlHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
        'Accept': '*/*',
        'Origin': 'https://dembed.st',
        'Referer': 'https://dembed.st/',
      };
      try {
        const tokRes = await fetch(`${EDGE}/api/playlist-token?slug=${encodeURIComponent(dlSlug)}`, {
          headers: dlHeaders,
        });
        if (!tokRes.ok) return new Response(`token ${tokRes.status}`, { status: 502 });
        const tok = (await tokRes.json()).token;
        if (!tok) return new Response('no token', { status: 502 });
        const sep = dlPath.includes('?') ? '&' : '?';
        const manRes = await fetch(`${EDGE}${dlPath}${sep}t=${encodeURIComponent(tok)}`, {
          headers: dlHeaders,
        });
        return new Response(await manRes.text(), {
          status: manRes.status,
          headers: {
            'content-type': manRes.headers.get('content-type') || 'application/vnd.apple.mpegurl',
            'access-control-allow-origin': '*',
            'cache-control': 'no-store',
          },
        });
      } catch (e) {
        return new Response(`DL pair error: ${e.message}`, { status: 502 });
      }
    }

    if (!targetUrl) {
      return new Response('Missing url param', { status: 400 });
    }

    try {
      const headers = new Headers();
      headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
      headers.set('Accept', '*/*');
      if (referer) headers.set('Referer', referer);
      // Origin passthrough — required by the DaddyLive edge's allowlist
      if (origin && /^https?:\/\//.test(origin)) headers.set('Origin', origin);

      const res = await fetch(targetUrl, {
        headers,
        redirect: 'follow',
      });

      const body = await res.arrayBuffer();
      const contentType = res.headers.get('content-type') || 'application/octet-stream';

      return new Response(body, {
        status: res.status,
        headers: {
          'content-type': contentType,
          'access-control-allow-origin': '*',
          'cache-control': 'no-store',
        },
      });
    } catch (e) {
      return new Response(`Proxy error: ${e.message}`, {
        status: 502,
        headers: {
          'content-type': 'text/plain',
          'access-control-allow-origin': '*',
        },
      });
    }
  }
};
