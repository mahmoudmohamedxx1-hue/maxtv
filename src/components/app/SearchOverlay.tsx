'use client';

import { useEffect, useRef, useState } from 'react';
import { useTV, type Playable } from '@/lib/store';
import { cn } from '@/lib/utils';

interface SearchResult {
  matches: {
    id: string;
    title: string;
    league: string;
    status: 'live' | 'upcoming';
    startTime: number;
    channels: { id: string; name: string }[];
  }[];
  sports: { id: string; name: string; kind: 'daddylive'; ref: string; logo?: string }[];
  channels: {
    id: string;
    name: string;
    logo?: string;
    kind: 'iptv';
    ref: string;
    source: string;
    category: string;
  }[];
}

const EMPTY: SearchResult = { matches: [], sports: [], channels: [] };

export function SearchOverlay({
  open,
  onClose,
  onPlay,
}: {
  open: boolean;
  onClose: () => void;
  onPlay: (ch: Playable, fromSearch?: boolean) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult>(EMPTY);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 60);
    } else {
      setQ('');
      setResults(EMPTY);
    }
  }, [open]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // debounce search
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults(EMPTY);
      return;
    }
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`);
        const data = (await res.json()) as Partial<SearchResult>;
        setResults({ matches: data.matches || [], sports: data.sports || [], channels: data.channels || [] });
      } catch {
        setResults(EMPTY);
      } finally {
        setLoading(false);
      }
    }, 280);
    return () => clearTimeout(t);
  }, [q]);

  if (!open) return null;

  const total = results.matches.length + results.sports.length + results.channels.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/85 p-3 backdrop-blur-md sm:p-8"
      role="dialog"
      aria-modal="true"
      aria-label="Search"
      onClick={onClose}
    >
      <div
        className="flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zilla-line bg-zilla-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* input */}
        <div className="flex items-center gap-3 border-b border-zilla-line px-4 py-3.5">
          <svg viewBox="0 0 24 24" className="h-5 w-5 shrink-0 fill-zilla-dim" aria-hidden>
            <path d="M15.5 14h-.8l-.3-.3a6.5 6.5 0 1 0-.7.7l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z" />
          </svg>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search live events, sports channels, TV channels…"
            className="w-full bg-transparent text-base font-semibold text-zilla-text placeholder:text-zilla-dim/70 focus:outline-none"
            aria-label="Search query"
          />
          {loading && <div className="h-4 w-4 shrink-0 animate-spin rounded-full border-2 border-zilla-line border-t-zilla-yellow" />}
          <button onClick={onClose} className="shrink-0 rounded-full bg-zilla-line p-1.5 text-zilla-dim hover:text-zilla-text" aria-label="Close search">
            <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
              <path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4z" />
            </svg>
          </button>
        </div>

        {/* results */}
        <div className="styled-scrollbar min-h-0 flex-1 overflow-y-auto p-2">
          {q.trim().length < 2 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-4xl">🔍</p>
              <p className="mt-3 text-sm font-bold text-zilla-dim">
                Type at least 2 characters to search 12,000+ channels & live events
              </p>
            </div>
          ) : !loading && total === 0 ? (
            <div className="px-4 py-10 text-center">
              <p className="text-4xl">📡</p>
              <p className="mt-3 text-sm font-bold text-zilla-dim">No results for “{q}”</p>
            </div>
          ) : (
            <>
              {results.matches.length > 0 && (
                <Section title="Live & upcoming events">
                  {results.matches.map((m) => (
                    <button
                      key={m.id}
                      onClick={() =>
                        m.channels[0] &&
                        onPlay({
                          id: `dl_${m.channels[0].id}`,
                          name: `${m.title} — ${m.channels[0].name}`,
                          kind: 'daddylive',
                          ref: m.channels[0].id,
                          source: m.league,
                        })
                      }
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/5"
                    >
                      {m.status === 'live' ? (
                        <span className="shrink-0 rounded-md bg-zilla-red px-1.5 py-1 text-[10px] font-black uppercase text-white">Live</span>
                      ) : (
                        <span className="shrink-0 rounded-md bg-zilla-line px-1.5 py-1 text-[10px] font-black uppercase text-zilla-dim">
                          {new Date(m.startTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-zilla-text">{m.title}</span>
                        <span className="block truncate text-xs font-medium text-zilla-dim">{m.league}</span>
                      </span>
                      <span className="shrink-0 text-xs font-bold text-zilla-dim">{m.channels.length} feeds</span>
                    </button>
                  ))}
                </Section>
              )}

              {results.sports.length > 0 && (
                <Section title="Sports channels">
                  {results.sports.map((c) => (
                    <button
                      key={c.id}
                      onClick={() =>
                        onPlay({ id: c.id, name: c.name, logo: c.logo, kind: 'daddylive', ref: c.ref, source: 'DaddyLive 24/7' })
                      }
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/5"
                    >
                      <span className="flex h-9 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md bg-zilla-card">
                        {c.logo ? (
                          <img src={`/api/img?u=${encodeURIComponent(c.logo)}&t=${encodeURIComponent(c.name)}&c=ffd200`} alt="" className="h-full w-full object-contain p-1" loading="lazy" />
                        ) : (
                          <span aria-hidden>🏟️</span>
                        )}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-bold text-zilla-text">{c.name}</span>
                    </button>
                  ))}
                </Section>
              )}

              {results.channels.length > 0 && (
                <Section title="TV channels">
                  {results.channels.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => onPlay({ id: c.id, name: c.name, logo: c.logo, kind: 'iptv', ref: c.ref, source: c.source })}
                      className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left hover:bg-white/5"
                    >
                      {c.logo ? (
                        <img src={`/api/img?u=${encodeURIComponent(c.logo)}&t=${encodeURIComponent(c.name)}&c=ffd200`} alt="" className="h-9 w-14 shrink-0 rounded-md bg-zilla-card object-contain p-1" loading="lazy" />
                      ) : (
                        <span className="flex h-9 w-14 shrink-0 items-center justify-center rounded-md bg-zilla-card text-zilla-dim">TV</span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-bold text-zilla-text">{c.name}</span>
                        <span className="block truncate text-xs font-medium text-zilla-dim">{c.source} · {c.category}</span>
                      </span>
                    </button>
                  ))}
                </Section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-2">
      <p className="px-3 pb-1 pt-2 text-[11px] font-black uppercase tracking-widest text-zilla-dim">{title}</p>
      {children}
    </section>
  );
}
