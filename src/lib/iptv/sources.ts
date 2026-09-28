// ─── IPTV-Scraper-Zilla playlist registry ────────────────────────────────────
// Data files copied from https://github.com/abusaeeidx/IPTV-Scraper-Zilla
// Playlists auto-update upstream every hour; we ship a snapshot and can
// optionally refresh from the raw GitHub URLs at runtime.

import path from 'path';
import fs from 'fs';

export interface PlaylistSource {
  /** source id used in channel ids */
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** Local file name inside data/iptv */
  file: string;
  /** Upstream raw URL for refreshes */
  upstream: string;
  /** Normalized category override — when set, every channel in this playlist
   *  is forced into this category (playlists without group metadata) */
  forceCategory?: string;
  /** Marks sports-only playlists (surface them in the SPORTS tab) */
  sports?: boolean;
  /** Short blurb for tooltips */
  blurb?: string;
}

const GH_RAW = 'https://raw.githubusercontent.com/abusaeeidx/IPTV-Scraper-Zilla/main';

export const PLAYLIST_SOURCES: PlaylistSource[] = [
  {
    id: 'pluto',
    name: 'Pluto TV',
    file: 'PlutoTV-All.m3u',
    upstream: `${GH_RAW}/PlutoTV-All.m3u`,
    blurb: 'Pluto TV fast channels',
  },
  {
    id: 'samsung',
    name: 'Samsung TV Plus',
    file: 'SamsungTVPlus-All.m3u',
    upstream: `${GH_RAW}/SamsungTVPlus-All.m3u`,
    blurb: 'Samsung TV Plus fast channels',
  },
  {
    id: 'plex',
    name: 'Plex',
    file: 'Plex-All.m3u',
    upstream: `${GH_RAW}/Plex-All.m3u`,
    blurb: 'Plex live TV',
  },
  {
    id: 'roku',
    name: 'Roku Channel',
    file: 'Roku-All.m3u',
    upstream: `${GH_RAW}/Roku-All.m3u`,
    blurb: 'The Roku Channel live',
  },
  {
    id: 'lgtv',
    name: 'LG Channels',
    file: 'LGTV.m3u',
    upstream: `${GH_RAW}/LGTV.m3u`,
    blurb: 'LG Channels powered by Amagi',
  },
  {
    id: 'xumo',
    name: 'Xumo Play',
    file: 'xumo_playlist.m3u',
    upstream: `${GH_RAW}/xumo_playlist.m3u`,
    blurb: 'Xumo Play fast channels',
  },
  {
    id: 'stirr',
    name: 'STIRR',
    file: 'Stirr-All.m3u',
    upstream: `${GH_RAW}/Stirr-All.m3u`,
    blurb: 'STIRR local + live',
  },
  {
    id: 'tubi',
    name: 'Tubi',
    file: 'tubi_playlist.m3u',
    upstream: `${GH_RAW}/tubi_playlist.m3u`,
    blurb: 'Tubi live channels',
  },
  {
    id: 'yupp',
    name: 'YuppTV',
    file: 'Yupptv.m3u',
    upstream: `${GH_RAW}/Yupptv.m3u`,
    blurb: 'YuppTV south-asian channels',
  },
  {
    id: 'uslocal',
    name: 'US Local',
    file: 'US_LOCAL.m3u',
    upstream: `${GH_RAW}/US_LOCAL.m3u`,
    blurb: 'US local broadcast stations',
  },
  {
    id: 'klowd',
    name: 'KlowdTV',
    file: 'klowdtv.m3u',
    upstream: `${GH_RAW}/klowdtv.m3u`,
    blurb: 'KlowdTV live',
  },
  {
    id: 'fstv',
    name: 'FSTV24',
    file: 'FSTV24.m3u8',
    upstream: `${GH_RAW}/FSTV24.m3u8`,
    forceCategory: 'entertainment',
    blurb: 'FSTV 24/7 US channels',
  },
  {
    id: 'japan',
    name: 'Japan TV',
    file: 'JapanTV.m3u8',
    upstream: `${GH_RAW}/JapanTV.m3u8`,
    forceCategory: 'world',
    blurb: 'Japanese terrestrial channels',
  },
  {
    id: 'udp',
    name: 'UDPTV',
    file: 'UDPTV.m3u',
    upstream: `${GH_RAW}/UDPTV.m3u`,
    blurb: 'UDPTV multigenre',
  },
  {
    id: 'wns',
    name: 'WNS Live',
    file: 'Wnslive.m3u',
    upstream: `${GH_RAW}/Wnslive.m3u`,
    blurb: 'WNS live feeds',
  },
  {
    id: 'distro',
    name: 'Distro TV',
    file: 'distrotv.m3u',
    upstream: `${GH_RAW}/distrotv.m3u`,
    blurb: 'DistroTV channels',
  },
  {
    id: 'moveonjoy',
    name: 'MoveOnJoy',
    file: 'Moveonjoy.m3u',
    upstream: `${GH_RAW}/Moveonjoy.m3u`,
    forceCategory: 'entertainment',
    blurb: 'MoveOnJoy entertainment',
  },
  {
    id: 'sofast',
    name: 'SoFast',
    file: 'SOFAST.m3u',
    upstream: `${GH_RAW}/SOFAST.m3u`,
    forceCategory: 'entertainment',
    blurb: 'SoFast channels',
  },
  // ── Sports playlists surfaced inside the SPORTS tab ──
  {
    id: 'tvpass',
    name: 'TVPass Sports',
    file: 'TVPass.m3u',
    upstream: `${GH_RAW}/TVPass.m3u`,
    sports: true,
    forceCategory: 'sports',
    blurb: 'NBA / NHL / NCAAF feeds',
  },
  {
    id: 'thetvapp',
    name: 'TheTVApp',
    file: 'TheTVApp.m3u8',
    upstream: `${GH_RAW}/TheTVApp.m3u8`,
    sports: true,
    forceCategory: 'sports',
    blurb: 'MLB network feeds',
  },
  {
    id: 'pixelsports',
    name: 'Pixelsports',
    file: 'Pixelsports.m3u',
    upstream: `${GH_RAW}/Pixelsports.m3u`,
    sports: true,
    forceCategory: 'sports',
    blurb: 'Pixelsports 24/7',
  },
  {
    id: 'bein',
    name: 'beIN Sports',
    file: 'bein.m3u',
    // curated snapshot (no upstream refresh — verified streams, kept as-is)
    upstream: '',
    sports: true,
    forceCategory: 'sports',
    blurb: 'beIN Sports networks — football first',
  },
];

