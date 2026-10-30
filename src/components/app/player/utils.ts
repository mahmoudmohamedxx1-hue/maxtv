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

/** Approximate data rate per rung height, for the menu's data-saver labels.
 *  Standard ABR ladder bitrates (these pools are Amagi/CloudFront/Akamai
 *  FAST playouts — their rung bitrates are the industry-standard encodes);
 *  Mbps → MB/min = ×7.5. These are honest APPROXIMATIONS for menu display,
 *  not measurements of the exact stream. */
const RUNG_MBPS: Array<[height: number, mbps: number]> = [
  [144, 0.2],
  [240, 0.35],
  [360, 0.7],
  [432, 0.9],
  [480, 1.2],
  [540, 1.6],
  [576, 1.8],
  [720, 2.5],
  [1080, 4.5],
];

/** ≈MB/min downloaded when playing a rung of this height (nearest standard
 *  rung; null only for nonsense heights). This is the number that makes the
 *  data-saver promise CONCRETE: 240p ≈ 3 MB/min vs Source 1080p ≈ 34 MB/min
 *  is a 10x saving the user can see and verify. */
export function rungMBPerMin(h: number): number | null {
  if (!h || h <= 0) return null;
  let best: [number, number] | null = null;
  for (const r of RUNG_MBPS) {
    if (best === null || Math.abs(r[0] - h) < Math.abs(best[0] - h)) best = r;
  }
  if (!best) return null;
  // round to a clean 1-2 significant figure value for the menu
  const mb = best[1] * 7.5;
  return mb >= 10 ? Math.round(mb) : Math.round(mb);
}
