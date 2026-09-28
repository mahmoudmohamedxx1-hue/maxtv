'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTV, type Playable } from '@/lib/store';
import { ChannelCard } from './ChannelCard';
import { CategoryPills } from './CategoryPills';
import { cn } from '@/lib/utils';

interface CatalogResponse {
  categories: { id: string; name: string; count: number }[];
  sources: { id: string; name: string; count: number; health?: string }[];
  total: number;
}

interface ChannelItem extends Playable {
  chno?: string;
  sourceName?: string;
}

const PAGE = 60;

export function OthersTab({ onPlayChannel }: { onPlayChannel: (ch: Playable) => void }) {
  const { favorites, recents } = useTV();
  const [catalog, setCatalog] = useState<CatalogResponse | null>(null);
  const [category, setCategory] = useState('all');
  const [source, setSource] = useState('');
  const [channels, setChannels] = useState<ChannelItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  // derive loading from a fetch key — no synchronous setState in effects
  const fetchKey = `${category}|${source}`;
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const loading = loadedKey !== fetchKey;

  useEffect(() => {
    fetch('/api/iptv/catalog')
      .then((r) => r.json() as Promise<CatalogResponse>)
      .then(setCatalog)
      .catch(() => setCatalog({ categories: [], sources: [], total: 0 }));
  }, []);

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (category !== 'all') params.set('category', category);
      if (source) params.set('source', source);
      const res = await fetch(`/api/iptv/channels?${params}`);
      const data = (await res.json()) as { channels?: ChannelItem[]; total?: number };
      const page: ChannelItem[] = (data.channels || []).map((c: ChannelItem) => ({
        ...c,
        source: c.sourceName || c.source,
      }));
      setTotal(data.total || 0);
      setChannels((prev) => (replace ? page : [...prev, ...page]));
    },
    [category, source]
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await fetchPage(0, true);
      } finally {
        if (alive) setLoadedKey(fetchKey);
      }
    })();
    return () => {
      alive = false;
    };
  }, [fetchKey, fetchPage]);

  const loadMore = () => {
    if (loadingMore || channels.length >= total) return;
    setLoadingMore(true);
    fetchPage(channels.length, false).finally(() => setLoadingMore(false));
  };

  const sourcePills = useMemo(() => {
    if (!catalog) return [];
    const pills: Array<{ id: string; name: string; health?: string }> = [
      { id: '', name: 'All sources' },
    ];
    for (const s of catalog.sources) pills.push({ id: s.id, name: s.name, health: s.health });
    return pills;
  }, [catalog]);

  const catPills = useMemo(() => {
    if (!catalog) return [];
    const emoji: Record<string, string> = {
      all: '📺', movies: '🎬', series: '🍿', entertainment: '✨', news: '📰',
      kids: '🧸', documentary: '🌍', music: '🎵', comedy: '😂', sports: '⚽',
      anime: '🕹️', lifestyle: '🌿', world: '🌐',
    };
    return catalog.categories.map((c) => ({ ...c, emoji: emoji[c.id] }));
  }, [catalog]);

  const favOthers = favorites.filter((f) => f.kind === 'iptv');
  const recentOthers = recents.filter((r) => r.kind === 'iptv');

  return (
    <div className="pb-16">
      <div className="mx-auto max-w-7xl pt-6">
        {/* header */}
        <div className="px-4 sm:px-6 lg:px-10">
          <h1 className="text-2xl font-black uppercase tracking-tight text-zilla-text sm:text-3xl">
            Everything else, <span className="text-zilla-yellow">one tab</span>
          </h1>
          <p className="mt-1 max-w-2xl text-sm font-medium text-zilla-dim">
            {catalog ? catalog.total.toLocaleString() : '11,000+'} free channels from Pluto TV, Samsung TV
            Plus, Plex, Xumo, Tubi, Roku, LG Channels, STIRR and more — refreshed hourly by{' '}
            <span className="font-bold text-zilla-text">IPTV-Scraper-Zilla</span>.
          </p>
        </div>

        {/* favorites / recents */}
        {favOthers.length > 0 && (
          <div className="mt-6">
            <p className="mb-2.5 px-4 text-lg font-black uppercase tracking-tight text-zilla-text sm:px-6 lg:px-10">
              Your favorites
            </p>
            <div className="hide-scrollbar flex gap-3 overflow-x-auto px-4 pb-1 sm:px-6 lg:px-10">
              {favOthers.map((c) => (
                <ChannelCard key={c.id} channel={c} onPlay={onPlayChannel} badge="★" />
              ))}
            </div>
          </div>
        )}
        {recentOthers.length > 0 && (
          <div className="mt-6">
            <p className="mb-2.5 px-4 text-lg font-black uppercase tracking-tight text-zilla-text sm:px-6 lg:px-10">
              Recently watched
            </p>
            <div className="hide-scrollbar flex gap-3 overflow-x-auto px-4 pb-1 sm:px-6 lg:px-10">
              {recentOthers.map((c) => (
                <ChannelCard key={`r-${c.id}`} channel={c} onPlay={onPlayChannel} />
              ))}
            </div>
          </div>
        )}

        {/* pills */}
        <div className="mt-6 space-y-3">
          <CategoryPills pills={catPills} active={category} onSelect={setCategory} />
          <CategoryPills
            pills={sourcePills}
            active={source}
            onSelect={(id) => setSource(id)}
          />
        </div>

        {/* grid */}
        <div className="mt-5">
          {loading ? (
            <div className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-3 sm:px-6 md:grid-cols-4 lg:grid-cols-6 lg:px-10">
              {Array.from({ length: 18 }).map((_, i) => (
                <div key={i}>
                  <div className="skeleton-shimmer aspect-video w-full rounded-xl" />
                  <div className="mt-2 h-3 w-3/4 rounded bg-zilla-panel" />
                </div>
              ))}
            </div>
          ) : channels.length === 0 ? (
            <div className="px-4 py-14 text-center sm:px-6 lg:px-10">
              <p className="text-4xl">📺</p>
              <p className="mt-3 text-base font-extrabold text-zilla-text">No channels match this filter</p>
              <p className="mt-1 text-sm font-medium text-zilla-dim">Try a different category or source.</p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 px-4 sm:grid-cols-3 sm:px-6 md:grid-cols-4 lg:grid-cols-6 lg:px-10">
                {channels.map((c) => (
                  <div key={c.id} className="w-full">
                    <div className="[&>button]:w-full">
                      <ChannelCard channel={c} onPlay={onPlayChannel} chno={c.chno} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-col items-center gap-2 px-4 py-8">
                <p className="text-xs font-bold text-zilla-dim">
                  Showing {channels.length.toLocaleString()} of {total.toLocaleString()} channels
                </p>
                {channels.length < total && (
                  <button
                    onClick={loadMore}
                    disabled={loadingMore}
                    className={cn(
                      'rounded-full bg-zilla-yellow px-7 py-3 text-xs font-black uppercase tracking-wide text-black transition-transform hover:scale-105',
                      loadingMore && 'opacity-60'
                    )}
                  >
                    {loadingMore ? 'Loading…' : 'Load more channels'}
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
