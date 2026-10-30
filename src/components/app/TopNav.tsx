'use client';

import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import {
  loadPrefs,
  updatePrefs,
  onPrefsChange,
  readConnection,
  type PlayerPrefs,
} from '@/lib/player-settings';
import { useT, useLocale } from '@/lib/locale';
import { usePwa } from '@/lib/pwa';
import { useTV } from '@/lib/store';
import { Icon } from './player/icons';

export type TabId = 'sports' | 'others';

const NATIVE_QUALITIES = [
  { h: 1080, label: '1080p', hintKey: 'player.rung.fullHd' },
  { h: 720, label: '720p', hintKey: 'player.rung.hd' },
  { h: 480, label: '480p', hintKey: '' },
  { h: 360, label: '360p', hintKey: '' },
];
const SAVER_QUALITIES = [
  { h: 1080, label: '1080p', hintKey: 'player.rung.fullHd' },
  { h: 720, label: '720p', hintKey: 'player.rung.hd' },
  { h: 480, label: '480p', hintKey: '' },
  { h: 360, label: '360p', hintKey: '' },
  { h: 244, label: '244p', hintKey: '' },
  { h: 144, label: '144p', hintKey: 'player.rung.ultraLow' },
];

export function TopNav({
  tab,
  onTab,
  onSearch,
  onZap,
  liveCount,
  totalChannels,
}: {
  tab: TabId;
  onTab: (t: TabId) => void;
  onSearch: () => void;
  onZap: () => void;
  liveCount: number;
  totalChannels: number;
}) {
  const { t } = useT();
  const { locale, setLocale } = useLocale();
  const pwa = usePwa();
  const { openGrid, gridPanes } = useTV();
  const [zapSpin, setZapSpin] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<PlayerPrefs | null>(null);
  const [tcCap, setTcCap] = useState(true); // server transcoding capability
  const menuRef = useRef<HTMLDivElement>(null);

  // probe once whether this deployment can transcode (data-saver ladder).
  const [segLadder, setSegLadder] = useState(false);
  useEffect(() => {
    let alive = true;
    fetch('/api/turbo?mode=cap')
      .then((r) => r.json())
      .then((d: { cap?: boolean; seg?: boolean }) => {
        if (!alive) return;
        setTcCap(d.cap === true || d.seg === true);
        setSegLadder(d.seg === true && d.cap !== true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  // prefs arrive through the shared settings events (player ↔ settings menu)
  useEffect(() => onPrefsChange(setPrefs), []);

  // click-outside closes the settings menu
  useEffect(() => {
    if (!settingsOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [settingsOpen]);

  const conn = readConnection();

  const pickQuality = (h: number) => {
    updatePrefs({ quality: h, autoPicked: false });
  };

  /** cycle EN → AR (→ EN) — the pill shows the language you'd switch TO */
  const nextLocale = locale === 'en' ? 'ar' : 'en';
  const nextLocaleLabel = nextLocale === 'ar' ? 'العربية' : 'English';

  return (
    <header className="sticky top-0 z-40 border-b border-zilla-line bg-zilla-bg/95 backdrop-blur-md">
      <div className="flex h-16 items-center gap-2 px-3 sm:gap-4 sm:px-6 lg:px-10">
        {/* logo — the real MaxTV mark + wordmark, big and leading the header */}
        <button
          onClick={() => onTab('sports')}
          className="group flex shrink-0 items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zilla-yellow"
          aria-label="MaxTV home"
        >
          <img
            src="/maxtv-logo.png"
            alt="MaxTV"
            draggable={false}
            className="h-10 w-auto drop-shadow-[0_0_12px_rgba(255,200,0,0.18)] transition-transform duration-200 group-hover:scale-[1.04] sm:h-12"
          />
        </button>

        {/* tabs */}
        <nav className="flex items-center gap-1 sm:gap-1.5" role="tablist" aria-label="Main navigation">
          <button
            role="tab"
            aria-selected={tab === 'sports'}
            onClick={() => onTab('sports')}
            className={cn(
              'flex items-center gap-1 rounded-full px-2.5 py-2 text-[11px] font-extrabold uppercase tracking-wide transition-colors sm:gap-1.5 sm:px-4 sm:text-[13px]',
              tab === 'sports'
                ? 'bg-zilla-yellow text-black'
                : 'text-zilla-dim hover:bg-white/5 hover:text-zilla-text'
            )}
          >
            <span aria-hidden>⚽</span>
            {t('common.sports')}
            {liveCount > 0 && (
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-[10px] font-black',
                  tab === 'sports' ? 'bg-black/20 text-black' : 'bg-zilla-red text-white'
                )}
              >
                {liveCount}
              </span>
            )}
          </button>
          <button
            role="tab"
            aria-selected={tab === 'others'}
            onClick={() => onTab('others')}
            className={cn(
              'flex items-center gap-1 rounded-full px-2.5 py-2 text-[11px] font-extrabold uppercase tracking-wide transition-colors sm:gap-1.5 sm:px-4 sm:text-[13px]',
              tab === 'others'
                ? 'bg-zilla-yellow text-black'
                : 'text-zilla-dim hover:bg-white/5 hover:text-zilla-text'
            )}
          >
            <span aria-hidden>📺</span>
            {t('common.others')}
            <span className={cn('hidden text-[10px] font-bold sm:inline', tab === 'others' ? 'text-black/60' : 'text-zilla-dim')}>
              {totalChannels > 0 ? `${Math.round(totalChannels / 1000)}k+` : ''}
            </span>
          </button>
        </nav>

        <div className="flex-1" />

        {/* multi-view grid */}
        <button
          onClick={openGrid}
          className="relative flex shrink-0 items-center gap-1.5 rounded-full border border-zilla-line bg-zilla-panel px-2.5 py-2 text-[11px] font-black uppercase tracking-wide text-zilla-dim transition-colors hover:border-white/25 hover:text-zilla-text"
          title={t('grid.open')}
          aria-label={t('grid.open')}
        >
          <span className="h-4 w-4">{Icon.grid}</span>
          {gridPanes.length > 0 && (
            <span className="absolute -end-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-zilla-red text-[9px] font-black text-white">
              {gridPanes.length}
            </span>
          )}
        </button>

        {/* PWA install — only when the browser offers it (or iOS hint) */}
        {(pwa.canInstall || (pwa.ios && !pwa.standalone)) && (
          <button
            onClick={() => {
              if (pwa.canInstall) void pwa.prompt();
              else onSearch(); // iOS: no prompt API — point at the share flow via search hint
            }}
            className="hidden shrink-0 items-center gap-1.5 rounded-full border border-zilla-yellow/50 bg-zilla-yellow/10 px-2.5 py-2 text-[11px] font-black uppercase tracking-wide text-zilla-yellow transition-colors hover:bg-zilla-yellow/20 sm:flex"
            title={t('nav.installHint')}
            aria-label={t('nav.install')}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
              <path d="M11 2h2v10h-2V2zm4.6 2.6 1.4 1.4L14.4 8 13 6.6l2.6-2zM7 6 8.4 4.6 11 7.2 9.6 8.6 7 6zm-2 9h14v2h-6v5h-2v-5H5v-2z" transform="rotate(180 12 12)" />
            </svg>
            <span className="hidden md:block">{t('nav.install')}</span>
          </button>
        )}

        {/* language toggle — shows the language you'd switch TO */}
        <button
          onClick={() => setLocale(nextLocale)}
          className="flex shrink-0 items-center gap-1.5 rounded-full border border-zilla-line bg-zilla-panel px-2.5 py-2 text-[11px] font-black uppercase tracking-wide text-zilla-dim transition-colors hover:border-white/25 hover:text-zilla-text"
          title={t('nav.language')}
          aria-label={t('nav.language')}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
            <path d="M12.9 15l-2.6-2.5.02-.02A17.9 17.9 0 0 0 13.9 7H17V5h-7V3H8v2H1v2h11.2A15.9 15.9 0 0 1 9 11.1 15.9 15.9 0 0 1 6.8 8H4.8a17.9 17.9 0 0 0 2.7 4.4L3.5 16.3l1.4 1.4L10 12.6l3.5 3.5.4-1.1zM18.5 10h-2L12 22h2l1.1-3h4.8l1.1 3h2l-4.5-12zm-2.6 7 1.6-4.3 1.6 4.3h-3.2z" />
          </svg>
          {nextLocaleLabel}
        </button>

        {/* search */}
        <button
          onClick={onSearch}
          className="flex shrink-0 items-center gap-2 rounded-full border border-zilla-line bg-zilla-panel px-2.5 py-2 text-xs font-bold text-zilla-dim transition-colors hover:border-white/25 hover:text-zilla-text sm:px-3.5"
          aria-label={t('nav.searchLabel')}
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
            <path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" />
          </svg>
          <span className="hidden md:block">{t('common.search')}</span>
        </button>

        {/* settings — quality, data saver, zap */}
        <div className="relative" ref={menuRef}>
          <button
            onClick={() => {
              setPrefs(loadPrefs()); // fresh read at open-time (event handler — safe)
              setSettingsOpen((s) => !s);
            }}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-2 text-[11px] font-black uppercase tracking-wide transition-transform hover:scale-105 sm:px-3.5 sm:text-xs',
              settingsOpen ? 'bg-white/15 text-white' : 'bg-zilla-yellow text-black shadow-[0_0_18px_rgba(255,210,0,0.3)]'
            )}
            aria-label={t('common.settings')}
            aria-expanded={settingsOpen}
          >
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden>
              <path
                fill="currentColor"
                d="M19.4 13a7.5 7.5 0 0 0 .1-1 7.5 7.5 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.5 11a7.5 7.5 0 0 0-.1 1 7.5 7.5 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.6c0 .3.2.4.5.4h4c.2 0 .5-.2.5-.4l.4-2.6a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
              />
            </svg>
            <span className="hidden sm:block">{t('common.settings')}</span>
          </button>

          {settingsOpen && (
            <div className="styled-scrollbar absolute end-0 top-12 z-50 max-h-[78vh] w-72 max-w-[88vw] overflow-y-auto rounded-xl border border-zilla-line bg-zilla-bg/97 shadow-2xl backdrop-blur">
              {/* zap — the Pluto signature lives on inside settings */}
              <button
                onClick={() => {
                  setZapSpin(true);
                  setSettingsOpen(false);
                  onZap();
                  setTimeout(() => setZapSpin(false), 700);
                }}
                className="flex w-full items-center gap-3 border-b border-zilla-line/60 px-4 py-3 text-start transition-colors hover:bg-white/5"
              >
                <span
                  className={cn(
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-zilla-yellow text-black',
                    zapSpin && 'rotate-180 transition-transform'
                  )}
                >
                  <svg viewBox="0 0 100 100" className="h-5 w-5" aria-hidden>
                    <path
                      d="M18 82 L18 18 L36 18 L50 42 L64 18 L82 18 L82 82 L68 82 L68 50 L50 76 L32 50 L32 82 Z"
                      fill="#0b0c0f"
                    />
                  </svg>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-black uppercase tracking-wide text-zilla-text">{t('settings.zap')}</span>
                  <span className="block text-[10px] font-medium text-zilla-dim">{t('settings.zapDesc')}</span>
                </span>
              </button>

              {/* video quality */}
              <p className="border-b border-zilla-line/60 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                {t('settings.videoQuality')}
              </p>
              <button
                onClick={() => pickQuality(-1)}
                className={cn(
                  'flex w-full items-center justify-between px-4 py-2.5 text-xs font-bold transition-colors hover:bg-white/5',
                  prefs?.quality === -1 ? 'text-zilla-yellow' : 'text-zilla-text'
                )}
              >
                <span>
                  {t('settings.auto')}
                  <span className="ms-1.5 text-[9px] font-bold text-zilla-dim">{t('settings.mostStable')}</span>
                </span>
                {prefs?.quality === -1 && <span>✓</span>}
              </button>
              <p className="px-4 pb-2 text-[10px] font-medium leading-snug text-zilla-dim">{t('settings.autoDesc')}</p>
              {NATIVE_QUALITIES.map((q) => (
                <button
                  key={q.h}
                  onClick={() => pickQuality(q.h)}
                  className={cn(
                    'flex w-full items-center justify-between px-4 py-2.5 text-xs font-bold transition-colors hover:bg-white/5',
                    prefs?.quality === q.h ? 'text-zilla-yellow' : 'text-zilla-text'
                  )}
                >
                  <span>
                    {q.label}
                    {q.hintKey && <span className="ms-1.5 text-[9px] font-bold text-zilla-dim">{t(q.hintKey)}</span>}
                  </span>
                  {prefs?.quality === q.h && <span>✓</span>}
                </button>
              ))}

              <p className="border-t border-zilla-line/60 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                {t('settings.dataSaver')}
              </p>
              {/* Data Saver master toggle (2026-10-31) — one switch for slow
                  networks: lowest rung + lowest-variant ABR + tight buffer */}
              <button
                onClick={() => updatePrefs({ dataSaver: !(prefs?.dataSaver ?? false) })}
                className="flex w-full items-center justify-between gap-2.5 px-4 py-2.5 text-start transition-colors hover:bg-white/5"
              >
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-xs font-bold', prefs?.dataSaver ? 'text-emerald-300' : 'text-zilla-text')}>
                    {t('settings.dsToggle')}
                  </span>
                  <span className="mt-0.5 block text-[10px] font-medium leading-snug text-zilla-dim">
                    {t('settings.dsToggleDesc')}
                  </span>
                </span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                    prefs?.dataSaver ? 'bg-emerald-500' : 'bg-white/15'
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-4 w-4 rounded-full bg-black transition-all',
                      prefs?.dataSaver ? 'start-[1.15rem]' : 'start-0.5'
                    )}
                  />
                </span>
              </button>
              {!tcCap && (
                <p className="px-4 pb-1.5 pt-1 text-[10px] font-medium leading-snug text-zilla-yellow/80">
                  {t('settings.dsUnavailable')}
                </p>
              )}
              {SAVER_QUALITIES.filter((q) => !segLadder || q.h <= 480).map((q) => (
                <button
                  key={q.h}
                  onClick={() => pickQuality(q.h)}
                  className={cn(
                    'flex w-full items-center justify-between px-4 py-2.5 text-xs font-bold transition-colors hover:bg-white/5',
                    prefs?.quality === q.h ? 'text-zilla-yellow' : 'text-zilla-text'
                  )}
                >
                  <span>
                    {q.label}
                    {q.hintKey && <span className="ms-1.5 text-[9px] font-bold text-zilla-dim">{t(q.hintKey)}</span>}
                  </span>
                  {prefs?.quality === q.h && <span>✓</span>}
                </button>
              ))}
              <p className="px-4 py-2 text-[10px] font-medium leading-snug text-zilla-dim">{t('settings.dsNote')}</p>

              {/* playback behaviour */}
              <p className="border-t border-zilla-line/60 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                {t('settings.perfTitle')}
              </p>
              <button
                onClick={() => updatePrefs({ perfMode: 'fast' })}
                className={cn(
                  'flex w-full items-start gap-2.5 px-4 py-2.5 text-start text-xs font-bold transition-colors hover:bg-white/5',
                  (prefs?.perfMode ?? 'fast') === 'fast' ? 'text-zilla-yellow' : 'text-zilla-text'
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block">{t('settings.perfFast')}</span>
                  <span className="mt-0.5 block text-[10px] font-medium leading-snug text-zilla-dim">{t('settings.perfFastDesc')}</span>
                </span>
                {(prefs?.perfMode ?? 'fast') === 'fast' && <span className="shrink-0">✓</span>}
              </button>
              <button
                onClick={() => updatePrefs({ perfMode: 'steady' })}
                className={cn(
                  'flex w-full items-start gap-2.5 px-4 py-2.5 text-start text-xs font-bold transition-colors hover:bg-white/5',
                  (prefs?.perfMode ?? 'fast') === 'steady' ? 'text-zilla-yellow' : 'text-zilla-text'
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block">{t('settings.perfSteady')}</span>
                  <span className="mt-0.5 block text-[10px] font-medium leading-snug text-zilla-dim">{t('settings.perfSteadyDesc')}</span>
                </span>
                {(prefs?.perfMode ?? 'fast') === 'steady' && <span className="shrink-0">✓</span>}
              </button>
              <p className="px-4 pb-2 text-[10px] font-medium leading-snug text-zilla-dim">{t('settings.appliesNextSwitch')}</p>

              <p className="border-t border-zilla-line/60 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                {t('settings.playback')}
              </p>
              <button
                onClick={() => updatePrefs({ autoAdvance: !(prefs?.autoAdvance ?? true) })}
                className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-bold text-zilla-text transition-colors hover:bg-white/5"
              >
                <span>
                  {t('settings.autoAdvance')}
                  <span className="block text-[10px] font-medium text-zilla-dim">{t('settings.autoAdvanceDesc')}</span>
                </span>
                <span
                  className={cn(
                    'relative h-5 w-9 shrink-0 rounded-full transition-colors',
                    prefs?.autoAdvance ?? true ? 'bg-zilla-yellow' : 'bg-white/15'
                  )}
                >
                  <span
                    className={cn(
                      'absolute top-0.5 h-4 w-4 rounded-full bg-black transition-all',
                      prefs?.autoAdvance ?? true ? 'start-[1.15rem]' : 'start-0.5'
                    )}
                  />
                </span>
              </button>

              {/* connection readout */}
              <p className="border-t border-zilla-line/60 px-4 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
                {t('settings.connection')}{' '}
                <span className="font-bold text-zilla-text">
                  {conn.downlink > 0
                    ? `~${conn.downlink} Mbps · ${conn.effectiveType}`
                    : conn.effectiveType !== 'unknown'
                      ? conn.effectiveType
                      : t('settings.connMeasuring')}
                </span>
                {conn.saveData && ` · ${t('settings.dataSaverOn')}`}
                <span className="mt-1 block">{t('settings.appliesEveryChannel')}</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
