// ─────────────────────────────────────────────────────────────────────────────
// MaxTV thin API router — the Cloudflare Workers data plane.
//
// WHY THIS EXISTS (2026-10-22): the whole Next.js server (OpenNext) cannot
// fit the Workers FREE plan's per-invocation CPU budget — cold module
// evaluation of the Next runtime alone blows past it, so /api/sports/schedule,
// /api/sports/stream, /api/img 503'd with "Worker exceeded CPU time limit"
// and the homepage rendered empty ("site doesn't open"). These handlers are
// the SAME route modules the Vercel deployment runs, bundled WITHOUT the
// Next.js runtime (esbuild + tiny next/server + node shims): a warm or cold
// invocation costs ~1-3ms CPU instead of 50-200ms.
//
// Free-plan protections layered here:
//   • Cache API (caches.default, per-colo) on the expensive JSON/image
//     endpoints — schedule/channels/search/iptv/img responses are shared
//     across all viewers at a colo, honoring each route's own max-age.
//   • a per-IP token bucket across ALL /api routes (the turbo route keeps
//     its own tighter 90/10s bucket for m3u8+seg on top of this).
//   • static assets never enter this router — wrangler serves them before
//     the worker runs, and asset requests are FREE + unlimited on Workers.
// ─────────────────────────────────────────────────────────────────────────────

import type { Ctx } from './shims/next-server';

// ── real route handlers (bundled from src/, Next-free) ──────────────────────
import { GET as turboGET } from '../src/app/api/turbo/route';
import { GET as scheduleGET } from '../src/app/api/sports/schedule/route';
import { GET as sportsChannelsGET } from '../src/app/api/sports/channels/route';
import { GET as sportsStreamGET } from '../src/app/api/sports/stream/route';
import { GET as imgGET } from '../src/app/api/img/route';
import { GET as iptvChannelsGET } from '../src/app/api/iptv/channels/route';
import { GET as iptvCatalogGET } from '../src/app/api/iptv/catalog/route';
import { GET as iptvStreamGET } from '../src/app/api/iptv/stream/route';
import { GET as hlsGET, HEAD as hlsHEAD } from '../src/app/api/hls/route';
import { GET as segdlGET, HEAD as segdlHEAD } from '../src/app/api/segdl/route';
import { GET as logoGET } from '../src/app/api/logo/route';
import { GET as searchGET } from '../src/app/api/search/route';
import { GET as rootApiGET } from '../src/app/api/route';

type Handler = () => Promise<Response>;
type EnvLike = { ASSETS?: { fetch(req: Request): Promise<Response> } };

const g = globalThis as {
  __maxtvWorkerCtx?: Ctx;
  __maxtvAssetFetch?: (path: string) => Promise<Response>;
  __maxtvApiRl?: Map<string, { n: number; at: number }>;
};

// ── global per-IP flood guard ────────────────────────────────────────────────
// 240 requests / 10s per IP across ALL /api routes — a real session peaks
// around 15-30 req/s during a channel switch (prefetcher burst); anything
// sustained above this is a quota thief. The turbo route applies its own
// tighter 90/10s bucket to the expensive m3u8/seg modes on top of this.
const RL_WINDOW_MS = 10_000;
const RL_MAX = 240;

function rateLimited(req: Request): boolean {
  if (!g.__maxtvApiRl) g.__maxtvApiRl = new Map();
  const ip =
    req.headers.get('cf-connecting-ip') ||
    req.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    'unknown';
  const now = Date.now();
  const b = g.__maxtvApiRl.get(ip);
  if (!b || now - b.at > RL_WINDOW_MS) {
    g.__maxtvApiRl.set(ip, { n: 1, at: now });
    if (g.__maxtvApiRl.size > 2000) {
      const keys = [...g.__maxtvApiRl.keys()].slice(0, 1000);
      for (const k of keys) g.__maxtvApiRl.delete(k);
    }
    return false;
  }
  b.n++;
  return b.n > RL_MAX;
}

// ── Cache API wrapper ────────────────────────────────────────────────────────
// Shares one handler's 200 response across every viewer at this colo for the
// TTL the route itself declares. no-store / non-public / non-200 responses
// pass straight through, so freshness-sensitive verdict payloads
// (sports/channels "refetch soon") behave exactly as on Vercel.
async function withCache(req: Request, handler: Handler): Promise<Response> {
  const ctx = g.__maxtvWorkerCtx;
  // workerd's Cache API (caches.default) — not in the DOM lib types
  const cache = (caches as unknown as {
    default: { match(req: Request): Promise<Response | undefined>; put(req: Request, res: Response): Promise<void> };
  }).default;
  let hit: Response | undefined;
  try {
    hit = await cache.match(req);
  } catch {
    /* cache API unavailable — serve live */
  }
  if (hit) return hit;

  const res = await handler();
  const cc = res.headers.get('cache-control') || '';
  if (
    res.status === 200 &&
    req.method === 'GET' &&
    cc.includes('public') &&
    !cc.includes('no-store')
  ) {
    try {
      ctx?.waitUntil(cache.put(req, res.clone()));
    } catch {
      /* best effort */
    }
  }
  return res;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body ?? null), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain', ...headers } });
}

