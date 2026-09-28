'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { logoSrc } from './ChannelCard';
import { prefetchStream } from '@/lib/prefetch';

export interface MatchCardData {
  id: string;
  title: string;
  league: string;
  category: string;
  startTime: number;
  timeStr: string;
  status: 'live' | 'upcoming';
  channels: { id: string; name: string; logo?: string }[];
  /** enrichment from the schedule API (original-repo technique) */
  team1?: string;
  team2?: string;
  team1Logo?: string;
  team2Logo?: string;
  leagueLogo?: string;
  channelLogo?: string;
}

const SPORT_ICON: Record<string, string> = {
  football: '⚽',
  cricket: '🏏',
  basketball: '🏀',
  american_football: '🏈',
  baseball: '⚾',
  mma: '🥊',
  motorsport: '🏎️',
  tennis: '🎾',
  hockey: '🏒',
  rugby: '🏉',
  golf: '⛳',
  darts: '🎯',
  cycling: '🚴',
  college: '🎓',
  esports: '🎮',
  other: '📡',
};

function kickoffLocal(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** Split "Team A vs Team B" into parts for the versus layout */
function versus(title: string): [string, string] | null {
  const m = title.match(/^(.+?)\s+(?:vs\.?|v)\s+(.+)$/i);
  return m ? [m[1].trim(), m[2].trim()] : null;
}

/** One crest slot — img via /api/img, graceful initials fallback */
function Crest({ logo, name, size = 'md' }: { logo?: string; name: string; size?: 'md' | 'lg' }) {
  const [ok, setOk] = useState(true);
  const src = logoSrc(logo, name);
  const dim = size === 'lg' ? 'h-16 w-16 sm:h-20 sm:w-20' : 'h-12 w-12';
  if (!src || !ok) {
    return (
      <div className={cn('flex shrink-0 items-center justify-center rounded-full bg-white/8', dim)}>
        <span className="text-xs font-black text-white/70">{name.slice(0, 2).toUpperCase()}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setOk(false)}
      className={cn('shrink-0 rounded-full object-contain drop-shadow-lg', dim)}
    />
  );
}

export function MatchCard({
  match,
  onPlay,
  index,
  fullWidth = false,
}: {
  match: MatchCardData;
  onPlay: (channelId: string, channelName: string) => void;
  index?: number;
  /** grid mode: fill the parent instead of the fixed rail width */
  fullWidth?: boolean;
}) {
  const isLive = match.status === 'live';
  const vs = versus(match.title);

  // warm the resolve cache for the primary feed while the card is hovered —
  // the click then plays from cache almost instantly
  const warm = () => {
    const first = match.channels[0];
    if (first)
      prefetchStream({
        id: `dl_${first.id}`,
        kind: 'daddylive',
        ref: first.id,
        name: match.title,
      });
  };

  return (
    <div
      onMouseEnter={warm}
      onTouchStart={warm}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-xl border bg-zilla-card card-hover-pop',
        fullWidth ? 'w-full' : 'w-[17rem]',
        isLive ? 'border-zilla-red/50' : 'border-zilla-line'
      )}
    >
      {/* top accent */}
      <div
        className={cn(
          'flex items-center justify-between px-3 py-2',
          isLive ? 'bg-zilla-red/15' : 'bg-zilla-panel'
        )}
      >
        <span className="inline-flex items-center gap-1.5 text-[11px] font-extrabold uppercase tracking-wider">
          {isLive ? (
            <span className="inline-flex items-center gap-1 rounded-md bg-zilla-red px-1.5 py-0.5 text-white">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" />
              Live now
            </span>
          ) : (
            <span className="rounded-md bg-zilla-line px-1.5 py-0.5 text-zilla-dim">
              {kickoffLocal(match.startTime)}
            </span>
          )}
          <span className="text-zilla-dim">{SPORT_ICON[match.category] || '📡'}</span>
        </span>
        <span className="flex max-w-[55%] items-center gap-1.5">
          {match.leagueLogo && (
            <img
              src={logoSrc(match.leagueLogo, match.league)}
              alt=""
              loading="lazy"
              className="h-4 w-4 rounded-sm object-contain"
            />
          )}
          <span className="truncate text-[11px] font-bold uppercase tracking-wide text-zilla-yellow">
            {match.league}
          </span>
        </span>
      </div>

      {/* teams */}
      <div className="px-3 py-3">
        {vs ? (
          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
              <Crest logo={match.team1Logo} name={match.team1 || vs[0]} />
              <p className="line-clamp-2 text-xs font-extrabold leading-tight text-zilla-text">
                {match.team1 || vs[0]}
              </p>
            </div>
            <span className="shrink-0 self-center rounded-md bg-zilla-line px-2 py-1 text-[10px] font-black uppercase text-zilla-dim">
              vs
            </span>
            <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
              <Crest logo={match.team2Logo} name={match.team2 || vs[1]} />
              <p className="line-clamp-2 text-xs font-extrabold leading-tight text-zilla-text">
                {match.team2 || vs[1]}
              </p>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Crest logo={match.channelLogo || match.leagueLogo} name={match.league} />
            <p className="line-clamp-3 min-h-[2.4rem] text-sm font-extrabold leading-snug text-zilla-text">
              {match.title}
            </p>
          </div>
        )}

        {/* feeds */}
        <div className="mt-2.5 flex items-center gap-1.5">
          {match.channels.slice(0, 3).map((c, i) => (
            <button
              key={c.id}
              onClick={() => onPlay(c.id, c.name)}
              className={cn(
                'rounded-md px-2 py-1 text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zilla-yellow',
                i === 0
                  ? 'bg-zilla-yellow text-black hover:bg-zilla-yellow-soft'
                  : 'bg-zilla-line text-zilla-text hover:bg-white/15'
              )}
              title={`Watch on ${c.name}`}
            >
              {i === 0 ? '▶ Watch' : `Feed ${i + 1}`}
            </button>
          ))}
          {match.channels.length > 3 && (
            <span className="text-[11px] font-semibold text-zilla-dim">
              +{match.channels.length - 3} more
            </span>
          )}
          {match.channels.length === 0 && (
            <span className="text-[11px] font-semibold text-zilla-dim">
              {match.status === 'upcoming' ? 'Feeds on match day' : 'No feeds'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
