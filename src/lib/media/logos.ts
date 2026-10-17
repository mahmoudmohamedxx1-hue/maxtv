// ─── Logo service — ported from live-sport-plugin ────────────────────────────
// Same technique as the original repo:
//   • ChannelLogoService  — curated jsDelivr tv-logos CDN map + aliases +
//     substring matching + deep resolution against an 18k-entry tv_logos_map
//   • TeamLogoService     — curated league emblems (ESPN CDN) + club badges +
//     TheSportsDB free API with in-memory cache
// Every logo URL we return is routed through /api/img (cache + SVG fallback),
// exactly like the original's ImageService proxy — so a dead upstream logo can
// never produce a broken image in the client.

import curated from '@/data/curated_logos.json';
import tvLogosMap from '@/data/tv_logos_map.json';
import teamSeed from '@/data/team_logos_seed.json';

const CDN_BASE: string = curated.cdnBase;
const CHANNEL_LOGOS: Record<string, string> = curated.channelLogos;
const ALIASES: Record<string, string> = curated.aliases;
const LEAGUE_EMBLEMS: Record<string, string> = curated.leagueEmblems;
const CLUB_BADGES: Record<string, string> = curated.clubs;
const TEAM_ALIASES: Record<string, string> = curated.teamAliases;
const TEAM_SEED: Record<string, string> = teamSeed;

// sorted longest-first so "sky sports cricket" beats "sky sports"
const SORTED_CHANNEL_KEYS = Object.entries(CHANNEL_LOGOS).sort(
  (a, b) => b[0].length - a[0].length
);

const TV_MAP = tvLogosMap as Record<string, string>;

const NUMBER_WORDS: Record<string, string> = {
  one: '1', two: '2', three: '3', four: '4', five: '5',
  six: '6', seven: '7', eight: '8', nine: '9', ten: '10',
};

