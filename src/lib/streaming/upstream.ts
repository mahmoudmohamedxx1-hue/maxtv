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
//   2. PROXY_BASE_URL — operator-set absolute URL (e.g. https://myhost.com)
//   3. /api/proxy — the in-repo edge-runtime route, using the origin
//      detected from the incoming request's Host header (auto on Vercel).
//      The origin is captured by setProxyOriginFromRequest() called at the
//      top of each streaming-layer route handler.
//      IMPORTANT: this is fetched via an ABSOLUTE URL because Node's native
//      fetch() cannot resolve relative URLs (no base).
//
// Both 1 and 2 are no-ops when no env is set and no origin has been captured
// → the original URL is returned (self-hosted direct-fetch behaviour).

const CF_PROXY_URL = process.env.CF_PROXY_URL || '';
const ON_VERCEL = process.env.VERCEL === '1' || !!process.env.VERCEL_ENV;

/**
 * The origin (scheme + host + port) of the most recent incoming HTTP request
 * to a streaming-layer route handler. Set via setProxyOriginFromRequest() at
 * the top of /api/hls, /api/turbo, /api/sports/stream, etc. — before any
 * streaming-layer code runs.
 *
 * Why this exists: Vercel sets VERCEL_URL to the DEPLOYMENT-SPECIFIC URL
 * (e.g. `maxtv-431bxrdj2-...vercel.app`) which requires SSO auth when the
 * project has Deployment Protection enabled. When the streaming layer
 * internally fetches `https://${VERCEL_URL}/api/proxy`, Vercel redirects to
 * https://vercel.com/login — and the proxy sees a 200 + text/html (the login
 * page) instead of the manifest. Using the origin from the incoming request
 * (the public alias the client used, e.g. maxtvs.vercel.app) bypasses SSO.
 *
 * Thread-safety: set on every request entry, so concurrent requests on the
 * same isolate converge to whatever the most recent request's host was. On
 * a single-domain Vercel prod that's always the same value.
 */
let detectedOrigin: string | null = null;

export function setProxyOriginFromRequest(req: Request): void {
  try {
    const u = new URL(req.url);
    // Trust x-forwarded-proto (Vercel always sets it to "https" in prod);
    // fall back to u.protocol if absent.
    const proto =
      req.headers.get('x-forwarded-proto')?.split(',')[0].trim() ||
      u.protocol.replace(':', '');
    const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim() || u.host;
    if (host) detectedOrigin = `${proto}://${host}`;
  } catch {
    /* ignore — fall back to env-based base */
  }
}

/** Test seam. */
export function _setDetectedOriginForTesting(origin: string | null): void {
  detectedOrigin = origin;
}

/**
 * The absolute base URL to use when routing through /api/proxy. Required
 * because Node's native fetch() rejects relative URLs (it has no base).
 *
 * Precedence (first wins):
 *   1. detectedOrigin — from the most recent incoming request's Host header
 *      (auto, captures the public alias the client used; bypasses SSO)
 *   2. PROXY_BASE_URL — operator-set env var
 *   3. VERCEL_URL — Vercel's auto-set deployment URL (RARELY useful —
 *      usually requires SSO; only works when Deployment Protection is off)
 *   4. http://localhost:$PORT — self-hosted standalone fallback
 */
function proxyBaseUrl(): string {
  if (detectedOrigin) return detectedOrigin.replace(/\/$/, '');
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
  //    relative paths. The origin comes from the incoming request's Host
  //    header (setProxyOriginFromRequest) to bypass Vercel's deployment-URL
  //    SSO redirect.
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
