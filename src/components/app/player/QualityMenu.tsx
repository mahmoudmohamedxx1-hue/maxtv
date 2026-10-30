'use client';

// ─── Player module: the quality menu (presentational) ────────────────────────
// Extracted from the old PlayerOverlay monolith. All state lives in the
// parent — this component renders the native rungs, "via <source>" alternate
// rungs and the data-saver ladder, RTL-aware.

import { cn } from '@/lib/utils';
import type { Translator } from '@/lib/locale';
import type { AltServer } from './constants';
import { rungHint, rungMBPerMin } from './utils';

export interface QualityMenuProps {
  t: Translator['t'];
  quality: { label: string; level: number }[];
  currentQuality: number;
  tcHeight: number | null;
  canDataSaver: boolean;
  dsHeights: readonly number[];
  ladderAlt: AltServer | null;
  ladderRungs: number[];
  singleQuality: boolean;
  segLadder: boolean;
  /** daddylive channel (or an alternate with a signed transcode source) */
  canLadderTranscode: boolean;
  /** Local Turbo (client-side pipeline) — offered + active state */
  canLocalTurbo: boolean;
  localTurboHeights: number[];
  localTurboHeight: number | null;
  onSetLevel: (level: number) => void;
  onSelectDataSaver: (height: number) => void;
  onPickAltRung: (alt: AltServer, height: number) => void;
  onPickLocalTurbo: (height: number) => void;
  onExitLocalTurbo: () => void;
  /** Data Saver master toggle (2026-10-31) — state, handler and what it
   *  does on THIS channel: 'alt' = lowest alternate rung, 'transcode' =
   *  re-encoded rung, 'buffer' = buffering trim only (single rendition) */
  dataSaver: boolean;
  onToggleDataSaver: () => void;
  dsChannelEffect: 'alt' | 'transcode' | 'buffer';
}

