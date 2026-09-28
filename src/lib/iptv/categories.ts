// ─── Category normalization for the OTHERS tab ───────────────────────────────
// IPTV-Scraper-Zilla playlists carry wildly different group-title vocabularies
// across 20+ sources (English, German, French, Italian ...). We fold them into
// a single Pluto-style pill list.

export interface CategoryDef {
  id: string;
  name: string;
  emoji?: string;
}

/** Pill order in the OTHERS tab */
export const CATEGORY_DEFS: CategoryDef[] = [
  { id: 'all', name: 'All', emoji: '📺' },
  { id: 'movies', name: 'Movies', emoji: '🎬' },
  { id: 'series', name: 'Series & Shows', emoji: '🍿' },
  { id: 'entertainment', name: 'Entertainment', emoji: '✨' },
  { id: 'news', name: 'News', emoji: '📰' },
  { id: 'kids', name: 'Kids', emoji: '🧸' },
  { id: 'documentary', name: 'Documentary', emoji: '🌍' },
  { id: 'music', name: 'Music', emoji: '🎵' },
  { id: 'comedy', name: 'Comedy', emoji: '😂' },
  { id: 'sports', name: 'Sports', emoji: '⚽' },
  { id: 'anime', name: 'Anime', emoji: '🕹️' },
  { id: 'lifestyle', name: 'Lifestyle', emoji: '🌿' },
  { id: 'world', name: 'World', emoji: '🌐' },
];

export function categoryName(id: string): string {
  return CATEGORY_DEFS.find((c) => c.id === id)?.name ?? id;
}

interface Rule {
  cat: string;
  /** lowercase substring tests against `${group} ${name}` */
  any: string[];
}

// Ordered — first match wins. Sports rules run LAST inside normalize() so that
// clearly-sporty channels are lifted into the SPORTS tab even from generic
// playlists (Pluto TV Sport, DAZN, ESPN ...).
const RULES: Rule[] = [
  { cat: 'movies', any: ['movie', 'cinema', 'kino', 'film', 'cine', 'pción', 'pizza night', 'action + drama', 'action & drama'] },
  { cat: 'news', any: ['news', 'nachrichten', 'actualité', 'aktuelles', 'info', 'weather', 'wetter', 'meteo', 'abc news', 'nbc news', 'cbs news'] },
  { cat: 'kids', any: ['kids', 'kid ', 'children', 'bambini', 'kinder', 'enfant', 'cartoon', 'junior', 'boomerang', 'nick', 'disney', 'gabbys', 'paw patrol', 'baby shark', 'peppa'] },
  { cat: 'documentary', any: ['documentar', 'doc ', 'docs', 'doku', 'nature', 'animals', 'animal', 'tiere', 'history', 'histoire', 'science', 'wissen', 'discovery', 'nat geo', 'national geo'] },
  { cat: 'music', any: ['music', 'musica', 'musique', 'musik', 'mtv', 'vevo', 'hits', 'radio', 'karaoke', 'concert'] },
  { cat: 'comedy', any: ['comedy', 'comédie', 'stand-up', 'stand up', 'sitcom', 'funny', 'humor', 'humour'] },
  { cat: 'anime', any: ['anime', 'manga', 'gaming', 'game ', 'esport', 'otaku'] },
  { cat: 'lifestyle', any: ['lifestyle', 'food', 'kitchen', 'cooking', 'cuisine', 'travel', 'home', 'garden', 'fashion', 'beauty', 'diy', 'craft', 'real estate', 'house', 'habitat', 'wellness', 'health', 'fitness'] },
  { cat: 'series', any: ['series', 'shows', 'show', 'drama', 'série', 'serie', 'serien', 'tv classics', 'classic tv', 'reality', 'reality tv', 'big brother', 'police', 'crime', 'thriller', 'mystery', 'western', 'sitcoms'] },
  { cat: 'entertainment', any: ['entertainment', 'general', 'variety', 'variétés', 'quiz', 'game show', 'talk', 'lifestyle', 'lifestyle'] },
];

const SPORTS_RULES: string[] = [
  'sport', 'sports', 'fútbol', 'futbol', 'football', 'soccer', 'calcio', 'basketball', 'basket',
  'nba', 'nfl', 'nhl', 'mlb', 'ncaa', 'ufc', 'mma', 'boxing', 'cricket', 'tennis', 'golf',
  'motor', 'f1', 'formula', 'racing', 'espn', 'dazn', 'bein', 'sky sport', 'eurosport',
  'willow', 'nfl network', 'nbatv', 'mlb network', 'fox sport', 'fs1', 'fs2', 'ten sport',
  'sportscraft', 'stadium', 'goal', 'kick', 'pitch', 'fight', 'wrestling', 'wwe', 'aeq',
  'pixelsport', 'redbull tv', 'outside tv', 'ginx', 'fite', 'impact', 'nxt', 'rohd',
];

/** Country / language buckets for the World pill */
const WORLD_RULES: string[] = [
  'bangla', 'bangladesh', 'india', 'indian', 'hindi', 'tamil', 'telugu', 'malayalam', 'kannada',
  'pakistan', 'arab', 'arabic', 'persian', 'iran', 'farsi', 'japan', 'japanese', 'nhk', 'nippon',
  'korea', 'china', 'chinese', 'cctv', 'cgtn', 'africa', 'nigeria', 'ethiopia', 'philippines',
  'latin', 'español', 'espanol', 'hispan', 'francia', 'france', 'français', 'francais', 'deutsch',
  'german', 'italia', 'italian', 'russia', 'russian', 'turkey', 'turkish', 'vietnamese', 'thai',
];

export interface NormalizeInput {
  group: string;
  name: string;
  source: string;
  url: string;
}

/**
 * Fold a channel into one normalized category.
 * `isSportsPlaylist` forces the sports bucket for curated sports playlists.
 */
export function normalizeCategory(input: NormalizeInput, forceCategory?: string): string {
  if (forceCategory === 'sports') return 'sports';

  const hay = `${input.group} ${input.name}`.toLowerCase();

  if (forceCategory) {
    // Playlists without metadata still get keyword refinement
    for (const r of RULES) {
      if (r.any.some((k) => hay.includes(k))) return r.cat;
    }
    return forceCategory;
  }

  for (const r of RULES) {
    if (r.any.some((k) => hay.includes(k))) {
      // Sports check takes precedence even for rule-matched channels:
      // "Sky Sports News" must land in sports, not news.
      if (SPORTS_RULES.some((k) => hay.includes(k))) return 'sports';
      return r.cat;
    }
  }
  if (SPORTS_RULES.some((k) => hay.includes(k))) return 'sports';
  if (WORLD_RULES.some((k) => hay.includes(k))) return 'world';
  return 'entertainment';
}
