// ─── LOCAL TEST HARNESS ONLY (never deployed) ────────────────────────────────
// Serves the thin API router without the OpenNext bundle, so the data plane
// can be regression-tested with `wrangler dev` before a full cf:build.
// Usage: bunx wrangler dev -c wrangler.test.jsonc
import { handleApi } from './dist/api.mjs';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return handleApi(request, env, ctx);
    }
    return new Response('not found (test harness — assets only)', { status: 404 });
  },
};
