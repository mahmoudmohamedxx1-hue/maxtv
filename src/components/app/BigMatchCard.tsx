'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { logoSrc } from './ChannelCard';
import type { MatchCardData } from './MatchCard';

/** shared 30s clock so every countdown updates together without spamming renders */
function useTick(ms = 30_000) {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setT(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return t;
}

function fmtCountdown(delta: number): { label: string; soon: boolean } {
  if (delta <= 0) return { label: 'Kick-off!', soon: true };
  const mins = Math.floor(delta / 60_000);
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  if (d > 0) return { label: `in ${d}d ${h}h`, soon: false };
  if (h > 0) return { label: `in ${h}h ${m}m`, soon: true };
  if (m > 0) return { label: `in ${m}m`, soon: true };
  return { label: 'starting…', soon: true };
}

function dayLabel(ts: number): string {
  const dt = new Date(ts);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const thatDay = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate()).getTime();
  const diffDays = Math.round((thatDay - today) / 86_400_000);
  const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 0) return `Today ${time}`;
  if (diffDays === 1) return `Tomorrow ${time}`;
  return `${dt.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`;
}

function Crest({ logo, name }: { logo?: string; name: string }) {
  const [ok, setOk] = useState(true);
  const src = logoSrc(logo, name);
  if (!src || !ok) {
    return (
      <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-white/8 sm:h-16 sm:w-16">
        <span className="text-sm font-black text-white/70">{name.slice(0, 3).toUpperCase()}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      onError={() => setOk(false)}
      className="h-14 w-14 shrink-0 rounded-full object-contain drop-shadow-lg sm:h-16 sm:w-16"
    />
  );
}

/** Headline fixture card for the big championships (Premier League, La Liga…) */
export function BigMatchCard({
  match,
  onPlay,
  onRemind,
  reminded,
}: {
  match: MatchCardData;
  onPlay: (channelId: string, channelName: string, feeds: { id: string; name: string }[]) => void;
  onRemind?: () => void;
  reminded?: boolean;
}) {
  useTick();
  const isLive = match.status === 'live';
  const vs = match.title.match(/^(.+?)\s+(?:vs\.?|v)\s+(.+)$/i);
  const cd = fmtCountdown(match.startTime - Date.now());
  const [t1, t2] = vs ? [vs[1].trim(), vs[2].trim()] : [match.team1 || '', match.team2 || ''];

  return (
    <div
      className={cn(
        'group relative w-[19rem] shrink-0 overflow-hidden rounded-2xl border bg-zilla-card card-hover-pop sm:w-[21rem]',
        isLive ? 'border-zilla-red/60 shadow-[0_0_24px_-6px] shadow-zilla-red/40' : 'border-zilla-line'
      )}
    >
      {/* league strip */}
      <div className="flex items-center justify-between gap-2 bg-gradient-to-r from-zilla-panel to-transparent px-4 py-2.5">
        <span className="flex min-w-0 items-center gap-2">
          {match.leagueLogo ? (
            <img
              src={logoSrc(match.leagueLogo, match.league)}
              alt=""
              loading="lazy"
              className="h-5 w-5 rounded-sm object-contain"
            />
          ) : (
            <span className="text-sm">⭐</span>
          )}
          <span className="truncate text-[12px] font-black uppercase tracking-wider text-zilla-yellow">
            {match.league}
          </span>
        </span>
        {isLive ? (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-zilla-red px-2 py-0.5 text-[10px] font-black uppercase text-white">
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" /> Live
          </span>
        ) : (
          <span
            className={cn(
              'shrink-0 rounded-md px-2 py-0.5 text-[10px] font-black uppercase tracking-wide',
              cd.soon ? 'bg-zilla-yellow text-black' : 'bg-zilla-line text-zilla-text'
            )}
          >
            {cd.label}
          </span>
        )}
      </div>

      {/* clash */}
      <div className="flex items-center gap-3 px-4 py-4">
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
          <Crest logo={match.team1Logo} name={t1 || match.league} />
          <p className="line-clamp-2 text-[13px] font-extrabold leading-tight text-zilla-text">
            {t1 || match.title}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-center gap-1">
          <span className="rounded-lg bg-zilla-line px-2.5 py-1 text-[10px] font-black uppercase text-zilla-dim">
            vs
          </span>
          {!isLive && (
            <span className="text-center text-[10px] font-bold leading-tight text-zilla-dim">
              {dayLabel(match.startTime)}
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-center gap-1.5 text-center">
          <Crest logo={match.team2Logo} name={t2 || match.league} />
          <p className="line-clamp-2 text-[13px] font-extrabold leading-tight text-zilla-text">
            {t2 || match.title}
          </p>
        </div>
      </div>

      {/* actions */}
      <div className="flex items-center gap-2 px-4 pb-4">
        {match.channels[0] ? (
          <button
            onClick={() =>
              onPlay(
                match.channels[0].id,
                `${match.title} — ${match.channels[0].name}`,
                match.channels
              )
            }
            disabled={!isLive}
            className={cn(
              'flex-1 rounded-lg py-2 text-xs font-black uppercase tracking-wide transition-colors',
              isLive
                ? 'bg-zilla-yellow text-black hover:bg-zilla-yellow-soft'
                : 'cursor-not-allowed bg-zilla-line text-zilla-dim'
            )}
          >
            {isLive ? '▶ Watch live' : 'Not started'}
          </button>
        ) : (
          <span className="flex-1 rounded-lg bg-zilla-line py-2 text-center text-xs font-bold text-zilla-dim">
            No feeds listed
          </span>
        )}
        {!isLive && onRemind && (
          <button
            onClick={onRemind}
            title={reminded ? 'Reminder set — it will open on your favorites' : 'Remind me — pin to favorites'}
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border transition-colors',
              reminded
                ? 'border-zilla-yellow/60 bg-zilla-yellow/15 text-zilla-yellow'
                : 'border-zilla-line bg-zilla-panel text-zilla-dim hover:text-zilla-text'
            )}
            aria-label="Remind me"
          >
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5 fill-current" aria-hidden>
              <path d="M12 22a2.3 2.3 0 0 0 2.3-2.3H9.7A2.3 2.3 0 0 0 12 22zm7-5.4v-1l1.7-1.7a1 1 0 0 0 .3-.7V8.9A7 7 0 0 0 5 8.9v4.3a1 1 0 0 0 .3.7L7 15.6v1z" />
            </svg>
          </button>
        )}
        {match.channels.length > 1 && (
          <span className="shrink-0 rounded-md bg-zilla-panel px-2 py-1.5 text-[10px] font-black text-zilla-dim">
            {match.channels.length} feeds
          </span>
        )}
      </div>
    </div>
  );
}
