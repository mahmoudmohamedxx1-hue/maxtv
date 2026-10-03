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
import { getLadderPool, providerLabelFromUrl } from './ladderpool';

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
    // disabled sources (provider dead — 403/404 upstream) never reach the UI
    if (src.disabled) continue;
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
  /** TRUE only when this is the SAME channel (not a brand-family sibling
   *  like beIN 1 → beIN XTRA). Quality-menu rungs require it — picking a
   *  quality must never change the channel. */
  sameChannel?: boolean;
  /** verified native quality rungs (pool entries ship pre-attached) */
  ladder?: number[];
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

/** regional/edition qualifiers — the same network sold under localized names
 *  ("beIN Sports MENA English 1" ≡ "beIN Sports 1"). Stripped for matching
 *  only; menu labels keep the full name. */
const REGION_QUALIFIERS =
  /\b(arabic|english|mena|usa|us|uk|ksa|qatar|egypt|france|french|germany|german|spain|espanol|español|hispanic|portugal|asia|pacific|america|american|international|premium|turkey|turkish|australia|malaysia)\b/gi;

function regionalCoreName(n: string): string {
  // strip qualifiers from the RAW name (word boundaries need the spaces),
  // then normalize — "beIN Sports 1 Arabic" → "beinsports1"
  return normalizeChannelName(n.replace(REGION_QUALIFIERS, ' '));
}

/** Region CLASS of a channel name — which localized variant of the network
 *  this feed actually is. "beIN Sports 5 Arabic" → 'mena-ar'; the UDPTV
 *  "Bein Sports 5" (tvg-id …sg, NOW-TV HK artwork) → '' — the Singapore/
 *  English feed. Two feeds are the SAME channel only when their region
 *  classes match: a regional twin is a language/content swap, and the
 *  2026-10-03 field report showed auto-failover hopping beIN 5 Arabic onto
 *  the unqualified (English) feed when the Arabic CDN id died — "arabic is
 *  not arabic". Quality rungs share the guard: picking 480p must never
 *  change the commentary language. */
const REGION_CLASS_RULES: Array<[RegExp, string]> = [
  // english FIRST — "MENA English" must classify as english, not mena-arabic
  [/\benglish\b/i, 'en'],
  [/\barabic\b|\bmena\b|\b(ksa|qatar|egypt)\b/i, 'mena-ar'],
  [/\bturk(ey|ish|ce)\b/i, 'tr'],
  [/\bfrance\b|\bfrench\b/i, 'fr'],
  [/\baustralia\b/i, 'au'],
  [/\bmalaysia\b/i, 'my'],
  [/\busa\b|\bus\b|\bespa[nñ]ol\b|\bhispanic\b|\bamerica(?:n)?\b/i, 'us'],
  [/\buk\b/i, 'uk'],
  [/\bgermany\b|\bgerman\b/i, 'de'],
  [/\bspain\b|\bportugal\b/i, 'es'],
  [/\basia\b|\bpacific\b/i, 'apac'],
  [/\bpremium\b/i, 'premium'],
];

function regionClass(n: string): string {
  for (const [re, cls] of REGION_CLASS_RULES) if (re.test(n)) return cls;
  return '';
}

/** standalone channel numbers of a name ("ESPN 2" → ["2"]). Same channel
 *  requires the SAME number — ESPN 2 must never match ESPN, and a numbered
 *  beIN must never match the un-numbered free-tier "beIN Sports" feed. */
function channelNumbers(n: string): string[] {
  return normalizeChannelName(n).match(/\d+/g) || [];
}

/**
 * Find the same channel served by other sources — the IPTV counterpart of the
 * original repo's per-stream server switching. Same channel on a different
 * provider (or a second stream URL on the same provider) = a different
 * "server" the user (or the failover engine) can hop to.
 *
 * Matching tiers (per candidate):
 *   t1 exact normalized name · t2 channel-number-stripped core · t3
 *   region-stripped (with a channel-number guard) → `sameChannel: true`
 *   t4 brand-family prefix ("beIN SPORTS XTRA" under the beIN brand) →
 *   `sameChannel: false` — listed in the servers menu as another source but
 *   NEVER as a quality rung (picking 1080p must not change the channel).
 *
 * The curated LadderAlts pool (verified same-channel ABR masters, rungs
 * pre-attached) is merged in first — its entries skip the runtime probe.
 */
