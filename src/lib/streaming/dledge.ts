// ─── DaddyLive EDGE paired token+manifest fetcher ────────────────────────────
// The DaddyLive premium edge (edge.cowedd4855ws.sbs) gates its playlist
// behind TWO checks, verified live on 2026-10-20:
//
//   1. ORIGIN ALLOWLIST — every request to the edge must carry
//      Origin ∈ { https://dembed.st, https://daddyliveplayer.st, https://dlive.sx }
//      Without it the edge answers 403 "forbidden" — from ANY IP, datacenter
//      or residential. (This is what actually broke the server-side
//      transports: /api/proxy, cloudflare-worker.js and the streaming layer
//      never sent an Origin header, so every fetch 403'd and the edge was
//      misdiagnosed as "blocking all datacenter IPs".)
//
//   2. IP-BOUND PLAYLIST TOKEN — GET /api/playlist-token?slug=premium<N>
//      returns a short-lived token (ttl ~120s) bound to the REQUESTER'S IP.
//      The manifest request must then carry ?t=<token> AND originate from
//      that same IP, otherwise 403 "token required".
//      → The token and the manifest MUST be fetched back-to-back from the
//        SAME serverless invocation (one invocation = one egress IP).
//        Tokens are therefore NEVER cached across invocations.
//
// Segments referenced by the manifest are absolute, long-signed TikTok-CDN
// URLs with `access-control-allow-origin: *` and no gate of their own —
// they need no token, no Origin and work from any IP. The manifest body
// itself is plain text, so caching IT briefly across invocations is safe.
//
// Fallbacks, in order:
//   1. direct paired fetch from the current runtime (default — same
//      invocation, same egress IP, works from datacenter IPs)
//   2. CF_PROXY_URL — an operator-deployed Cloudflare Worker with the
//      paired `dlslug`/`dlpath` mode (one worker invocation = one egress IP)
//
// Retries: the pair is re-fetched (token AND manifest together) a few times
// with a short jitter — hosts with rotating egress pools (some clouds NAT
// per-connection) can split the pair across IPs; a retry re-rolls the dice.

import { UA } from './resolve';

/** the premium edge host — updatable when the resolve layer learns a new one */
let edgeHost = 'edge.cowedd4855ws.sbs';

/** Origin values the edge accepts (allowlist, verified 2026-10-20) */
const DL_ORIGIN = 'https://dembed.st';

const CF_PROXY_URL = process.env.CF_PROXY_URL || '';

export function setDlEdgeHost(host: string): void {
  const clean = host.trim().toLowerCase();
  if (clean && clean !== edgeHost) edgeHost = clean;
}

export function getDlEdgeHost(): string {
  return edgeHost;
}

/** True for premium-edge manifest URLs we can token-fetch:
 *  https://edge.cowedd4855ws.sbs/premium<N>/…m3u8 */
export function isDaddyLiveEdgeManifest(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.hostname !== edgeHost) return false;
    return /\/premium\d+\/[^?]*\.m3u8?(\?|$)/i.test(u.pathname + u.search);
  } catch {
    return false;
  }
}

