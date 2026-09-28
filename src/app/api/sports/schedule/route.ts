import { NextResponse } from 'next/server';
import { getSchedule } from '@/lib/sports/daddylive';
import { sportName } from '@/lib/sports/categories';
import { extractTeamsFromTitle, findTeamLogo, getLeagueLogo, getChannelLogo } from '@/lib/media/logos';
import { getBigLeagueFixtures, getNFLFixtures, fixtureKey, peekFixtures, warmBigLeagues, type BigFixture } from '@/lib/sports/bigleagues';
import type { SportsMatch } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** Enriched match with artwork (same technique as the original repo's
 *  catalog.js: team crests from TheSportsDB/seed, league emblems from the
 *  curated ESPN CDN map, broadcaster logos from the tv-logos CDN map). */
export interface EnrichedMatch extends SportsMatch {
  team1?: string;
  team2?: string;
  team1Logo?: string;
  team2Logo?: string;
  leagueLogo?: string;
  channelLogo?: string;
}

/** enrichment cache keyed by match id — survives across requests */
const enrichCache = new Map<string, EnrichedMatch>();

/** Clean invisible Unicode tag characters (flag-emoji composition bits
 *  like 󠁧󠁢󠁥󠁮󠁧󠁿 that render as garbage boxes) from schedule strings. */
