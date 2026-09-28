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

export type TabId = 'sports' | 'others';

const NATIVE_QUALITIES = [
  { h: 1080, label: '1080p', hint: 'Full HD' },
  { h: 720, label: '720p', hint: 'HD' },
  { h: 480, label: '480p', hint: 'default' },
  { h: 360, label: '360p', hint: '' },
];
const SAVER_QUALITIES = [
  { h: 1080, label: '1080p', hint: 'Full HD' },
  { h: 720, label: '720p', hint: 'HD' },
  { h: 480, label: '480p', hint: 'default' },
  { h: 360, label: '360p', hint: '' },
  { h: 244, label: '244p', hint: '' },
  { h: 144, label: '144p', hint: 'ultra low' },
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
  const [zapSpin, setZapSpin] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<PlayerPrefs | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

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

  return (
    <header className="sticky top-0 z-40 border-b border-zilla-line bg-zilla-bg/95 backdrop-blur-md">
      <div className="flex h-16 items-center gap-2 px-3 sm:gap-6 sm:px-6 lg:px-10">
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
            Sports
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
            Others
            <span className={cn('hidden text-[10px] font-bold sm:inline', tab === 'others' ? 'text-black/60' : 'text-zilla-dim')}>
              {totalChannels > 0 ? `${Math.round(totalChannels / 1000)}k+` : ''}
            </span>
          </button>
        </nav>

        <div className="flex-1" />

        {/* search */}
        <button
          onClick={onSearch}
          className="flex shrink-0 items-center gap-2 rounded-full border border-zilla-line bg-zilla-panel px-2.5 py-2 text-xs font-bold text-zilla-dim transition-colors hover:border-white/25 hover:text-zilla-text sm:px-3.5"
          aria-label="Search channels and events"
        >
          <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
            <path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" />
          </svg>
          <span className="hidden md:block">Search</span>
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
            aria-label="Settings"
            aria-expanded={settingsOpen}
          >
            <svg viewBox="0 0 24 24" className="h-4.5 w-4.5" aria-hidden>
              <path
                fill="currentColor"
                d="M19.4 13a7.5 7.5 0 0 0 .1-1 7.5 7.5 0 0 0-.1-1l2.1-1.7a.5.5 0 0 0 .1-.6l-2-3.5a.5.5 0 0 0-.6-.2l-2.5 1a7.7 7.7 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.7a7.7 7.7 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.5a.5.5 0 0 0 .1.6L4.5 11a7.5 7.5 0 0 0-.1 1 7.5 7.5 0 0 0 .1 1l-2.1 1.7a.5.5 0 0 0-.1.6l2 3.5c.1.2.4.3.6.2l2.5-1a7.7 7.7 0 0 0 1.7 1l.4 2.6c0 .3.2.4.5.4h4c.2 0 .5-.2.5-.4l.4-2.6a7.7 7.7 0 0 0 1.7-1l2.5 1c.2.1.5 0 .6-.2l2-3.5a.5.5 0 0 0-.1-.6L19.4 13zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
              />
            </svg>
            <span className="hidden sm:block">Settings</span>
          </button>

          {settingsOpen && (
            <div className="styled-scrollbar absolute right-0 top-12 z-50 max-h-[78vh] w-72 max-w-[88vw] overflow-y-auto rounded-xl border border-zilla-line bg-zilla-bg/97 shadow-2xl backdrop-blur">
              {/* zap — the Pluto signature lives on inside settings */}
              <button
                onClick={() => {
                  setZapSpin(true);
                  setSettingsOpen(false);
                  onZap();
                  setTimeout(() => setZapSpin(false), 700);
                }}
                className="flex w-full items-center gap-3 border-b border-zilla-line/60 px-4 py-3 text-left transition-colors hover:bg-white/5"
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
                  <span className="block text-xs font-black uppercase tracking-wide text-zilla-text">Zap</span>
                  <span className="block text-[10px] font-medium text-zilla-dim">Jump to a random live channel</span>
                </span>
              </button>

              {/* video quality */}
              <p className="border-b border-zilla-line/60 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                Video quality
              </p>
              <button
                onClick={() => pickQuality(-1)}
                className={cn(
                  'flex w-full items-center justify-between px-4 py-2.5 text-xs font-bold transition-colors hover:bg-white/5',
                  prefs?.quality === -1 ? 'text-zilla-yellow' : 'text-zilla-text'
                )}
              >
                <span>
                  Auto
                  <span className="ml-1.5 text-[9px] font-bold text-zilla-dim">network-adaptive</span>
                </span>
                {prefs?.quality === -1 && <span>✓</span>}
              </button>
              <p className="px-4 pb-2 text-[10px] font-medium leading-snug text-zilla-dim">
                Picks the best quality your connection can hold and follows it as it changes.
              </p>
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
                    {q.hint && <span className="ml-1.5 text-[9px] font-bold text-zilla-dim">{q.hint}</span>}
                  </span>
                  {prefs?.quality === q.h && <span>✓</span>}
                </button>
              ))}

              <p className="border-t border-zilla-line/60 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                Quality ladder · transcoded live
              </p>
              {SAVER_QUALITIES.map((q) => (
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
                    {q.hint && <span className="ml-1.5 text-[9px] font-bold text-zilla-dim">{q.hint}</span>}
                  </span>
                  {prefs?.quality === q.h && <span>✓</span>}
                </button>
              ))}
              <p className="px-4 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
                Any height, re-encoded in real time — even heights the provider doesn't offer.
              </p>

              {/* playback behaviour */}
              <p className="border-t border-zilla-line/60 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                Streaming performance
              </p>
              {(
                [
                  {
                    id: 'fast' as const,
                    label: '⚡ Fast start',
                    desc: 'Joins the live edge sooner and buffers less — quickest load, lowest lag. Best for normal connections.',
                  },
                  {
                    id: 'steady' as const,
                    label: '🛡️ Rock steady',
                    desc: 'Deeper buffer that rides out weak Wi-Fi and mobile data — starts a touch slower, rarely stalls.',
                  },
                ] as const
              ).map((m) => {
                const active = (prefs?.perfMode ?? 'fast') === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => updatePrefs({ perfMode: m.id })}
                    className={cn(
                      'flex w-full items-start gap-2.5 px-4 py-2.5 text-left text-xs font-bold transition-colors hover:bg-white/5',
                      active ? 'text-zilla-yellow' : 'text-zilla-text'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block">{m.label}</span>
                      <span className="mt-0.5 block text-[10px] font-medium leading-snug text-zilla-dim">{m.desc}</span>
                    </span>
                    {active && <span className="shrink-0">✓</span>}
                  </button>
                );
              })}
              <p className="px-4 pb-2 text-[10px] font-medium leading-snug text-zilla-dim">
                Applies to every channel from your next stream switch.
              </p>

              <p className="border-t border-zilla-line/60 px-4 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                Playback
              </p>
              <button
                onClick={() => updatePrefs({ autoAdvance: !(prefs?.autoAdvance ?? true) })}
                className="flex w-full items-center justify-between px-4 py-2.5 text-xs font-bold text-zilla-text transition-colors hover:bg-white/5"
              >
                <span>
                  Auto-switch on dead streams
                  <span className="block text-[10px] font-medium text-zilla-dim">Surfs to the next channel after 10s</span>
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
                      prefs?.autoAdvance ?? true ? 'left-[1.15rem]' : 'left-0.5'
                    )}
                  />
                </span>
              </button>

              {/* connection readout */}
              <p className="border-t border-zilla-line/60 px-4 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
                Your connection:{' '}
                <span className="font-bold text-zilla-text">
                  {conn.downlink > 0 ? `~${conn.downlink} Mbps · ${conn.effectiveType}` : conn.effectiveType !== 'unknown' ? conn.effectiveType : 'measuring…'}
                </span>
                {conn.saveData && ' · data saver on'}
                <span className="mt-1 block">Applies to every channel — in the player you can also switch per stream.</span>
              </p>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
