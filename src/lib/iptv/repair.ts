// ─── Channel name repair ─────────────────────────────────────────────────────
// Some IPTV-Scraper-Zilla playlists obfuscate display names (FSTV24 uses
// "Ori2Usacbssport", "Ori21Cdn Ukskysportaction" ...). The obfuscation layers
// are: "Ori" + digits + optional markers (Cdn / Usa / Uk / Sv2 / Ion) glued
// onto the real name. We strip those, then rebuild a readable name from the
// remainder, the stream-URL slug, or the tvg-logo filename.

// Known channel words used to recognise and split concatenated slugs
const TOKEN_MAP: Array<[RegExp, string]> = [
  [/^usanetwork$/i, 'USA Network'],
  [/^cbssportsnetwork$/i, 'CBS Sports Network'],
  [/^cbssport(s)?$/i, 'CBS Sports'],
  [/^cbssportsgolazo(network)?$/i, 'CBS Sports Golazo Network'],
  [/^secnetwork$/i, 'SEC Network'],
  [/^espndeportes$/i, 'ESPN Deportes'],
  [/^espnnews$/i, 'ESPNews'],
  [/^espnu$/i, 'ESPNU'],
  [/^espn\d?$/i, 'ESPN'],
  [/^uespn$/i, 'U ESPN'],
  [/^fs1$/i, 'FS1'],
  [/^fs2$/i, 'FS2'],
  [/^mlbnetwork$/i, 'MLB Network'],
  [/^nflnetwork$/i, 'NFL Network'],
  [/^nbanetwork$/i, 'NBA TV'],
  [/^redzone$/i, 'NFL RedZone'],
  [/^nfl$/i, 'NFL'],
  [/^nba$/i, 'NBA'],
  [/^mlb$/i, 'MLB'],
  [/^nhl$/i, 'NHL'],
  [/^ufc$/i, 'UFC'],
  [/^wwe$/i, 'WWE'],
  [/^golf$/i, 'Golf Channel'],
  [/^tennistv\d?$/i, 'Tennis Channel'],
  [/^cbslosangeles$/i, 'CBS Los Angeles'],
  [/^msnbc$/i, 'MSNBC'],
  [/^msn$/i, 'MSN'],
  [/^cnbcworld$/i, 'CNBC World'],
  [/^cnbc$/i, 'CNBC'],
  [/^nbc$/i, 'NBC'],
  [/^abc$/i, 'ABC'],
  [/^fox$/i, 'FOX'],
  [/^pbs$/i, 'PBS'],
  [/^cw$/i, 'The CW'],
  [/^unirso$/i, 'Universo'],
  [/^universo$/i, 'Universo'],
  [/^mutv$/i, 'MUTV'],
  [/^lfctv$/i, 'LFC TV'],
  [/^laligatv$/i, 'LaLiga TV'],
  [/^laliga$/i, 'LaLiga TV'],
  [/^premiersport(\d)$/i, 'Premier Sports $1'],
  [/^tntsport(\d)$/i, 'TNT Sports $1'],
  [/^btsport(\d)$/i, 'BT Sport $1'],
  [/^eurosport(\d)$/i, 'Eurosport $1'],
  [/^eplsky(\w+)$/i, 'Sky Sports $1'],
  [/^skysports?(\d)$/i, 'Sky Sports $1'],
  [/^skysportpremierleague$/i, 'Sky Sports Premier League'],
  [/^skysportfootball$/i, 'Sky Sports Football'],
  [/^skysport(.+)$/i, 'Sky Sports $1'],
  [/^skyplus$/i, 'Sky Sports Plus'],
  [/^skynews$/i, 'Sky News'],
  [/^mainent$/i, 'Sky Sports Main Event'],
  [/^premierleague$/i, 'Premier League'],
  [/^football$/i, 'Football'],
  [/^cricket$/i, 'Cricket'],
  [/^racingtv$/i, 'Racing TV'],
  [/^racing$/i, 'Racing'],
  [/^tennis$/i, 'Tennis'],
  [/^golf$/i, 'Golf'],
  [/^mix$/i, 'Mix'],
  [/^action$/i, 'Action'],
  [/^arena$/i, 'Arena'],
  [/^news$/i, 'News'],
  [/^network$/i, 'Network'],
  [/^fubosport(s)?$/i, 'Fubo Sports'],
  [/^foxsoccerplus$/i, 'Fox Soccer Plus'],
  [/^tycsport(s)?$/i, 'TYC Sports'],
  [/^itv(\d)$/i, 'ITV $1'],
  [/^beinsport(s)?(xtra|hd|espanol|es)$/i, 'beIN Sports'],
  [/^beinsport(s)?$/i, 'beIN Sports'],
  [/^bein$/i, 'beIN Sports'],
  [/^willow$/i, 'Willow Cricket'],
  [/^dazn$/i, 'DAZN'],
  [/^ion$/i, 'ION'],
  [/^viaplayxtra$/i, 'Viaplay Xtra'],
  [/^pre22$/i, 'CBS Sports Golazo'],
  [/^tsn(\d)?$/i, 'TSN $1'],
  [/^tsn$/i, 'TSN'],
  [/^hbo(\d)?$/i, 'HBO $1'],
  [/^bbc(one|two|three|four|news|sport)$/i, 'BBC $1'],
  [/^fightnetwork$/i, 'Fight Network'],
  [/^nbatv$/i, 'NBA TV'],
  [/^nhlnetwork$/i, 'NHL Network'],
  [/^wnetwork$/i, 'W Network'],
  [/^accnetwork$/i, 'ACC Network'],
  [/^wnn$/i, 'W Network'],
  [/^wfn$/i, 'World Fishing Network'],
  [/^tudn$/i, 'TUDN'],
  [/^unimas$/i, 'Unimás'],
  [/^trutv$/i, 'truTV'],
  [/^fanduel(\s?tv)?$/i, 'FanDuel TV'],
  [/^gol$/i, 'Gol TV'],
  [/^goltv$/i, 'Gol TV'],
  [/^deskyde(.*)$/i, 'Sky $1'],
  [/^skyde(.*)$/i, 'Sky $1'],
  [/^ptsporttv(\d)$/i, 'Sport TV $1'],
  [/^ptbenfica$/i, 'Benfica TV'],
  [/^debundesliga(\d?)[a-z]*$/i, 'Bundesliga $1'],
  [/^bundesliga(\d)?$/i, 'Bundesliga $1'],
  [/^zentcinemax$/i, 'Cinemax'],
  [/^zentdiscory$/i, 'Discovery Channel'],
  [/^bignetwork$/i, 'BIG Network'],
  [/^marquee?sportnetwork$/i, 'Marquee Sports Network'],
  [/^yes$/i, 'YES Network'],
  [/^dazn(\d)?$/i, 'DAZN $1'],
  [/^cnn$/i, 'CNN'],
  [/^foxnews$/i, 'Fox News'],
  [/^telemundo$/i, 'Telemundo'],
  [/^tnt$/i, 'TNT'],
  [/^tbs$/i, 'TBS'],
  [/^aand[e]$/i, 'A&E'],
  [/^ae$/i, 'A&E'],
  [/^fx$/i, 'FX'],
  [/^amc$/i, 'AMC'],
  [/^btsport(\d)$/i, 'BT Sport $1'],
];

