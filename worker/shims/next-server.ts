// ─── next/server shim for the thin Cloudflare Worker bundle ──────────────────
// The app's API routes import exactly two things from next/server:
//   • NextResponse — used as a constructor + .json() + .redirect(); every
//     form maps 1:1 onto the Workers runtime's native Response.
//   • after(callback) — on Vercel it runs the callback past the response;
//     here we hand it to ctx.waitUntil (the router stashes the per-request
//     execution context on globalThis before dispatching a route handler).
//
// Nothing else from next/server is referenced anywhere under src/app/api —
// verified by audit (2026-10-22) before this shim was written.

type Ctx = { waitUntil(p: Promise<unknown>): void };
export type { Ctx };

const g = globalThis as { __maxtvWorkerCtx?: Ctx };

export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    return new NextResponse(JSON.stringify(body ?? null), { ...init, headers });
  }

  static redirect(url: string | URL, status: number = 307): NextResponse {
    return new NextResponse(null, { status, headers: { location: String(url) } });
  }
}

export function after(fn: () => unknown): void {
  const task = (async () => {
    try {
      await fn();
    } catch {
      /* best effort — mirrors Vercel's after() semantics */
    }
  })();
  const ctx = g.__maxtvWorkerCtx;
  if (ctx?.waitUntil) ctx.waitUntil(task);
  // no ctx available (module-init time) — the promise already runs
}

/** re-exported for type-only imports in route files (never called) */
export const NextRequest = Request;
export default { NextResponse, after, NextRequest };