export async function findAlternates(
  name: string,
  excludeUrl: string,
  limit = 10
): Promise<AlternateChannel[]> {
  if (!name) return [];
  const cat = await getCatalog();
  const want = normalizeChannelName(name);
  const core = coreChannelName(name);
  if (!want) return [];

  const out: AlternateChannel[] = [];
  const seenUrls = new Set<string>([excludeUrl]);
  const seenKeys = new Set<string>();
  const regional = regionalCoreName(name);
  const nums = channelNumbers(name);
  // catalog channels carry only a source id — resolve the display name
  const srcLabel = (id: string) => cat.sources.find((s) => s.id === id)?.name || id;

  const consider = (
    ch: { name: string; url: string; logo?: string; source: string; sourceName?: string; id?: string; chno?: string; health?: SourceHealth },
    opts?: { ladder?: number[]; pool?: boolean }
  ): 'same' | 'family' | null => {
    if (seenUrls.has(ch.url)) return null;
    const n = normalizeChannelName(ch.name);
    const rc = regionalCoreName(ch.name);
    let tier: 1 | 2 | 3 | 4 | null = null;
    if (n === want) tier = 1;
    else if (core.length >= 5 && coreChannelName(ch.name) === core) tier = 2;
    else if (regional.length >= 6 && rc === regional && n !== want) tier = 3;
    else if (
      regional.length >= 8 &&
      rc.length >= 8 &&
      rc !== regional &&
      (rc.startsWith(regional) || regional.startsWith(rc))
    ) tier = 4;
    if (!tier) return null;

    // same-channel rules for quality rungs: exact/core always qualify; the
    // regional tier additionally needs matching channel numbers AND must not
    // cross into the curated free-tier beIN feeds (beIN 1 ≠ "beIN Sports"
    // cloud/XTRA — different channel, per the 2026-10-02 field report)
    let sameChannel = tier <= 2;
    if (tier === 3) {
      sameChannel =
        channelNumbers(ch.name).join(',') === nums.join(',') &&
        ch.source !== 'bein';
    }
    // region guard at EVERY tier — a localized twin (Arabic ↔ unqualified/
    // Singapore ↔ Turkey ↔ France …) is a DIFFERENT channel. Auto-failover
    // and quality rungs must never silently swap languages (2026-10-03:
    // "bein 5 arabic is not arabic" — dead premium95 hopped onto the
    // unqualified English "Bein Sports 5"). Regional twins stay in the
    // servers menu as manual picks, never automatic ones.
    if (sameChannel && regionClass(ch.name) !== regionClass(name)) sameChannel = false;

    seenUrls.add(ch.url);
    // one menu entry per (source, matched-name) pair — skips "108 X" + "129 X"
    // clones AND regional twins from the same source
    const key = `${ch.source}|${tier === 1 ? n : tier === 2 ? coreChannelName(ch.name) : rc}`;
    if (seenKeys.has(key)) return null;
    seenKeys.add(key);
    out.push({
      id: ch.id || `alt:${ch.source}:${n}`,
      name: ch.name,
      source: ch.source,
      sourceName: ch.sourceName || srcLabel(ch.source),
      url: ch.url,
      logo: ch.logo,
      chno: ch.chno,
      health: ch.health,
      sameChannel,
      ...(opts?.ladder?.length ? { ladder: opts.ladder } : {}),
    });
    return sameChannel ? 'same' : 'family';
  };

  // ── 1. curated ladder pool first (verified rungs pre-attached) ────────────
  for (const e of getLadderPool()) {
    if (out.length >= limit) break;
    consider(
      {
        name: e.name,
        url: e.url,
        logo: e.logo,
        source: 'ladderalts',
        sourceName: providerLabelFromUrl(e.url),
      },
      { ladder: e.ladder, pool: true }
    );
  }

  // ── 2. the live catalog ─────────────────────────────────────────────────
  for (const ch of cat.channels) {
    if (out.length >= limit) break;
    consider({
      ...ch,
      sourceName: srcLabel(ch.source),
      health: cat.sourceHealth[ch.source] || 'unknown',
    });
  }

  // verified ladder rungs first, then worldsports, then healthy, then name
  const tier = (h?: SourceHealth) => (h === 'ok' ? 0 : h === 'geo' ? 1 : 2);
  return out.sort(
    (a, b) =>
      Number(!!b.ladder) - Number(!!a.ladder) ||
      Number(b.source === 'worldsports') - Number(a.source === 'worldsports') ||
      tier(a.health) - tier(b.health) ||
      a.sourceName.localeCompare(b.sourceName)
  );
}
