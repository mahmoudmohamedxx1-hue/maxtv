'use client';

import { cn } from '@/lib/utils';

export interface Pill {
  id: string;
  name: string;
  count?: number;
  emoji?: string;
  /** 'ok' | 'geo' | 'dead' | 'unknown' — shows a health dot */
  health?: string;
}

export function CategoryPills({
  pills,
  active,
  onSelect,
  className,
}: {
  pills: Pill[];
  active: string;
  onSelect: (id: string) => void;
  className?: string;
}) {
  return (
    <div
      className={cn('hide-scrollbar flex gap-2 overflow-x-auto px-4 sm:px-6 lg:px-10', className)}
      role="tablist"
    >
      {pills.map((p) => {
        const isActive = p.id === active;
        return (
          <button
            key={p.id}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(p.id)}
            className={cn(
              'shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zilla-yellow',
              isActive
                ? 'border-zilla-yellow bg-zilla-yellow text-black shadow-[0_0_18px_rgba(255,210,0,0.25)]'
                : 'border-zilla-line bg-zilla-panel text-zilla-text hover:border-white/30 hover:bg-zilla-card'
            )}
          >
            {p.emoji && <span className="mr-1">{p.emoji}</span>}
            {p.health && p.health !== 'unknown' && (
              <span
                aria-hidden
                className={cn(
                  'mr-1.5 inline-block h-1.5 w-1.5 rounded-full',
                  p.health === 'ok'
                    ? 'bg-emerald-400'
                    : p.health === 'geo'
                      ? 'bg-amber-400'
                      : 'bg-red-500'
                )}
              />
            )}
            {p.name}
            {typeof p.count === 'number' && (
              <span className={cn('ml-1.5 font-semibold', isActive ? 'text-black/60' : 'text-zilla-dim')}>
                {p.count.toLocaleString()}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