const COUNTRY_RE = /-(usa|us|uk|italy|it|germany|de|spain|es|france|fr|netherlands|nl|poland|pl|portugal|pt|serbia|rs|croatia|hr|bulgaria|bg|uae|nz|au|ca|bih|turkey|tr|arabic|brasil|br|malaysia|my|india|in|japan|jp|canada|australia|america|europe|world|intl|international)$/i;
const QUALITY_RE = /-(hd|fhd|sd|4k|uhd)$/i;

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function cleanChannelTitle(raw: string): string {
  if (!raw) return '';
  return String(raw)
    .toLowerCase()
    .replace(/\((?:\d{3,4}[pi]|sd|hd|fhd|uhd|4k)\)/gi, ' ')
    .replace(/\[([^\]]*)\]/g, ' ')
    .replace(/\b(24\/7|live|stream|hd|fhd|4k|uhd|raw|en|us|uk)\b/gi, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tryFindLogo(candidate: string): string | null {
  if (!candidate) return null;
  if (TV_MAP[candidate]) return TV_MAP[candidate];
  if (/-(usa|us)$/.test(candidate)) {
    const usKey = candidate.replace(/-(usa|us)$/, '') + '-us';
    if (TV_MAP[usKey]) return TV_MAP[usKey];
  }
  const sc = candidate.replace(COUNTRY_RE, '');
  if (TV_MAP[sc]) return TV_MAP[sc];
  const sq = sc.replace(QUALITY_RE, '');
  if (TV_MAP[sq]) return TV_MAP[sq];
  const sqc = candidate.replace(QUALITY_RE, '').replace(COUNTRY_RE, '');
  if (TV_MAP[sqc]) return TV_MAP[sqc];
  return null;
}

/** Deep resolution against the 18k tv_logos map (ported resolveDeepLogo) */
function resolveDeepLogo(title: string): string | null {
  if (!title) return null;
  const clean = String(title).trim();
  const slug = slugify(clean);

  // major US networks
  if (
    /^(abc|cbs|nbc|fox|pbs|cw)(-[a-z0-9]+)*-(usa|us)$/.test(slug) ||
    ['abc', 'cbs', 'nbc', 'fox', 'pbs', 'cw'].includes(slug)
  ) {
    const baseNet = slug.split('-')[0];
    if (TV_MAP[`${baseNet}-us`]) return TV_MAP[`${baseNet}-us`];
    if (TV_MAP[baseNet]) return TV_MAP[baseNet];
  }

  let res = tryFindLogo(slug);
  if (res) return res;

  // parentheses e.g. "AHC (American Heroes Channel)"
  const paren = clean.match(/^(.*?)\s*\((.*?)\)$/);
  if (paren) {
    res = tryFindLogo(slugify(paren[1])) || tryFindLogo(slugify(paren[2]));
    if (res) return res;
  }

  // number words: "sky sport one" -> "sky-sport-1"
  const numSlug = slug.split('-').map((w) => NUMBER_WORDS[w] || w).join('-');
  if (numSlug !== slug) {
    res = tryFindLogo(numSlug);
    if (res) return res;
  }

  // sport tv pt / sportklub / polsat / formula / motogp
  if (slug.includes('sport-tv')) {
    const num = slug.match(/sport-tv-?(\d+)/);
    if (num && TV_MAP[`sport-tv-${num[1]}-pt`]) return TV_MAP[`sport-tv-${num[1]}-pt`];
    if (num && TV_MAP[`sport-tv-${num[1]}`]) return TV_MAP[`sport-tv-${num[1]}`];
  }
  if (slug.includes('sport-klub') || slug.includes('sportklub')) {
    const num = slug.match(/sport-?klub-?(\d+)/);
    if (num && TV_MAP[`sportklub-${num[1]}-hd-hr`]) return TV_MAP[`sportklub-${num[1]}-hd-hr`];
    if (TV_MAP['sportklub-1-hd-hr']) return TV_MAP['sportklub-1-hd-hr'];
  }
  if (slug.includes('polsat-sport')) {
    const num = slug.match(/polsat-sport-(?:premium-)?(\d+)/);
    if (num && TV_MAP[`polsat-sport-${num[1]}-pl`]) return TV_MAP[`polsat-sport-${num[1]}-pl`];
    if (TV_MAP['polsat-sport-1-pl']) return TV_MAP['polsat-sport-1-pl'];
  }
  if (slug.includes('formula')) {
    res = tryFindLogo(slug.replace(/formula-1/g, 'formula1'));
    if (res) return res;
  }
  if (slug.includes('motogp') || slug.includes('moto-gp')) {
    res = tryFindLogo(slug.replace(/moto-gp/g, 'motogp'));
    if (res) return res;
  }

  return null;
}

function toCdn(pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${CDN_BASE}/${pathOrUrl.replace(/^\/+/, '')}`;
}

/** Main entry: channel name → logo URL (routed through /api/img) */
export function getChannelLogo(title: string): string | null {
  if (!title) return null;
  const rawLower = String(title).toLowerCase().trim();
  const cleaned = cleanChannelTitle(rawLower);

  // Special case: beIN Sports N Arabic channels. The substring key
  // "bein sports arabic" doesn't match "beIN Sports 1 Arabic" because
  // the channel number ("1") sits between "sports" and "arabic" in the
  // name. Detect beIN + "arabic" as separate tokens so the Arabic-specific
  // logo (bein-sports-arabic-mea.png) is returned instead of the generic
  // French one. (field report 2026-10-17: "bein sport keep bugging")
  if (/be\s?in/i.test(title) && /arabic/i.test(rawLower)) {
    return CHANNEL_LOGOS['bein sports arabic'] || null;
  }

  if (CHANNEL_LOGOS[rawLower]) return CHANNEL_LOGOS[rawLower];
  if (CHANNEL_LOGOS[cleaned]) return CHANNEL_LOGOS[cleaned];

  const alias = ALIASES[rawLower] || ALIASES[cleaned];
  if (alias && CHANNEL_LOGOS[alias]) return CHANNEL_LOGOS[alias];

  // substring, longest key wins
  for (const [key, logoUrl] of SORTED_CHANNEL_KEYS) {
    if (cleaned.includes(key) || rawLower.includes(key)) return logoUrl;
  }

  // deep resolution — try the cleaned name too (quality suffixes stripped)
  const deep = resolveDeepLogo(title) || (cleaned ? resolveDeepLogo(cleaned) : null);
  if (deep) return toCdn(deep);

  return null;
}

/** League / competition emblem (ESPN CDN curated) */
export function getLeagueLogo(league: string, title = ''): string | null {
  if (!league) return null;
  const l = league.toLowerCase().trim();
  if (LEAGUE_EMBLEMS[l]) return LEAGUE_EMBLEMS[l];
  // try title words for known competitions
  const t = title.toLowerCase();
  for (const [name, url] of Object.entries(LEAGUE_EMBLEMS)) {
    if (name.length > 3 && t.includes(name)) return url;
  }
  return null;
}

// ─── Team crest resolution (TheSportsDB + seed + curated) ───────────────────

const teamCache = new Map<string, string | null>(); // includes negatives
const inFlight = new Map<string, Promise<string | null>>();
/** when each NEGATIVE verdict was recorded — a timeout must not poison the
 *  cache for the isolate's whole life (the comment promised 10 min; the code
 *  never delivered it, which mattered once lookups became fast-fail 2.5s) */
const negAt = new Map<string, number>();
const NEG_TTL_MS = 10 * 60_000;

// ─── ESPN team logos (instant, no API rate limiting) ─────────────────────────
// The ESPN CDN has logos for ALL major league teams (NHL, NBA, NFL, college
// football, college basketball). These are fast, reliable CDN URLs — no
// 2.5s timeout, no rate limiting, no enrichment deadline issue. Fetched
// once at startup (fire-and-forget) and cached in-memory for the isolate's
// life. Used as a fallback in findCachedTeamLogo when the curated seed
// doesn't have a match — gives INSTANT logos for all major-league teams
// on the FIRST response (no need for the after() continuation to fill them).
// (field report 2026-10-17: "really i dont understand why all sports logos
// isnt there" — the TheSportsDB API was too slow/rate-limited for 80+
// concurrent lookups; ESPN teams gives comprehensive coverage in one fetch.)
const espnTeamLogos = new Map<string, string>(); // lowercase team name → logo URL
let espnWarmPromise: Promise<void> | null = null;

const ESPN_LEAGUES: Array<{ sport: string; league: string }> = [
  { sport: 'hockey', league: 'nhl' },
  { sport: 'basketball', league: 'nba' },
  { sport: 'football', league: 'nfl' },
  { sport: 'football', league: 'college-football' },
  { sport: 'basketball', league: 'mens-college-basketball' },
];

/** Fetch all teams from ESPN for major leagues and cache their logos.
 *  Fire-and-forget — the first request triggers it; subsequent requests
 *  use the cached map. */
export function warmEspnTeamLogos(): Promise<void> {
  if (espnWarmPromise) return espnWarmPromise;
  espnWarmPromise = (async () => {
    for (const { sport, league } of ESPN_LEAGUES) {
      try {
        const url = `https://site.api.espn.com/apis/site/v2/sports/${sport}/${league}/teams?limit=1000`;
        const res = await fetch(url, {
          signal: AbortSignal.timeout(5000),
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        });
        if (!res.ok) continue;
        // Use a minimal typed interface — the ESPN API response is deeply
        // nested and a complex inline type annotation confuses the TS parser.
        interface EspnTeamLogo { href?: string }
        interface EspnTeam { displayName?: string; shortDisplayName?: string; abbreviation?: string; logos?: EspnTeamLogo[] }
        interface EspnTeamEntry { team?: EspnTeam }
        interface EspnLeague { teams?: EspnTeamEntry[] }
        interface EspnSport { leagues?: EspnLeague[] }
        interface EspnTeamsResponse { sports?: EspnSport[] }
        const data = (await res.json()) as EspnTeamsResponse;
        const leagues = data.sports?.[0]?.leagues || [];
        for (const lg of leagues) {
          for (const t of lg.teams || []) {
            const team = t.team;
            if (!team) continue;
            const logo = team.logos?.[0]?.href;
            if (!logo) continue;
            // Store by multiple name variants for flexible lookup
            if (team.displayName) {
              const name = team.displayName.toLowerCase().trim();
              espnTeamLogos.set(name, logo);
            }
            if (team.shortDisplayName) {
              espnTeamLogos.set(team.shortDisplayName.toLowerCase().trim(), logo);
            }
            if (team.abbreviation) {
              espnTeamLogos.set(team.abbreviation.toLowerCase().trim(), logo);
            }
          }
        }
      } catch {
        /* best effort — TheSportsDB fallback still works */
      }
    }
  })();
  return espnWarmPromise;
}

