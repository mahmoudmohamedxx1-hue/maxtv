'use client';

// ─── Player module: state panels (resolving / loading / off-air / error /
//    HEVC choice) + the tap-for-sound, mismatch and go-live chips ────────────
// Extracted from the old PlayerOverlay monolith — pure presentational.

import { cn } from '@/lib/utils';
import type { Translator } from '@/lib/locale';
import type { AltServer, Phase } from './constants';
import { Icon } from './icons';

export interface StateOverlaysProps {
  t: Translator['t'];
  phase: Phase;
  errorMsg: string;
  /** auto-advance countdown seconds (null = not counting) */
  autoAdvSecs: number | null;
  nextName?: string;
  hasServerChoices: boolean;
  altFeedsCount: number;
  familyAlt?: AltServer;
  /** HEVC panel context */
  hevcBlock: { family?: AltServer } | null;
  canSegLadder: boolean;
  mismatch: { sport: string; confidence: number } | null;
  onCancelAutoAdv: () => void;
  onRetry: () => void;
  onOpenServers: () => void;
  onBrowse: () => void;
  onClose: () => void;
  onSelectDataSaver480: () => void;
  onSwitchAlternate: (alt: AltServer) => void;
  onPlayHevcAnyway: () => void;
  onSwitchFeed: () => void;
  onDismissMismatch: () => void;
}

