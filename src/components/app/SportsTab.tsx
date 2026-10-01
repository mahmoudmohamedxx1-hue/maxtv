'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTV, type Playable } from '@/lib/store';
import { ContentRow, RowSkeleton } from './ContentRow';
import { MatchCard, type MatchCardData } from './MatchCard';
import { ChannelCard } from './ChannelCard';
import { HeroBanner } from './HeroBanner';
import { CategoryPills } from './CategoryPills';
import { BigMatchCard } from './BigMatchCard';
import { PlaylistZone } from './PlaylistZone';
import { cn } from '@/lib/utils';

interface ScheduleResponse {
  live: MatchCardData[];
  upcoming: MatchCardData[];
  football: MatchCardData[];
  americanFootball: MatchCardData[];
  bigMatches: MatchCardData[];
  sports: { id: string; name: string; count: number }[];
  total: number;
}

interface Channel247 {
  id: string;
  name: string;
  kind: 'daddylive' | 'iptv';
  ref: string;
  source: string;
  category: string;
  logo?: string;
  meta?: string;
}

const SPORT_EMOJI: Record<string, string> = {
  football: '⚽', cricket: '🏏', basketball: '🏀', american_football: '🏈',
  baseball: '⚾', mma: '🥊', motorsport: '🏎️', tennis: '🎾', hockey: '🏒',
  rugby: '🏉', golf: '⛳', darts: '🎯', cycling: '🚴', college: '🎓',
  esports: '🎮', other: '📡',
};

/** best artwork for a match feed — team crest → channel logo → league emblem */
function matchLogo(m: MatchCardData): string | undefined {
  return m.team1Logo || m.channelLogo || m.leagueLogo || m.team2Logo;
}

/** match channel list → playable feed list (kept identical app-wide) */
function feedsOf(m: MatchCardData): Playable[] {
  const logo = matchLogo(m);
  return m.channels.map((c) => ({
    id: `dl_${c.id}`,
    name: `${m.title} — ${c.name}`,
    kind: 'daddylive' as const,
    ref: c.id,
    source: m.league,
    logo: c.logo || logo,
    category: m.category,
  }));
}