function cleanTeamName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(fc|cf|sc|afc|cfc|if|bk|sk|ac|as|ss|ssd|calcio|deportivo|club)\b/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function findCachedTeamLogo(name: string): string | null {
  if (!name) return null;
  const rawLower = name.toLowerCase().trim();
  if (CLUB_BADGES[rawLower]) return CLUB_BADGES[rawLower];
  const alias = TEAM_ALIASES[rawLower];
  if (alias) {
    const a = alias.toLowerCase();
    if (CLUB_BADGES[a]) return CLUB_BADGES[a];
    if (TEAM_SEED[alias]) return TEAM_SEED[alias];
  }
  if (TEAM_SEED[rawLower]) return TEAM_SEED[rawLower];
  const clean = cleanTeamName(rawLower);
  if (TEAM_SEED[clean]) return TEAM_SEED[clean];
  // seed contains partial last-token keys
  const tokens = clean.split(' ');
  if (tokens.length > 1) {
    const last = tokens[tokens.length - 1];
    if (TEAM_SEED[last]) return TEAM_SEED[last];
  }
  // ESPN team logos (instant — no API call needed). The ESPN CDN has logos
  // for ALL NHL/NBA/NFL/college teams. Once warmed (first request), this
  // gives instant logos without any TheSportsDB API call or enrichment
  // deadline issue.
  if (espnTeamLogos.has(rawLower)) return espnTeamLogos.get(rawLower)!;
  if (espnTeamLogos.has(clean)) return espnTeamLogos.get(clean)!;
  return null;
}

