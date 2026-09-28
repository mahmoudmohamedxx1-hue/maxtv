// ─── IPTV catalog (server-side, in-memory cached) ────────────────────────────
// Builds the unified channel catalog from the IPTV-Scraper-Zilla playlists:
//   1. kicks off an upstream refresh when snapshots are stale (hourly upstream)
//   2. repairs obfuscated channel names (FSTV-style "Ori2Usacbssport")
//   3. enriches channels with logos — playlist tvg-logo, or the tv-logos CDN
//      map ported from the original live-sport-plugin repo
//   4. probes source health and drops fully dead sources (like the original's
//      check-sources.js), re-probing every 15 minutes

import type { IPTVChannel, CatalogCategory, ChannelSourceInfo } from '../types';
import { PLAYLIST_SOURCES, readPlaylistFile, refreshAllPlaylists, setPlaylistRefreshCallback, type PlaylistSource } from './sources';
import { parseM3U, entryToChannel } from './m3u';
import { normalizeCategory } from './categories';
import { isObfuscatedName, repairChannelName } from './repair';
import { getChannelLogo, warmLogoCache } from '@/lib/media/logos';
import { probeSource, type SourceHealth } from './health';

export interface Catalog {
  channels: IPTVChannel[];
  /** channels of the SPORTS tab (curated sports playlists only) */
  sportsChannels: IPTVChannel[];
  /** every other channel (OTHERS tab) */
  otherChannels: IPTVChannel[];
  categories: CatalogCategory[];
  sources: ChannelSourceInfo[];
  /** source id → health */
  sourceHealth: Record<string, SourceHealth>;
  builtAt: number;
}

let cached: Catalog | null = null;
let building: Promise<Catalog> | null = null;

// self-healing window: rebuild the catalog when it is older than this, so
// re-probed source health and refreshed playlists are picked up automatically
const REBUILD_AFTER_MS = 20 * 60 * 1000;

function startBuild(): Promise<Catalog> {
  building = build()
    .then((c) => {
      cached = c;
      building = null;
      return c;
    })
    .catch((e) => {
      building = null;
      throw e;
    });
  return building;
}

// when a refreshed playlist lands on disk, rebuild the catalog in background
setPlaylistRefreshCallback(() => {
  cached = null;
  if (!building) {
    startBuild().catch(() => {});
  }
});

export function getCatalog(): Promise<Catalog> {
  if (cached) {
    // serve stale but kick a background rebuild when past the window
    if (Date.now() - cached.builtAt > REBUILD_AFTER_MS && !building) {
      startBuild().catch(() => {});
    }
    return Promise.resolve(cached);
  }
  if (building) return building;
  return startBuild();
}

/** Invalidate the in-memory catalog (used after playlist refreshes). */
export function invalidateCatalog(): void {
  cached = null;
}

export function isCatalogBuilt(): boolean {
  return cached !== null;
}

