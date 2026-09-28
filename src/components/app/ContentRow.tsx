'use client';

import { useRef, useState, useEffect, useCallback, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Pluto-style horizontal carousel row with hover arrows */
export function ContentRow({
  title,
  subtitle,
  children,
  seeAll,
  onSeeAll,
  className,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  seeAll?: boolean;
  onSeeAll?: () => void;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(true);

  const update = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 8);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [update]);

  const scrollBy = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(el.clientWidth * 0.8, 300), behavior: 'smooth' });
  };

  return (
    <section className={cn('relative', className)} aria-label={title}>
      {/* heading */}
      <div className="mb-2.5 flex items-end justify-between gap-3 px-4 sm:px-6 lg:px-10">
        <div className="min-w-0">
          <h2 className="truncate text-lg font-black uppercase tracking-tight text-zilla-text sm:text-xl">
            {title}
          </h2>
          {subtitle && <p className="mt-0.5 truncate text-xs font-medium text-zilla-dim">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          {seeAll && (
            <button
              onClick={onSeeAll}
              className="text-xs font-bold uppercase tracking-wide text-zilla-yellow hover:text-zilla-yellow-soft"
            >
              See all →
            </button>
          )}
          <div className="hidden gap-1.5 sm:flex">
            <button
              onClick={() => scrollBy(-1)}
              disabled={!canLeft}
              aria-label={`Scroll ${title} left`}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full border border-zilla-line bg-zilla-panel text-zilla-text transition-opacity',
                canLeft ? 'hover:bg-zilla-card' : 'cursor-default opacity-30'
              )}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
                <path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6 4.6-4.6z" />
              </svg>
            </button>
            <button
              onClick={() => scrollBy(1)}
              disabled={!canRight}
              aria-label={`Scroll ${title} right`}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full border border-zilla-line bg-zilla-panel text-zilla-text transition-opacity',
                canRight ? 'hover:bg-zilla-card' : 'cursor-default opacity-30'
              )}
            >
              <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
                <path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6-4.6 4.6z" />
              </svg>
            </button>
          </div>
        </div>
      </div>

      {/* scroller */}
      <div className="group/row relative">
        <div
          ref={scroller}
          className="hide-scrollbar flex gap-3 overflow-x-auto scroll-smooth px-4 pb-1 sm:px-6 lg:px-10"
        >
          {children}
        </div>
      </div>
    </section>
  );
}

export function RowSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="hide-scrollbar flex gap-3 overflow-hidden px-4 sm:px-6 lg:px-10">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="w-[10.5rem] shrink-0 sm:w-[12rem]">
          <div className="skeleton-shimmer aspect-video w-full rounded-xl" />
          <div className="mt-2 h-3 w-3/4 rounded bg-zilla-panel" />
        </div>
      ))}
    </div>
  );
}
