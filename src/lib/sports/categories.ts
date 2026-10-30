// ─── Sports taxonomy helpers ─────────────────────────────────────────────────
// Ported + simplified from live-sport-plugin's category normalizer.

export function decodeEntities(str: string): string {
  if (!str) return '';
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;|&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, c) => String.fromCharCode(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .trim();
}

export function stripEmojis(str: string): string {
  return str
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "League : Team1 vs Team2" → { league, title } */
export function splitLeague(raw: string): { league: string; title: string } {
  const idx = raw.indexOf(' : ');
  if (idx !== -1) {
    return { league: raw.slice(0, idx).trim(), title: raw.slice(idx + 3).trim() };
  }
  return { league: '', title: raw };
}

/** DaddyLive "Event PPV / Event Stream" dummy channels — never playable */
export function isEventStream(name: string | undefined | null): boolean {
  if (!name) return false;
  return /^event\s*[-_]?\s*(sd\s*[-_]?\s*)?stream/i.test(name) || /\bevent\s*(sd\s*)?stream\b/i.test(name);
}

/** DaddyLive premium-CDN channel ids that are dead (manifest 404) — a full
 *  scan snapshot (scripts/scan-dead-channels.js → src/data/daddylive-dead.ts)
 *  of the whole 24/7 index, refreshed whenever drift is reported. The CDN's
 *  dead set drifts over time, so this seed is combined with a runtime probe
 *  (probeDaddyLiveChannels, 5-min cache + rolling background refresh) that
 *  resurrects ids on their own. Shared here so the feed ranker can push dead
 *  ids to the back without import cycles.
 *  NOTE: the seed is a TS module, NOT a .json import — JSON modules don't
 *  reliably survive the standalone-server bundle (they resolve to an empty
 *  module, silently disabling the filter). */
import { DEAD_DL_SCAN } from '@/data/daddylive-dead';

// kept: long-dead, known. ⚠ #92 (beIN 2 Arabic) and #1010 (beIN 5 Turkey)
// were removed 2026-10-06 — both resurrected on the CDN but stayed buried
// here, so football matches fell through to broken English feeds. The
// runtime probe now overrides this seed either way; keep it accurate.
const HAND_CURATED_DEAD = ['99', '597', '491', '492'];
export const DEAD_DL_CHANNEL_IDS = new Set<string>([...HAND_CURATED_DEAD, ...DEAD_DL_SCAN]);

interface SportDef {
  id: string;
  name: string;
  /** Match tokens applied via substring against the padded, lowercased
   *  `${cleanCat} ${league} ${title}` string (see normalizeSport — it pads
   *  with a leading & trailing space so a token like ' mma' fires on a
   *  section header that is just "MMA", without falsely matching the bare
   *  'mma' inside "Hammarby" (Swedish football club) or the bare 'pfl'
   *  inside "(PFL)" abbreviations of the Philippines Football League.
   *  Convention: every greedy single-word token carries a leading space so
   *  it only fires as a word boundary; multi-word phrases keep the spaces
   *  they need; tokens that are merely section-headers (like 'ppv', which
   *  DaddyLive uses for premium events of ANY sport) are removed entirely. */
  any: string[];
}

export const SPORT_DEFS: SportDef[] = [
  // ── order matters: specific first, greedy/generic (football) later ──
  // "Handball-Bundesliga" must hit handball before football's 'bundesliga';
  // "Touring Car Championship" must hit motorsport before football's
  // 'championship'; "College Football" must hit american_football before
  // football's bare 'football'.
  { id: 'table_tennis', name: 'Table Tennis', any: ['table tennis', 'ping pong', 'wtt'] },
  { id: 'snooker', name: 'Snooker', any: ['snooker', 'world snooker'] },
  { id: 'darts', name: 'Darts', any: ['darts', 'pdc', 'world darts'] },
  { id: 'volleyball', name: 'Volleyball', any: ['volleyball', 'vnl', 'cev'] },
  { id: 'handball', name: 'Handball', any: ['handball', 'ehf', 'bundesliga handball'] },
  { id: 'esports', name: 'Esports', any: ['esports', 'esport', 'csgo', 'dota', 'lol ', 'league of legends', 'valorant', 'rocket league'] },
  { id: 'cycling', name: 'Cycling', any: ['cycling', 'tour de france', 'giro', 'vuelta', 'uci'] },
  // Golf: 'masters' was DROPPED — bare substring matched "ATP Masters" (tennis) and
  //  mis-filed tennis events into golf (field report 2026-10-17). The other
  //  tokens ('pga'/'lpga'/'ryder cup'/'european tour'/'open championship'/'liv golf')
  //  cover the major golf events; "The Masters" at Augusta still lands in golf
  //  via the DaddyLive section header (cleanCat="Golf" → bare 'golf' fires).
  { id: 'golf', name: 'Golf', any: ['golf', 'pga', 'lpga', 'ryder cup', 'european tour', 'open championship', 'liv golf'] },
  { id: 'rugby', name: 'Rugby', any: ['rugby', 'super rugby', 'six nations', 'nrl', 'rugby league', 'premiership rugby', 'challenge cup', 'top14', 'top 14', 'mitre 10'] },
  // Hockey: every bare 3-4 letter acronym carries a leading space so it fires
  //  as a word boundary. The bare 'del' substring used to FALSE-MATCH
  //  "Wen**del**ken" (tennis player surname) and 'liiga' used to FALSE-MATCH
  //  "Veikka**liiga**" (Finland's top FOOTBALL division — Veikkausliiga),
  //  mis-filing live tennis/football events into the Hockey row (field report
  //  2026-10-17). 'ahl'/'shl'/'khl'/'echl'/'nhl' take the same leading-space
  //  treatment defensively.
  { id: 'hockey', name: 'Hockey', any: ['hockey', ' nhl', 'nhl ', 'ice hockey', ' khl', ' ahl', ' echl', ' del', ' shl', ' liiga', 'chl hockey'] },
  { id: 'tennis', name: 'Tennis', any: ['tennis', 'atp', 'wta', 'grand slam', 'wimbledon', 'us open', 'french open', 'australian open', 'davis cup', 'laver cup'] },
  { id: 'motorsport', name: 'Motorsport', any: ['f1', 'formula 1', 'formula one', 'formula e', 'nascar', 'motogp', 'wrc', 'rally', 'indycar', 'indy car', 'supercars', 'btcc', 'dtm', 'speedway', 'motorsport', 'wsb', 'world superbike'] },
  // Fight-sports tokens carry a leading space (enforced by the pad in
  // normalizeSport) so they fire as word boundaries. The bare 'mma' substring
  // used to false-match "Hammarby" (Sweden, Allsvenskan) and 'pfl' used to
  // false-match "(PFL)" in Philippines Football League listings, mis-filing
  // live football matches into the MMA row. 'ppv' was dropped entirely — it
  // is a DaddyLive section header for premium events of ANY sport (a
  // Champions League PPV game is still football, not MMA).
  //
  // ' glory' was tightened to multi-word 'glory kickboxing' after it kept
  //  false-matching "Perth Glory" (Australian A-League football club) —
  //  the leading-space version ' glory' was not enough because the combined
  //  string contains " perth glory" which still contains " glory". The
  //  multi-word token only fires on the actual Glory Kickboxing MMA brand
  //  (field report 2026-10-17: "mma opens football").
  { id: 'mma', name: 'Fight Sports', any: [' ufc', ' mma', ' boxing', ' wwe', ' wrestling', ' aew', ' bellator', ' pfl', ' fight', ' cage', 'glory kickboxing', ' one championship', ' sumo', ' bareknuckle', ' bare knuckle'] },
  { id: 'baseball', name: 'Baseball', any: ['baseball', 'mlb', 'npb', 'kbo', 'ncaa baseball', 'world series', 'mlb network'] },
  // Basketball tokens likewise carry a leading space so 'nba' / 'nbl' /
  // 'fiba' can't false-fire inside a handball league/team word and pull a
  // handball match into the Basketball row (field report 2026-10-17:
  // "basketball plays handball match").
  { id: 'basketball', name: 'Basketball', any: [' basketball', ' nba', 'ncaa basketball', ' wnba', ' euroleague', ' acb', 'bbl basket', ' fiba', ' gleague', 'g league', ' nbl'] },
  // Cricket: every bare 3-char acronym carries a leading space so it fires
  //  as a word boundary. The bare 'odi' substring used to FALSE-MATCH
  //  "voj**vodina**" (ŽFK Vojvodina, Serbian Women's Super League — football),
  //  and 'ipl' used to FALSE-MATCH "Mul**ipl**e" or similar generic words,
  //  mis-filing football events into the Cricket row (field report
  //  2026-10-17). 't20'/'bbl'/'cpl'/'psl' take the same leading-space treatment
  //  defensively.
  { id: 'cricket', name: 'Cricket', any: ['cricket', ' ipl', ' t20', ' odi', 'test match', 'big bash', ' bbl', ' cpl', 'the hundred', ' psl', 'sheffield shield', 'vitality'] },
  { id: 'american_football', name: 'Am. Football', any: ['nfl', 'american football', 'ncaa football', 'cfl', 'ufl', 'super bowl', 'college football'] },
  { id: 'football', name: 'Football', any: ['soccer', 'football', 'futbol', 'fútbol', 'mls', 'premier league', 'la liga', 'serie a', 'bundesliga', 'ligue 1', 'league one', 'league two', 'national league', ' - championship', 'fa cup', 'carabao', 'uefa', 'champions league', 'europa', 'nwsl', 'usl', 'copa', 'world cup', 'fifa', 'afcon', 'eredivisie', 'mls soccer', 'ekstraklasa', 'allsvenskan', 'chinese super'] },
  { id: 'college', name: 'College', any: ['college', 'ncaa', 'ncaaf', 'ncaab', 'university', 'varsity'] },
];

export function normalizeSport(hay: string): string {
  // Pad the lowercased input with a leading & trailing space so leading-space
  // tokens like ' mma' / ' wrestling' fire reliably on a section header that
  // IS the sport word (e.g. "MMA" alone, "Wrestling" alone). Without the pad,
  // ' mma' would miss "MMA UFC 265" (no leading space at index 0) and the
  // fallback bare 'mma' substring would FALSE-MATCH "Hammarby" (Swedish
  // football club) — mis-filing live football matches into the MMA row
  // (field report 2026-10-17). The pad is harmless for plain substrings and
  // multi-word phrases like 'bundesliga handball' or 'g league'.
  const h = ` ${hay.toLowerCase()} `;
  for (const s of SPORT_DEFS) {
    if (s.any.some((k) => h.includes(k))) return s.id;
  }
  return 'other';
}

export function sportName(id: string): string {
  if (id === 'other') return 'More Sports';
  return SPORT_DEFS.find((s) => s.id === id)?.name ?? id;
}

// ─── Reserve / youth / development-league detection ─────────────────────────
// Field report 2026-10-30: "how man utd meets monaco in premier league that is
// really shit" — the fixture was REAL but it was Premier League 2, the U21
// reserve competition (DaddyLive lists it on MUTV): the headline-rail test
// matched /premier league/i as a substring, and the card's CSS truncation cut
// exactly the "2", so an academy fixture was billed with first-team crests as
// a Premier League match. Development variants of the big names never carry
// headline weight, and their tier must never be the truncated part of a label.
export const MINOR_LEAGUE_RE =
  /premier league 2|premier league international|la liga 2|hypermot|smartbank|2\.?\s*bundesliga|bundesliga 2|\bliga [23]\b|under-?\d+|\bu1[6-9]\b|\bu2[0-3]\b|\bsub-?\d+\b|youth|academy|reserve|\bg league\b|femen|women/i;

/** Is this a development / reserve / youth competition? (drives the
 *  "U21/Reserve" chip on match cards + exclusion from headline rails) */
export function isMinorLeague(league: string): boolean {
  return MINOR_LEAGUE_RE.test(league);
}

// ─── Youth / reserve / academy competitions — out of the fixture lists ──────
// Field report 2026-10-31: "there is no Premier League 2 — that match is fake
// as well". The "Man United vs Monaco" fixture is REAL, but it is the U21
// Premier League International Cup (MUTV, Leigh Sports Village, 2026-10-30) —
// DaddyLive bills it "England - Premier League 2", so the app presented an
// academy cup with first-team crests and an impossible Premier League
// billing. Users correctly read these as fake fixtures, so development
// competitions no longer reach the user-facing fixture lists (schedule
// arrays + search) at all — the event stays playable from its channel's own
// EPG, where it belongs.
// ⚠ NARROWER than MINOR_LEAGUE_RE on purpose: professional second tiers
// (2. Bundesliga, Ligue 2, LaLiga Hypermotion…) are real leagues with real
// fixtures and STAY; so do women's competitions. Only the academy /
// reserve / youth class is removed.
export const YOUTH_LEAGUE_RE =
  /premier league 2|premier league international|professional development|under-?\d+|\bu1[6-9]\b|\bu2[0-3]\b|\bsub-?\d+\b|youth|academy|reserve|development squad/i;

/** Is this an academy / reserve / youth competition? (excluded from the
 *  user-facing fixture lists — they read as fake first-team fixtures) */
export function isYouthLeague(league: string): boolean {
  return YOUTH_LEAGUE_RE.test(league);
}

/** Compact league label for card headers. Long names are shortened by
 *  dropping the COUNTRY prefix ("England - Premier League 2" →
 *  "Premier League 2") — never the league name itself, because the tier
 *  digit is the difference between a first-team fixture and a reserve one
 *  and must never be the part CSS truncation eats. */
export function leagueDisplayName(league: string): string {
  if (league.length <= 22) return league;
  const parts = league.split(' - ');
  if (parts.length > 1) {
    const tail = parts[parts.length - 1].trim();
    if (tail && tail.length >= 6) return tail;
  }
  return league;
}
