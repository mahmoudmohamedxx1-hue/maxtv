// ─── Big-league upcoming fixtures (ESPN scoreboard API) ───────────────────────
// DaddyLive only lists today/tomorrow, so when the Premier League or La Liga
// aren't playing *today* there was nothing to show in "upcoming big matches".
// This engine pulls the real fixture calendars for the big championships from
// ESPN's public scoreboard API (same CDN the original repo uses for league
// emblems) and decorates them with team crests + league logos.
// Game-day live feeds still come from DaddyLive; these fixtures merge with it.

import { getLeagueLogo } from '@/lib/media/logos';

const API = 'https://site.api.espn.com/apis/site/v2/sports';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36';

export interface BigFixture {
  id: string;
  title: string;
  league: string;
  category: 'football' | 'american_football';
  startTime: number;
  timeStr: string;
  status: 'upcoming';
  channels: { id: string; name: string }[];
  team1?: string;
  team2?: string;
  team1Logo?: string;
  team2Logo?: string;
  leagueLogo?: string;
  source: string;
  venue?: string;
}

/** The championships users actually want to browse ahead (ESPN sport paths) */
export const FOOTBALL_LEAGUES: { path: string; pretty: string }[] = [
  { path: 'soccer/eng.1', pretty: 'Premier League' },
  { path: 'soccer/esp.1', pretty: 'La Liga' },
  { path: 'soccer/ita.1', pretty: 'Serie A' },
  { path: 'soccer/ger.1', pretty: 'Bundesliga' },
  { path: 'soccer/fra.1', pretty: 'Ligue 1' },
  { path: 'soccer/uefa.champions', pretty: 'Champions League' },
  { path: 'soccer/usa.1', pretty: 'MLS' },
];

export const NFL_PATH = 'football/nfl';

// ─── caches with stale-serve (expired data still beats no data) ─────────────
interface CacheBox<T> {
  data: T;
  expires: number;
  hardExpires: number;
}
const cache = new Map<string, CacheBox<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

function peekCache<T>(key: string): T | null {
  const box = cache.get(key) as CacheBox<T> | undefined;
  return box ? box.data : null;
}

function isFresh(key: string): boolean {
  const box = cache.get(key);
  return !!box && Date.now() <= box.expires;
}

function setCached<T>(key: string, data: T, ttlMs: number) {
  cache.set(key, { data, expires: Date.now() + ttlMs, hardExpires: Date.now() + 48 * 3600_000 });
  for (const [k, b] of cache) {
    if (Date.now() > (b as CacheBox<unknown>).hardExpires) cache.delete(k);
  }
}

/** fetch-through cache: concurrent callers share one promise */
async function through<T>(key: string, loader: () => Promise<T | null>, ttlMs: number): Promise<T | null> {
  if (isFresh(key)) return peekCache<T>(key);
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    const data = await loader();
    if (data) setCached(key, data, ttlMs);
    return data;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

// ─── ESPN scoreboard fetch (one calendar month per call) ────────────────────
interface EspnTeam {
  team?: { displayName?: string; shortDisplayName?: string; abbreviation?: string; logo?: string };
  homeAway?: string;
}
interface EspnEvent {
  id: string;
  date: string;
  name?: string;
  status?: { type?: { state?: string } };
  competitions?: { competitors?: EspnTeam[]; venue?: { fullName?: string } }[];
}
interface EspnScoreboard {
  events?: EspnEvent[];
  leagues?: { name?: string; logos?: { href?: string }[] }[];
}

async function espnMonth(path: string, ym: string): Promise<EspnEvent[] | null> {
  const url = `${API}/${path}/scoreboard?dates=${ym}&limit=100`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: AbortSignal.timeout(9000),
      });
      if (!res.ok) {
        if (attempt === 0) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        return null;
      }
      const j = (await res.json()) as EspnScoreboard;
      return j.events ?? null;
    } catch {
      if (attempt === 1) return null;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return null;
}

