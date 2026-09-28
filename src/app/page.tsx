'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { TopNav, type TabId } from '@/components/app/TopNav';
import { SportsTab } from '@/components/app/SportsTab';
import { OthersTab } from '@/components/app/OthersTab';
import { PlayerOverlay } from '@/components/app/PlayerOverlay';
import { SearchOverlay } from '@/components/app/SearchOverlay';
import { useTV, type Playable } from '@/lib/store';

/** Give persisted recents/favorites their photos back.
 *  Entries saved before logos were attached to playables (or via flows that
 *  had no artwork at hand) get backfilled from the 24/7 channel index and the
 *  original-repo logo services — so "Recently watched" always shows photos. */
function useLogoBackfill() {
  const { recents, favorites, enrichPlayable } = useTV();
  const done = useRef<Set<string>>(new Set());

  useEffect(() => {
    const missing = [...recents, ...favorites].filter((p) => !p.logo && !done.current.has(p.id));
    if (missing.length === 0) return;
    for (const m of missing) done.current.add(m.id);

    let alive = true;
    (async () => {
      // 1) DaddyLive feeds: logo from the 24/7 channel index (by channel ref)
      const dl = missing.filter((m) => m.kind === 'daddylive');
      const stillMissing: Playable[] = [];
      if (dl.length) {
        try {
          const c = (await fetch('/api/sports/channels').then((r) => r.json())) as {
            channels?: { ref: string; logo?: string }[];
          };
          if (!alive) return;
          const byRef = new Map((c.channels || []).map((ch) => [ch.ref, ch.logo]));
          for (const m of dl) {
            const logo = byRef.get(m.ref);
            if (logo) enrichPlayable(m.id, { logo });
            else stillMissing.push(m);
          }
        } catch {
          stillMissing.push(...dl);
        }
      }

      // 2) everything still photo-less: batch lookup through the logo service
      //    (channel logos → league emblems → team crests, original-repo chain)
      const iptv = missing.filter((m) => m.kind !== 'daddylive');
      const rest = [...iptv, ...stillMissing];
      if (rest.length === 0) return;
      try {
        const names = rest.map((m) => m.name).join('|');
        const r = (await fetch(`/api/logo?names=${encodeURIComponent(names)}`).then((x) => x.json())) as {
          logos?: Record<string, string>;
        };
        if (!alive) return;
        for (const m of rest) {
          const logo = r.logos?.[m.name];
          if (logo) enrichPlayable(m.id, { logo });
        }
      } catch { /* photos stay as gradient tiles */ }
    })();

    return () => {
      alive = false;
    };
  }, [recents, favorites, enrichPlayable]);
}

