'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { Playable } from '@/lib/store';
import { prefetchStream } from '@/lib/prefetch';

/** Deterministic gradient per channel name (Pluto-card fallback art) */
function gradientFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  const h2 = (h + 40) % 360;
  return `linear-gradient(135deg, hsl(${h} 42% 22%) 0%, hsl(${h2} 38% 13%) 100%)`;
}

function initials(name: string): string {
  const words = name.replace(/[^\w\s]/g, '').trim().split(/\s+/);
  if (!words.length || !words[0]) return 'TV';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Wrap a logo URL in the /api/img proxy (cache + SVG fallback, upgrades
 *  http:// → https:// so mixed-content never blocks the image). */
export function logoSrc(logo: string | undefined, name: string): string | undefined {
  if (!logo) return undefined;
  const params = new URLSearchParams({ u: logo, t: name, c: 'ffd200' });
  return `/api/img?${params.toString()}`;
}

export function ChannelCard({
  channel,
  onPlay,
  chno,
  badge,
  compact,
}: {
  channel: Playable;
  onPlay: (ch: Playable) => void;
  chno?: string;
  badge?: string;
  compact?: boolean;
}) {
  const [imgOk, setImgOk] = useState(true);
  const src = logoSrc(channel.logo, channel.name);

  return (
    <button
      onClick={() => onPlay(channel)}
      onMouseEnter={() => prefetchStream(channel)}
      onFocus={() => prefetchStream(channel)}
      onTouchStart={() => prefetchStream(channel)}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-xl border border-zilla-line bg-zilla-card text-left card-hover-pop focus-visible:ring-2 focus-visible:ring-zilla-yellow focus-visible:outline-none',
        compact ? 'w-[8.25rem]' : 'w-[10.5rem] sm:w-[12rem]'
      )}
      aria-label={`Watch ${channel.name}`}
    >
      {/* 16:9 art area */}
      <div className="relative aspect-video w-full" style={{ background: gradientFor(channel.name) }}>
        {src && imgOk ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setImgOk(false)}
            className="absolute inset-0 h-full w-full object-contain p-4 drop-shadow-lg"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-2xl font-black tracking-tight text-white/80">{initials(channel.name)}</span>
          </div>
        )}

        {/* LIVE badge */}
        <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-1 rounded-md bg-zilla-red px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-white shadow">
          <span className="live-dot inline-block h-1.5 w-1.5 rounded-full bg-white" />
          Live
        </span>

        {/* optional custom badge (sport / source) */}
        {badge && (
          <span className="absolute right-1.5 top-1.5 rounded-md bg-black/70 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-zilla-yellow backdrop-blur-sm">
            {badge}
          </span>
        )}

        {/* channel number, Pluto-guide style */}
        {chno && (
          <span className="absolute bottom-1.5 left-1.5 rounded-md bg-black/65 px-1.5 py-0.5 text-[10px] font-bold text-white/90 backdrop-blur-sm">
            ch {chno}
          </span>
        )}

        {/* hover play */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
          <span className="flex h-11 w-11 items-center justify-center rounded-full bg-zilla-yellow text-black shadow-xl">
            <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5 fill-current" aria-hidden>
              <path d="M8 5.14v13.72L19 12 8 5.14z" />
            </svg>
          </span>
        </div>
      </div>

      {/* name strip */}
      <div className="px-2.5 py-2">
        <p className="truncate text-[13px] font-bold leading-tight text-zilla-text">{channel.name}</p>
        <p className="mt-0.5 truncate text-[11px] font-medium text-zilla-dim">
          {channel.source || channel.meta || 'Live channel'}
        </p>
      </div>
    </button>
  );
}
