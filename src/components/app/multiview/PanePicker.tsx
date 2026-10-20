'use client';

// ─── Multi-view: the channel picker modal ────────────────────────────────────
// Lists live events + 24/7 channels (+ a search over both), so panes can be
// filled without leaving the grid. Multi-add friendly: rows show an "In grid"
// state and the modal stays open until Done.

import { useEffect, useMemo, useState } from 'react';
import { cn } from '@/lib/utils';
import { logoSrc } from '../ChannelCard';
import type { Playable } from '@/lib/store';
import { Icon } from '../player/icons';
import { fmtAgo } from '../player/utils';
import type { Translator } from '@/lib/locale';

interface PickerRow {
  ch: Playable;
  sub: string;
  live: boolean;
}

export interface PanePickerProps {
  t: Translator['t'];
  open: boolean;
  usedCount: number;
  maxPanes: number;
  inGridIds: Set<string>;
  onPick: (ch: Playable) => void;
  onClose: () => void;
}

export function PanePicker({ t, open, usedCount, maxPanes, inGridIds, onPick, onClose }: PanePickerProps) {
  const [rows, setRows] = useState<PickerRow[] | null>(null);
  const [q, setQ] = useState('');

  // build the picker list once per open (live schedule + 24/7 channels).
  // Fresh state on every open comes from the parent's key-remount — no
  // synchronous setState in the effect.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      const out: PickerRow[] = [];
      try {
        const s = (await fetch('/api/sports/schedule', { cache: 'no-store' }).then((r) => r.json())) as {
          live?: {
            title: string;
            league: string;
            startTime: number;
            channels?: { id: string; name: string; logo?: string }[];
            team1Logo?: string;
            channelLogo?: string;
            leagueLogo?: string;
          }[];
        };
        for (const m of s.live || []) {
          const logo = m.team1Logo || m.channelLogo || m.leagueLogo;
          for (const ch of m.channels?.slice(0, 2) || []) {
            out.push({
              ch: { id: `dl_${ch.id}`, name: m.title, kind: 'daddylive', ref: ch.id, source: m.league, logo: ch.logo || logo },
              sub: `${ch.name}${m.startTime ? ' · ' + fmtAgo(m.startTime, t) : ''}`,
              live: true,
            });
          }
        }
      } catch { /* live list is best-effort */ }
      try {
        const c = (await fetch('/api/sports/channels', { cache: 'no-store' }).then((r) => r.json())) as {
          channels?: { id: string; name: string; kind: 'daddylive'; ref: string; source: string; logo?: string }[];
        };
        for (const ch of (c.channels || []).slice(0, 80)) {
          out.push({
            ch: { id: ch.id, name: ch.name, kind: ch.kind, ref: ch.ref, source: ch.source, logo: ch.logo },
            sub: ch.source,
            live: false,
          });
        }
      } catch { /* channels list is best-effort */ }
      if (alive) setRows(out);
    })();
    return () => {
      alive = false;
    };
  }, [open]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    const needle = q.trim().toLowerCase();
    if (!needle) return rows.slice(0, 60);
    return rows.filter((r) => r.ch.name.toLowerCase().includes(needle) || r.sub.toLowerCase().includes(needle)).slice(0, 60);
  }, [rows, q]);

  if (!open) return null;
  const full = usedCount >= maxPanes;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={t('grid.pickerTitle')}
      onClick={onClose}
    >
      <div
        className="flex max-h-[82vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zilla-line bg-zilla-bg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* header */}
        <div className="border-b border-zilla-line p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-black uppercase tracking-wide text-zilla-text">{t('grid.pickerTitle')}</p>
              <p className="mt-0.5 text-[11px] font-medium text-zilla-dim">{t('grid.pickerHint', { n: usedCount, max: maxPanes })}</p>
            </div>
            <button
              onClick={onClose}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zilla-yellow text-black"
              aria-label={t('common.done')}
            >
              <span className="h-4 w-4">{Icon.close}</span>
            </button>
          </div>
          {/* search */}
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-zilla-line bg-zilla-panel px-3 py-2">
            <svg viewBox="0 0 24 24" className="h-4 w-4 shrink-0 fill-zilla-dim" aria-hidden>
              <path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" />
            </svg>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={t('grid.searchPlaceholder')}
              className="w-full bg-transparent text-sm font-semibold text-zilla-text placeholder:text-zilla-dim/70 focus:outline-none"
            />
          </div>
        </div>

        {/* list */}
        <div className="styled-scrollbar flex-1 overflow-y-auto p-2">
          {!filtered && (
            <div className="flex flex-col items-center gap-3 py-10">
              <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-zilla-line border-t-zilla-yellow" />
              <p className="text-xs font-bold text-zilla-dim">…</p>
            </div>
          )}
          {filtered && filtered.length === 0 && (
            <p className="px-3 py-8 text-center text-xs font-bold text-zilla-dim">{t('search.noResults')} “{q}”</p>
          )}
          {filtered?.map((r, i) => {
            const added = inGridIds.has(r.ch.id);
            return (
              <button
                key={`${r.ch.kind}-${r.ch.ref}-${i}`}
                disabled={full && !added}
                onClick={() => onPick(r.ch)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-start transition-colors',
                  full && !added ? 'cursor-not-allowed opacity-40' : 'hover:bg-white/5',
                  added && 'bg-zilla-yellow/10'
                )}
              >
                {r.ch.logo ? (
                  <img src={logoSrc(r.ch.logo, r.ch.name)} alt="" loading="lazy" className="h-8 w-12 shrink-0 rounded object-contain" />
                ) : (
                  <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-white/5 text-[10px] font-black text-zilla-dim">
                    {r.live ? '●' : 'TV'}
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-bold text-zilla-text">{r.ch.name}</span>
                  <span className="block truncate text-[10px] font-medium text-zilla-dim">{r.sub}</span>
                </span>
                {r.live && (
                  <span className="shrink-0 rounded bg-zilla-red px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
                    {t('common.live')}
                  </span>
                )}
                {added ? (
                  <span className="shrink-0 rounded-full bg-zilla-yellow/20 px-2.5 py-1 text-[9px] font-black uppercase text-zilla-yellow">
                    {t('grid.added')}
                  </span>
                ) : (
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-zilla-dim">
                    <span className="h-3.5 w-3.5">{Icon.plus}</span>
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