export function StateOverlays(p: StateOverlaysProps) {
  const { t } = p;
  return (
    <>
      {/* ── state overlays (resolving / loading) ─────────────────────────── */}
      {(p.phase === 'resolving' || p.phase === 'loading') && (
        <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60">
          <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-white/15 border-t-zilla-yellow" />
          <p className="text-sm font-bold text-white/70">
            {p.phase === 'resolving' ? t('player.resolving') : t('player.buffering')}
          </p>
          <button
            onClick={p.onClose}
            className="pointer-events-auto mt-1 rounded-full border border-white/25 bg-white/10 px-5 py-2 text-[11px] font-black uppercase tracking-wide text-white transition-colors hover:bg-white/20"
          >
            {t('common.cancel')}
          </button>
        </div>
      )}

      {(p.phase === 'offair' || p.phase === 'error') && (
        <div
          className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center"
          onPointerDown={p.onCancelAutoAdv}
        >
          <div
            className={cn(
              'flex h-14 w-14 items-center justify-center rounded-full',
              p.phase === 'offair' ? 'bg-zilla-yellow/15 text-zilla-yellow' : 'bg-zilla-red/20 text-zilla-red'
            )}
          >
            <span className="h-7 w-7">{p.phase === 'offair' ? Icon.info : Icon.warn}</span>
          </div>
          <div>
            <p className="text-base font-extrabold text-white">
              {p.phase === 'offair' ? t('player.offairTitle') : t('player.unavailable')}
            </p>
            <p className="mx-auto mt-1 max-w-md text-sm font-medium text-white/60">
              {p.phase === 'offair' ? t('player.offairText') : p.errorMsg || t('player.geoText')}
            </p>
          </div>
          {p.autoAdvSecs !== null && (
            <p className="mt-2 text-sm font-black text-zilla-yellow">
              {t('player.upNext', { s: p.autoAdvSecs, name: p.nextName || '' })}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              onClick={p.onRetry}
              className="rounded-full bg-zilla-yellow px-5 py-2.5 text-xs font-black uppercase tracking-wide text-black hover:bg-zilla-yellow-soft"
            >
              {t('common.retry')}
            </button>
            {/* related family feed — an EXPLICIT choice (labeled as a different
                channel), never an automatic hop that silently swaps channels */}
            {p.familyAlt && (
              <button
                onClick={() => p.onSwitchAlternate(p.familyAlt!)}
                className="rounded-full border border-zilla-yellow/50 bg-zilla-yellow/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-zilla-yellow hover:bg-zilla-yellow/20"
                title={t('player.watchInsteadTitle', { name: p.nextName || '' })}
              >
                {t('player.watchInstead', { name: p.familyAlt.name })}
              </button>
            )}
            {p.hasServerChoices && (
              <button
                onClick={p.onOpenServers}
                className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
              >
                {t('player.switchServer')}
              </button>
            )}
            {p.autoAdvSecs !== null && (
              <button
                onClick={p.onCancelAutoAdv}
                className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
              >
                {t('player.cancelAutoSwitch')}
              </button>
            )}
            <button
              onClick={p.onBrowse}
              className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
            >
              {t('player.browseChannels')}
            </button>
            {p.altFeedsCount > 1 && (
              <button
                onClick={p.onBrowse}
                className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
              >
                {t('player.tryAnotherFeed', { n: p.altFeedsCount })}
              </button>
            )}
            <button
              onClick={p.onClose}
              className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {/* ── HEVC-phase choice panel ─────────────────────────────────────────
          The channel is LIVE but broadcasting in a codec this browser can't
          decode. Never a silent swap onto a related feed — the user picks. */}
      {p.hevcBlock && p.phase === 'hevc' && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/88 px-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-full bg-zilla-yellow/15 text-zilla-yellow">
            <span className="h-7 w-7">{Icon.info}</span>
          </div>
          <div>
            <p className="text-base font-extrabold text-white">{t('player.hevcTitle')}</p>
            <p className="mx-auto mt-1 max-w-md text-sm font-medium text-white/60">{t('player.hevcText')}</p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {p.canSegLadder && (
              <button
                onClick={p.onSelectDataSaver480}
                className="rounded-full bg-emerald-400 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-black hover:bg-emerald-300"
                title={t('player.play480Title')}
              >
                {t('player.play480')}
                <span className="ms-1.5 font-bold normal-case tracking-normal opacity-70">
                  ({t('player.play480Note')})
                </span>
              </button>
            )}
            {p.hevcBlock.family && (
              <button
                onClick={() => p.onSwitchAlternate(p.hevcBlock!.family!)}
                className="rounded-full bg-zilla-yellow px-5 py-2.5 text-xs font-black uppercase tracking-wide text-black hover:bg-zilla-yellow-soft"
                title={t('player.watchInsteadTitle', { name: p.nextName || '' })}
              >
                {t('player.watchFamily', { name: p.hevcBlock.family.name })}
                <span className="ms-1.5 font-bold normal-case tracking-normal opacity-70">
                  ({t('player.differentChannel')})
                </span>
              </button>
            )}
            <button
              onClick={p.onPlayHevcAnyway}
              className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
            >
              {t('player.tryAnyway')}
            </button>
            <button
              onClick={p.onRetry}
              className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
            >
              {t('common.retry')}
            </button>
            <button
              onClick={p.onClose}
              className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
            >
              {t('common.close')}
            </button>
          </div>
        </div>
      )}

      {/* content-mismatch banner — "this feed is showing motorsport" (z-30:
          the top bar's gradient box must not swallow its buttons) */}
      {p.mismatch && p.phase === 'playing' && (
        <div className="absolute left-1/2 top-16 z-30 w-[92vw] max-w-lg -translate-x-1/2 rounded-xl border border-zilla-yellow/40 bg-black/90 p-3.5 shadow-2xl backdrop-blur">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zilla-yellow/15 text-zilla-yellow">
              <span className="h-4 w-4">{Icon.info}</span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-extrabold text-zilla-text">
                {t('player.mismatchTitle', { sport: p.mismatch.sport.replace(/_/g, ' ') })}
              </p>
              <p className="mt-0.5 text-[11px] font-medium text-zilla-dim">{t('player.mismatchText')}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {p.altFeedsCount > 1 ? (
                  <button
                    onClick={p.onSwitchFeed}
                    className="rounded-full bg-zilla-yellow px-4 py-1.5 text-[11px] font-black uppercase tracking-wide text-black hover:bg-zilla-yellow-soft"
                  >
                    {t('player.switchFeed')}
                  </button>
                ) : (
                  <button
                    onClick={p.onDismissMismatch}
                    className="rounded-full bg-zilla-yellow px-4 py-1.5 text-[11px] font-black uppercase tracking-wide text-black hover:bg-zilla-yellow-soft"
                  >
                    {t('player.browseChannels')}
                  </button>
                )}
                <button
                  onClick={p.onDismissMismatch}
                  className="rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-[11px] font-black uppercase tracking-wide text-white/80 hover:bg-white/20"
                >
                  {t('player.keepWatching')}
                </button>
              </div>
            </div>
            <button
              onClick={p.onDismissMismatch}
              className="shrink-0 rounded-full p-1 text-zilla-dim hover:text-zilla-text"
              aria-label={t('common.close')}
            >
              <span className="h-3.5 w-3.5">{Icon.close}</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}