/** fetch with timeout + retry — the home must never stay empty */
async function fetchJson(url: string, timeoutMs = 20_000, retries = 4): Promise<unknown> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { signal: ctrl.signal, cache: 'no-store' });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < retries) await new Promise((r2) => setTimeout(r2, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

export function SportsTab({
  onPlayChannel,
  onOpenSearch,
}: {
  onPlayChannel: (ch: Playable, altFeeds?: Playable[]) => void;
  onOpenSearch: () => void;
}) {
  const { favorites, recents, toggleFavorite, openPlayer } = useTV();
  const [schedule, setSchedule] = useState<ScheduleResponse | null>(null);
  const [channels, setChannels] = useState<Channel247[] | null>(null);
  const [sportFilter, setSportFilter] = useState('all');
  const [error, setError] = useState('');
  const scheduleTried = useRef(false);

  // ── progressive load: schedule FIRST (hero + match rows render immediately),
  //    channels second — a slow/failing channel index must never blank the page.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = (await fetchJson('/api/sports/schedule')) as ScheduleResponse;
        if (!alive) return;
        if (s && s.total > 0) {
          setSchedule(s);
          setError('');
        } else {
          // empty lineup = upstream scrape failed — retry, never blank the hero
          setError('Live sports engine is warming up — retrying automatically…');
        }
      } catch {
        if (alive && !scheduleTried.current) {
          scheduleTried.current = true;
          setError('Live sports engine is warming up — retrying automatically…');
        }
      }
    })();
    (async () => {
      try {
        const c = (await fetchJson('/api/sports/channels')) as { channels: Channel247[] };
        if (alive) setChannels(c.channels || []);
      } catch {
        if (alive) setChannels([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // ── keep retrying the schedule until it succeeds (the #1 "empty home" bug)
  useEffect(() => {
    if (schedule || !error) return;
    const t = setInterval(async () => {
      try {
        const s = (await fetchJson('/api/sports/schedule', 20_000, 0)) as ScheduleResponse;
        // only a real lineup clears the retry loop — empty keeps retrying
        if (s && s.total > 0) {
          setSchedule(s);
          setError('');
        }
      } catch {
        /* keep retrying */
      }
    }, 10_000);
    return () => clearInterval(t);
  }, [schedule, error]);

  // auto refresh schedule each minute (live events move fast)
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const s = (await fetchJson('/api/sports/schedule', 20_000, 0)) as ScheduleResponse;
        // an empty refresh must never wipe a loaded home (hero) mid-session
        if (s && s.total > 0) {
          setSchedule(s);
          setError('');
        }
      } catch { /* keep old */ }
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  const liveMatches = schedule?.live ?? [];
  const upcoming = useMemo(
    () => (schedule?.upcoming ?? []).filter((m) => m.status === 'upcoming'),
    [schedule]
  );
  const bigMatches = schedule?.bigMatches ?? [];
  const footballList = schedule?.football ?? [];
  const amFootballList = schedule?.americanFootball ?? [];

  const heroMatches = useMemo(
    () => [...liveMatches].sort((a, b) => b.channels.length - a.channels.length).slice(0, 6),
    [liveMatches]
  );

  const bySport = useMemo(() => {
    const map = new Map<string, MatchCardData[]>();
    for (const m of liveMatches) {
      // football & american football have their own dedicated playlist zones
      if (m.category === 'football' || m.category === 'american_football') continue;
      const arr = map.get(m.category) || [];
      arr.push(m);
      map.set(m.category, arr);
    }
    return map;
  }, [liveMatches]);

  const ch247 = channels || [];
  // multi-quality provider networks (World Sports source) — real ABR ladders
  const worldChannels = useMemo(() => ch247.filter((c) => c.meta === 'worldsports'), [ch247]);
  const filtered247 = useMemo(
    () => (sportFilter === 'all' ? ch247 : ch247.filter((c) => c.category === sportFilter)),
    [ch247, sportFilter]
  );

  // beIN Sports network rail — Arabic/MENA football feeds lead (the user's
  // region + preference), then MENA English, then the rest of the family.
  // Official always-on IPTV streams (XTRA) close the row. The channels API
  // runtime-probes the DaddyLive beIN ids, so everyone listed here plays.
  const beinChannels = useMemo(() => {
    const list = ch247.filter((c) => /be\s?in/i.test(c.name));
    const rank = (c: Channel247): number => {
      const n = c.name.toLowerCase();
      if (c.kind !== 'daddylive') return 4; // XTRA & other IPTV entries last
      if (/mena\s*\d|arabic/.test(n)) return 0; // beIN Sports Arabic
      if (/mena\s*english/.test(n)) return 1; // MENA English
      return 2; // France / Turkey / Malaysia / USA …
    };
    return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 40);
  }, [ch247]);

  const sportPills = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of ch247) counts.set(c.category, (counts.get(c.category) || 0) + 1);
    const pills = [{ id: 'all', name: 'All', count: ch247.length }];
    for (const [id, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      pills.push({ id, name: id === 'more' ? 'More' : id.replace(/_/g, ' '), count: n });
    }
    return pills.slice(0, 12);
  }, [ch247]);

  const favSports = favorites.filter((f) => f.kind === 'daddylive');
  const recentSports = recents.filter((r) => r.kind === 'daddylive');

  const playFeed = useCallback(
    (m: MatchCardData, chId: string, chName: string) => {
      const ch = m.channels.find((c) => c.id === chId);
      onPlayChannel(
        {
          id: `dl_${chId}`,
          name: `${m.title} — ${chName}`,
          kind: 'daddylive',
          ref: chId,
          source: m.league,
          logo: ch?.logo || matchLogo(m),
          category: m.category,
        },
        feedsOf(m)
      );
    },
    [onPlayChannel]
  );

  const isReminded = useCallback(
    (m: MatchCardData) => favorites.some((f) => f.id === `dl_${m.channels[0]?.id}`),
    [favorites]
  );

  const remind = useCallback(
    (m: MatchCardData) => {
      const ch = m.channels[0];
      if (!ch) return;
      toggleFavorite({
        id: `dl_${ch.id}`,
        name: `${m.title} — ${ch.name}`,
        kind: 'daddylive',
        ref: ch.id,
        source: m.league,
        logo: ch.logo || matchLogo(m),
      });
    },
    [toggleFavorite]
  );

  return (
    <div className="pb-16">
      {error && !schedule ? (
        <div className="hero-gradient flex min-h-[19rem] flex-col items-center justify-center gap-3 border-b border-zilla-line px-4 text-center">
          <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-zilla-line border-t-zilla-yellow" />
          <p className="text-sm font-bold text-zilla-text">{error}</p>
          <p className="text-xs font-medium text-zilla-dim">
            Warming the live sports engine — this usually takes under a minute.
          </p>
        </div>
      ) : !schedule ? (
        <div className="hero-gradient flex min-h-[19rem] items-center justify-center border-b border-zilla-line">
          <div className="flex flex-col items-center gap-3">
            <div className="h-10 w-10 animate-spin rounded-full border-[3px] border-zilla-line border-t-zilla-yellow" />
            <p className="text-sm font-bold text-zilla-dim">Syncing live sports schedule…</p>
          </div>
        </div>
      ) : (
        <HeroBanner
          matches={heroMatches}
          onPlay={(chId, chName, feeds) => {
            // find the hero match so the playable carries its artwork
            const m =
              heroMatches.find((hm) => hm.channels.some((c) => c.id === chId)) ||
              [...liveMatches, ...upcoming].find((hm) => hm.channels.some((c) => c.id === chId));
            const logo = m ? m.channels.find((c) => c.id === chId)?.logo || matchLogo(m) : undefined;
            onPlayChannel(
              {
                id: `dl_${chId}`,
                name: chName,
                kind: 'daddylive',
                ref: chId,
                source: 'DaddyLive',
                logo,
              },
              feeds.map((c) => ({
                id: `dl_${c.id}`,
                name: c.name,
                kind: 'daddylive' as const,
                ref: c.id,
                source: 'DaddyLive',
                logo,
              }))
            );
          }}
        />
      )}

      <div className="mx-auto max-w-7xl space-y-8 pt-6 sm:space-y-10">
        {/* big championships ahead — Premier League, La Liga & co */}
        {schedule && bigMatches.length > 0 && (
          <ContentRow
            title="Big matches ahead"
            subtitle="Premier League · La Liga · Serie A · Bundesliga · Champions League & more"
          >
            {bigMatches.map((m) => (
              <BigMatchCard
                key={m.id}
                match={m}
                onPlay={(chId, chName, feeds) => playFeed(m, chId, chName)}
                onRemind={() => remind(m)}
                reminded={isReminded(m)}
              />
            ))}
          </ContentRow>
        )}

        {/* live now */}
        {liveMatches.length > 0 && (
          <ContentRow
            title="Live now"
            subtitle={`${liveMatches.length} events streaming right now`}
            seeAll
          >
            {liveMatches.map((m) => (
              <MatchCard key={m.id} match={m} onPlay={(id, name) => playFeed(m, id, name)} />
            ))}
          </ContentRow>
        )}

        {/* ⚽ football (played by foot) — dedicated playlist zone */}
        {schedule && (
          <PlaylistZone
            emoji="⚽"
            title="Football"
            matches={footballList}
            onPlay={({ channelId, channelName, match }) => playFeed(match, channelId, channelName)}
            onRemind={remind}
            isReminded={isReminded}
          />
        )}

        {/* 🏈 american football — dedicated playlist zone */}
        {schedule && (
          <PlaylistZone
            emoji="🏈"
            title="American Football"
            matches={amFootballList}
            onPlay={({ channelId, channelName, match }) => playFeed(match, channelId, channelName)}
            onRemind={remind}
            isReminded={isReminded}
          />
        )}

        {/* beIN Sports network — dedicated football-first rail, Arabic feeds lead */}
        {beinChannels.length > 0 && (
          <ContentRow
            title="beIN Sports"
            subtitle={`${beinChannels.filter((c) => c.kind === 'daddylive').length} verified networks — Arabic MENA football feeds first · every channel health-checked`}
          >
            {beinChannels.map((c) => (
              <ChannelCard
                key={`bein-${c.id}`}
                channel={c}
                onPlay={onPlayChannel}
                badge="⚽"
              />
            ))}
          </ContentRow>
        )}

        {/* World Sports — multi-quality networks rail (real ABR ladders) */}
        {worldChannels.length > 0 && (
          <ContentRow
            title="World Sports"
            subtitle={`${worldChannels.length} multi-quality networks — pick any quality from 360p to 1080p in the player · every stream verified`}
          >
            {worldChannels.slice(0, 40).map((c) => (
              <ChannelCard
                key={`ws-${c.id}`}
                channel={c}
                onPlay={onPlayChannel}
                badge="HD"
              />
            ))}
          </ContentRow>
        )}

        {/* favorites */}
        {favSports.length > 0 && (
          <ContentRow title="Your favorites" subtitle="Saved sports channels & reminders">
            {favSports.map((c) => (
              <ChannelCard key={c.id} channel={c} onPlay={onPlayChannel} badge="★" />
            ))}
          </ContentRow>
        )}

        {/* recents */}
        {recentSports.length > 0 && (
          <ContentRow title="Recently watched" subtitle="Jump back in">
            {recentSports.map((c) => (
              <ChannelCard key={`r-${c.id}`} channel={c} onPlay={onPlayChannel} />
            ))}
          </ContentRow>
        )}

        {/* 24/7 sports channels */}
        <section aria-label="24/7 sports channels">
          <div className="mb-2.5 flex flex-wrap items-end justify-between gap-2 px-4 sm:px-6 lg:px-10">
            <div>
              <h2 className="text-lg font-black uppercase tracking-tight text-zilla-text sm:text-xl">
                24/7 Sports channels
              </h2>
              <p className="mt-0.5 text-xs font-medium text-zilla-dim">
                {ch247.length > 0
                  ? `${ch247.length} always-on sports networks · ESPN, Sky Sports, beIN, Willow & more`
                  : 'Loading the always-on sports networks…'}
              </p>
            </div>
          </div>
          <CategoryPills pills={sportPills} active={sportFilter} onSelect={setSportFilter} className="mb-3" />
          {!channels ? (
            <div className="px-4 sm:px-6 lg:px-10">
              <RowSkeleton />
            </div>
          ) : filtered247.length === 0 ? (
            <p className="px-4 py-6 text-sm font-bold text-zilla-dim sm:px-6 lg:px-10">
              No networks in this sport right now — try another pill.
            </p>
          ) : (
            <div className="hide-scrollbar flex gap-3 overflow-x-auto px-4 pb-1 sm:px-6 lg:px-10">
              {filtered247.slice(0, 40).map((c) => (
                <ChannelCard
                  key={c.id}
                  channel={c}
                  onPlay={onPlayChannel}
                  badge={SPORT_EMOJI[c.category === 'espn' ? 'other' : c.category]}
                />
              ))}
            </div>
          )}
        </section>

        {/* per-sport live rows (football & am. football live in their zones above) */}
        {[...bySport.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 8)
          .map(([sport, ms]) => (
            <ContentRow
              key={sport}
              title={`${SPORT_EMOJI[sport] || '📡'} ${sport.replace(/_/g, ' ')} live`}
              subtitle={`${ms.length} live ${sport.replace(/_/g, ' ')} events`}
            >
              {ms.map((m) => (
                <MatchCard key={m.id} match={m} onPlay={(id, name) => playFeed(m, id, name)} />
              ))}
            </ContentRow>
          ))}

        {/* upcoming */}
        {upcoming.length > 0 && (
          <ContentRow title="Upcoming events" subtitle="Kick off soon — times shown in your timezone">
            {upcoming.map((m) => (
              <MatchCard key={m.id} match={m} onPlay={(id, name) => playFeed(m, id, name)} />
            ))}
          </ContentRow>
        )}

        {/* empty state */}
        {schedule && liveMatches.length === 0 && (
          <div className="px-4 py-10 text-center sm:px-6 lg:px-10">
            <p className="text-4xl">🏟️</p>
            <p className="mt-3 text-base font-extrabold text-zilla-text">No live events right now</p>
            <p className="mx-auto mt-1 max-w-sm text-sm font-medium text-zilla-dim">
              The schedule refreshes every minute — check the 24/7 channels above or{' '}
              <button onClick={onOpenSearch} className="font-bold text-zilla-yellow hover:underline">
                search for a channel
              </button>
              .
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