/** extract the slug ("premium<N>") from an edge manifest URL */
function slugFor(url: string): string | null {
  const m = url.match(/\/(premium\d+)\//i);
  return m ? m[1] : null;
}

export interface DlPlaylistResult {
  ok: boolean;
  status: number;
  body?: string;
  finalUrl: string;
}

interface DlFetchOptions {
  /** total attempts for the token+manifest pair (default 3) */
  attempts?: number;
  /** per-request timeout in ms (default 5000) */
  timeoutMs?: number;
}

/** one token fetch — returns the token string or null */
async function fetchToken(
  slug: string,
  timeoutMs: number
): Promise<string | null> {
  try {
    const res = await fetch(`https://${edgeHost}/api/playlist-token?slug=${encodeURIComponent(slug)}`, {
      headers: dlHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { token?: string };
    return typeof j.token === 'string' && j.token ? j.token : null;
  } catch {
    return null;
  }
}

/** one manifest fetch with ?t=token — returns status + body */
async function fetchManifest(
  url: string,
  token: string,
  timeoutMs: number
): Promise<{ status: number; body: string } | null> {
  try {
    const u = new URL(url);
    u.searchParams.set('t', token);
    const res = await fetch(`https://${edgeHost}${u.pathname}${u.search}`, {
      headers: dlHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
      cache: 'no-store',
    });
    const body = await res.text();
    return { status: res.status, body };
  } catch {
    return null;
  }
}

/** headers the edge expects: UA + allowlisted Origin (+ Referer for realism) */
function dlHeaders(): Record<string, string> {
  return {
    'User-Agent': UA,
    Accept: '*/*',
    Origin: DL_ORIGIN,
    Referer: `${DL_ORIGIN}/`,
  };
}

/**
 * Fetch a DaddyLive premium-edge playlist with a fresh paired token.
 * The token is fetched and used from the SAME invocation (same egress IP);
 * on any 403 the WHOLE pair is retried. Never caches tokens.
 *
 * When CF_PROXY_URL is set, the pair is delegated to the operator's
 * Cloudflare Worker (`?dlslug=&dlpath=` paired mode — one worker invocation
 * = one egress IP for both legs).
 *
 * Returns { ok: true, body } on a 200 #EXTM3U, { ok: false, status } on a
 * definitive upstream answer (404/410 = dead channel), or null when the
 * edge could not be reached at all.
 */
export async function fetchDaddyLivePlaylist(
  manifestUrl: string,
  opts: DlFetchOptions = {}
): Promise<DlPlaylistResult | null> {
  if (!isDaddyLiveEdgeManifest(manifestUrl)) return null;
  const slug = slugFor(manifestUrl);
  if (!slug) return null;

  const attempts = Math.max(1, opts.attempts ?? 3);
  const timeoutMs = opts.timeoutMs ?? 5000;
  const u = new URL(manifestUrl);
  const manifestPath = u.pathname + u.search;
  let lastStatus = 0;

  // ── CF-worker delegated pair ─────────────────────────────────────────────
  if (CF_PROXY_URL) {
    const base = CF_PROXY_URL.replace(/\/$/, '');
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));
      try {
        const res = await fetch(
          `${base}?dlslug=${encodeURIComponent(slug)}&dlpath=${encodeURIComponent(manifestPath)}`,
          {
            headers: { 'User-Agent': UA, Accept: '*/*' },
            signal: AbortSignal.timeout(timeoutMs + 4000),
            redirect: 'follow',
            cache: 'no-store',
          }
        );
        const body = await res.text();
        lastStatus = res.status;
        if (res.status === 200 && body.includes('#EXTM3U')) {
          return { ok: true, status: 200, body, finalUrl: manifestUrl };
        }
        if (res.status === 404 || res.status === 410) {
          return { ok: false, status: res.status, finalUrl: manifestUrl };
        }
      } catch {
        lastStatus = 0;
      }
    }
    return { ok: false, status: lastStatus, finalUrl: manifestUrl };
  }

  // ── direct pair from this invocation ─────────────────────────────────────
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 150 + Math.random() * 250));

    const token = await fetchToken(slug, Math.min(timeoutMs, 3000));
    if (!token) {
      lastStatus = 403;
      continue;
    }
    const res = await fetchManifest(manifestUrl, token, timeoutMs);
    if (!res) {
      lastStatus = 0;
      continue;
    }
    lastStatus = res.status;
    if (res.status === 200 && res.body.includes('#EXTM3U')) {
      return { ok: true, status: 200, body: res.body, finalUrl: manifestUrl };
    }
    // 404/410 = the channel genuinely does not exist on this edge — definitive
    if (res.status === 404 || res.status === 410) {
      return { ok: false, status: res.status, finalUrl: manifestUrl };
    }
    // 403 = token/IP mismatch (egress IP rotated between the pair) → retry pair
  }
  return { ok: false, status: lastStatus, finalUrl: manifestUrl };
}
