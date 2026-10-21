// ─── Shared segdl/CDN-direct helpers ─────────────────────────────────────────
// Extracted from uncloak-loader.ts (2026-10-22) so the loader AND the segment
// prefetcher (seg-prefetch.ts) agree on exactly which URLs are CDN-direct
// eligible and how a /api/segdl?u= URL maps to its CDN target. Single source
// of truth — the segdl ROUTE's allowlist mirrors DIRECT_HOSTS server-side.

export const SEGDL_MARK = '/api/segdl?u=';

/** CDN hosts whose segments are CORS-readable and cloaked — the direct path
 *  only engages for these (the segdl route allowlists the same hosts
 *  server-side, so client and server fallback agree on what's eligible). */
export const DIRECT_HOSTS = ['tiktokcdn-us.com', 'tiktokcdn.com', 'tiktokcdn-eu.com', 'tiktokv.us'];

export function isDirectHost(u: string): boolean {
  try {
    const h = new URL(u).hostname.toLowerCase();
    return DIRECT_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

/** extract ?u= from a same-origin /api/segdl URL (works for relative and
 *  absolute forms — hls.js resolves playlist URLs against the page) */
export function segdlTarget(url: string): string | null {
  const i = url.indexOf(SEGDL_MARK);
  if (i === -1) return null;
  const q = url.slice(i + SEGDL_MARK.length);
  const u = new URLSearchParams(q).get('u') || decodeURIComponent(q.split('&')[0]);
  return /^https?:\/\//i.test(u) ? u : null;
}