/** Async lookup: seed → TheSportsDB search. Cached, negative-cached (10 min). */
export async function findTeamLogo(name: string): Promise<string | null> {
  if (!name) return null;
  const cached = teamCache.get(name);
  if (cached !== undefined) {
    // expired negative → treat as a miss so a slow moment doesn't bury a
    // crest for the rest of the isolate's life
    if (cached === null && Date.now() - (negAt.get(name) ?? 0) > NEG_TTL_MS) {
      teamCache.delete(name);
      negAt.delete(name);
    } else {
      return cached;
    }
  }
  const direct = findCachedTeamLogo(name);
  if (direct) {
    teamCache.set(name, direct);
    return direct;
  }
  if (inFlight.has(name)) return inFlight.get(name)!;

  const p = (async () => {
    try {
      const q = name.replace(/\(.*?\)/g, '').trim().slice(0, 48);
      // The old free API key '3' was permanently disabled by TheSportsDB
      // (2026) — every lookup that fell through the curated seed/CLUB_BADGES
      // returned the error string "The old '3' Free Sports API key is
      // permanently disabled…" instead of team JSON, so findTeamLogo() got
      // no teams back and returned null. This is why "most of the teams
      // logos doesnt load" (field report 2026-10-17): every non-seeded
      // team had no crest. The new free test key '123' restores the lookup.
      // Confirmed working: Napoli + Greuther Fürth return full team JSON
      // including strBadge URLs.
      const url = `https://www.thesportsdb.com/api/v1/json/123/searchteams.php?t=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        // 2.5s hard cap — a crest lookup that can't answer fast is worthless
        // on a first-paint path; ~300 matches × 7s timeouts on a cold isolate
        // was the bulk of the 37s "sports section loads forever" (2026-10-09).
        // The negative cache means the retry happens politely in the
        // background (after() continuation), not on the user's request.
        signal: AbortSignal.timeout(2500),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { teams?: Array<{ strTeam: string; strBadge?: string | null }> };
      const team = data.teams?.[0];
      if (team?.strBadge) return team.strBadge;
      return null;
    } catch {
      return null;
    }
  })().then((logo) => {
    teamCache.set(name, logo);
    if (logo === null) negAt.set(name, Date.now());
    else negAt.delete(name);
    inFlight.delete(name);
    return logo;
  });

  inFlight.set(name, p);
  return p;
}

/** Split a fixture title into two team names ("Arsenal vs Chelsea") */
export function extractTeamsFromTitle(title: string): [string, string] | null {
  const m = title.match(/^(.+?)\s+(?:vs\.?|v|@)\s+(.+?)(?:\s*[-–—|]\s*|$)/i);
  if (!m) return null;
  const t1 = m[1].trim();
  const t2 = m[2].trim();
  if (!t1 || !t2 || t1.length > 42 || t2.length > 42) return null;
  return [t1, t2];
}

// ─── Tennis player photos (searchplayers.php) ───────────────────────────────
// TheSportsDB's searchteams.php endpoint only returns TEAMS — tennis (ATP/WTA)
// has no "team", just two players. The searchplayers.php endpoint returns
// individual athletes with strThumb (full photo) and strCutout (cutout PNG).
// Used by the schedule enrichment for tennis events (field report 2026-10-17:
// "what about the rest of the sports" — tennis matches had no player photos).

const playerCache = new Map<string, string | null>(); // includes negatives
const playerInFlight = new Map<string, Promise<string | null>>();
const playerNegAt = new Map<string, number>();

/** Extract tennis player names from titles like:
 *  "ATP - Singles: Alexander Zverev vs Alejandro Davidovich Fokina"
 *  "WTA - Doubles: Player A vs Player B"
 *  "Challenger Women - Singles: Tamara Zidansek vs Selena Janicijevic"
 *  Returns [player1, player2] WITHOUT the "ATP - Singles: " prefix, or null
 *  if the title doesn't look like a tennis singles/doubles match. */
export function extractTennisPlayers(title: string): [string, string] | null {
  const m = title.match(
    /^(?:ATP|WTA|Challenger(?:\s+(?:Women|Men))?|ITF)\s+(?:[-–]\s+)?(?:Singles|Doubles):\s*(.+?)\s+(?:vs\.?|v|@)\s+(.+?)(?:\s*[-–—|]\s*|$)/i
  );
  if (!m) return null;
  const p1 = m[1].trim();
  const p2 = m[2].trim();
  if (!p1 || !p2 || p1.length > 42 || p2.length > 42) return null;
  return [p1, p2];
}

/** Async lookup of a tennis player's photo via TheSportsDB searchplayers.php.
 *  Cached + negative-cached (10 min), same pattern as findTeamLogo. Prefers
 *  strThumb (full photo) over strCutout (cutout PNG with transparent bg).
 *
 *  The optional `sport` parameter filters results by strSport — this is
 *  critical for MMA/boxing where partial name matches can return players
 *  from other sports (e.g., searching "Jon Jones" returns "Kenwyne Jones"
 *  the soccer player; filtering for "Fighting" skips that and finds the
 *  actual UFC fighter if he's in the DB). For tennis, filtering for "Tennis"
 *  avoids matching a soccer player who happens to share the name. */
export async function findPlayerLogo(name: string, sport?: string): Promise<string | null> {
  if (!name) return null;
  const cacheKey = sport ? `${name}\u0001${sport}` : name;
  const cached = playerCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached === null && Date.now() - (playerNegAt.get(cacheKey) ?? 0) > NEG_TTL_MS) {
      playerCache.delete(cacheKey);
      playerNegAt.delete(cacheKey);
    } else {
      return cached;
    }
  }
  if (playerInFlight.has(cacheKey)) return playerInFlight.get(cacheKey)!;

  const p = (async () => {
    try {
      const q = name.replace(/\(.*?\)/g, '').trim().slice(0, 48);
      const url = `https://www.thesportsdb.com/api/v1/json/123/searchplayers.php?p=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(2500),
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
      });
      if (!res.ok) return null;
      const data = (await res.json()) as {
        player?: Array<{ strPlayer: string; strSport?: string; strThumb?: string | null; strCutout?: string | null }>;
      };
      const players = data.player || [];
      // If a sport filter is specified, find the first player matching that
      // sport. Without this, a search for "Jon Jones" returns "Kenwyne Jones"
      // (soccer) as the first result — the actual UFC fighter Jon Jones
      // (sport="Fighting") would be buried deeper in the list.
      const player = sport
        ? players.find((pl) => pl.strSport?.toLowerCase() === sport.toLowerCase())
        : players[0];
      if (player?.strThumb) return player.strThumb;
      if (player?.strCutout) return player.strCutout;
      return null;
    } catch {
      return null;
    }
  })().then((logo) => {
    playerCache.set(cacheKey, logo);
    if (logo === null) playerNegAt.set(cacheKey, Date.now());
    else playerNegAt.delete(cacheKey);
    playerInFlight.delete(cacheKey);
    return logo;
  });

  playerInFlight.set(cacheKey, p);
  return p;
}