const TITLE_ACRONYMS = new Set([
  'ESPN', 'ESPN2', 'ESPN3', 'ESPNU', 'ESPNEWS', 'NFL', 'NBA', 'MLB', 'NHL', 'UFC', 'WWE',
  'FS1', 'FS2', 'CBS', 'NBC', 'ABC', 'FOX', 'PBS', 'CW', 'MSNBC', 'CNBC', 'HBO', 'CNN',
  'BBC', 'ITV', 'MTV', 'VH1', 'TNT', 'TBS', 'AMC', 'FX', 'FXX', 'USA', 'UK', 'TV', 'HD',
  'MUTV', 'DAZN', 'UTV', 'RT', 'OSN', 'SEC', 'ACC', 'PAC', 'AEW', 'KBS', 'MBC', 'SBS',
  'EBS', 'NHK', 'TX', 'CX', 'EX', 'MX', 'CBC', 'IBC', 'TV5', 'ARTE', 'RAI', 'SET', 'ZEE',
  'LFC', 'TYC', 'MSN', 'ION', 'UEFA', 'FIFA', 'T20', 'PSL', 'IPL',
]);

function titleCase(word: string): string {
  const up = word.toUpperCase();
  if (TITLE_ACRONYMS.has(up)) return up;
  if (word.length <= 2 && word === word.toLowerCase()) return up;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** Does this name look obfuscated/garbage? (used on ORIGINAL playlist names) */
export function isObfuscatedName(name: string): boolean {
  if (!name) return true;
  const n = name.trim();
  // Ori2 / Ori21 / Ori22 prefixes used by FSTV24
  if (/^ori\d/i.test(n)) return true;
  // concatenated words without any space but > 12 chars and case shifts
  if (!/\s/.test(n) && n.length > 12 && /[a-z][A-Z]/.test(n)) return true;
  // single-glued-token with (almost) no vowels — base64-ish garbage
  if (!/\s/.test(n)) {
    const letters = n.replace(/[^a-zA-Z]/g, '');
    if (letters.length > 10) {
      const vowels = (letters.match(/[aeiouAEIOU]/g) || []).length;
      if (vowels <= 1) return true;
    }
  }
  // hex-like or random-char strings
  if (/^[a-f0-9]{16,}$/i.test(n)) return true;
  return false;
}

/** Is a REPAIRED name readable enough to show? (acronym-friendly) */
function looksReadable(s: string | null): s is string {
  if (!s || s.length < 2) return false;
  if (/^ori\d/i.test(s)) return false;
  const letters = s.replace(/[^a-zA-Z]/g, '');
  if (!letters) return false;
  const words = s.trim().split(/\s+/).filter(Boolean).length;
  if (words >= 2) return true;
  const vowels = (letters.match(/[aeiouAEIOU]/g) || []).length;
  return vowels >= 1 || s.length <= 4;
}

/** Strip the obfuscation markers from the original display name. */
function stripMarkers(name: string): string | null {
  let n = name.trim();
  n = n.replace(/^ori\d+\s*/i, '');
  // remove standalone marker words anywhere (space-delimited → safe)
  n = n
    .replace(/\b(cdn|sv\d+|de|pt|eu|lat|ion|usa|uk|us|ca|au)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // remove ONE glued prefix group at the start: markers (cdn/svN) around a
  // single country prefix (usa/uk/us) — combined so it can never double-strip
  n = n
    .replace(/^(cdn|sv\d+)*(usa|uk|us)(cdn|sv\d+)*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!n || n.length < 2) return null;
  return n;
}

/** Extract a slug from the stream URL: https://host/usa-cbssport.m3u8 → "cbssport" */
function slugFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    let base = u.pathname.split('/').pop() || '';
    base = base.replace(/\.(m3u8|ts|mp4)$/i, '');
    base = base.replace(/^(usa|us|uk|ca|au|in|eu)[_-]/i, '');
    if (!base || base.length < 2 || /^\d+$/.test(base)) return null;
    return base;
  } catch {
    return null;
  }
}

