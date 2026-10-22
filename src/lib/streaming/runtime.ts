// ─── Runtime detection + per-invocation subrequest budget ────────────────────
// 2026-10-22: maxtv runs on TWO serverless runtimes:
//   • Vercel (Node) — isolates freeze between requests; no subrequest cap
//     worth worrying about (1000/invocation on the platform contract);
//     invocation = one stable egress IP (the dledge token pair depends on it)
//   • Cloudflare Workers (OpenNext) — FREE plan caps a single invocation at
//     50 subrequests (fetches); outbound fetches egress from a per-colo IP
//     pool that can rotate BETWEEN two fetches of one invocation. The turbo
//     engine (built for Vercel) burned the whole budget during channel
//     warm-up: resolve chain (~6 fetches) + paired token+manifest retries
//     (4 attempts × 2) + segment batches (4/pass) + timer-driven passes
//     sharing the same budget — "Too many subrequests by single Worker
//     invocation", the pass died mid-warm-up, and playlists 502'd.
//
// This module centralizes the runtime switch + a conservative per-isolate
// fetch budget so the engine can NEVER hit the wall again: each route
// invocation resets it, every upstream fetch spends from it, and the poller
// trims its batches to what remains. The counter is shared across concurrent
// requests in the same isolate (isolate-global, not request-scoped) — that is
// deliberately conservative: concurrent requests may under-use the budget but
// can never jointly blow past it.

/** true when running inside Cloudflare Workers (workerd) */
export const ON_WORKERS: boolean = (() => {
  try {
    return (
      typeof navigator !== 'undefined' && /Cloudflare-Workers/i.test(navigator.userAgent || '')
    );
  } catch {
    return false;
  }
})();

/** Workers free-plan subrequest ceiling is 50/invocation. The counter only
 *  sees fetches wrapped by the streaming lib — the daddylive resolve chain
 *  (~5-8 fetches, uncaptured, runs once per 2min per session per isolate)
 *  must fit inside the margin, so the counted budget stays at 36. */
const WORKERS_BUDGET = 36;

let remaining = Infinity;

/** call at the start of every API route invocation (Workers only matters,
 *  but harmless everywhere) */
export function resetSubrequestBudget(): void {
  remaining = ON_WORKERS ? WORKERS_BUDGET : Infinity;
}

/** try to reserve one upstream fetch. Returns false when the invocation is
 *  out of budget — the caller must treat it as "not now, try next request"
 *  (never an error: session state survives across invocations). */
export function grantSubrequest(): boolean {
  if (remaining <= 0) return false;
  remaining--;
  return true;
}

/** how many upstream fetches this invocation can still afford */
export function subrequestsRemaining(): number {
  return remaining;
}