export function dataDir(): string {
  // data/iptv lives at the project root (cwd in dev server)
  return path.join(process.cwd(), 'data', 'iptv');
}

export function readPlaylistFile(source: PlaylistSource): string | null {
  try {
    const p = path.join(dataDir(), source.file);
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

// ─── Upstream refresh ─────────────────────────────────────────────────────────
// IPTV-Scraper-Zilla regenerates its playlists hourly; stream tokens inside
// (STIRR, Tubi, Samsung …) expire quickly, so a stale snapshot means dead
// links. We re-pull each playlist from GitHub raw when the local copy is
// older than REFRESH_AFTER_MS. Refresh failures keep the old snapshot.

const REFRESH_AFTER_MS = 60 * 60 * 1000; // 1h — upstream regenerates hourly
const refreshing = new Set<string>();

let onRefreshed: (() => void) | null = null;
/** catalog registers here to rebuild after a playlist lands */
export function setPlaylistRefreshCallback(cb: () => void): void {
  onRefreshed = cb;
}

function fileAgeMs(source: PlaylistSource): number {
  try {
    const st = fs.statSync(path.join(dataDir(), source.file));
    return Date.now() - st.mtimeMs;
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Fire-and-forget refresh of one playlist from upstream GitHub raw. */
export function refreshPlaylist(source: PlaylistSource): void {
  if (!source.upstream) return; // curated sources ship as static snapshots
  if (refreshing.has(source.id)) return;
  if (fileAgeMs(source) < REFRESH_AFTER_MS) return;
  refreshing.add(source.id);
  const url = source.upstream;
  fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    signal: AbortSignal.timeout(20000),
  })
    .then(async (res) => {
      if (!res.ok) return;
      const text = await res.text();
      // sanity: must look like a playlist and be non-trivial
      if (!text.includes('#EXTM3U') || !text.includes('#EXTINF')) return;
      if (text.length < 200) return;
      fs.mkdirSync(dataDir(), { recursive: true });
      fs.writeFileSync(path.join(dataDir(), source.file), text, 'utf-8');
      onRefreshed?.();
    })
    .catch(() => {
      /* keep snapshot */
    })
    .finally(() => refreshing.delete(source.id));
}

/** Kick off refreshes for all sources (called on catalog build). */
export function refreshAllPlaylists(): void {
  for (const src of PLAYLIST_SOURCES) refreshPlaylist(src);
}
