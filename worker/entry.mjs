// ─────────────────────────────────────────────────────────────────────────────
// MaxTV worker entry — thin API fast-path + OpenNext pages fallback.
//
// Request flow on the Workers FREE plan:
//   1. static asset match (_next/static, public/, prerendered pages)
//      → served by the asset layer BEFORE this code runs (free + unlimited)
//   2. /api/* → worker/api-router.ts (the thin data plane — no Next.js
//      runtime, ~1-3ms CPU per invocation, Cache API on the JSON endpoints)
//   3. anything else → the OpenNext server exactly as before (page routing,
//      RSC navigation) — pages measured ~20ms CPU and were never the failure
//
// Re-exports everything OpenNext's worker exports (Durable Object classes
// etc.) so the deployed script surface stays identical to a plain
// `main: .open-next/worker.js` deployment.
import openNextWorker from '../.open-next/worker.js';
import { handleApi } from './dist/api.mjs';

export * from '../.open-next/worker.js';

const g = globalThis;

export default {
  async fetch(request, env, ctx) {
    // install the ASSETS fetcher for BOTH paths — the OpenNext bundle also
    // contains the IPTV catalog fast-path (ON_WORKERS is true there too),
    // and it must find the snapshot instead of degrading to an empty catalog
    if (!g.__maxtvAssetFetch && env.ASSETS) {
      const assets = env.ASSETS;
      g.__maxtvAssetFetch = (path) =>
        assets.fetch(new Request(`https://maxtv-assets.internal${path}`));
    }

    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    return openNextWorker.fetch(request, env, ctx);
  },
};
