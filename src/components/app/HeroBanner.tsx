'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { logoSrc } from './ChannelCard';
import type { MatchCardData } from './MatchCard';

/** Deterministic hero backdrop gradient per event */
function heroGradient(title: string): string {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) % 360;
  return `radial-gradient(120% 140% at 82% 18%, hsl(${h} 55% 24% / 0.85) 0%, hsl(${(h + 40) % 360} 45% 12% / 0.9) 45%, #0b0c0f 100%)`;
}

function HeroCrest({ logo, name }: { logo?: string; name: string }) {
  const [ok, setOk] = useState(true);
  const src = logoSrc(logo, name);
  if (!src || !ok) {
    return (
      <div className="flex h-20 w-20 items-center justify-center rounded-2xl border border-white/10 bg-white/5 sm:h-28 sm:w-28">
        <span className="text-xl font-black text-white/75">{name.slice(0, 2).toUpperCase()}</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      alt=""
      onError={() => setOk(false)}
      className="h-20 w-20 rounded-2xl border border-white/10 bg-white/5 object-contain p-2 drop-shadow-2xl sm:h-28 sm:w-28 sm:p-3"
    />
  );
}

/**
 * Auto-rotating hero banner for live events — Pluto TV "featured rail" style.
 * Shows the two team crests (or league emblem for non-versus events), exactly
 * like the original repo's composed match cards.
 */
export function HeroBanner({
  matches,
  onPlay,
  onSeeAll,
}: {
  matches: MatchCardData[];
  onPlay: (channelId: string, channelName: string, feeds: { id: string; name: string }[]) => void;
  onSeeAll?: () => void;
}) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (paused || matches.length <= 1) return;
    const t = setInterval(() => setIdx((i) => (i + 1) % matches.length), 6000);
    return () => clearInterval(t);
  }, [paused, matches.length]);

  if (!matches.length) return null;
  const m = matches[idx % matches.length];

  const versusMatch = m.team1 && m.team2 ? m : null;
  const emblem = versusMatch ? null : m.leagueLogo || m.channelLogo;

  return (
    <section
      className="relative overflow-hidden border-b border-zilla-line"
      style={{ background: heroGradient(m.title) }}
      aria-label="Featured live events"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="relative mx-auto flex min-h-[19rem] max-w-7xl flex-col justify-end gap-4 px-4 py-8 sm:min-h-[22rem] sm:px-6 lg:px-10 lg:py-12">
        {/* crest art — right side on desktop, top-right on mobile */}
        <div key={`art-${m.id}`} className="pointer-events-none absolute right-4 top-6 flex items-center gap-3 sm:right-6 sm:top-8 lg:right-10">
          {versusMatch ? (
            <>
              <HeroCrest logo={m.team1Logo} name={m.team1!} />
              <span className="text-lg font-black text-white/40 sm:text-2xl">vs</span>
              <HeroCrest logo={m.team2Logo} name={m.team2!} />
            </>
          ) : emblem ? (
            <HeroCrest logo={emblem} name={m.league} />
          ) : null}
        </div>

        <div key={m.id} className="rise-in max-w-2xl">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-md bg-zilla-red px-2.5 py-1 text-[11px] font-black uppercase tracking-widest text-white">
              <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" /> Live now
            </span>
            <span className="flex items-center gap-1.5 rounded-md bg-black/50 px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-widest text-zilla-yellow backdrop-blur-sm">
              {m.leagueLogo && (
                <img src={logoSrc(m.leagueLogo, m.league)} alt="" className="h-3.5 w-3.5 object-contain" />
              )}
              {m.league}
            </span>
            <span className="text-[11px] font-bold uppercase tracking-widest text-zilla-dim">
              {m.channels.length} streams available
            </span>
          </div>

          <h1 className="text-2xl font-black leading-[1.08] tracking-tight text-zilla-text sm:text-4xl lg:text-5xl">
            {m.title}
          </h1>

          <p className="mt-3 max-w-xl text-sm font-medium leading-relaxed text-zilla-dim sm:text-base">
            Watch {m.title} live right now on MaxTV — free HD streams aggregated from{' '}
            {m.channels.length} international feeds. No signup, no limits.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            <button
              onClick={() => m.channels[0] && onPlay(m.channels[0].id, m.channels[0].name, m.channels)}
              className="flex items-center gap-2 rounded-full bg-zilla-yellow px-6 py-3 text-sm font-black uppercase tracking-wide text-black shadow-[0_8px_30px_rgba(255,210,0,0.35)] transition-transform hover:scale-[1.03]"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
                <path d="M8 5.14v13.72L19 12 8 5.14z" />
              </svg>
              Watch live
            </button>
            {onSeeAll && (
              <button
                onClick={onSeeAll}
                className="rounded-full border border-white/20 bg-white/5 px-6 py-3 text-sm font-black uppercase tracking-wide text-zilla-text backdrop-blur-sm transition-colors hover:bg-white/10"
              >
                All live events
              </button>
            )}
          </div>
        </div>

        {/* dots */}
        {matches.length > 1 && (
          <div className="flex gap-1.5" role="tablist" aria-label="Featured events">
            {matches.slice(0, 8).map((mm, i) => (
              <button
                key={mm.id}
                role="tab"
                aria-selected={i === idx % matches.length}
                onClick={() => setIdx(i)}
                aria-label={`Show event ${i + 1}`}
                className={cn(
                  'h-1.5 rounded-full transition-all',
                  i === idx % matches.length ? 'w-7 bg-zilla-yellow' : 'w-3 bg-white/25 hover:bg-white/40'
                )}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