function cleanText(s: string | undefined | null): string {
  if (!s) return '';
  return s
    // tag characters & variation selectors (invisible flag-emoji internals)
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    // zero-width joiners / non-joiners / BOM
    .replace(/[\u{200B}-\u{200D}\uFEFF]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function enrich(m: SportsMatch): Promise<EnrichedMatch> {
  const hit = enrichCache.get(m.id);
  if (hit && hit.channels.length === m.channels.length) return hit;

  const e: EnrichedMatch = { ...m, title: cleanText(m.title), league: cleanText(m.league) };
  const teams = extractTeamsFromTitle(e.title);
  if (teams) {
    e.team1 = cleanText(teams[0]);
    e.team2 = cleanText(teams[1]);
    const [l1, l2] = await Promise.all([findTeamLogo(teams[0]), findTeamLogo(teams[1])]);
    if (l1) e.team1Logo = l1;
    if (l2) e.team2Logo = l2;
  }
  const leagueLogo = getLeagueLogo(m.league, e.title);
  if (leagueLogo) e.leagueLogo = leagueLogo;
  if (m.channels[0]) {
    const cl = getChannelLogo(m.channels[0].name);
    if (cl) e.channelLogo = cl;
  }
  // per-channel broadcaster logos — feed lists + recents get their photos
  e.channels = m.channels.map((c) => {
    const name = cleanText(c.name);
    return { ...c, name, logo: getChannelLogo(name) || e.channelLogo || undefined };
  });
  enrichCache.set(m.id, e);
  if (enrichCache.size > 3000) {
    // trim
    const it = enrichCache.keys();
    for (let i = 0; i < 800; i++) {
      const k = it.next().value;
      if (k === undefined) break;
      enrichCache.delete(k);
    }
  }
  return e;
}

/** bounded-concurrency map (keeps TheSportsDB lookups polite + fast) */
async function enrichAll(ms: SportsMatch[], limit = 8): Promise<EnrichedMatch[]> {
  const out: EnrichedMatch[] = new Array(ms.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, ms.length) }, async () => {
    while (cursor < ms.length) {
      const i = cursor++;
      out[i] = await enrich(ms[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ─── big-league detector (Premier League, La Liga & friends) ────────────────
const BIG_LEAGUE_TESTS: ((league: string, title: string) => boolean)[] = [
  (l) => /premier league/i.test(l) && !/femen|women/i.test(l),
  (l) => (/primera divisi|la liga/i.test(l) && !/femen|women/i.test(l)),
  (l) => /serie a$/i.test(l.trim()) && !/femen|women/i.test(l),
  (l) => /bundesliga/i.test(l) && !/handball|femen|women/i.test(l),
  (l) => /ligue 1/i.test(l) && !/femen|women/i.test(l),
  (l) => /champions league|europa league|conference league/i.test(l),
  (l) => /major league soccer|\bmls\b/i.test(l),
  (l) => /saudi (arabia )?pro league|roshn/i.test(l),
  (l) => /eredivisie/i.test(l) && !/femen|women/i.test(l),
  (l) => /primeira liga|portugal - liga/i.test(l),
  (l) => /copa libertadores|copa america/i.test(l),
  (l, t) => /el\s*cl[aá]sico/i.test(t),
  (l) => /\bnfl\b/i.test(l),
];

function isBigLeague(m: SportsMatch): boolean {
  if (m.category === 'handball' || m.category === 'basketball' || m.category === 'motorsport') return false;
  const hay = `${m.league} ${m.title}`;
  return BIG_LEAGUE_TESTS.some((t) => t(m.league, hay));
}

/** merge DaddyLive fixtures with TheSportsDB calendars, DaddyLive wins (it carries feeds) */
function mergeFixtures(daddyLive: EnrichedMatch[], sdb: BigFixture[]): (EnrichedMatch | BigFixture)[] {
  const seen = new Set<string>();
  const out: (EnrichedMatch | BigFixture)[] = [];
  for (const m of daddyLive) {
    const teams = extractTeamsFromTitle(m.title);
    if (teams) seen.add(fixtureKey(teams[0], teams[1], m.startTime));
    out.push(m);
  }
  for (const f of sdb) {
    if (f.team1 && f.team2 && seen.has(fixtureKey(f.team1, f.team2, f.startTime))) continue;
    out.push(f);
  }
  return out.sort((a, b) => a.startTime - b.startTime);
}

export async function GET() {
  try {
    const matches = await getSchedule();
    const now = Date.now();

    const liveRaw = matches.filter((m) => m.status === 'live');

    // football (soccer) + american football playlists — everything, live first
    const footballRaw = matches
      .filter((m) => m.category === 'football' && (m.status as string) !== 'finished')
      .sort((a, b) => (a.status === b.status ? a.startTime - b.startTime : a.status === 'live' ? -1 : 1))
      .slice(0, 90);
    const amFootRaw = matches
      .filter((m) => m.category === 'american_football' || /\bnfl\b|college football|\bcfl\b|cfl\(/i.test(m.league))
      .sort((a, b) => (a.status === b.status ? a.startTime - b.startTime : a.status === 'live' ? -1 : 1))
      .slice(0, 60);

    // headline upcoming fixtures from the big championships only
    // (skip channel-style listings like "NFL Redzone" — not a real matchup)
    const bigRaw = matches
      .filter(
        (m) =>
          m.status === 'upcoming' &&
          isBigLeague(m) &&
          !/red\s*zone|redzone/i.test(m.title)
      )
      .sort((a, b) => a.startTime - b.startTime)
      .slice(0, 24);

    // the first big-league LIVE matches deserve headline billing too
    const bigLiveRaw = matches
      .filter((m) => m.status === 'live' && isBigLeague(m))
      .sort((a, b) => b.channels.length - a.channels.length)
      .slice(0, 8);

    const upcomingRaw = matches.filter((m) => m.status === 'upcoming').slice(0, 120);

    // TheSportsDB→ESPN championship calendars (PL, La Liga, Serie A, …, NFL) so
    // the big-matches rail has real fixtures even on days DaddyLive carries none.
    // Bounded wait when cold (~1–2s, hard cap 4s) so the first response already
    // carries the championship fixtures; afterwards it's a pure cache read.
    warmBigLeagues();
    let { football: sdbFootball, nfl: sdbNFL } = peekFixtures();
    {
      const missing: Promise<void>[] = [];
      if (sdbFootball.length === 0) {
        missing.push(
          getBigLeagueFixtures().then((fb) => {
            sdbFootball = fb;
          }).catch(() => {})
        );
      }
      if (sdbNFL.length === 0) {
        missing.push(
          getNFLFixtures().then((nfl) => {
            sdbNFL = nfl;
          }).catch(() => {})
        );
      }
      if (missing.length > 0) {
        await Promise.race([...missing, new Promise((r) => setTimeout(r, 4000))]);
      }
    }

    // enrich with team logos / league emblems (bounded concurrency)
    const [live, upcoming, football, americanFootball, bigMatches, bigLive] = await Promise.all([
      enrichAll(liveRaw.slice(0, 80)),
      enrichAll(upcomingRaw.slice(0, 60)),
      enrichAll(footballRaw),
      enrichAll(amFootRaw),
      enrichAll(bigRaw),
      enrichAll(bigLiveRaw),
    ]);

    const bigMerged = mergeFixtures([...bigLive, ...bigMatches], sdbFootball).slice(0, 28);
    const amFbMerged = mergeFixtures(
      americanFootball.map((m) => ({ ...m, status: m.status as 'live' | 'upcoming' })),
      sdbNFL.filter((f) => f.startTime > now)
    ).slice(0, 60);

    // counts per sport for the pill row
    const counts = new Map<string, number>();
    for (const m of matches) counts.set(m.category, (counts.get(m.category) || 0) + 1);

    const payload = {
      live,
      upcoming,
      football,
      americanFootball: amFbMerged,
      bigMatches: bigMerged,
      sports: [...counts.entries()]
        .map(([id, count]) => ({ id, name: sportName(id), count }))
        .sort((a, b) => b.count - a.count),
      total: matches.length,
      generatedAt: now,
    };

    return NextResponse.json(payload, {
      headers: { 'cache-control': 'public, max-age=30, stale-while-revalidate=60' },
    });
  } catch (e) {
    return NextResponse.json({ error: 'schedule_failed', message: (e as Error).message }, { status: 502 });
  }
}