/** Extract fighter names from MMA/boxing titles, stripping the event prefix.
 *  Examples:
 *    "ONE Samurai 4: Haggerty vs. Akimoto"     → ["Haggerty", "Akimoto"]
 *    "UFC 309: Jones vs Miocic"                → ["Jones", "Miocic"]
 *    "Boxing WBA : Tyson Fury vs Anthony Joshua" → ["Tyson Fury", "Anthony Joshua"]
 *    "Glory Kickboxing Glory 110 : Miguel Trindade vs Deniz Demirkapu" → ["Miguel Trindade", "Deniz Demirkapu"]
 *    "Tanner Boser vs Daniel Weichel"          → ["Tanner Boser", "Daniel Weichel"]
 *  Strips everything before the LAST colon (the event prefix), then splits
 *  by "vs" / "v" / "@". Returns null if no "vs" separator is found. */
export function extractFighters(title: string): [string, string] | null {
  // Strip the event prefix — everything up to and including the last colon.
  // "ONE Samurai 4: Haggerty vs. Akimoto" → "Haggerty vs. Akimoto"
  let fightPart = title;
  const colonIdx = title.lastIndexOf(':');
  if (colonIdx !== -1 && colonIdx < title.length - 1) {
    fightPart = title.slice(colonIdx + 1).trim();
  }
  const m = fightPart.match(/^(.+?)\s+(?:vs\.?|v|@)\s+(.+?)(?:\s*[-–—|]\s*|$)/i);
  if (!m) return null;
  const f1 = m[1].trim();
  const f2 = m[2].trim();
  if (!f1 || !f2 || f1.length > 42 || f2.length > 42) return null;
  return [f1, f2];
}