/** Extract words from a logo filename: CBS_Sports_Network_2016.png → "CBS Sports Network" */
function wordsFromLogoUrl(logo: string): string | null {
  try {
    const u = new URL(logo);
    let base = decodeURIComponent(u.pathname.split('/').pop() || '');
    base = base.replace(/\.(png|svg|jpe?g|webp)$/i, '');
    base = base.replace(/^\d+px-/, '');
    base = base
      .replace(/[_-]?\d{4}$/, '')
      .replace(/[_-]?(logo|icon|badge)$/i, '')
      .replace(/-sv\d+$/i, '')
      .replace(/[_-]?\d+x\d+$/i, '')
      .replace(/[_-]?(hd|4k|fhd|uhd)$/i, '');
    if (!base || base.length < 3) return null;
    if (/^(image|images?|photo|logo|icon|untitled|img|channel|stream)\d*$/i.test(base)) return null;
    if (/^\d[\d-]*$/.test(base)) return null;
    return base;
  } catch {
    return null;
  }
}

/** Pretty-print a slug: "skysportgolf" → "Sky Sports Golf" via token map.
 *  Second return element = trusted (came from the curated token table). */
function prettySlug(slug: string): { text: string; trusted: boolean } | null {
  const s = slug.toLowerCase().replace(/[^a-z0-9]+/g, '');
  // direct token map first (map is ordered specific-first)
  for (const [re, label] of TOKEN_MAP) {
    const m = s.match(re);
    if (m) {
      let out = label;
      if (m[1]) out = out.replace('$1', titleCase(m[1]));
      return { text: out.replace(/\s+/g, ' ').trim(), trusted: true };
    }
  }
  // split camelCase and separators
  const parts = slug
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[-_.\s]+/)
    .filter(Boolean);
  if (!parts.length) return null;
  const pretty = parts.map((p) => {
    const pp = p.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const [re, label] of TOKEN_MAP) {
      const m = pp.match(re);
      if (m) {
        let out = label;
        if (m[1]) out = out.replace('$1', titleCase(m[1]));
        return out;
      }
    }
    return titleCase(p);
  }).join(' ');
  if (pretty.length < 3) return null;
  return { text: pretty, trusted: false };
}

/**
 * Repair an obfuscated channel name:
 *   1. strip obfuscation markers from the original name (keeps multi-word names)
 *   2. rebuild from the stream-URL slug
 *   3. rebuild from the tvg-logo filename
 * Returns null when nothing sensible can be built.
 */
export function repairChannelName(name: string, url: string, logo?: string): string | null {
  // 1. marker-strip the original (best for multi-word names)
  const stripped = stripMarkers(name);
  if (stripped) {
    const p = prettySlug(stripped);
    if (p && (p.trusted || looksReadable(p.text))) return p.text;
    if (looksReadable(stripped) && stripped.length >= 3 && !isObfuscatedName(stripped)) {
      // already readable after stripping — just title case each word
      return stripped.split(/\s+/).map(titleCase).join(' ');
    }
  }
  // 2. URL slug
  const urlSlug = slugFromUrl(url);
  if (urlSlug) {
    const p = prettySlug(urlSlug);
    if (p && (p.trusted || looksReadable(p.text))) return p.text;
  }
  // 3. logo filename words
  if (logo) {
    const lw = wordsFromLogoUrl(logo);
    if (lw) {
      const p = prettySlug(lw);
      const text = p ? p.text : lw.replace(/[_-]+/g, ' ');
      if (text && looksReadable(text) && !isObfuscatedName(text)) {
        return text.replace(/\s+/g, ' ').trim();
      }
    }
  }
  return null;
}
