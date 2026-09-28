// ─── Event feed ranking (the "football match opened F1" fix) ──────────────────
// DaddyLive schedule events list *network* channels (24/7 feeds like
// "Sky Sports Main Event"), and the same network id can appear under many
// simultaneous events of different sports. When a football match lists a
// network that is currently airing F1, clicking it plays F1.
//
// This module ranks every event's feeds so the FIRST feed (the "▶ Watch"
// button) is the one most likely to actually carry the event:
//   • dedicated-sport mismatch  → heavy penalty (Sky Sports F1 on a football
//     match is never the right feed)
//   • shared with LIVE events of other categories → strong penalty (the
//     network is airing something else RIGHT NOW)
//   • shared with live events of the SAME category → boost (dedicated feed)
//   • channel name matches the league's country/brand → boost
//     ("Match Premier Russia" for Russia FNL, "DAZN1 Spain" for Spain)
//   • generic "Feed N" entries → boost (per-event dedicated feeds)

import type { SportsMatch, SportsChannelRef } from '../types';
import { DEAD_DL_CHANNEL_IDS } from './categories';

/** dedicated-sport networks — a channel whose name matches one of these is
 *  almost certainly airing that sport, not the event it happens to be listed on */
const SPORT_HINTS: Array<[RegExp, string]> = [
  [/\bf1\b|formula\s*(1|one)|moto\s*gp|motogp|moto2|moto3|nascar|worldsbk|wsbk|\bwrc\b|indycar|superbike|speed\s*channel/i, 'motorsport'],
  [/\bnba\b|nbatv|basketball\s*tv|\bnbl\b/i, 'basketball'],
  [/nfl\s*network|red\s*zone|redzone|nfl\s*sunday/i, 'american_football'],
  [/tennis\s*channel/i, 'tennis'],
  [/golf\s*channel/i, 'golf'],
  [/willow.*(cricket|hd)?|cricket/i, 'cricket'],
  [/mlb\s*network/i, 'baseball'],
  [/ufc|fight\s*network|boxing|top\s*rank/i, 'mma'],
  [/rugby\s*pass/i, 'rugby'],
  [/cycling\s*channel/i, 'cycling'],
];

function channelSportHint(name: string): string | null {
  for (const [re, sport] of SPORT_HINTS) {
    if (re.test(name)) return sport;
  }
  return null;
}

/** generic words that carry no league signal */
const STOPWORDS = new Set([
  'league', 'division', 'cup', 'football', 'soccer', 'futbol', 'liga', 'serie',
  'premier', 'championship', 'season', 'playoff', 'qualifiers', 'football2',
  'super', 'primera', 'segunda', 'national', 'regionalliga', 'oberliga',
  'champions', 'europa', 'conference', 'friendlies', 'international', 'world',
  'femenina', 'women', 'womens', 'men', 'mens', 'youth', 'u18', 'u19', 'u20',
  'u21', 'u23', 'reserve', 'club', 'series', 'tour', 'open', 'masters',
]);

/** meaningful tokens from a league name ("Russia - FNL" → ["russia", "fnl"]) */
function leagueTokens(league: string): string[] {
  return league
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/[\s-]+/)
    .filter((t) => t.length >= 4 && !STOPWORDS.has(t));
}

interface ChannelStats {
  /** category → { live, upcoming } usage counts across the schedule */
  cats: Map<string, { live: number; up: number }>;
  /** league → usage count (channels carrying several events of the SAME
   *  league are league-dedicated networks, e.g. "Match Premier Russia") */
  leagues: Map<string, number>;
}

function buildStats(matches: SportsMatch[]): Map<string, ChannelStats> {
  const stats = new Map<string, ChannelStats>();
  for (const m of matches) {
    for (const c of m.channels) {
      let s = stats.get(c.id);
      if (!s) {
        s = { cats: new Map(), leagues: new Map() };
        stats.set(c.id, s);
      }
      const cat = s.cats.get(m.category) || { live: 0, up: 0 };
      if (m.status === 'live') cat.live++;
      else cat.up++;
      s.cats.set(m.category, cat);
      if (m.league) s.leagues.set(m.league, (s.leagues.get(m.league) || 0) + 1);
    }
  }
  return stats;
}

function scoreChannel(m: SportsMatch, ch: SportsChannelRef, stats?: ChannelStats): number {
  let score = 0;

  // 1. dedicated-sport mismatch — Sky Sports F1 listed on a football match
  const hint = channelSportHint(ch.name);
  if (hint && hint !== m.category) score -= 100;

  if (stats) {
    let otherLive = 0;
    let otherUp = 0;
    let sameLive = 0;
    for (const [cat, { live, up }] of stats.cats) {
      if (cat === m.category) {
        sameLive += live;
      } else {
        otherLive += live;
        otherUp += up;
      }
    }
    // 2. the network is airing another sport's event RIGHT NOW
    if (m.status === 'live') score -= Math.min(105, otherLive * 35);
    // 3. reserved for another sport later — mild penalty
    score -= Math.min(30, otherUp * 6);
    // 4. carries several events of our own sport → dedicated-ish feed
    const sameOthers = sameLive - (m.status === 'live' ? 1 : 0);
    score += Math.min(24, Math.max(0, sameOthers) * 8);
    // 4b. carries several events of our exact LEAGUE → league-dedicated
    //     network ("Match Premier Russia" for Russia FNL) — the strongest
    //     signal that clicking it shows our sport
    const sameLeagueOthers = (stats.leagues.get(m.league) || 1) - 1;
    score += Math.min(60, Math.max(0, sameLeagueOthers) * 30);
  }

  // 5. name matches the league (country/brand tokens)
  const tokens = leagueTokens(m.league);
  const lname = ch.name.toLowerCase();
  if (tokens.some((t) => lname.includes(t))) score += 40;

  // 6. generic per-event feed names ("Feed 1", "Stream 2")
  if (/^\s*(feed|stream|source|link)\s*\d*\s*$/i.test(ch.name)) score += 25;

  // 7. beIN Sports ARABIC / MENA networks on football events — the dedicated
  //    football broadcasters of the MENA region (and the user's preference:
  //    football should stream from the beIN Arabic feeds). They list hundreds
  //    of fixtures per day and never preempt with other sports, so they beat
  //    every generic network. MENA *English* variants get a smaller edge.
  if (m.category === 'football' && /be\s?in/i.test(ch.name)) {
    if (/mena\s*\d|arabic/i.test(ch.name)) score += 80;
    else if (/mena\s*english/i.test(ch.name)) score += 30;
  }

  // 8. statically-known-dead CDN channels sink to the very back — clicking
  //    the primary Watch feed must never open a channel whose manifest has
  //    been 404 for days (e.g. beIN Sports MENA 2 on "Germany vs Greece")
  if (DEAD_DL_CHANNEL_IDS.has(ch.id)) score -= 1000;

  return score;
}

/** Rank each event's channels so the primary Watch feed is the best bet.
 *  Stable — equally-scored feeds keep their upstream order. */
export function rankScheduleFeeds(matches: SportsMatch[]): SportsMatch[] {
  const stats = buildStats(matches);
  let anyChange = false;
  const out = matches.map((m) => {
    if (m.channels.length < 2) return m;
    const scored = m.channels.map((c, idx) => ({ c, idx, score: scoreChannel(m, c, stats.get(c.id)) }));
    scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
    if (scored.some((s, i) => s.idx !== i)) anyChange = true;
    return { ...m, channels: scored.map((s) => s.c) };
  });
  return anyChange ? out : matches;
}