async function build(): Promise<Catalog> {
  // stale playlists refresh in the background; the next build picks them up
  refreshAllPlaylists();
  // warm the curated logo cache so first paint is not photo-less
  warmLogoCache();

  const channels: IPTVChannel[] = [];
  const sportsChannels: IPTVChannel[] = [];
  const seen = new Set<string>();
  const seenIds = new Set<string>();
  const bySource = new Map<string, IPTVChannel[]>();

  for (const src of PLAYLIST_SOURCES) {
    const content = readPlaylistFile(src);
    if (!content) continue;
    const entries = parseM3U(content);
    const srcChannels: IPTVChannel[] = [];
    for (const e of entries) {
      const ch = entryToChannel(src.id, e);
      if (!ch.url || !/^https?:\/\//i.test(ch.url)) continue;

      // repair obfuscated names (FSTV-style); drop unrecoverable ones
      if (isObfuscatedName(ch.name)) {
        const repaired = repairChannelName(ch.name, ch.url, ch.logo);
        if (!repaired) continue; // junk channel — drop
        ch.name = repaired;
      }

      // dedupe by (name + url) — combined playlists repeat channels
      const key = `${ch.name.toLowerCase()}|${ch.url}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // guarantee unique ids — two channels can share a tvg-id ("24.7.Dummy.us"),
      // and duplicate React keys / store ids would merge distinct channels
      if (seenIds.has(ch.id)) {
        let n = 2;
        while (seenIds.has(`${ch.id}-${n}`)) n++;
        ch.id = `${ch.id}-${n}`;
      }
      seenIds.add(ch.id);

      ch.category = normalizeCategory(
        { group: ch.group, name: ch.name, source: src.id, url: ch.url },
        src.forceCategory
      );

      // logo enrichment: playlist logo → tv-logos CDN map (original repo
      // ChannelLogoService technique) → none (UI generates a gradient tile)
      if (!ch.logo) {
        const mapped = getChannelLogo(ch.name);
        if (mapped) ch.logo = mapped;
      }

      srcChannels.push(ch);
      channels.push(ch);
      if (src.sports) sportsChannels.push(ch);
    }
    if (srcChannels.length) bySource.set(src.id, srcChannels);
  }

  // ── health probe: drop sources where every sample is dead ────────────────
  const sourceHealth: Record<string, SourceHealth> = {};
  const probeIds = [...bySource.keys()];
  await Promise.all(
    probeIds.map(async (id) => {
      const status = await probeSource(id, bySource.get(id)!);
      sourceHealth[id] = status.health;
    })
  );

  const dropped = new Set(
    Object.entries(sourceHealth)
      .filter(([, h]) => h === 'dead')
      .map(([id]) => id)
  );

  let liveChannels = channels;
  let liveSports = sportsChannels;
  if (dropped.size > 0) {
    liveChannels = channels.filter((c) => !dropped.has(c.source));
    liveSports = sportsChannels.filter((c) => !dropped.has(c.source));
  }

  // OTHERS = everything except the curated sports playlists' channels
  const sportsIds = new Set(liveSports.map((c) => c.id));
  const otherChannels = liveChannels.filter((c) => !sportsIds.has(c.id));

  // Category counts for pills (count within OTHERS tab)
  const catCount = new Map<string, number>();
  for (const c of otherChannels) catCount.set(c.category, (catCount.get(c.category) || 0) + 1);

  const CATEGORY_ORDER = [
    'movies', 'series', 'entertainment', 'news', 'kids', 'documentary',
    'music', 'comedy', 'anime', 'lifestyle', 'world', 'sports',
  ];
  const categories: CatalogCategory[] = [{ id: 'all', name: 'All', count: otherChannels.length }];
  for (const id of CATEGORY_ORDER) {
    const n = catCount.get(id) || 0;
    if (n > 0) {
      categories.push({
        id,
        name: prettify(id),
        count: n,
      });
    }
  }

  // Source counts + health (alive sources first)
  const srcCount = new Map<string, number>();
  for (const c of liveChannels) srcCount.set(c.source, (srcCount.get(c.source) || 0) + 1);
  const sources: ChannelSourceInfo[] = PLAYLIST_SOURCES.map((s: PlaylistSource) => ({
    id: s.id,
    name: s.name,
    count: srcCount.get(s.id) || 0,
    health: sourceHealth[s.id] || 'unknown',
  }))
    .filter((s) => s.count > 0)
    .sort((a, b) => {
      // ok first, then geo, then unknown — alphabetical within a tier
      const tier = (h?: string) => (h === 'ok' ? 0 : h === 'geo' ? 1 : 2);
      return tier(a.health) - tier(b.health) || a.name.localeCompare(b.name);
    });

  return {
    channels: liveChannels,
    sportsChannels: liveSports,
    otherChannels,
    categories,
    sources,
    sourceHealth,
    builtAt: Date.now(),
  };
}

function prettify(id: string): string {
  const map: Record<string, string> = {
    movies: 'Movies',
    series: 'Series & Shows',
    entertainment: 'Entertainment',
    news: 'News',
    kids: 'Kids',
    documentary: 'Documentary',
    music: 'Music',
    comedy: 'Comedy',
    anime: 'Anime & Gaming',
    lifestyle: 'Lifestyle',
    world: 'World',
    sports: 'Sports',
  };
  return map[id] ?? id;
}

// ─── per-stream server switching: same channel on other sources ─────────────

export interface AlternateChannel {
  id: string;
  name: string;
  source: string;
  sourceName: string;
  url: string;
  logo?: string;
  chno?: string;
  health?: SourceHealth;
}

/** Normalize a channel name for "same channel" matching */
function normalizeChannelName(n: string): string {
  return n
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/\b(hd|fhd|uhd|4k|sd|hq)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Strip leading channel numbers ("129 Bloomberg TV+" → "bloombergtv") */
function coreChannelName(n: string): string {
  return normalizeChannelName(n).replace(/^[0-9]+/, '');
}

/**
 * Find the same channel served by other sources — the IPTV counterpart of the
 * original repo's per-stream server switching. Same channel on a different
 * provider (or a second stream URL on the same provider) = a different
 * "server" the user (or the failover engine) can hop to.
 */
export async function findAlternates(
  name: string,
  excludeUrl: string,
  limit = 8
): Promise<AlternateChannel[]> {
  if (!name) return [];
  const cat = await getCatalog();
  const want = normalizeChannelName(name);
  const core = coreChannelName(name);
  if (!want) return [];

  const out: AlternateChannel[] = [];
  const seenUrls = new Set<string>([excludeUrl]);
  const seenKeys = new Set<string>();
  for (const ch of cat.channels) {
    if (seenUrls.has(ch.url)) continue;
    // tier 1: exact normalized name; tier 2: channel-number-stripped core name
    const n = normalizeChannelName(ch.name);
    if (n !== want && !(core.length >= 5 && coreChannelName(ch.name) === core && n !== want)) continue;
    seenUrls.add(ch.url);
    // one menu entry per (source, channel) pair — skip "108 X" + "129 X" clones
    const key = `${ch.source}|${n}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const src = cat.sources.find((s) => s.id === ch.source);
    out.push({
      id: ch.id,
      name: ch.name,
      source: ch.source,
      sourceName: src?.name || ch.source,
      url: ch.url,
      logo: ch.logo,
      chno: ch.chno,
      health: cat.sourceHealth[ch.source] || 'unknown',
    });
    if (out.length >= limit) break;
  }

  // healthy sources first, then alphabetical
  const tier = (h?: SourceHealth) => (h === 'ok' ? 0 : h === 'geo' ? 1 : 2);
  return out.sort((a, b) => tier(a.health) - tier(b.health) || a.sourceName.localeCompare(b.sourceName));
}