function monthStr(d: Date): string {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** this month + next month (fixtures rarely live further ahead) */
function monthsAhead(): string[] {
  const now = new Date();
  const next = new Date(now.getTime() + 31 * 86400_000);
  return [...new Set([monthStr(now), monthStr(next)])];
}

async function leagueFixtures(
  path: string,
  pretty: string,
  category: 'football' | 'american_football'
): Promise<BigFixture[]> {
  const key = `espn:next:${path}`;
  const hit = peekCache<BigFixture[]>(key);
  if (hit && isFresh(key)) return hit;

  const load = async (): Promise<BigFixture[] | null> => {
    const months = await Promise.all(monthsAhead().map((m) => espnMonth(path, m)));
    const events = months.flat().filter(Boolean) as EspnEvent[];
    if (events.length === 0) return null;

    const now = Date.now();
    const seen = new Set<string>();
    const out: BigFixture[] = [];
    const leagueEmblem = getLeagueLogo(pretty, '') || undefined;

    for (const e of events) {
      const ts = Date.parse(e.date);
      if (Number.isNaN(ts)) continue;
      if (ts < now - 3 * 3600_000) continue; // skip past fixtures
      const state = e.status?.type?.state;
      if (state === 'post') continue; // finished

      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find((c) => c.homeAway === 'home');
      const away = comp?.competitors?.find((c) => c.homeAway === 'away');
      const t1 = home?.team?.displayName || '';
      const t2 = away?.team?.displayName || '';

      if (seen.has(e.id)) continue;
      seen.add(e.id);

      const utcDate = new Date(ts);
      out.push({
        id: `espn_${e.id}`,
        title: t1 && t2 ? `${t1} vs ${t2}` : (e.name || pretty).replace(' at ', ' vs '),
        league: pretty,
        category,
        startTime: ts,
        timeStr: `${String(utcDate.getUTCHours()).padStart(2, '0')}:${String(utcDate.getUTCMinutes()).padStart(2, '0')}`,
        status: 'upcoming',
        channels: [], // feeds appear on match day via DaddyLive
        team1: t1 || undefined,
        team2: t2 || undefined,
        team1Logo: home?.team?.logo || undefined,
        team2Logo: away?.team?.logo || undefined,
        leagueLogo: leagueEmblem,
        source: pretty,
        venue: comp?.venue?.fullName || undefined,
      });
    }

    out.sort((a, b) => a.startTime - b.startTime);
    return out;
  };

  const fresh = await through(key, load, 45 * 60_000);
  if (fresh && fresh.length > 0) return fresh;
  if (hit) return hit; // stale-serve
  return [];
}

/** upcoming fixtures across all big football championships (league-diverse) */
export async function getBigLeagueFixtures(perLeagueCap = 3): Promise<BigFixture[]> {
  const lists = await Promise.all(
    FOOTBALL_LEAGUES.map((l) => leagueFixtures(l.path, l.pretty, 'football'))
  );
  const out: BigFixture[] = [];
  const perLeague = new Map<string, number>();
  for (const fx of lists.flat().sort((a, b) => a.startTime - b.startTime)) {
    const n = perLeague.get(fx.league) || 0;
    if (n >= perLeagueCap) continue;
    perLeague.set(fx.league, n + 1);
    out.push(fx);
  }
  return out;
}

/** upcoming NFL fixtures for the American Football playlist zone */
export async function getNFLFixtures(cap = 30): Promise<BigFixture[]> {
  const fx = await leagueFixtures(NFL_PATH, 'NFL', 'american_football');
  return fx.slice(0, cap);
}

/** dedupe helper: same two teams playing on the same UTC day = same fixture */
export function fixtureKey(team1: string, team2: string, ts: number): string {
  const day = new Date(ts).toISOString().slice(0, 10);
  const pair = [team1.toLowerCase().trim(), team2.toLowerCase().trim()].sort().join('|');
  return `${day}#${pair}`;
}

// ─── non-blocking reads (never let a cold cache stall the schedule API) ─────

/** cached fixtures without any network activity — empty until warmed */
export function peekFixtures(perLeagueCap = 3): { football: BigFixture[]; nfl: BigFixture[] } {
  const all = FOOTBALL_LEAGUES.flatMap((l) => peekCache<BigFixture[]>(`espn:next:${l.path}`) ?? []).sort(
    (a, b) => a.startTime - b.startTime
  );
  const perLeague = new Map<string, number>();
  const capped: BigFixture[] = [];
  for (const f of all) {
    const n = perLeague.get(f.league) || 0;
    if (n >= perLeagueCap) continue;
    perLeague.set(f.league, n + 1);
    capped.push(f);
  }
  return { football: capped, nfl: (peekCache<BigFixture[]>(`espn:next:${NFL_PATH}`) ?? []).slice(0, 30) };
}

/** kick off background refresh (no-op when fresh) — call from warmups/routes */
export function warmBigLeagues(): void {
  void getBigLeagueFixtures().catch(() => {});
  void getNFLFixtures().catch(() => {});
}
