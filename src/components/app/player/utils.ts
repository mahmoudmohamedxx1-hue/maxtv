// ─── Player module: pure helpers ─────────────────────────────────────────────
// Extracted from the old PlayerOverlay monolith. No React state — safe to
// unit-test and import from any component.

import type { Playable } from '@/lib/store';
import type { AltServer } from './constants';

/** Can THIS browser decode HEVC through MSE (Safari, Edge, Chrome with
 *  hardware decode)? Cached for the page lifetime — the provider flips
 *  channels into HEVC phases dynamically and an incapable browser used to
 *  buffer into a codec error that silently hopped onto beIN XTRA (a
 *  different channel) — now it gets the explicit HEVC choice panel. */
const canHevc = (() => {
  let cached: boolean | null = null;
  return () => {
    if (cached !== null) return cached;
    if (typeof window === 'undefined') return (cached = true);
    const probe = (cs: string) =>
      (typeof MediaSource !== 'undefined' &&
        MediaSource.isTypeSupported(`video/mp4; codecs="${cs}"`)) ||
      document.createElement('video').canPlayType(`video/mp4; codecs="${cs}"`) === 'probably';
    return (cached = probe('hvc1.1.6.L93.B0') || probe('hev1.1.6.L93.B0'));
  };
})();

export { canHevc };

/** build the playable for hopping to an alternate (multi-quality) source —
 *  a DaddyLive channel flips to the iptv resolve path, KEEPING its id so
 *  the servers-menu state and the failover chain survive the hop. */
export function altPlayable(cur: Playable, alt: AltServer): Playable {
  return cur.kind === 'daddylive'
    ? { ...cur, kind: 'iptv', ref: alt.url, name: alt.name, source: alt.sourceName, logo: alt.logo || cur.logo }
    : { ...cur, ref: alt.url, source: alt.sourceName, logo: alt.logo || cur.logo };
}

/** encode/decode a playable as a shareable ?ch= deep link */
export function encodePlayable(p: Playable): string {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(p))));
  } catch {
    return '';
  }
}

export function decodePlayable(s: string): Playable | null {
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(s)))) as Playable;
    // strict kind check — a typo'd kind ("daddylyve") is truthy but must not
    // fall through to the IPTV branch (url=<channel-id> → guaranteed 400)
    return p && (p.kind === 'daddylive' || p.kind === 'iptv') && p.ref ? p : null;
  } catch {
    return null;
  }
}

/** "started 12 min ago" for the guide + header (localized) */
export function fmtAgo(ts: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (m < 1) return t('player.justStarted');
  if (m < 60) return t('player.startedMin', { n: m });
  const h = Math.floor(m / 60);
  return t('player.startedHour', { h, m: m % 60 });
}

/** Does THIS deployment have the data-saver ladder? Two flavors, probed on
 *  mount via /api/turbo?mode=cap:
 *    cap — continuous /api/live relay (self-hosted PATH ffmpeg)
 *    seg — per-segment &h= ladder via the bundled static binary (works on
 *          serverless — the "qualities don't work" fix for single-rendition
 *          DaddyLive channels incl. every beIN)
 *  Fail-open until the answer lands; the 503-bounce in attachSource covers
 *  the gap. */
let tcCapPromise: Promise<{ cap: boolean; seg: boolean }> | null = null;

export function probeTcCap(): Promise<{ cap: boolean; seg: boolean }> {
  if (!tcCapPromise) {
    tcCapPromise = fetch('/api/turbo?mode=cap')
      .then((r) => r.json())
      .then((d: { cap?: boolean; seg?: boolean }) => ({
        cap: d.cap === true,
        seg: d.seg === true,
      }))
      .catch(() => ({ cap: true, seg: true }));
  }
  return tcCapPromise;
}

/** quality-chip hints for the ladder rungs (localized) */
export function rungHint(h: number, t: (key: string) => string): string | undefined {
  if (h === 144) return t('player.rung.ultraLow');
  if (h === 720) return t('player.rung.hd');
  if (h === 1080) return t('player.rung.fullHd');
  return undefined;
}
