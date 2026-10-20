'use client';

// ─── Player module: the channel-surf sidebar / guide (presentational) ────────
// Extracted from the old PlayerOverlay monolith. RTL: anchored to the "end"
// edge with a direction-aware slide.

import { cn } from '@/lib/utils';
import { logoSrc } from '../ChannelCard';
import type { Translator } from '@/lib/locale';
import type { SurfItem } from './constants';
import { Icon } from './icons';

export interface SurfSidebarProps {
  t: Translator['t'];
  open: boolean;
  surf: SurfItem[];
  activeId?: string;
  altFeeds: { id: string }[];
  fmtAgo: (ts: number) => string;
  onSwitchTo: (item: SurfItem, feeds?: SurfItem[]) => void;
  onAddToGrid: (item: SurfItem) => void;
  onClose: () => void;
}

export function SurfSidebar({ t, open, surf, activeId, altFeeds, fmtAgo, onSwitchTo, onAddToGrid, onClose }: SurfSidebarProps) {
  return (
    <div
      className={cn(
        'styled-scrollbar absolute inset-y-0 end-0 z-20 w-80 max-w-[86vw] overflow-y-auto border-zilla-line bg-zilla-bg/97 backdrop-blur-xl transition-transform duration-300 rtl:border-r-0 rtl:border-l',
        open ? 'translate-x-0' : 'translate-x-full rtl:-translate-x-full'
      )}
    >
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zilla-line bg-zilla-bg/95 px-4 py-3 backdrop-blur">
        <p className="text-xs font-black uppercase tracking-wider text-zilla-text">{t('player.guide')}</p>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-zilla-dim hover:text-zilla-text"
          aria-label={t('player.closeGuide')}
        >
          <span className="h-3.5 w-3.5">{Icon.close}</span>
        </button>
      </div>

      {[
        { key: 'feeds', label: t('player.feedsGroup'), items: surf.filter((s) => s.group === 'feeds') },
        { key: 'live', label: t('player.liveGroup'), items: surf.filter((s) => s.group === 'live') },
        { key: 'channels', label: t('player.channelsGroup'), items: surf.filter((s) => s.group === 'channels') },
      ]
        .filter((g) => g.items.length > 0)
        .map((g, gi) => (
          <div key={g.key} className="pb-2">
            <p className="px-4 pb-1.5 pt-3 text-[10px] font-black uppercase tracking-widest text-zilla-dim">
              {g.label} · {g.items.length}
            </p>
            {g.items.map((item, i) => {
              const num = gi === 0 ? i + 1 : surf.indexOf(item) + 1;
              const active = item.id === activeId;
              return (
                <div
                  key={`${item.kind}-${item.ref}-${i}`}
                  className={cn('group/row flex w-full items-center gap-2.5 px-3 py-2 text-start transition-colors', active ? 'bg-zilla-yellow/15' : 'hover:bg-white/5')}
                >
                  <button
                    onClick={() => onSwitchTo(item, g.key === 'feeds' ? (altFeeds as SurfItem[]) : undefined)}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-start"
                  >
                    <span className="w-6 shrink-0 text-center text-[10px] font-black text-zilla-dim">{num}</span>
                    {item.logo ? (
                      <img
                        src={logoSrc(item.logo, item.name)}
                        alt=""
                        loading="lazy"
                        className="h-8 w-12 shrink-0 rounded object-contain"
                      />
                    ) : (
                      <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-white/5 text-[10px] font-black text-zilla-dim">
                        {item.group === 'live' ? '●' : 'TV'}
                      </span>
                    )}
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block truncate text-xs font-bold',
                          active ? 'text-zilla-yellow' : 'text-zilla-text'
                        )}
                      >
                        {item.name}
                      </span>
                      <span className="block truncate text-[10px] font-medium text-zilla-dim">
                        {item.group === 'live'
                          ? `${item.sub || ''} ${item.startedAt ? '· ' + fmtAgo(item.startedAt) : ''}`
                          : item.source || t('player.alwaysOn')}
                      </span>
                    </span>
                    {item.group === 'live' && (
                      <span className="shrink-0 rounded bg-zilla-red px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
                        {t('common.live')}
                      </span>
                    )}
                  </button>
                  {/* add to the multi-view grid — kept outside the main tap
                      target so a grid add never switches the channel */}
                  <button
                    onClick={() => onAddToGrid(item)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-zilla-dim opacity-0 transition-all hover:bg-white/10 hover:text-zilla-yellow focus-visible:opacity-100 group-hover/row:opacity-100"
                    title={t('player.addToGrid')}
                    aria-label={t('player.addToGrid')}
                  >
                    <span className="h-3.5 w-3.5">{Icon.plus}</span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}

      {surf.length === 0 && (
        <div className="flex flex-col items-center gap-3 px-4 py-10">
          <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-zilla-line border-t-zilla-yellow" />
          <p className="text-xs font-bold text-zilla-dim">{t('player.guideLoading')}</p>
        </div>
      )}
    </div>
  );
}
