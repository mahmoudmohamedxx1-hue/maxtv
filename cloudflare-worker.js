/**
 * MaxTV Cloudflare Worker Proxy
 *
 * The DaddyLive CDN edge (edge.cowedd4855ws.sbs) returns 403 Forbidden
 * for Vercel's IP ranges. This Worker runs on Cloudflare's edge (different
 * IP range) and proxies fetches to the CDN, bypassing the block.
 *
 * Deploy:
 * 1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 * 2. Name it "maxtv-proxy" and deploy
 * 3. Click "Edit Code", paste this entire script, click "Deploy"
 * 4. Copy the Worker URL (e.g., https://maxtv-proxy.yourname.workers.dev)
 * 5. Set CF_PROXY_URL env var in Vercel to that URL
 *
 * Usage: https://maxtv-proxy.yourname.workers.dev/?url=<target>&referer=<referer>
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

    if (!targetUrl) {
      return new Response('Missing url param', { status: 400 });
    }

    try {
      const headers = new Headers();
      headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
      headers.set('Accept', '*/*');
      if (referer) headers.set('Referer', referer);

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
