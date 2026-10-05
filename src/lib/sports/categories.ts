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
  { id: 'golf', name: 'Golf', any: ['golf', 'pga', 'lpga', 'ryder cup', 'european tour', 'masters', 'open championship', 'liv golf'] },
  { id: 'rugby', name: 'Rugby', any: ['rugby', 'super rugby', 'six nations', 'nrl', 'rugby league', 'premiership rugby', 'challenge cup', 'top14', 'top 14', 'mitre 10'] },
  { id: 'hockey', name: 'Hockey', any: ['hockey', 'nhl', 'nhl ', 'ice hockey', 'khl', 'ahl', 'echl', 'del', 'shl', 'liiga', 'chl hockey'] },
  { id: 'tennis', name: 'Tennis', any: ['tennis', 'atp', 'wta', 'grand slam', 'wimbledon', 'us open', 'french open', 'australian open', 'davis cup', 'laver cup'] },
  { id: 'motorsport', name: 'Motorsport', any: ['f1', 'formula 1', 'formula one', 'formula e', 'nascar', 'motogp', 'wrc', 'rally', 'indycar', 'indy car', 'supercars', 'btcc', 'dtm', 'speedway', 'motorsport', 'wsb', 'world superbike'] },
  { id: 'mma', name: 'Fight Sports', any: ['ufc', 'mma', 'boxing', 'wwe', ' wrestling', 'aew', 'bellator', 'pfl', 'fight', 'ppv', 'cage', 'glory', 'one championship', 'sumo', 'bareknuckle', 'bare knuckle'] },
  { id: 'baseball', name: 'Baseball', any: ['baseball', 'mlb', 'npb', 'kbo', 'ncaa baseball', 'world series', 'mlb network'] },
  { id: 'basketball', name: 'Basketball', any: ['basketball', 'nba', 'ncaa basketball', 'wnba', 'euroleague', 'acb', 'bbl basket', 'fiba', 'gleague', 'g league', 'nbl'] },
  { id: 'cricket', name: 'Cricket', any: ['cricket', 'ipl', 't20', 'odi', 'test match', 'big bash', 'bbl', 'cpl', 'the hundred', 'psl', 'sheffield shield', 'vitality'] },
  { id: 'american_football', name: 'Am. Football', any: ['nfl', 'american football', 'ncaa football', 'cfl', 'ufl', 'super bowl', 'college football'] },
  { id: 'football', name: 'Football', any: ['soccer', 'football', 'futbol', 'fútbol', 'mls', 'premier league', 'la liga', 'serie a', 'bundesliga', 'ligue 1', 'league one', 'league two', 'national league', ' - championship', 'fa cup', 'carabao', 'uefa', 'champions league', 'europa', 'nwsl', 'usl', 'copa', 'world cup', 'fifa', 'afcon', 'eredivisie', 'mls soccer', 'ekstraklasa', 'allsvenskan', 'chinese super'] },
  { id: 'college', name: 'College', any: ['college', 'ncaa', 'ncaaf', 'ncaab', 'university', 'varsity'] },
];

export function normalizeSport(hay: string): string {
  const h = hay.toLowerCase();
  for (const s of SPORT_DEFS) {
    if (s.any.some((k) => h.includes(k))) return s.id;
  }
  return 'other';
}

export function sportName(id: string): string {
  if (id === 'other') return 'More Sports';
  return SPORT_DEFS.find((s) => s.id === id)?.name ?? id;
}