export function QualityMenu({
  t,
  quality,
  currentQuality,
  tcHeight,
  canDataSaver,
  dsHeights,
  ladderAlt,
  ladderRungs,
  singleQuality,
  segLadder,
  canLadderTranscode,
  canLocalTurbo,
  localTurboHeights,
  localTurboHeight,
  onSetLevel,
  onSelectDataSaver,
  onPickAltRung,
  onPickLocalTurbo,
  onExitLocalTurbo,
  dataSaver,
  onToggleDataSaver,
  dsChannelEffect,
}: QualityMenuProps) {
  return (
    <div className="styled-scrollbar absolute end-0 top-11 z-30 max-h-[70vh] w-48 overflow-y-auto rounded-xl border border-zilla-line bg-zilla-bg/95 shadow-2xl backdrop-blur">
      <button
        onClick={onToggleDataSaver}
        className={cn(
          'flex w-full items-center justify-between gap-2.5 border-b border-zilla-line/60 px-3.5 py-2.5 text-start transition-colors hover:bg-white/10',
          dataSaver ? 'text-emerald-300' : 'text-zilla-text'
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-black">{t('player.dsToggle')}</span>
          <span className="mt-0.5 block text-[10px] font-medium leading-snug text-zilla-dim">
            {t('player.dsToggleNote')}
          </span>
        </span>
        <span
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-full transition-colors',
            dataSaver ? 'bg-emerald-500' : 'bg-white/15'
          )}
        >
          <span
            className={cn(
              'absolute top-0.5 h-4 w-4 rounded-full bg-black transition-all',
              dataSaver ? 'start-[1.15rem]' : 'start-0.5'
            )}
          />
        </span>
      </button>
      {dataSaver && (
        <p className="border-b border-zilla-line/60 bg-emerald-500/5 px-3.5 py-1.5 text-[10px] font-medium leading-snug text-emerald-300/90">
          {t(
            dsChannelEffect === 'alt'
              ? 'player.dsEffectAlt'
              : dsChannelEffect === 'transcode'
                ? 'player.dsEffectTc'
                : 'player.dsEffectBuffer'
          )}
        </p>
      )}
      <p className="border-b border-zilla-line/60 px-3.5 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
        {t('player.streamQuality')}
      </p>
      <button
        onClick={() => onSetLevel(-1)}
        className={cn(
          'flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-bold transition-colors hover:bg-white/10',
          currentQuality === -1 && tcHeight === null ? 'text-zilla-yellow' : 'text-zilla-text'
        )}
      >
        {t('player.auto')} {currentQuality === -1 && tcHeight === null && <span>✓</span>}
      </button>
      <p className="px-3.5 pb-1.5 text-[10px] font-medium leading-snug text-zilla-dim">{t('player.autoNote')}</p>
      {quality.map((q) => (
        <button
          key={q.level}
          onClick={() => onSetLevel(q.level)}
          className={cn(
            'flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-bold transition-colors hover:bg-white/10',
            currentQuality === q.level && tcHeight === null ? 'text-zilla-yellow' : 'text-zilla-text'
          )}
        >
          {q.label} {currentQuality === q.level && tcHeight === null && <span>✓</span>}
        </button>
      ))}
      {singleQuality && ladderRungs.length === 0 && (
        <p className="px-3.5 py-1.5 text-[10px] font-medium leading-snug text-zilla-dim">
          {t('player.singleQualityNote')}
        </p>
      )}

      {ladderAlt && ladderRungs.length > 0 && (
        <>
          <p className="border-t border-zilla-line/60 px-3.5 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
            {t('player.moreQualitiesVia', { source: ladderAlt.sourceName })}
          </p>
          {ladderRungs
            .slice()
            .reverse()
            .map((h) => (
              <button
                key={`${ladderAlt.id}-${h}`}
                onClick={() => onPickAltRung(ladderAlt, h)}
                className="flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-bold text-zilla-text transition-colors hover:bg-white/10"
              >
                <span>
                  {h}p
                  {rungHint(h, t) && <span className="ms-1.5 text-[9px] font-bold text-zilla-dim">{rungHint(h, t)}</span>}
                  {rungMBPerMin(h) !== null && (
                    <span className="ms-1.5 text-[9px] font-bold text-emerald-400/80">
                      ≈{rungMBPerMin(h)} MB/min
                    </span>
                  )}
                </span>
                <span className="text-[9px] font-bold text-zilla-dim">{ladderAlt.sourceName}</span>
              </button>
            ))}
          <p className="px-3.5 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
            {t('player.altRungNote', { source: ladderAlt.sourceName })}
          </p>
        </>
      )}

      {canLocalTurbo && localTurboHeights.length > 0 && (
        <>
          <p className="border-t border-zilla-line/60 px-3.5 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
            {t('player.localTurboSection')}
          </p>
          {localTurboHeights.map((h) => (
            <button
              key={`turbo-${h}`}
              onClick={() => onPickLocalTurbo(h)}
              className={cn(
                'flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-bold transition-colors hover:bg-white/10',
                localTurboHeight === h ? 'text-zilla-yellow' : 'text-zilla-text'
              )}
            >
              <span>
                {h === 0 ? t('player.sourceRung') : `${h}p`}
                <span className="ms-1.5 text-[9px] font-bold text-zilla-dim">{t('player.turboChip')}</span>
              </span>
              {localTurboHeight === h && <span>✓</span>}
            </button>
          ))}
          {localTurboHeight !== null && (
            <button
              onClick={onExitLocalTurbo}
              className="w-full px-3.5 py-2 text-start text-[10px] font-bold text-zilla-yellow/80 transition-colors hover:text-zilla-yellow"
            >
              {t('player.localTurboExit')}
            </button>
          )}
          <p className="px-3.5 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
            {t('player.localTurboNote')}
          </p>
        </>
      )}

      {canLadderTranscode && !canDataSaver && ladderRungs.length === 0 && (
        <>
          <p className="border-t border-zilla-line/60 px-3.5 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
            {t('player.dataSaverSection')}
          </p>
          <p className="px-3.5 pb-2 pt-1 text-[10px] font-medium leading-snug text-zilla-dim">
            {t('player.dsUnavailableHere')}
          </p>
        </>
      )}

      {canDataSaver && (
        <>
          <p className="border-t border-zilla-line/60 px-3.5 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
            {t('player.dataSaverSection')}
          </p>
          {dsHeights.map((h) => (
            <button
              key={h}
              onClick={() => onSelectDataSaver(h)}
              className={cn(
                'flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-bold transition-colors hover:bg-white/10',
                tcHeight === h ? 'text-zilla-yellow' : 'text-zilla-text'
              )}
            >
              <span>
                {h}p
                {rungHint(h, t) && <span className="ms-1.5 text-[9px] font-bold text-zilla-dim">{rungHint(h, t)}</span>}
                {rungMBPerMin(h) !== null && (
                  <span className="ms-1.5 text-[9px] font-bold text-emerald-400/80">
                    ≈{rungMBPerMin(h)} MB/min
                  </span>
                )}
              </span>
              {tcHeight === h && <span>✓</span>}
            </button>
          ))}
          {tcHeight !== null && (
            <button
              onClick={() => onSetLevel(-1)}
              className="w-full px-3.5 py-2 text-start text-[10px] font-bold text-zilla-yellow/80 transition-colors hover:text-zilla-yellow"
            >
              {t('player.backToNative')}
            </button>
          )}
          <p className="px-3.5 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
            {segLadder ? t('player.dsNoteSeg') : t('player.dsNoteRelay')}
          </p>
        </>
      )}

      <p className="border-t border-zilla-line/60 px-3.5 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
        {t('player.choiceSaved')}
      </p>
    </div>
  );
}