/** Route any image through our /api/img proxy (cache + fallback) */
export function imgProxy(url: string, fallbackText = '', color = 'ffd200'): string {
  const params = new URLSearchParams({ u: url });
  if (fallbackText) params.set('t', fallbackText.slice(0, 40));
  params.set('c', color);
  return `/api/img?${params.toString()}`;
}

/** Logo for a channel, already wrapped in the img proxy (never broken) */
export function channelLogoProxy(name: string, fallbackText?: string): string | null {
  const logo = getChannelLogo(name);
  if (!logo) return null;
  return imgProxy(logo, fallbackText || name);
}

// ─── Cache warming ───────────────────────────────────────────────────────────
// First paint is logo-less while /api/img cold-fetches upstreams one by one.
// Warming the curated set in the background (channel logos + league emblems,
// ~170 fixed URLs) makes every common card instant after a few seconds.

let warmed = false;

export function warmLogoCache(): void {
  if (warmed) return;
  warmed = true;
  // Kick off the ESPN team logos fetch (fire-and-forget). This populates
  // the espnTeamLogos map with ALL NHL/NBA/NFL/college team logos in
  // ~150ms, giving instant logo lookups for those sports without any
  // TheSportsDB API call or enrichment deadline issue.
  void warmEspnTeamLogos();

  const urls = [
    ...Object.values(CHANNEL_LOGOS),
    ...Object.values(LEAGUE_EMBLEMS),
    ...Object.values(CLUB_BADGES),
  ].slice(0, 220);

  const POOL = 12;
  let next = 0;
  const worker = async () => {
    while (next < urls.length) {
      const u = urls[next++];
      try {
        await fetch(`http://localhost:3000/api/img?u=${encodeURIComponent(u)}&t=warm&c=ffd200`, {
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        /* best-effort */
      }
    }
  };
  for (let i = 0; i < POOL; i++) void worker();
}
