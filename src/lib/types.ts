// ─── Shared domain types ─────────────────────────────────────────────────────

export interface IPTVChannel {
  /** Unique id across the app: `${source}:${nativeId}` */
  id: string;
  /** Display name */
  name: string;
  /** Channel logo URL */
  logo?: string;
  /** Original group-title from the playlist */
  group: string;
  /** Normalized category id (see iptv/categories.ts) */
  category: string;
  /** Playlist source id (pluto, samsung, plex ...) */
  source: string;
  /** Stream URL (may be a jmp2.uk shortlink needing resolution) */
  url: string;
  tvgId?: string;
  /** Channel number, Pluto-guide style */
  chno?: string;
}

export interface ChannelSourceInfo {
  id: string;
  name: string;
  /** Rough channel count, filled at catalog build time */
  count?: number;
  /** Probed upstream health: ok | geo | dead | unknown */
  health?: string;
}

export interface CatalogCategory {
  id: string;
  name: string;
  count: number;
}

export interface SportsChannelRef {
  /** DaddyLive channel id (numeric) */
  id: string;
  name: string;
}

export interface SportsMatch {
  id: string;
  title: string;
  league: string;
  /** Normalized sport id (football, cricket, mma ...) */
  category: string;
  /** Epoch ms of kickoff (UTC) */
  startTime: number;
  /** Raw time string from the schedule */
  timeStr: string;
  /** live = started and not yet finished */
  status: 'live' | 'upcoming';
  channels: SportsChannelRef[];
  /** Day header the event was listed under */
  day: string;
  /** women's competition (WSL, NWSL, Frauen-Bundesliga, Serie A Femminile …).
   *  Field report 2026-10-03: a WSL "Manchester United vs Liverpool" listing
   *  read as the MEN'S derby — "there is no match at that time in real
   *  fixtures" — because nothing on the card said it was the women's match.
   *  This flag drives an unmissable WOMEN'S badge on every card. */
  women?: boolean;
}

export interface ResolvedStream {
  /** Absolute upstream manifest URL */
  url: string;
  /** Referer that must be sent when fetching the manifest / segments */
  referer?: string;
  /** Where the manifest came from */
  origin?: string;
  /** Resolution strategy used (for debugging) */
  strategy?: string;
}

export interface PlayableChannel {
  id: string;
  name: string;
  logo?: string;
  meta?: string;
  /** Which pipeline plays this channel */
  kind: 'daddylive' | 'iptv';
  /** daddylive: numeric channel id — iptv: absolute stream url */
  ref: string;
  source?: string;
  category?: string;
}