export default function Home() {
  const [tab, setTab] = useState<TabId>('sports');
  const [searchOpen, setSearchOpen] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [totalChannels, setTotalChannels] = useState(0);
  const [zapPool, setZapPool] = useState<Playable[]>([]);
  const { openPlayer, player } = useTV();

  // backfill photos for persisted recents/favorites (Recently watched fix)
  useLogoBackfill();

  // live count badge + zap pool
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = (await fetch('/api/sports/schedule').then((r) => r.json())) as {
          live?: unknown[];
        };
        if (alive) setLiveCount(s.live?.length || 0);
      } catch { /* ignore */ }
      try {
        const c = (await fetch('/api/iptv/catalog').then((r) => r.json())) as { total?: number };
        if (alive) setTotalChannels(c.total || 0);
      } catch { /* ignore */ }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // deep link: /?ch=<base64 playable> opens the player straight away (share feature)
  useEffect(() => {
    const ch = new URLSearchParams(window.location.search).get('ch');
    if (!ch) return;
    try {
      const p = JSON.parse(decodeURIComponent(escape(atob(ch)))) as Playable;
      if (p && p.kind && p.ref) openPlayer(p);
      // clean the URL so refreshes don't force the same channel forever
      window.history.replaceState({}, '', window.location.pathname);
    } catch { /* ignore malformed links */ }
  }, []);

  const buildZapPool = useCallback(async (): Promise<Playable[]> => {
    // zap pool: live event feeds first, then 24/7 sports, then iptv picks
    const pool: Playable[] = [];
    try {
      const s = (await fetch('/api/sports/schedule').then((r) => r.json())) as {
        live?: { title: string; league: string; team1Logo?: string; team2Logo?: string; leagueLogo?: string; channelLogo?: string; channels?: { id: string; name: string; logo?: string }[] }[];
      };
      for (const m of s.live || []) {
        const logo = m.team1Logo || m.channelLogo || m.leagueLogo || m.team2Logo;
        for (const ch of m.channels?.slice(0, 2) || []) {
          pool.push({
            id: `dl_${ch.id}`,
            name: `${m.title} — ${ch.name}`,
            kind: 'daddylive',
            ref: ch.id,
            source: m.league,
            logo: ch.logo || logo,
          });
        }
      }
    } catch { /* ignore */ }
    try {
      const c = (await fetch('/api/sports/channels').then((r) => r.json())) as {
        channels?: { id: string; name: string; kind: 'daddylive'; ref: string; source: string; logo?: string }[];
      };
      for (const ch of (c.channels || []).slice(0, 60)) {
        pool.push({ id: ch.id, name: ch.name, kind: ch.kind, ref: ch.ref, source: ch.source, logo: ch.logo });
      }
    } catch { /* ignore */ }
    try {
      const i = (await fetch('/api/iptv/channels?limit=40&offset=200').then((r) => r.json())) as {
        channels?: { id: string; name: string; kind: 'iptv'; ref: string; sourceName: string; logo?: string }[];
      };
      for (const ch of i.channels || []) {
        pool.push({ id: ch.id, name: ch.name, kind: 'iptv', ref: ch.ref, source: ch.sourceName, logo: ch.logo });
      }
    } catch { /* ignore */ }
    // shuffle so zap mixes sports + iptv picks instead of always sports-first
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    return pool;
  }, []);

  const handleZap = useCallback(async () => {
    let pool = zapPool;
    if (pool.length === 0) {
      pool = await buildZapPool();
      setZapPool(pool);
    }
    if (pool.length > 0) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      openPlayer(pick);
    }
  }, [zapPool, buildZapPool, openPlayer]);

  const handlePlayChannel = useCallback(
    (ch: Playable, altFeeds?: Playable[]) => {
      openPlayer(ch, altFeeds);
    },
    [openPlayer]
  );

  // player feeds for the current channel (same DaddyLive channel = single feed)
  return (
    <div className="min-h-screen bg-zilla-bg text-zilla-text">
      <TopNav
        tab={tab}
        onTab={setTab}
        onSearch={() => setSearchOpen(true)}
        onZap={handleZap}
        liveCount={liveCount}
        totalChannels={totalChannels}
      />

      <main>
        {tab === 'sports' ? (
          <SportsTab onPlayChannel={handlePlayChannel} onOpenSearch={() => setSearchOpen(true)} />
        ) : (
          <OthersTab onPlayChannel={handlePlayChannel} />
        )}
      </main>

      <footer className="mt-auto border-t border-zilla-line bg-zilla-panel/60">
        <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-10">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex items-center gap-2">
              
              <img src="/maxtv-mark.png" alt="MaxTV" className="h-8 w-8" />
              <div>
                <p className="text-sm font-black tracking-tight text-zilla-text">
                  MAX<span className="text-zilla-yellow">TV</span>
                </p>
                <p className="text-[11px] font-medium text-zilla-dim">Sports-first free streaming</p>
              </div>
            </div>
            <p className="max-w-md text-[11px] font-medium leading-relaxed text-zilla-dim">
              Live sports engine ported from{' '}
              <span className="font-bold text-zilla-text">live-sport-plugin</span> · channel lineup from{' '}
              <span className="font-bold text-zilla-text">IPTV-Scraper-Zilla</span>. MaxTV hosts no content —
              it aggregates publicly available streams for informational purposes.
            </p>
          </div>
        </div>
      </footer>

      <PlayerOverlay />
      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onPlay={(ch) => {
          setSearchOpen(false);
          openPlayer(ch);
        }}
      />
    </div>
  );
}
