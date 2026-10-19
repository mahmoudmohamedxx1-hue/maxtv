// ─── Upstream fetch routing ──────────────────────────────────────────────────
// Centralised here so every streaming-layer fetcher (proxy.ts / turbo.ts /
// daddylive.ts) routes DaddyLive CDN fetches through the SAME bypass, with
// the SAME precedence. Without this, fetches from /api/hls (Node runtime on
// Vercel = AWS IPs) hit the DaddyLive CDN edge (edge.cowedd4855ws.sbs) and
// get 403'd — channels don't play. The bypass is /api/proxy (runtime=edge),
// which runs on Vercel's edge network (Cloudflare's IPs, NOT blocked).
//
// PRECEDENCE (first wins):
//   1. CF_PROXY_URL — explicit Cloudflare Worker (operator-deployed, also
//      works in dev / self-hosted where edge runtime isn't honoured)
//   2. /api/proxy — the in-repo edge-runtime route (auto on Vercel).
//      IMPORTANT: this is fetched via an ABSOLUTE URL because Node's native
//      fetch() cannot resolve relative URLs (no base). The base is taken
//      from VERCEL_URL (auto-set by Vercel at runtime) or, on self-hosted
//      standalone, from http://localhost:$PORT.
//   3. direct — original URL (self-hosted where the host's egress isn't
//      blocked; this is the historical behaviour)
//
// Both 1 and 2 are no-ops when neither env var is set → original URL.

const CF_PROXY_URL = process.env.CF_PROXY_URL || '';
const ON_VERCEL = process.env.VERCEL === '1' || !!process.env.VERCEL_ENV;

/**
 * The absolute base URL to use when routing through /api/proxy. Required
 * because Node's native fetch() rejects relative URLs (it has no base).
 * On Vercel prod, VERCEL_URL is auto-set at runtime (e.g. myapp.vercel.app).
 * On self-hosted standalone (where VERCEL isn't set but the bypass is
 * explicitly enabled via PROXY_BASE_URL), the operator can set
 * PROXY_BASE_URL=http://myhost:3000 to route through their own /api/proxy.
 */
function proxyBaseUrl(): string {
  if (process.env.PROXY_BASE_URL) return process.env.PROXY_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  // self-hosted standalone — /api/proxy runs on the same Node process as
  // /api/hls, so localhost:PORT is the correct base.
  const port = process.env.PORT || '3000';
  return `http://localhost:${port}`;
}

/**
 * Returns the URL to actually fetch() when the streaming layer needs to
 * reach an UPSTREAM resource (the DaddyLive CDN edge, mirror pages, player
 * pages). The returned URL is what fetch() should hit — either the original
 * target, a Cloudflare-Worker-proxied URL, or the /api/proxy edge route.
 *
 * `referer` is forwarded to the proxy (CF Worker / /api/proxy both attach
 * it as the `Referer` header on the upstream fetch — required by the
 * DaddyLive CDN edge, which 403s requests without the correct referer).
 */
export function routeUpstream(url: string, referer: string): string {
  if (!url) return url;

  // 1. operator-deployed Cloudflare Worker — works everywhere (including
  //    self-hosted / dev where Vercel's edge runtime isn't running)
  if (CF_PROXY_URL) {
    const params = new URLSearchParams({ url, ...(referer ? { referer } : {}) });
    return `${CF_PROXY_URL}?${params}`;
  }

  // 2. /api/proxy (runtime=edge) — auto on Vercel prod. The edge runtime
  //    runs on Cloudflare's IPs (different from the serverless Node runtime
  //    which runs on AWS IPs that the DaddyLive CDN edge blocks). This is
  //    the production bypass; no manual Worker deployment needed.
  //    The absolute URL is required because Node fetch() can't resolve
  //    relative paths.
  if (ON_VERCEL) {
    const params = new URLSearchParams({ url, ...(referer ? { referer } : {}) });
    return `${proxyBaseUrl()}/api/proxy?${params}`;
  }

  // 3. self-hosted with no Worker configured — direct fetch from the host's
  //    own egress IP. If that IP is also blocked (dev machines on blocked
  //    ISPs), the operator sets CF_PROXY_URL to recover.
  return url;
}

/** True when the upstream-routing bypass is active (CF_PROXY_URL or Vercel). */
export const UPSTREAM_BYPASS_ACTIVE = !!CF_PROXY_URL || ON_VERCEL;
