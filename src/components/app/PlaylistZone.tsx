'use client';

import { useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { MatchCard, type MatchCardData } from './MatchCard';

/**
 * A dedicated sport playlist zone — the "football played by foot" and the
 * "american football" sections, each with its own Live / Upcoming toggle and
 * a full grid (Pluto TV browse-style) instead of a single mixed row.
 */
export function PlaylistZone({
  emoji,
  title,
  matches,
  onPlay,
  onRemind,
  isReminded,
}: {
  emoji: string;
  title: string;
  matches: MatchCardData[];
  onPlay: (ch: PlayableArgs) => void;
  onRemind?: (m: MatchCardData) => void;
  isReminded?: (m: MatchCardData) => boolean;
}) {
  const live = useMemo(() => matches.filter((m) => m.status === 'live'), [matches]);
  const upcoming = useMemo(() => matches.filter((m) => m.status === 'upcoming'), [matches]);
  const [tab, setTab] = useState<'live' | 'upcoming'>(live.length > 0 ? 'live' : 'upcoming');
  const [expanded, setExpanded] = useState(false);

  const shown = tab === 'live' ? live : upcoming;
  const visible = expanded ? shown : shown.slice(0, 8);

  if (matches.length === 0) return null;

  return (
    <section
      aria-label={`${title} playlist`}
      className="rounded-2xl border border-zilla-line bg-zilla-panel/40 px-4 py-5 sm:px-6 lg:px-8"
    >
      {/* zone header */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-zilla-card text-2xl shadow-inner">
            {emoji}
          </span>
          <div>
            <h2 className="text-lg font-black uppercase tracking-tight text-zilla-text sm:text-xl">
              {title}
            </h2>
            <p className="text-xs font-semibold text-zilla-dim">
              {live.length > 0 ? (
                <>
                  <span className="font-black text-zilla-red">{live.length} live</span>
                  <span> · </span>
                </>
              ) : null}
              {upcoming.length} upcoming fixtures
            </p>
          </div>
        </div>

        {/* live / upcoming segmented control */}
        <div className="flex items-center rounded-full border border-zilla-line bg-zilla-bg p-1">
          {(['live', 'upcoming'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              disabled={t === 'live' && live.length === 0}
              className={cn(
                'rounded-full px-4 py-1.5 text-[11px] font-black uppercase tracking-wide transition-colors disabled:opacity-40',
                tab === t ? 'bg-zilla-yellow text-black' : 'text-zilla-dim hover:text-zilla-text'
              )}
            >
              {t === 'live' ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="live-dot h-1.5 w-1.5 rounded-full bg-current" /> Live {live.length}
                </span>
              ) : (
                <>Upcoming {upcoming.length}</>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* grid */}
      {shown.length === 0 ? (
        <p className="px-1 py-8 text-center text-sm font-bold text-zilla-dim">
          {tab === 'live'
            ? 'No live fixtures right now — flip to Upcoming for kick-off times.'
            : 'No upcoming fixtures listed yet — the schedule refreshes every minute.'}
        </p>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {visible.map((m) => (
            <MatchCard
              key={m.id}
              match={m}
              fullWidth
              onPlay={(chId, chName) =>
                onPlay({ channelId: chId, channelName: chName, match: m })
              }
            />
          ))}
        </div>
      )}

      {shown.length > 8 && (
        <button
          onClick={() => setExpanded((e) => !e)}
          className="mx-auto mt-4 block rounded-full border border-zilla-line bg-zilla-card px-5 py-2 text-xs font-black uppercase tracking-wide text-zilla-text transition-colors hover:border-zilla-yellow/50 hover:text-zilla-yellow"
        >
          {expanded ? 'Show less' : `Show all ${shown.length} ${tab === 'live' ? 'live matches' : 'fixtures'}`}
        </button>
      )}
    </section>
  );
}

export interface PlayableArgs {
  channelId: string;
  channelName: string;
  match: MatchCardData;
}