// ── the router ───────────────────────────────────────────────────────────────
export async function handleApi(
  request: Request,
  env: EnvLike,
  ctx: Ctx
): Promise<Response> {
  g.__maxtvWorkerCtx = ctx;

  // stash the ASSETS binding once per isolate so the IPTV catalog fast-path
  // can lazy-load its build-time snapshot (see catalog.ts) without pulling
  // 4MB of JSON into the bundle
  if (!g.__maxtvAssetFetch && env.ASSETS) {
    const assets = env.ASSETS;
    g.__maxtvAssetFetch = (path: string) =>
      assets.fetch(new Request(`https://maxtv-assets.internal${path}`));
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (rateLimited(request)) {
    return text('slow down', 429, { 'cache-control': 'no-store', 'retry-after': '2' });
  }

  try {
    // ── turbo transport (beIN / DaddyLive playback) ─────────────────────────
    if (path === '/api/turbo') {
      // mode=native probes the stream height with ffmpeg — impossible on
      // Workers (no processes), so the 5.5s probe loop would burn wall time
      // + subrequests to always answer 0. Answer 0 instantly instead; the
      // player just labels the top rung "Source".
      if (url.searchParams.get('mode') === 'native') {
        return json(
          { h: 0 },
          200,
          { 'cache-control': 'public, max-age=1800', 'access-control-allow-origin': '*' }
        );
      }
      return turboGET(request);
    }

    // ── sports (homepage EPG + channel rails + stream resolution) ───────────
    if (path === '/api/sports/schedule') {
      return withCache(request, () => scheduleGET(request));
    }
    if (path === '/api/sports/channels') {
      return withCache(request, () => sportsChannelsGET(request));
    }
    if (path === '/api/sports/stream') {
      return sportsStreamGET(request);
    }

    // ── IPTV catalog (OTHERS tab + alternates + hover prefetch) ─────────────
    if (path === '/api/iptv/catalog') {
      // catalog GET() takes no request argument
      return withCache(request, () => iptvCatalogGET());
    }
    if (path === '/api/iptv/channels') {
      return withCache(request, () => iptvChannelsGET(request));
    }
    if (path === '/api/iptv/stream') {
      return iptvStreamGET(request);
    }

    // ── media / discovery ────────────────────────────────────────────────────
    if (path === '/api/img') {
      return withCache(request, () => imgGET(request));
    }
    if (path === '/api/logo') {
      return withCache(request, () => logoGET(request));
    }
    if (path === '/api/search') {
      return withCache(request, () => searchGET(request));
    }

    // ── streaming transports (signed HLS proxy + segment download) ─────────
    if (path === '/api/hls') {
      return (request.method === 'HEAD' ? hlsHEAD : hlsGET)(request);
    }
    if (path === '/api/segdl') {
      return (request.method === 'HEAD' ? segdlHEAD : segdlGET)(request);
    }

    // ── capability stubs — honest 503s match the Vercel-serverless shape ───
    if (path === '/api/live') {
      // continuous ffmpeg relay: only exists self-hosted; the player serves
      // HEVC feeds through instead (same as Vercel)
      return text('relay not available on this host', 503, {
        'cache-control': 'no-store',
        'x-offair': '1',
      });
    }
    if (path === '/api/transcode') {
      if (url.searchParams.get('mode') === 'cap') {
        return json({ cap: false }, 200, { 'cache-control': 'no-store' });
      }
      return text('transcode ladder not available on this host', 503, {
        'cache-control': 'no-store',
      });
    }

    // ── not applicable on this deployment ───────────────────────────────────
    if (path === '/api' || path === '/api/') {
      // root /api GET() takes no request argument
      return rootApiGET();
    }
    if (path.startsWith('/api/vision')) {
      return json({ error: 'vision is not available on this deployment' }, 501);
    }
    if (path === '/api/diagnostics') {
      return json({
        ok: true,
        runtime: 'cloudflare-workers/thin-api',
        ts: Date.now(),
      }, 200, { 'cache-control': 'no-store' });
    }
    if (path === '/api/debug-catalog' || path === '/api/debug-upstream' || path === '/api/proxy') {
      return json({ error: 'not available on this deployment' }, 404);
    }

    return json({ error: 'not_found' }, 404);
  } catch (err) {
    // a handler crash must never take the worker down — the player retries
    return text(`api error: ${(err as Error)?.message || 'unknown'}`, 500, {
      'cache-control': 'no-store',
    });
  }
}
