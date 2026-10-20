'use client';

// ─── Player module: the quality menu (presentational) ────────────────────────
// Extracted from the old PlayerOverlay monolith. All state lives in the
// parent — this component renders the native rungs, "via <source>" alternate
// rungs and the data-saver ladder, RTL-aware.

import { cn } from '@/lib/utils';
import type { Translator } from '@/lib/locale';
import type { AltServer } from './constants';
import { rungHint } from './utils';

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
  onSetLevel: (level: number) => void;
  onSelectDataSaver: (height: number) => void;
  onPickAltRung: (alt: AltServer, height: number) => void;
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
  onSetLevel,
  onSelectDataSaver,
  onPickAltRung,
}: QualityMenuProps) {
  return (
    <div className="styled-scrollbar absolute end-0 top-11 z-30 max-h-[70vh] w-48 overflow-y-auto rounded-xl border border-zilla-line bg-zilla-bg/95 shadow-2xl backdrop-blur">
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
                </span>
                <span className="text-[9px] font-bold text-zilla-dim">{ladderAlt.sourceName}</span>
              </button>
            ))}
          <p className="px-3.5 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
            {t('player.altRungNote', { source: ladderAlt.sourceName })}
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
