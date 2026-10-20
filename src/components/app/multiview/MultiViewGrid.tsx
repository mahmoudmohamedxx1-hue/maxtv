'use client';

// ─── Multi-view grid — up to 4 simultaneous streams ──────────────────────────
// Z-45: sits ABOVE the site (z-40 TopNav) but BELOW the full PlayerOverlay
// (z-50) — expanding a pane opens the real player with its whole engine
// (failover, quality ladder, stats, servers) on top, and closing it returns
// to the grid. While the player overlay is open, every pane pauses so the
// link feeds only the main stream.

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { useTV, MAX_GRID_PANES } from '@/lib/store';
import { useT } from '@/lib/locale';
import { readConnection } from '@/lib/player-settings';
import { Icon } from '../player/icons';
import { GridPane } from './GridPane';
import { PanePicker } from './PanePicker';

export function MultiViewGrid() {
  const { gridOpen, gridPanes, gridActive, closeGrid, addPane, removePane, setGridActive, openPlayer, playerOpen } = useTV();
  const { t } = useT();
  const [pickerOpen, setPickerOpen] = useState(false);

  // Esc closes the picker first, then the grid (the player overlay owns its
  // own Esc at z-50 and closes before this one ever sees it)
  useEffect(() => {
    if (!gridOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (pickerOpen) setPickerOpen(false);
      else if (!playerOpen) closeGrid();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [gridOpen, pickerOpen, playerOpen, closeGrid]);

  const inGridIds = useMemo(() => new Set(gridPanes.map((p) => p.ch.id)), [gridPanes]);

  // bandwidth hint — 3+ panes on a measured slow link
  const slowLink = useMemo(() => {
    const c = readConnection();
    return gridPanes.length >= 3 && ((c.downlink > 0 && c.downlink < 6) || c.effectiveType === '2g' || c.effectiveType === 'slow-2g');
  }, [gridPanes.length]);

  if (!gridOpen) return null;

  const cols =
    gridPanes.length <= 1
      ? 'grid-cols-1'
      : gridPanes.length === 2
        ? 'grid-cols-1 sm:grid-cols-2'
        : 'grid-cols-1 sm:grid-cols-2';

  return (
    <div
      className="fixed inset-0 z-[45] flex flex-col bg-zilla-bg"
      role="dialog"
      aria-modal="true"
      aria-label={t('grid.title')}
    >
      {/* top bar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-zilla-line bg-zilla-bg/95 px-4 py-3 backdrop-blur">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zilla-yellow text-black">
            <span className="h-4.5 w-4.5">{Icon.grid}</span>
          </span>
          <div className="min-w-0">
            <p className="text-sm font-black uppercase tracking-wide text-zilla-text">{t('grid.title')}</p>
            <p className="text-[11px] font-medium text-zilla-dim">{t('grid.paneCount', { n: gridPanes.length, max: MAX_GRID_PANES })}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button
            onClick={() => setPickerOpen(true)}
            disabled={gridPanes.length >= MAX_GRID_PANES}
            className={cn(
              'flex h-9 items-center gap-2 rounded-full px-4 text-[11px] font-black uppercase tracking-wide transition-colors',
              gridPanes.length >= MAX_GRID_PANES
                ? 'cursor-not-allowed bg-white/5 text-zilla-dim'
                : 'bg-zilla-yellow text-black hover:bg-zilla-yellow-soft'
            )}
            title={gridPanes.length >= MAX_GRID_PANES ? t('grid.full', { n: gridPanes.length, max: MAX_GRID_PANES }) : t('grid.addChannels')}
          >
            <span className="h-3.5 w-3.5">{Icon.plus}</span>
            <span className="hidden sm:inline">{t('grid.addChannels')}</span>
          </button>
          <button
            onClick={closeGrid}
            className="flex h-9 w-9 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
            title={t('grid.closeGrid')}
            aria-label={t('grid.closeGrid')}
          >
            <span className="h-4 w-4">{Icon.close}</span>
          </button>
        </div>
      </div>

      {/* the grid */}
      <div className="flex-1 overflow-hidden p-3 sm:p-4">
        {gridPanes.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/5 text-zilla-yellow">
              <span className="h-8 w-8">{Icon.grid}</span>
            </span>
            <div>
              <p className="text-lg font-black text-zilla-text">{t('grid.empty')}</p>
              <p className="mx-auto mt-1 max-w-md text-xs font-medium leading-relaxed text-zilla-dim">{t('grid.emptyHint')}</p>
            </div>
            <button
              onClick={() => setPickerOpen(true)}
              className="mt-1 flex h-11 items-center gap-2 rounded-full bg-zilla-yellow px-6 text-xs font-black uppercase tracking-wide text-black transition-transform hover:scale-105"
            >
              <span className="h-4 w-4">{Icon.plus}</span>
              {t('grid.addChannels')}
            </button>
          </div>
        ) : (
          <div className={cn('grid h-full gap-3', cols)} style={{ gridAutoRows: '1fr' }}>
            {gridPanes.map((pane) => (
              <GridPane
                key={pane.id}
                ch={pane.ch}
                active={gridActive === pane.id}
                covered={playerOpen}
                onActivate={() => setGridActive(pane.id)}
                onRemove={() => removePane(pane.id)}
                onExpand={() => openPlayer(pane.ch)}
                labels={{
                  expand: t('grid.expand'),
                  remove: t('grid.removePane'),
                  offair: t('grid.paneOffair'),
                  error: t('grid.paneError'),
                  retry: t('grid.retryPane'),
                  live: t('common.live'),
                  soundOn: t('grid.active'),
                }}
              />
            ))}
          </div>
        )}
      </div>

      {/* bandwidth hint */}
      {slowLink && gridPanes.length > 0 && (
        <p className="shrink-0 border-t border-zilla-line bg-zilla-yellow/10 px-4 py-2 text-center text-[10px] font-bold text-zilla-yellow">
          {t('grid.bandwidthWarn')}
        </p>
      )}

      <PanePicker
        key={`picker-${pickerOpen}`}
        t={t}
        open={pickerOpen}
        usedCount={gridPanes.length}
        maxPanes={MAX_GRID_PANES}
        inGridIds={inGridIds}
        onPick={(ch) => addPane(ch)}
        onClose={() => setPickerOpen(false)}
      />
    </div>
  );
}
