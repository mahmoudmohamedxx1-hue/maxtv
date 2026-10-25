'use client';

// ─── PlayerOverlay — the playback engine orchestrator ────────────────────────
// Decomposed 2026-10-20 out of the old 3,085-line monolith:
//   • constants/types   → ./player/constants.ts
//   • icons             → ./player/icons.tsx
//   • pure helpers      → ./player/utils.ts
//   • connectivity eng. → ./player/createNetWatcher.ts
//   • quality menu      → ./player/QualityMenu.tsx
//   • servers menu      → ./player/ServersMenu.tsx
//   • channel guide     → ./player/SurfSidebar.tsx
//   • state panels      → ./player/StateOverlays.tsx
//   • stats overlay     → ./player/StatsOverlay.tsx  (NEW)
// This file keeps the STATEFUL engine: resolve → attach hls → failover walk
// → data-saver ladder → keyboard remote. New in this version:
//   • IPTV cross-playlist failover — a unified 2-pass hop walker covering
//     resolve failures, manifest load/parse/timeout errors and network errors
//   • the stats overlay (I key) with edge-host rotation alerting
//   • full EN/AR localization + RTL-safe layout
//   • add-to-grid from the channel guide (multi-view)

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { useTV, type Playable } from '@/lib/store';
import { cn } from '@/lib/utils';
import {
  loadPrefs,
  updatePrefs,
  onPrefsChange,
  connectionBudget,
  dataSaverForBudget,
  hlsPerfConfig,
} from '@/lib/player-settings';
import { useT } from '@/lib/locale';
import {
  DL_SERVERS,
  RESILIENT_LOAD_POLICIES,
  LADDER_HLS_CONFIG,
  LADDER_MASTER_HLS_CONFIG,
  DATA_SAVER_HEIGHTS,
  LOCAL_TURBO_RUNGS,
  isDlIframeSrc,
  type AltServer,
  type MatchLike,
  type Phase,
  type ServerOption,
  type SurfItem,
} from './player/constants';
import { Icon } from './player/icons';
import {
  altPlayable,
  canHevc,
  encodePlayable,
  fmtAgo,
  probeTcCap,
} from './player/utils';
import { createNetWatcher } from './player/createNetWatcher';
import { UncloakDirectLoader, directPathHealthy } from './player/uncloak-loader';
import { attachSegPrefetch } from './player/seg-prefetch';
import { QualityMenu } from './player/QualityMenu';
import {
  probeLocalTurbo,
  startLocalTurbo,
  type LocalTurboHandle,
} from './player/local-turbo';
import { ServersMenu } from './player/ServersMenu';
import { SurfSidebar } from './player/SurfSidebar';
import { StateOverlays } from './player/StateOverlays';
import { StatsOverlay } from './player/StatsOverlay';

export function PlayerOverlay() {
  const { player, playerOpen, closePlayer, toggleFavorite, favorites, altFeeds, openPlayer, addPane } = useTV();
  const { t } = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfRef = useRef<SurfItem[]>([]);

  const [phase, setPhase] = useState<Phase>('resolving');
  const [errorMsg, setErrorMsg] = useState('');
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(0.9);
  const [buffering, setBuffering] = useState(false);
  const [quality, setQuality] = useState<{ label: string; level: number }[]>([]);
  const [currentQuality, setCurrentQuality] = useState(-1); // -1 = auto
  const [activeHeight, setActiveHeight] = useState(0); // detected playing height
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  /** active data-saver (transcoded) height — null = native stream */
  const [tcHeight, setTcHeight] = useState<number | null>(null);
  /* ── Local Turbo (Tier 3 client pipeline) ── turboHeight = active render
   * rung (0 = Source/native size); null = standard hls.js playback */
  const [turboHeight, setTurboHeight] = useState<number | null>(null);
  const [turboCapable, setTurboCapable] = useState(false);
  const turboRef = useRef<LocalTurboHandle | null>(null);
  const turboHeightRef = useRef<number | null>(null);
  const turboCanvasRef = useRef<HTMLCanvasElement>(null);
  const turboPausedRef = useRef(false);
  /** the data-saver rung was picked by the connectivity engine (not the user) */
  const [autoDs, setAutoDs] = useState(false);
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [alternates, setAlternates] = useState<AltServer[]>([]);
  const [activeServer, setActiveServer] = useState('');
  const [showServersMenu, setShowServersMenu] = useState(false);
  const [surfOpen, setSurfOpen] = useState(false);
  const [surf, setSurf] = useState<SurfItem[]>([]);
  /** url of the alternate (multi-quality) source currently playing — null = a
   *  native DaddyLive transport. Drives the servers-menu active highlight. */
  const [altUrl, setAltUrl] = useState<string | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [toast, setToast] = useState('');
  const [digits, setDigits] = useState('');
  const [autoAdvSecs, setAutoAdvSecs] = useState<number | null>(null);
  const [liveBehind, setLiveBehind] = useState(false);
  const [startedAgo, setStartedAgo] = useState<string>('');
  /** content-mismatch banner ("this feed is showing motorsport") */
  const [mismatch, setMismatch] = useState<{ sport: string; confidence: number } | null>(null);
  const mismatchChecked = useRef<string>('');
  /** can the server transcode at all (data-saver ladder exists)? Probed on
   *  mount — false on serverless deployments (no ffmpeg). Fail-open until
   *  the answer lands; the 503-bounce in attachSource covers the gap. */
  const [tcCap, setTcCap] = useState(true);
  const tcCapRef = useRef(true);
  /** the per-segment &h= ladder (bundled static ffmpeg — works on serverless) */
  const [tcSeg, setTcSeg] = useState(false);
  const tcSegRef = useRef(false);
  const tcRelayRef = useRef(true);
  /** one "data saver unavailable" notice per page load — not per channel */
  const tcNoticeRef = useRef(false);
  const hiPrefNoticeRef = useRef(false);
  /** the HEVC-phase choice panel ({family} = the related free feed, if any) */
  const [hevcBlock, setHevcBlock] = useState<{ family?: AltServer } | null>(null);
  /** stats-for-nerds overlay (I key / top-bar button) */
  const [showStats, setShowStats] = useState(false);

  /* ── refs for cross-callback access (hls error handler → failover) ─────── */
  const playerRef = useRef<Playable | null>(null);
  const serversRef = useRef<{ id: string; label: string; host: string }[]>([...DL_SERVERS]);
  const alternatesRef = useRef<AltServer[]>([]);
  /** signed source params for data-saver transcodes of the current stream */
  const tcSrcRef = useRef<{ src: string; r: string; s: string } | null>(null);
  /** the native (non-transcoded) source URL — restored when leaving data saver */
  const nativeSrcRef = useRef<string | null>(null);
  /** the NATIVE feed's real height (0 unknown) — the transcode ladder never
   *  encodes UP: a request at/above it stays on the untouched native feed */
  const nativeHeightRef = useRef(0);
  /** the ladder Source rung's hls level index — label-independent identity
   *  (the entry relabels "Source" → "720p"/"1080p" once the height is known,
   *  so the label can no longer be used to find it) */
  const srcLevelRef = useRef<number | null>(null);
  const loadRef = useRef<(ch: Playable, opts?: { server?: string; isAlternate?: boolean }) => Promise<void>>(async () => {});
  /** servers/alternate urls already tried for the current channel (+ which
   *  failover PASS we're on — see findNextHop) */
  const triedRef = useRef<{ chId: string; tried: Set<string>; pass: number }>({ chId: '', tried: new Set(), pass: 0 });
  /** cancel hook for the auto-advance countdown (any interaction stops it) */
  const cancelAutoAdvRef = useRef<(() => void) | null>(null);
  /** live bandwidth samples for the connectivity engine (Auto mode) */
  const netRef = useRef<{ lows: number; highs: number }>({ lows: 0, highs: 0 });
  /** rate-limits the "Reconnecting…" toast during CDN flap retry storms */
  const lastReconnectToastRef = useRef(0);
  /** load generation counter — every new load/close bumps it; an in-flight
   *  resolve whose generation is stale returns silently. This is what makes
   *  "close while loading" truly instant and keeps stale failover hops from
   *  fighting a freshly opened channel. */
  const loadGenRef = useRef(0);
  /** one-shot height pin for alternate-rung hops (quality-menu "via <source>") */
  const pinHeightRef = useRef<number | null>(null);
  /** proxy URL for the current stream — the fallback when direct-CDN play fails */
  const proxiedSrcRef = useRef<string | null>(null);
  /** current attachment plays the CDN directly (CORS-open source) */
  const directPlayRef = useRef(false);
  /** the direct→proxy swap fired for this attachment (once) */
  const usedProxyFallbackRef = useRef(false);
  /** the user explicitly chose "play the HEVC feed anyway" for this channel */
  const forceHevcRef = useRef(false);
  /** codec-reconnect attempts for the CURRENT channel (one-shot per channel) */
  const codecRecovRef = useRef<{ chId: string; count: number }>({ chId: '', count: 0 });
  /** ref mirror of tcHeight for hls event closures */
  const tcHeightRef = useRef<number | null>(null);
  /** v1.3 — the current attachment plays the synthetic QUALITY LADDER master
   *  (turbo rungs + CDN-direct Source rung). On ladder sources the quality
   *  menu is the native hls level list: every pick is an in-place level
   *  switch — NEVER a source re-attach (the "144p changed the channel then
   *  came back" bug). */
  const [ladderMaster, setLadderMaster] = useState(false);
  const ladderMasterRef = useRef(false);
  useEffect(() => {
    tcHeightRef.current = tcHeight;
  }, [tcHeight]);

  const isFav = player ? favorites.some((f) => f.id === player.id) : false;

  /* ── prefs on mount ─────────────────────────────────────────────────────── */
  useEffect(() => {
    const p = loadPrefs();
    setVolume(p.volume);
    setMuted(p.muted);
  }, []);

  // probe the deployment's data-saver capability once (cached per page load)
  useEffect(() => {
    let alive = true;
    void probeTcCap().then(({ cap, seg }) => {
      if (!alive) return;
      tcCapRef.current = cap || seg;
      tcRelayRef.current = cap;
      tcSegRef.current = seg;
      setTcCap(cap || seg);
      setTcSeg(seg);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    updatePrefs({ volume, muted });
  }, [volume, muted]);

  /* ── toast helper ───────────────────────────────────────────────────────── */
  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2200);
  }, []);

  /* ── build the surf list once per player session ───────────────────────── */
  useEffect(() => {
    if (!playerOpen) return;
    let alive = true;

    const feeds: SurfItem[] = altFeeds.map((f) => ({ ...f, group: 'feeds' as const }));

    (async () => {
      try {
        const s = (await fetch('/api/sports/schedule', { cache: 'no-store' }).then((r) => r.json())) as {
          live?: MatchLike[];
        };
        if (!alive) return;
        const liveFeeds: SurfItem[] = [];
        for (const m of s.live || []) {
          for (const ch of m.channels?.slice(0, 2) || []) {
            liveFeeds.push({
              id: `dl_${ch.id}`,
              name: m.title,
              kind: 'daddylive',
              ref: ch.id,
              source: m.league,
              group: 'live',
              sub: ch.name,
              startedAt: m.startTime,
              logo: m.team1Logo || m.channelLogo || m.leagueLogo || ch.logo,
            });
          }
        }
        setSurf([...feeds, ...liveFeeds.slice(0, 24)]);
      } catch {
        if (alive) setSurf(feeds);
      }
      try {
        const c = (await fetch('/api/sports/channels', { cache: 'no-store' }).then((r) => r.json())) as {
          channels?: { id: string; name: string; kind: 'daddylive'; ref: string; source: string; logo?: string }[];
        };
        if (!alive) return;
        const chans: SurfItem[] = (c.channels || []).slice(0, 60).map((ch) => ({
          id: ch.id,
          name: ch.name,
          kind: ch.kind,
          ref: ch.ref,
          source: ch.source,
          logo: ch.logo,
          group: 'channels',
        }));
        setSurf((prev) => [...prev, ...chans]);
      } catch { /* sidebar stays with what we have */ }
    })();

    return () => {
      alive = false;
    };
  }, [playerOpen, altFeeds]);

  /* keep the latest surf list in a ref for the digit-jump timer */
  useEffect(() => {
    surfRef.current = surf;
  }, [surf]);

  /* ── started-ago ticker ─────────────────────────────────────────────────── */
  useEffect(() => {
    if (!playerOpen) return;
    const update = () => {
      const cur = surf.find((s) => s.id === player?.id);
      setStartedAgo(cur?.startedAt ? fmtAgo(cur.startedAt, t) : t('player.liveChannel'));
    };
    update();
    const iv = setInterval(update, 30_000);
    return () => clearInterval(iv);
  }, [surf, player, playerOpen, t]);

  /* ── off-air watchdog (placeholder segments that never decode) ─────────── */
  useEffect(() => {
    if ((phase !== 'loading' && phase !== 'resolving') || !playerOpen) return;
    const tm = setTimeout(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) setPhase('offair');
    }, 20000);
    return () => clearTimeout(tm);
  }, [phase, playerOpen]);

  /* ── connectivity engine (extracted → createNetWatcher) ─────────────────── */
  const selectDataSaverRef = useRef<((h: number, opts?: { auto?: boolean }) => void) | null>(null);
  const exitDataSaverRef = useRef<(() => void) | null>(null);
  const attachNetWatcher = useMemo(
    () =>
      createNetWatcher({
        netRef,
        tcHeightRef,
        nativeHeightRef,
        tcCapRef,
        tcSrcRef,
        playerRef,
        showToast,
        t,
        selectDataSaverRef,
        exitDataSaverRef,
      }),
    [showToast, t]
  );

  /* ── the unified failover walk ────────────────────────────────────────────
   * DL transports first (daddylive), then SAME-CHANNEL alternates — for IPTV
   * those are the CROSS-PLAYLIST entries (the same channel carried by Pluto /
   * Samsung TV+ / Roku / Plex / the curated ladder pool). When everything has
   * burned once, ONE fresh pass re-rolls the CDN dice (the edge flaps in
   * 10-20s windows that recover on their own) — then the honest error screen.
   * Family feeds (sameChannel === false) never auto-enter the chain: a silent
   * channel swap was the beIN complaint; they stay explicit buttons. */
  const findNextHop = useCallback(
    (
      cur: Playable
    ): { kind: 'server'; server: { id: string; label: string; host: string } } | { kind: 'alternate'; alt: AltServer } | null => {
      if (cur.kind === 'daddylive') {
        const next = serversRef.current.find((s) => !triedRef.current.tried.has(s.id));
        if (next) return { kind: 'server', server: next };
      }
      const alt = alternatesRef.current.find((a) => a.sameChannel !== false && !triedRef.current.tried.has(a.url));
      if (alt) return { kind: 'alternate', alt };
      // pass 2 — one fresh walk (CDN flaps recover within 10-20s windows)
      if (triedRef.current.pass < 1 && alternatesRef.current.some((a) => a.sameChannel !== false)) {
        triedRef.current = {
          chId: cur.id,
          tried: new Set(cur.kind === 'iptv' ? [cur.ref] : []),
          pass: triedRef.current.pass + 1,
        };
        if (cur.kind === 'daddylive') {
          const srv = serversRef.current.find((s) => !triedRef.current.tried.has(s.id));
          if (srv) return { kind: 'server', server: srv };
        }
        const retry = alternatesRef.current.find((a) => a.sameChannel !== false && !triedRef.current.tried.has(a.url));
        if (retry) return { kind: 'alternate', alt: retry };
      }
      return null;
    },
    []
  );

  /* ── resolve → attach hls → play ───────────────────────────────────────── */
  const load = useCallback(
    async (ch: Playable, opts: { server?: string; isAlternate?: boolean } = {}) => {
      if (!ch) return;
      const gen = ++loadGenRef.current;
      setPhase('resolving');
      setErrorMsg('');
      setBuffering(false);
      setAutoAdvSecs(null);
      setLiveBehind(false);
      setActiveHeight(0);
      setTcHeight(null);
      nativeHeightRef.current = 0; // learned again from the native manifest
      srcLevelRef.current = null; // re-identified at the next MANIFEST_PARSED
      if (!opts.isAlternate) setAltUrl(null); // playing a DL server / fresh channel
      pinHeightRef.current = null; // one-shot alternate-rung pin
      proxiedSrcRef.current = null;
      directPlayRef.current = false;
      usedProxyFallbackRef.current = false;
      if (!opts.isAlternate) setHevcBlock(null); // a fresh channel clears the panel

      // fresh channel → reset the per-channel server-switching state.
      // ⚠ alternate playables keep the ORIGINAL channel id, so hopping to a
      // multi-quality source never wipes the servers menu mid-session.
      if (triedRef.current.chId !== ch.id) {
        triedRef.current = { chId: ch.id, tried: new Set(), pass: 0 };
        setServers([]);
        setAlternates([]);
        setActiveServer('');
        serversRef.current = [...DL_SERVERS];
        alternatesRef.current = [];
        tcSrcRef.current = null;
        forceHevcRef.current = false; // a NEW channel re-evaluates its codec phase
        codecRecovRef.current = { chId: ch.id, count: 0 }; // fresh codec-reconnect budget
      }
      if (opts.server) triedRef.current.tried.add(opts.server);
      if (ch.kind === 'iptv') triedRef.current.tried.add(ch.ref);

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      // a channel switch always drops any active Local Turbo session
      if (turboRef.current) {
        turboRef.current.stop();
        turboRef.current = null;
        turboHeightRef.current = null;
        turboPausedRef.current = false;
        setTurboHeight(null);
      }

      try {
        const endpoint =
          ch.kind === 'daddylive'
            ? `/api/sports/stream?channel=${encodeURIComponent(ch.ref)}${opts.server ? `&server=${encodeURIComponent(opts.server)}` : ''}${ch.name ? `&name=${encodeURIComponent(ch.name.slice(0, 80))}` : ''}`
            : `/api/iptv/stream?url=${encodeURIComponent(ch.ref)}${ch.name ? `&name=${encodeURIComponent(ch.name)}` : ''}`;
        // 25s cap — some embed chains crawl; fail fast so auto-advance can surf on
        const ctrl = new AbortController();
        const cap = setTimeout(() => ctrl.abort(), 25_000);
        let res: Response;
        try {
          res = await fetch(endpoint, { signal: ctrl.signal });
        } finally {
          clearTimeout(cap);
        }
        // the player was closed (or another channel opened) mid-resolve — bail
        if (gen !== loadGenRef.current) return;
        const data = (await res.json().catch(() => ({}))) as {
          url?: string;
          message?: string;
          server?: string;
          serverId?: string;
          servers?: { id: string; label: string; host: string }[];
          alternates?: AltServer[];
          tc?: { src: string; r: string; s: string };
          proxied?: string;
          cors?: boolean;
          hevc?: boolean;
        };

        // capture the server lists (available even on failures for failover)
        if (Array.isArray(data.servers) && data.servers.length) {
          const list = data.servers as { id: string; label: string; host: string }[];
          serversRef.current = list;
          setServers(list);
        }
        if (Array.isArray(data.alternates)) {
          const alts = data.alternates as AltServer[];
          alternatesRef.current = alts;
          setAlternates(alts);
          // alternates exist but none carries a (probed) ladder yet — the
          // bounded probe may still be completing server-side. ONE delayed
          // re-resolve picks up the landed ladders and fills the quality-menu
          // rungs in place, without ever disturbing playback.
          if (ch.kind === 'daddylive' && alts.length && !alts.some((a) => a.ladder?.length)) {
            const reGen = gen;
            window.setTimeout(() => {
              if (reGen !== loadGenRef.current) return; // channel changed / closed
              (async () => {
                try {
                  const ep = `/api/sports/stream?channel=${encodeURIComponent(ch.ref)}${
                    ch.name ? `&name=${encodeURIComponent(ch.name.slice(0, 80))}` : ''
                  }`;
                  const r2 = await fetch(ep);
                  if (reGen !== loadGenRef.current) return;
                  const d2 = (await r2.json().catch(() => ({}))) as { alternates?: AltServer[] };
                  if (Array.isArray(d2.alternates) && d2.alternates.length) {
                    const fresh = d2.alternates;
                    // only an upgrade (a ladder landed) is worth a re-render
                    if (fresh.some((a) => a.ladder?.length)) {
                      alternatesRef.current = fresh;
                      setAlternates(fresh);
                    }
                  }
                } catch {
                  /* best-effort */
                }
              })();
            }, 7_000);
          }
        }
        if (typeof data.serverId === 'string' && data.serverId) {
          setActiveServer(data.serverId);
          triedRef.current.tried.add(data.serverId);
        } else if (typeof data.server === 'string' && data.server) {
          setActiveServer(data.server);
          // legacy host-based response — record the matching server id
          const used = serversRef.current.find((s) => s.host === data.server);
          if (used) triedRef.current.tried.add(used.id);
        }
        // signed source so data-saver transcodes target this exact stream
        if (data.tc) tcSrcRef.current = data.tc;
        // direct-CDN play posture: CORS-open sources play straight from the
        // CDN (native ABR, zero proxy latency); proxied is the fallback
        if (data.proxied) proxiedSrcRef.current = data.proxied;
        directPlayRef.current = data.cors === true;
        usedProxyFallbackRef.current = false;

        if (!res.ok || !data.url) {
          // a failed resolve already burned through every mirror server-side —
          // mark them tried so the walker hops to alternates instead of retrying
          if (ch.kind === 'daddylive') {
            for (const s of serversRef.current) triedRef.current.tried.add(s.id);
          }
          // unified failover: DL transports, then cross-playlist/cross-source
          // same-channel alternates (2 passes) — then the honest error screen
          const cur = playerRef.current || ch;
          const hop = findNextHop(cur);
          if (hop?.kind === 'server') {
            showToast(t('player.switchingServer', { label: hop.server.label, host: hop.server.host }));
            await loadRef.current(cur, { server: hop.server.id });
            return;
          }
          if (hop?.kind === 'alternate') {
            showToast(t('player.tryingSource', { name: hop.alt.sourceName }));
            await loadRef.current(altPlayable(cur, hop.alt), { isAlternate: true });
            return;
          }
          throw new Error(data.message || 'Stream is offline or geo-blocked right now.');
        }

        // ── HEVC-phase gate ────────────────────────────────────────────────
        // The resolve sniffed the feed in a browser-UNSAFE codec phase (HEVC)
        // and THIS browser can't decode it (Firefox / Chrome without hw
        // decode). Playing it is a guaranteed ~10s stall into a codec error,
        // and the old failover walk landed on beIN XTRA — a DIFFERENT channel
        // the user never asked for. Show the explicit choice panel instead.
        if (data.hevc && !canHevc() && !forceHevcRef.current && !opts.isAlternate) {
          const family =
            alternatesRef.current.find((a) => a.sameChannel === false && a.ladder?.length) ||
            alternatesRef.current.find((a) => a.sameChannel === false);
          setHevcBlock({ family });
          setPhase('hevc');
          return;
        }

        const src = data.url as string;
        nativeSrcRef.current = src;
        // v1.3 — ladder master attachment: quality picks become in-place
        // level switches from here on (see selectDataSaver / setLevel)
        const isLadderSrc = /lad=1/.test(src);
        ladderMasterRef.current = isLadderSrc;
        setLadderMaster(isLadderSrc);
        setPhase('loading');
        const video = videoRef.current;
        if (!video) return;

        // DaddyLive iframe bypass — the embedded page takes over playback
        // (the iframe renders in JSX instead of <video>).
        if (isDlIframeSrc(src)) {
          setPhase('playing');
          setBuffering(false);
          return;
        }

        const prefs = loadPrefs();
        video.volume = prefs.volume;
        video.muted = prefs.muted;

        if (Hls.isSupported()) {
          // seed ABR with the browser's connection estimate so Auto starts on a
          // rung the link can actually sustain (instead of overshoot + stall).
          const budget = connectionBudget();
          // v1.3 ladder master (lad=1): CDN-direct Source rung + turbo rungs —
          // balanced ride distance; the custom loader uncloaks segments in-page
          const isLadderSrc = /lad=1/.test(src);
          const hls = new Hls({
            // ⚠ lowLatencyMode MUST be false: with it on, hls.js's
            // latency-controller ramps playbackRate toward 2× to "catch up"
            // to the live edge after every CDN stall — the "plays like 2x"
            // bug. These CDNs are not LL-HLS anyway.
            lowLatencyMode: false,
            enableWorker: true,
            // segment loader: DaddyLive segments resolve CDN-direct with
            // in-browser uncloaking (ultra-low lag); falls back per-segment
            // to the server route when the direct path can't deliver
            loader: UncloakDirectLoader as unknown as typeof Hls.DefaultConfig.loader,
            // start the first fragment download while the manifest is still
            // parsing — shaves ~1-2s off channel changes (freestream-tv trick)
            startFragPrefetch: true,
            ...(isLadderSrc
              ? LADDER_MASTER_HLS_CONFIG
              : hlsPerfConfig(loadPrefs().perfMode)),
            ...RESILIENT_LOAD_POLICIES,
            ...(budget > 0 ? { abrEwmaDefaultEstimate: Math.max(400_000, budget * 0.75) } : {}),
          });
          hlsRef.current = hls;
          // expose the live hls instance for E2E inspection
          if (typeof window !== 'undefined') {
            (window as unknown as { __maxtvHls?: Hls }).__maxtvHls = hls;
          }
          hls.loadSource(src);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            const isLadder = ladderMasterRef.current;
            const buildLevels = () =>
              (hls.levels || []).map((l, i) => {
                const resH = Number(String(l.attrs?.RESOLUTION ?? '').split('x')[1]) || 0;
                // ⚠ manifest-declared heights ONLY — video.videoHeight here is
                // the PREVIOUS channel's last decoded frame on a channel change.
                // The real height arrives via LEVEL_SWITCHED once THIS stream
                // decodes a frame.
                const h = l.height || resH;
                const k = Math.round((l.bitrate || 0) / 1000);
                // ⚠ hls.js SORTS levels (height ascending) — the ladder's
                // Source rung (no declared height) lands at index 0, NOT at
                // the top. Identify it by its raw=1 variant URL, never by index.
                const lvlUrl = (l.url || []).join('') || '';
                const isSrc = isLadder && /raw=1/.test(lvlUrl);
                // native label when the master declared RESOLUTION (the
                // server probes the channel's real height) or the client-side
                // probe already taught us — the user sees "720p"/"1080p",
                // the native quality, instead of a mystery "Source"
                const label = isSrc
                  ? h > 0
                    ? `${h}p`
                    : 'Source'
                  : h
                    ? `${h}p`
                    : k > 0
                      ? `${k}k`
                      : 'Source';
                return { label, level: i, height: h, src: isSrc };
              });
            const seen = new Set<string>();
            const levels = buildLevels().filter((l) => (seen.has(l.label) ? false : seen.add(l.label)));
            setQuality(levels.map(({ label, level }) => ({ label, level })));
            // remember the Source rung's level index — label-independent
            // identity for persistence and 'Source' preference restores
            // (the label becomes "720p"/"1080p" once the height is known)
            const srcEntry = levels.find((l) => l.src);
            if (srcEntry) srcLevelRef.current = srcEntry.level;
            // learn the native height when the master declares it — powers
            // the no-upscale guards and native-ask mapping in selectDataSaver
            if (srcEntry?.height && srcEntry.height > 0) {
              nativeHeightRef.current = Math.max(nativeHeightRef.current, srcEntry.height);
            }
            // ladder master without RESOLUTION on the Source rung (cold
            // isolate) — ask the server for the channel's real height in the
            // background and relabel the menu entry once it answers. Also
            // seeds the per-isolate server cache, so future masters carry
            // RESOLUTION natively.
            if (isLadder && !srcEntry?.height) {
              const chId = src.match(/[?&]ch=(\d+)/)?.[1] || '';
              if (chId) {
                const gen = loadGenRef.current;
                void fetch(`/api/turbo?channel=${chId}&mode=native`, { cache: 'no-store' })
                  .then((r) => (r.ok ? (r.json() as Promise<{ h?: number }>) : null))
                  .then((d) => {
                    if (gen !== loadGenRef.current) return; // channel changed meanwhile
                    const h = d?.h || 0;
                    if (h <= 0) return;
                    nativeHeightRef.current = Math.max(nativeHeightRef.current, h);
                    setQuality((prev) =>
                      prev.some((q) => q.label === `${h}p`)
                        ? prev
                        : prev.map((q) => (q.label === 'Source' ? { ...q, label: `${h}p` } : q))
                    );
                  })
                  .catch(() => {});
              }
            }
            // remember the native feed's best height — the ladder never encodes up.
            // ⚠ ladder masters: the turbo rungs (144-480) are NOT the native
            // height — only the Source rung (handled above) teaches the truth.
            if (!isLadder) {
              const knownH = levels.map((l) => l.height).filter((h) => h > 0);
              if (knownH.length) {
                nativeHeightRef.current = Math.max(...knownH);
              }
            }

            const prefH = loadPrefs().quality;
            const canTc = (ch.kind === 'daddylive' || !!tcSrcRef.current) && tcCapRef.current;

            if (prefH === -1) {
              // AUTO — open on the best rung a CONSERVATIVE 60% of the
              // estimated link can hold, then let the sticky-cap rules adapt.
              setCurrentQuality(-1);
              if (budget > 0 && hls.levels?.length) {
                const safe = budget * 0.6;
                const capH = safe < 350_000 ? 144 : safe < 500_000 ? 244 : safe < 750_000 ? 360 : safe < 1_400_000 ? 480 : safe < 2_800_000 ? 720 : 1080;
                let target = 0;
                for (let i = 0; i < hls.levels.length; i++) {
                  const lh = hls.levels[i].height || 0;
                  if (lh && lh <= capH) target = i;
                }
                hls.startLevel = target;
              }
              // the link is too slow for the native ladder → open transcoded.
              // ONLY when ladder heights are actually KNOWN (master playlists).
              // ⚠ ladder masters already list the 144-480 rungs — the check
              // below never fires for them (a rung always fits the budget).
              const ds = dataSaverForBudget(budget);
              const ladderKnown = levels.some((l) => l.height > 0);
              if (ds && canTc && ladderKnown && !levels.some((l) => l.height > 0 && l.height <= ds + 60)) {
                void selectDataSaverRef.current?.(ds, { auto: true });
                return;
              }
            } else if (prefH === 0 && levels.length > 0) {
              // 'Source' preference — pin the NATIVE rung (identified by its
              // raw=1 URL — hls.js sorts levels, so "top" is NOT the Source;
              // the srcLevelRef survives the "Source"→"720p" relabel)
              const srcIdx = srcEntry ? srcEntry.level : levels.length - 1;
              const pin = srcIdx >= 0 ? srcIdx : levels.length - 1;
              hls.currentLevel = pin;
              setCurrentQuality(pin);
            } else if (prefH > 0 && levels.length > 1) {
              // a persisted native-height pick (the Source entry relabeled
              // "720p"/"1080p" persists as its height) must pin the Source
              // rung, not fall through to the 480 turbo rung below it
              const nativeAsk =
                !!srcEntry && (prefH === srcEntry.height || prefH >= (nativeHeightRef.current || Infinity) - 60);
              let idx = nativeAsk
                ? srcEntry.level
                : levels.find((l) => l.height === prefH)?.level ?? -1;
              if (idx === -1) {
                const below = levels.filter((l) => l.height > 0 && l.height <= prefH).sort((a, b) => b.height - a.height)[0];
                idx = below?.level ?? -1;
              }
              if (idx >= 0) {
                hls.currentLevel = idx;
                setCurrentQuality(idx);
              } else if (!tcCapRef.current) {
                // no native rung at/below the preference and no transcode
                // ladder — pin the LOWEST rung so a 480p preference never
                // plays 1080p by accident
                const lowest = levels.filter((l) => l.height > 0).sort((a, b) => a.height - b.height)[0];
                if (lowest) {
                  hls.currentLevel = lowest.level;
                  setCurrentQuality(lowest.level);
                } else {
                  setCurrentQuality(-1);
                }
              } else {
                setCurrentQuality(-1);
              }
            } else {
              setCurrentQuality(-1);
            }

            // persisted data-saver preference the provider cannot satisfy
            // natively → switch to the real-time transcode ladder (with the
            // serverless segment-ladder guards — >480 asks stay native).
            // ⚠ ladder masters carry the 144-480 rungs natively — hasNative
            // is true and this never re-attaches (in-place switch above).
            if (prefH > 0 && (DATA_SAVER_HEIGHTS as readonly number[]).includes(prefH)) {
              const hasNative = levels.some((l) => l.height > 0 && l.height <= prefH + 60);
              const segOnly = ch.kind === 'daddylive' && tcSegRef.current && !tcRelayRef.current;
              const servable = !segOnly || prefH <= 480;
              if (!hasNative && tcCapRef.current && servable) {
                void selectDataSaverRef.current?.(prefH);
                return;
              }
              if (!hasNative && !servable && prefH > 480 && !hiPrefNoticeRef.current) {
                hiPrefNoticeRef.current = true;
                showToast(t('player.prefUnavailable', { h: prefH }));
              }
              if (!hasNative && !tcCapRef.current && !tcNoticeRef.current) {
                tcNoticeRef.current = true;
                showToast(t('player.dsUnavailableToast'));
              }
            }

            // explicit alternate-rung pick — pin the closest rung, one shot
            const pin = pinHeightRef.current;
            pinHeightRef.current = null;
            if (pin && levels.length) {
              let bestLevel = -1;
              let bestH = 0;
              levels.forEach((l) => {
                if (l.height > 0 && l.height <= pin + 60 && l.height > bestH) {
                  bestH = l.height;
                  bestLevel = l.level;
                }
              });
              if (bestLevel >= 0) {
                hls.currentLevel = bestLevel;
                setCurrentQuality(bestLevel);
              }
            }

            video.muted = prefs.muted;
            playWithFallbackRef.current?.(video);
          });

          // connectivity engine — Auto keeps following the measured bandwidth
          attachNetWatcher(hls);
          // 2026-10-22 stall fix — background segment prefetch (ladder rungs
          // + Source): decouple fetch time from play time so cold-isolate
          // 404s and slow fallbacks never sit on the playhead's critical path
          attachSegPrefetch(hls);
          hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => {
            // ┚ rung-adaptive ride distance (ladder masters): turbo rungs are
            // encode-bound at the live edge (4-7s per 5s segment on a 1-vCPU
            // isolate) — they need the deep 5-segment ride + 45s buffer for
            // encode lead. The Source rung is CDN-direct (sub-second segments)
            // and keeps the ultra-low 3/30 posture. hls.js reads both config
            // keys live, so mutating per-switch is safe.
            if (ladderMasterRef.current && hls.levels) {
              const lvl = hls.levels[d.level];
              const turboRung = !!lvl && (lvl.height || 0) > 0 && !/raw=1/.test((lvl.url || []).join(''));
              // ⤴ 2026-10-22: when the CDN-direct path is dead (breaker open
              // — restrictive networks / CDN CORS flaps) every Source segment
              // rides the server fallback at 1.6-2.7s each; the prefetcher's
              // parallelism holds the throughput, and the deeper ride gives
              // that margin room to breathe instead of hugging the edge.
              const dead = !directPathHealthy();
              const cfg = hls.config as { liveSyncDurationCount?: number; maxBufferLength?: number };
              cfg.liveSyncDurationCount = turboRung ? 5 : dead ? 5 : 3;
              cfg.maxBufferLength = turboRung ? 45 : dead ? 45 : 30;
            }
            // refresh labels — some CDNs only report resolution once fragments load
            const lvl = hls.levels?.[d.level];
            const resH = Number(String(lvl?.attrs?.RESOLUTION ?? '').split('x')[1]) || 0;
            // videoHeight is trustworthy ONLY once THIS stream decoded a frame
            const vh = video.readyState >= 2 && video.currentTime > 0 ? video.videoHeight : 0;
            const h = lvl?.height || resH || vh;
            if (h) {
              setActiveHeight(h);
              // ⚠ on ladder masters only the SOURCE rung teaches the native
              // height — turbo rungs (144-480) are transcodes, and learning
              // e.g. 144 from an early ABR landing would corrupt the
              // native-ask threshold in selectDataSaver/setLevel
              const isSrcRung = !!ladderMasterRef.current && d.level === srcLevelRef.current;
              if (tcHeightRef.current === null && (!ladderMasterRef.current || isSrcRung)) {
                nativeHeightRef.current = Math.max(nativeHeightRef.current, h);
              }
              setQuality((prev) => {
                const label = `${h}p`;
                const next = prev.some((q) => q.label === label)
                  ? prev
                  : [...prev.filter((q) => q.label !== 'Source' && q.label !== '0k'), { label, level: d.level }];
                return next;
              });
              setCurrentQuality(hls.autoLevelEnabled ? -1 : d.level);
            }
          });
          hls.on(Hls.Events.ERROR, (_e, dRaw) => {
            // deterministic codec rejections arrive NON-FATAL first — promote
            // them so the codec-shaped handling below takes over immediately.
            const d =
              !dRaw.fatal &&
              dRaw.type === Hls.ErrorTypes.MEDIA_ERROR &&
              (dRaw.details === 'bufferAddCodecError' || dRaw.details === 'bufferIncompatibleCodecsError')
                ? { ...dRaw, fatal: true }
                : dRaw;
            if (!d.fatal) {
              // our relay/turbo endpoints mark off-air channels with 503 +
              // x-offair — bail to the honest off-air state immediately.
              if (
                d.type === Hls.ErrorTypes.NETWORK_ERROR &&
                (d as { response?: { code?: number } }).response?.code === 503
              ) {
                setPhase('offair');
                return;
              }
              // transient CDN flap — hls.js is retrying under the deep budget
              if (
                d.type === Hls.ErrorTypes.NETWORK_ERROR &&
                Date.now() - lastReconnectToastRef.current > 6000
              ) {
                lastReconnectToastRef.current = Date.now();
                showToast(t('player.reconnecting'));
              }
              return;
            }
            if (
              d.type === Hls.ErrorTypes.NETWORK_ERROR &&
              (d.details === 'manifestLoadError' ||
                d.details === 'manifestLoadTimeOut' ||
                d.details === 'manifestParsingError')
            ) {
              // manifest-level failure — includes PARSING (upstream served an
              // HTML error page as a "manifest"), which previously fell to the
              // generic branch without the off-air/proxy checks.
              if ((d as { response?: { code?: number } }).response?.code === 503) {
                setPhase('offair');
                return;
              }
              // direct-CDN play failed (CORS misdetected / CDN cold) — swap to
              // the proxy route for the SAME source before any server walking
              if (directPlayRef.current && proxiedSrcRef.current && !usedProxyFallbackRef.current) {
                usedProxyFallbackRef.current = true;
                directPlayRef.current = false;
                showToast(t('player.routing'));
                setPhase('loading');
                const pin = loadPrefs().quality;
                attachSourceRef.current?.(proxiedSrcRef.current, undefined, pin > 0 ? pin : undefined);
                return;
              }
              // unified failover walk (transports → cross-playlist alternates,
              // 2 passes) before declaring the stream dead
              const cur = playerRef.current || ch;
              const hop = findNextHop(cur);
              if (hop?.kind === 'server') {
                showToast(t('player.switchingServer', { label: hop.server.label, host: hop.server.host }));
                void loadRef.current(cur, { server: hop.server.id });
                return;
              }
              if (hop?.kind === 'alternate') {
                showToast(t('player.tryingSource', { name: hop.alt.sourceName }));
                void loadRef.current(altPlayable(cur, hop.alt), { isAlternate: true });
                return;
              }
              setPhase('error');
              setErrorMsg(t('player.manifestUnreachable'));
            } else if (
              d.type === Hls.ErrorTypes.NETWORK_ERROR &&
              (d.details === 'fragLoadError' || d.details === 'fragLoadTimeOut') &&
              (d as { response?: { code?: number } }).response?.code === 503
            ) {
              // our proxy returns 503 for off-air placeholder segments
              setPhase('offair');
            } else if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
              // direct-CDN segments failing (CORS only covered the manifest) —
              // swap to the proxy route for the same source, once
              if (directPlayRef.current && proxiedSrcRef.current && !usedProxyFallbackRef.current) {
                usedProxyFallbackRef.current = true;
                directPlayRef.current = false;
                showToast(t('player.routing'));
                setPhase('loading');
                const pin = loadPrefs().quality;
                attachSourceRef.current?.(proxiedSrcRef.current, undefined, pin > 0 ? pin : undefined);
                return;
              }
              // transient network trouble — one reconnect attempt, then the
              // unified failover walk
              const cur = playerRef.current || ch;
              const recon = (hlsRef.current as unknown as { _zillaRecon?: boolean }) || null;
              if (recon && !recon._zillaRecon) {
                recon._zillaRecon = true;
                hls.startLoad();
                return;
              }
              const hop = findNextHop(cur);
              if (hop?.kind === 'server') {
                showToast(t('player.switchingServer', { label: hop.server.label, host: hop.server.host }));
                void loadRef.current(cur, { server: hop.server.id });
                return;
              }
              if (hop?.kind === 'alternate') {
                showToast(t('player.tryingSource', { name: hop.alt.sourceName }));
                void loadRef.current(altPlayable(cur, hop.alt), { isAlternate: true });
                return;
              }
              setPhase('error');
              setErrorMsg(t('player.networkError', { detail: d.details || '' }));
            } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
              // codec-shaped failures are DETERMINISTIC — same-channel
              // alternates auto-hop; with none left, the explicit HEVC choice
              // panel takes over — NEVER a silent swap onto a brand-family feed.
              const codecShaped =
                d.details === 'bufferAppendError' ||
                d.details === 'bufferAddCodecError' ||
                d.details === 'bufferIncompatibleCodecsError' ||
                d.details === 'manifestIncompatibleCodecsError' ||
                (d.details === 'bufferAppendingError' && d.fatal);
              if (codecShaped) {
                const cur = playerRef.current;
                const h = hlsRef.current as unknown as { _zillaAppendRecov?: boolean } | null;
                // one plain reconnect PER CHANNEL first — append races can
                // mimic codec errors; a fresh MSE usually clears those.
                const recov = codecRecovRef.current;
                if (
                  cur &&
                  h &&
                  !h._zillaAppendRecov &&
                  d.details === 'bufferAppendError' &&
                  recov.chId === cur.id &&
                  recov.count < 1
                ) {
                  h._zillaAppendRecov = true;
                  recov.count += 1;
                  showToast(t('player.hiccup'));
                  triedRef.current = { chId: cur.id, tried: new Set(), pass: 0 };
                  void loadRef.current(cur);
                  return;
                }
                if (cur) {
                  if (cur.kind === 'iptv') triedRef.current.tried.add(cur.ref);
                  const next = alternatesRef.current.find((a) => a.sameChannel !== false && !triedRef.current.tried.has(a.url));
                  if (next) {
                    showToast(t('player.codecHop', { name: next.sourceName }));
                    void loadRef.current(altPlayable(cur, next), { isAlternate: true });
                    return;
                  }
                }
                // no same-channel escape → the explicit choice panel
                const family =
                  alternatesRef.current.find((a) => a.sameChannel === false && a.ladder?.length) ||
                  alternatesRef.current.find((a) => a.sameChannel === false);
                setHevcBlock({ family });
                setPhase('hevc');
                return;
              }
              // corrupted SourceBuffer state — reload the whole channel
              const h = hlsRef.current as unknown as { _zillaAppendRecov?: boolean; _zillaMediaRecov?: number } | null;
              const appendBroken =
                d.details === 'bufferAppendError' ||
                d.details === 'bufferAddCodecError' ||
                d.details === 'bufferAppendingError' && d.fatal;
              if (appendBroken) {
                const cur = playerRef.current;
                const recov = codecRecovRef.current;
                if (cur && h && !h._zillaAppendRecov && recov.chId === cur.id && recov.count < 1) {
                  h._zillaAppendRecov = true;
                  recov.count += 1;
                  showToast(t('player.hiccup'));
                  triedRef.current = { chId: cur.id, tried: new Set(), pass: 0 };
                  void loadRef.current(cur);
                  return;
                }
                setPhase('error');
                setErrorMsg(t('player.mediaError'));
                return;
              }
              // recovery ladder: recoverMediaError → swapAudioCodec+recover →
              // fresh reload → error
              if (h && !h._zillaMediaRecov) {
                h._zillaMediaRecov = 1;
                try {
                  hls.recoverMediaError();
                  return;
                } catch {
                  /* fall through */
                }
              } else if (h && h._zillaMediaRecov === 1) {
                h._zillaMediaRecov = 2;
                try {
                  hls.swapAudioCodec();
                  hls.recoverMediaError();
                  return;
                } catch {
                  /* fall through */
                }
              } else if (h && h._zillaMediaRecov === 2) {
                h._zillaMediaRecov = 3;
                const cur = playerRef.current;
                if (cur) {
                  showToast(t('player.hiccup'));
                  triedRef.current = { chId: cur.id, tried: new Set(), pass: 0 };
                  void loadRef.current(cur);
                  return;
                }
              }
              setPhase('error');
              setErrorMsg(t('player.mediaError'));
            } else {
              setPhase('error');
              setErrorMsg(t('player.playbackError', { detail: d.details || '' }));
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS
          video.src = src;
          video.muted = prefs.muted;
          playWithFallbackRef.current?.(video);
        }
      } catch (e) {
        if (gen !== loadGenRef.current) return; // closed/superseded — stay quiet
        setPhase('error');
        setErrorMsg((e as Error).message || 'Failed to resolve stream.');
      }
    },
    [showToast, t, findNextHop]
  );
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  loadRef.current = load;

  // keep the player ref in sync for the hls error handler / failover engine
  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  // reload the stream only when the channel ACTUALLY changes. The store's
  // enrichPlayable patches the open player (logo backfill) — a new object
  // identity with the SAME channel. Treating those as channel changes
  // re-resolved and re-attached the stream in a loop.
  const loadKeyRef = useRef('');
  useEffect(() => {
    if (!playerOpen || !player) return;
    const key = `${player.kind}:${player.ref}`;
    if (loadKeyRef.current === key) return; // logo/enrich patch — never reload
    loadKeyRef.current = key;
    void load(player);
  }, [playerOpen, player]);

  // cleanup on close — destroy hls AND invalidate any in-flight resolve so
  // closing during "Resolving stream…" is instant
  useEffect(() => {
    if (!playerOpen) {
      loadGenRef.current++;
      loadKeyRef.current = ''; // a reopen of the same channel must load again
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (turboRef.current) {
        turboRef.current.stop();
        turboRef.current = null;
        turboHeightRef.current = null;
        turboPausedRef.current = false;
        setTurboHeight(null);
      }
    }
  }, [playerOpen]);

  /* ── next-up helper ─────────────────────────────────────────────────────── */
  const nextChannel = useCallback((): SurfItem | null => {
    const list = surf;
    if (list.length < 2) return null;
    const idx = list.findIndex((s) => s.id === player?.id);
    if (idx === -1) return list[0];
    return list[(idx + 1) % list.length];
  }, [surf, player]);

  /* ── auto-advance countdown (Pluto-style "up next" on dead channels) ────── */
  useEffect(() => {
    if ((phase === 'offair' || phase === 'error') && playerOpen && loadPrefs().autoAdvance) {
      const next = nextChannel();
      if (!next || next.id === player?.id) return;
      let cancelled = false;
      let secs = 10;
      setAutoAdvSecs(secs);
      cancelAutoAdvRef.current = () => {
        cancelled = true;
        setAutoAdvSecs(null);
      };
      const iv = setInterval(() => {
        if (cancelled) {
          clearInterval(iv);
          return;
        }
        secs -= 1;
        if (secs <= 0) {
          clearInterval(iv);
          setAutoAdvSecs(null);
          openPlayer(next);
        } else {
          setAutoAdvSecs(secs);
        }
      }, 1000);
      return () => {
        clearInterval(iv);
        cancelAutoAdvRef.current = null;
      };
    }
    setAutoAdvSecs(null);
  }, [phase, playerOpen, nextChannel, openPlayer, player]);

  /* ── Settings-menu sync — apply quality changes made while playing ───────── */
  useEffect(() => {
    return onPrefsChange((p, patch) => {
      // Only react to actual QUALITY changes (incidental patches used to
      // re-enter selectDataSaver/exitDataSaver and mutually recurse).
      if (patch && patch.quality === undefined) return;
      const hls = hlsRef.current;
      if (p.quality === -1) {
        if (hls && hls.levels?.length && tcHeightRef.current === null) hls.nextLevel = -1;
        setCurrentQuality(-1);
        if (tcHeightRef.current !== null && !p.autoPicked) void exitDataSaverRef.current?.();
        return;
      }
      if (!hls || !hls.levels?.length) return;
      // 'Source' preference (0) — pin the NATIVE rung on ladder masters
      // (identified by label; hls.js sorting makes "top" unreliable)
      if (p.quality === 0) {
        if (tcHeightRef.current === null) {
          const labels = (hls.levels || []).map((l, i) => ({
            i,
            src: /raw=1/.test((l.url || []).join('')),
          }));
          const srcIdx = labels.find((l) => l.src)?.i ?? hls.levels.length - 1;
          hls.nextLevel = srcIdx;
          setCurrentQuality(srcIdx);
        }
        return;
      }
      const levels = hls.levels.map((l, i) => ({
        i,
        h: l.height || 0,
        src: /raw=1/.test((l.url || []).join('')),
      }));
      // a persisted native-height pick (the relabeled Source entry persists
      // as its height) must re-pin the Source rung, not the 480 turbo rung
      const srcLvl = levels.find((l) => l.src);
      const nativeAsk =
        !!srcLvl && (p.quality === srcLvl.h || p.quality >= (nativeHeightRef.current || Infinity) - 60);
      let idx = nativeAsk
        ? srcLvl.i
        : levels.find((l) => l.h === p.quality)?.i ?? -1;
      if (idx === -1) {
        const below = levels.filter((l) => l.h > 0 && l.h <= p.quality).sort((a, b) => b.h - a.h)[0];
        idx = below?.i ?? -1;
      }
      if (idx >= 0 && tcHeightRef.current === null) {
        hls.nextLevel = idx; // smooth switch at the next segment boundary
        setCurrentQuality(idx);
      } else if ((DATA_SAVER_HEIGHTS as readonly number[]).includes(p.quality)) {
        // guard: never re-enter a rung that is ALREADY active
        if (tcHeightRef.current !== p.quality) {
          void selectDataSaverRef.current?.(p.quality);
        }
      }
    });
  }, []);

  /* ── content-mismatch guard (the football→F1 fix, layer 3) ───────────── */
  useEffect(() => {
    if (phase !== 'playing' || !player || player.kind !== 'daddylive') return;
    if (!player.category || player.category === 'other') return;
    if (mismatchChecked.current === player.id) return;

    const tm = setTimeout(async () => {
      const v = videoRef.current;
      if (!v || v.videoWidth === 0 || v.readyState < 2) return;
      mismatchChecked.current = player.id;
      try {
        const canvas = document.createElement('canvas');
        const scale = Math.min(1, 640 / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * scale);
        canvas.height = Math.round(v.videoHeight * scale);
        canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height);
        const image = canvas.toDataURL('image/jpeg', 0.72);
        const r = await fetch('/api/vision/sport', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ image, expect: player.category }),
        });
        if (!r.ok) return;
        const d = (await r.json()) as { sport?: string; confidence?: number; matches?: boolean };
        if (d && d.matches === false && d.sport && (d.confidence ?? 0) >= 0.55) {
          setMismatch({ sport: d.sport, confidence: d.confidence ?? 0.5 });
        }
      } catch {
        /* advisory only — never disturb playback */
      }
    }, 9000);

    return () => clearTimeout(tm);
  }, [phase, player]);

  /** hop to the event's next feed (mismatch banner + feed cycler) */
  const cycleFeed = useCallback(() => {
    if (altFeeds.length < 2 || !player) return;
    const idx = altFeeds.findIndex((f) => f.id === player.id);
    const next = altFeeds[(idx + 1) % altFeeds.length] || altFeeds[0];
    if (next && next.id !== player.id) {
      setMismatch(null);
      showToast(t('player.switchingTo', { name: next.name.split(' — ')[1] || next.name }));
      openPlayer(next, altFeeds);
    }
  }, [altFeeds, player, openPlayer, showToast, t]);

  /* ── ladder Source-rung keep-alive ──────────────────────────────────────────
   * hls.js only polls the playlist of the CURRENT level — while the viewer
   * sits on a turbo rung (144-480), the Source rung's raw=1 manifest is
   * never polled: the dledge micro-cache expires, the CH_UP session drifts,
   * and the later switch back to Source pays a cold pair-fetch at the worst
   * moment (a flaky pair then escalates to a fatal walk). A 20s keep-alive
   * fetch of the Source variant keeps every rung transition warm — and each
   * poll also touches the channel's turbo session server-side (see
   * /api/hls touchTurbo), keeping the rungs' transcode engine alive. */
  useEffect(() => {
    if (phase !== 'playing' || !ladderMaster) return;
    const iv = setInterval(() => {
      const hls = hlsRef.current;
      if (!hls || !hls.levels?.length) return;
      const srcUrl = hls.levels.find((l) => /raw=1/.test((l.url || []).join('')))?.url?.[0];
      if (srcUrl) {
        void fetch(srcUrl, { cache: 'no-store' }).catch(() => {
          /* best-effort warmth — failures are silent by design */
        });
      }
    }, 20_000);
    return () => clearInterval(iv);
  }, [phase, ladderMaster]);

  /* ── ladder live-edge watchdog (stale-position deadlock) ───────────────────
   * Rung switches mid-stream leave the flushed playhead parked BEHIND the new
   * rung's window — the Source rung lists only the live 4-6 segments, so a
   * playhead that fell 30s+ behind finds NO fragment at its position and
   * hls.js waits forever with an empty buffer (measured frozen 65s+ on
   * production). Nothing else recovers that state: the playlists advance, the
   * polls succeed, but no frag ever matches. The watchdog detects exactly
   * that shape — starved (readyState≤2), zero buffered, far behind the
   * seekable end — and jumps the playhead to the live edge, where the new
   * rung delivers immediately. Live sports: the edge is where the match is. */
  useEffect(() => {
    if (phase !== 'playing' || !ladderMaster) return;
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.readyState > 2 || v.buffered.length || !v.seekable.length) return;
      const end = v.seekable.end(v.seekable.length - 1);
      if (Number.isFinite(end) && end - v.currentTime > 25 && v.currentTime >= 0) {
        try {
          v.currentTime = Math.max(0, end - 1.5);
          setLiveBehind(false);
        } catch {
          /* seekable not ready — next tick retries */
        }
      }
    }, 3_000);
    return () => clearInterval(iv);
  }, [phase, ladderMaster]);

  /* ── micro-gap unfreeze watchdog (frozen-WITH-buffer deadlock) ─────────────
   * The DUAL of the watchdog above: the playhead freezes while the buffer
   * still has data. Root cause (measured on production, 2026-10-22 audit,
   * ch91 Source): an upstream PTS discontinuity left a 0.11s hole between two
   * completely-appended segments → the video decoder's frames ended 0.07s
   * before the buffered range end → Chrome stalled at the last frame. hls.js
   * 1.7.3 could not recover it — its bufferInfo merges holes under
   * maxBufferHole (0.5s) so the gap looked like continuous buffer ("nothing
   * to fix"), _trySkipBufferHole only fires on PARTIAL fragments, and
   * nudgeOnVideoHole needs the playhead already PAST the video range end.
   * Net effect: a permanent freeze with 23.8s of "buffer" — for 2.5+ minutes
   * until a manual seek, while the starved watchdog above stayed silent
   * (it requires ZERO buffer). Detection here is the exact deadlock shape:
   * playhead FROZEN (not advancing between ticks) + starved (readyState≤2)
   * + data AHEAD of the playhead + not paused/seeking. Recovery: hop onto
   * the far side of the micro-gap (next buffered range start +0.05) or, when
   * frozen mid-range, the classic +0.15 nudge — the same move that unfroze
   * the production incident by hand. Bounded: fires only after 8s frozen,
   * max 3 nudges per episode (reset the moment the playhead moves again);
   * never seeks past the buffered span. */
  useEffect(() => {
    if (phase !== 'playing') return;
    let lastCt = -1;
    let frozenAt = 0;
    let nudges = 0;
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.seeking || v.paused || v.playbackRate === 0 || !v.buffered.length) {
        if (v) lastCt = v.currentTime;
        frozenAt = 0;
        return;
      }
      const ct = v.currentTime;
      if (ct !== lastCt) {
        // playhead advancing — healthy; reset the episode
        lastCt = ct;
        frozenAt = 0;
        nudges = 0;
        return;
      }
      // frozen — only the deadlock shape: starved at the decoder while
      // servable data sits ahead (a legit wait at the live edge has NO
      // data ahead and is left to the fetch machinery)
      if (v.readyState > 2 || v.buffered.end(v.buffered.length - 1) <= ct + 0.05) return;
      if (!frozenAt) {
        frozenAt = Date.now();
        return;
      }
      if (Date.now() - frozenAt < 8_000 || nudges >= 3) return;
      let nextStart = -1;
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) > ct) {
          nextStart = v.buffered.start(i);
          break;
        }
      }
      const end = v.buffered.end(v.buffered.length - 1);
      const target =
        nextStart > 0 && nextStart - ct < 2
          ? nextStart + 0.05 // hop the micro-gap onto the far range
          : ct + 0.15 < end - 0.05
            ? ct + 0.15 // classic nudge, still inside the buffered span
            : -1;
      if (target < 0) return;
      try {
        v.currentTime = target;
        nudges++;
        frozenAt = Date.now(); // fresh window before the next nudge
      } catch {
        /* seekable not ready — next tick retries */
      }
    }, 3_000);
    return () => clearInterval(iv);
  }, [phase]);

  /* ── live-edge drift watcher ───────────────────────────────────────────── */
  useEffect(() => {
    if (phase !== 'playing') return;
    const iv = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.seekable.length) return;
      const end = v.seekable.end(v.seekable.length - 1);
      setLiveBehind(end - v.currentTime > 20);
    }, 5000);
    return () => clearInterval(iv);
  }, [phase]);

  /* ── auto-hide controls ─────────────────────────────────────────────────── */
  const poke = useCallback(() => {
    setControlsVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (phase === 'playing' && !surfOpen && !showQualityMenu && !showServersMenu && !showStats) setControlsVisible(false);
    }, 3200);
  }, [phase, surfOpen, showQualityMenu, showServersMenu, showStats]);

  useEffect(() => {
    poke();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [poke, phase]);

  /* ── channel switching ──────────────────────────────────────────────────── */
  const switchTo = useCallback(
    (item: Playable, feeds?: Playable[]) => {
      openPlayer(item, feeds);
    },
    [openPlayer]
  );

  const zapPrev = useCallback(() => {
    const list = surf;
    if (list.length < 2) return;
    const idx = list.findIndex((s) => s.id === player?.id);
    const prev = idx <= 0 ? list[list.length - 1] : list[idx - 1];
    if (prev) openPlayer(prev);
  }, [surf, player, openPlayer]);

  const zapNext = useCallback(() => {
    const n = nextChannel();
    if (n && n.id !== player?.id) openPlayer(n);
  }, [nextChannel, player, openPlayer]);

  /* ── video actions ──────────────────────────────────────────────────────── */
  /** Unmute helper — a ZERO volume makes the unmute button look dead. Every
   *  unmute path funnels through here and lifts a 0 volume back to 0.75. */
  const soundOn = useCallback((v: HTMLVideoElement) => {
    if (v.volume === 0 || Number.isNaN(v.volume)) {
      v.volume = 0.75;
      setVolume(0.75);
    }
    v.muted = false;
    setMuted(false);
  }, []);

  /** play() with the browser-autoplay fallback: when unmuted autoplay is
   *  blocked, fall back to MUTED playback + the tap-for-sound button. */
  const playWithFallback = useCallback((v: HTMLVideoElement) => {
    v.play().catch(() => {
      v.muted = true;
      setMuted(true);
      v.play().catch(() => {
        /* still blocked — the play button / tap overlay remain */
      });
    });
  }, []);
  const playWithFallbackRef = useRef(playWithFallback);
  playWithFallbackRef.current = playWithFallback;

  const togglePlay = useCallback(() => {
    if (turboRef.current) {
      if (turboPausedRef.current) {
        turboRef.current.resume();
        turboPausedRef.current = false;
        setPhase('playing');
      } else {
        turboRef.current.pause();
        turboPausedRef.current = true;
        setPhase('paused');
      }
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      soundOn(v);
      v.play().catch(() => {});
    } else {
      v.pause();
      setPhase('paused');
    }
  }, [soundOn]);

  const toggleMute = useCallback(() => {
    if (turboRef.current) {
      const next = !muted;
      turboRef.current.setMuted(next);
      setMuted(next);
      if (!next && (volume === 0 || Number.isNaN(volume))) {
        turboRef.current.setVolume(0.75);
        setVolume(0.75);
      }
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    if (v.muted) soundOn(v);
    else {
      v.muted = true;
      setMuted(true);
    }
  }, [soundOn, muted, volume]);

  const goLive = useCallback(() => {
    if (turboRef.current) {
      turboRef.current.jumpToLive();
      setLiveBehind(false);
      return;
    }
    const v = videoRef.current;
    if (!v || !v.seekable.length) return;
    v.currentTime = v.seekable.end(v.seekable.length - 1) - 1;
    setLiveBehind(false);
    v.play().catch(() => {});
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void el.requestFullscreen().catch(() => {});
    }
  }, []);

  useEffect(() => {
    const onFs = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const togglePip = useCallback(async () => {
    if (turboRef.current) {
      showToast(t('player.localTurboNoPip'));
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await v.requestPictureInPicture();
      } else {
        showToast(t('player.pipUnsupported'));
      }
    } catch {
      showToast(t('player.pipUnavailable'));
    }
  }, [showToast, t]);

  /* ── data-saver ladder (real-time transcode) ────────────────────────── */

  /** attach a fresh hls instance to a source URL without re-resolving. */
  const attachSource = useCallback(
    (src: string, level?: number, pinHeight?: number) => {
      const video = videoRef.current;
      if (!video) return;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      const prefs = loadPrefs();
      video.volume = prefs.volume;
      video.muted = prefs.muted;
      if (Hls.isSupported()) {
        // &h= ladder src → ride 5 segments back with a deep buffer (the encode
        // needs lead time); native srcs keep the profile-tuned edge distance.
        // v1.3 ladder masters → the balanced ladder distance + the direct-
        // segment loader; plain restores keep the profile config.
        const ladderSeg = /\/api\/turbo\?.*\bh=\d+/.test(src);
        const isLadderSrc = /lad=1/.test(src);
        ladderMasterRef.current = isLadderSrc;
        setLadderMaster(isLadderSrc);
        const hls = new Hls({
          // see load() — LL mode off or hls.js plays 2× catch-up
          lowLatencyMode: false,
          enableWorker: true,
          // CDN-direct segment uncloaking (v1.3) — no-ops for non-segdl URLs
          loader: UncloakDirectLoader as unknown as typeof Hls.DefaultConfig.loader,
          ...(isLadderSrc
            ? LADDER_MASTER_HLS_CONFIG
            : ladderSeg
              ? LADDER_HLS_CONFIG
              : hlsPerfConfig(loadPrefs().perfMode)),
          ...RESILIENT_LOAD_POLICIES,
        });
        hlsRef.current = hls;
        // expose the live hls instance for E2E inspection
        if (typeof window !== 'undefined') {
          (window as unknown as { __maxtvHls?: Hls }).__maxtvHls = hls;
        }
        hls.loadSource(src);
        hls.attachMedia(video);
        // connectivity engine on data-saver attachments too — this is the only
        // place recovery ("back to native") and rung-hopping can fire from
        // while transcoding
        attachNetWatcher(hls);
        // 2026-10-22 stall fix — background segment prefetch (see load())
        attachSegPrefetch(hls);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (typeof level === 'number' && level >= 0 && hls.levels?.[level]) {
            hls.currentLevel = level;
          } else if (pinHeight && hls.levels?.length) {
            let best = -1;
            let bestH = 0;
            hls.levels.forEach((l, i) => {
              const h = l.height || 0;
              if (h > 0 && h <= pinHeight + 60 && h > bestH) {
                bestH = h;
                best = i;
              }
            });
            if (best >= 0) {
              hls.currentLevel = best;
              setCurrentQuality(best);
            }
          }
          playWithFallback(video);
        });
        hls.on(Hls.Events.ERROR, (_e, d) => {
          if (!d.fatal) return;
          if (d.details === 'manifestLoadError' || (d.type === Hls.ErrorTypes.NETWORK_ERROR && (d as { response?: { code?: number } }).response?.code === 503)) {
            // only bounce back to native when we're actually IN data-saver
            // mode — calling exitDataSaver from a failing NATIVE restore
            // would recurse
            if (tcHeightRef.current !== null) {
              showToast(t('player.dsStreamUnavailable'));
              void exitDataSaverRef.current?.();
            }
          }
        });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.play().catch(() => {});
      }
    },
    [showToast, t, attachNetWatcher]
  );
  const attachSourceRef = useRef(attachSource);
  attachSourceRef.current = attachSource;

  /** ladder rung switch without the stall — edge-aligned. Both directions
   *  need it: a playhead riding deep on one rung is often OUTSIDE the other
   * rung's servable window (the Source playlist lists only the live 4-6
   * segments; the turbo warm band sits 2-7 segments back), so a plain flush
   * at the current position stalls — hls.js waits forever with an empty
   * buffer and the live-edge watchdog only recovers it after a 25s+ freeze
   * (the "quality picks load so much" report). Jump the playhead to the
   * live edge - ~12s FIRST — still inside the CURRENT rung's buffer, so the
   * seek is instant — then flush: the first fragment request lands where
   * the target rung actually has (or can instantly get) bytes. TURBO
   * targets always flush (encode-bound rungs must show the pick NOW);
   * the CDN-direct Source rides the boundary smoothly on a shallow buffer. */
  const warmBandSwitch = useCallback(
    (hlsL: Hls, level: number) => {
      const v = videoRef.current;
      const ahead = v && v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
      if (ahead > 14 && v && v.seekable.length) {
        const end = v.seekable.end(v.seekable.length - 1);
        if (Number.isFinite(end)) {
          // COLD-RUNG RUNWAY: a target level never polled this session may
          // still be spinning its encoder up (5-15s). Landing 12s from the
          // edge puts the playhead AT the encode frontier once the
          // prefetched band plays out (measured 2026-10-22, ch91 → 144p:
          // single stall cluster right at the frontier; the pre-tip-404
          // cascade was fixed in 5e509f4, this is the residual). Land
          // deeper on cold targets — inside the fresh-level prewarm band
          // (ride−1 … tip, ≈6 segments) so the band is real runway and
          // the encoder settles before the playhead reaches the tip.
          // Polled targets (hot rungs, recent Source) keep the tight 12s.
          const cold = !hlsL.levels?.[level]?.details?.fragments?.length;
          try {
            v.currentTime = Math.max(0, end - (cold ? 16 : 12));
          } catch {
            /* seekable not ready — the flush below still switches */
          }
        }
        hlsL.currentLevel = level; // flush NOW at the edge-aligned position
      } else {
        hlsL.nextLevel = level; // shallow — seamless boundary switch
      }
    },
    []
  );

  /** switch to a transcoded rendition (144p → 1080p) of the current stream.
   *  opts.auto marks a connectivity-engine pick — keeps the user's Auto.
   *  ⚠ v1.3 LADDER SOURCES: the rungs are native hls levels — this maps to
   *  an IN-PLACE nextLevel switch. No re-attach, no reload, no channel
   *  jump (the "144p changed the channel then returned" bug lived here). */
  const selectDataSaver = useCallback(
    (height: number, opts: { auto?: boolean } = {}) => {
      const cur = playerRef.current;
      if (!cur) return;
      // ladder master — the rung already exists as a level: switch in place
      const hlsL = hlsRef.current;
      if (ladderMasterRef.current && hlsL && hlsL.levels?.length) {
        const lvls = hlsL.levels.map((l, i) => ({
          i,
          h: l.height || 0,
          src: /raw=1/.test((l.url || []).join('')),
        }));
        // a native ask (the Source rung, or its probed height) pins the
        // SOURCE — the level list may not expose its height on cold isolates
        const srcLvl = lvls.find((l) => l.src);
        const nativeAsk =
          height === 0 || (!!srcLvl && height >= (nativeHeightRef.current || Infinity) - 60);
        const exact = nativeAsk ? srcLvl : lvls.find((l) => l.h === height);
        const below = lvls.filter((l) => l.h > 0 && l.h <= height).sort((a, b) => b.h - a.h)[0];
        const pick = exact || below;
        if (pick) {
          setShowQualityMenu(false);
          // edge-aligned rung switch (see warmBandSwitch): deep runway →
          // seek to the live-edge band + flush (pick shows NOW); shallow →
          // seamless boundary switch (the target rung's session warms up
          // BEHIND the still-playing buffer instead of a black screen).
          // PREWARM: fire the rung's playlist once so whichever isolate
          // serves it starts its turbo session + warm band immediately —
          // hls.js only polls the new level at the switch boundary, and a
          // cold-isolate warmup (5-15s) must never be paid in front of a
          // drained buffer.
          const lvlUrls = (hlsL.levels[pick.i]?.url || []).join('');
          if (!/raw=1/.test(lvlUrls)) {
            try {
              const u = new URL(lvlUrls, window.location.origin);
              void fetch(u.toString(), { cache: 'no-store' }).catch(() => {});
            } catch {
              /* prewarm is best-effort */
            }
          }
          warmBandSwitch(hlsL, pick.i);
          setCurrentQuality(pick.i);
          // persist the NATIVE preference when the pick was the Source rung
          updatePrefs({ quality: pick.src ? 0 : height, autoPicked: !!opts.auto });
          if (opts.auto) setAutoDs(true);
          showToast(t('player.qualityToast', { label: pick.src ? 'Source' : `${height}p` }));
          return;
        }
      }
      // deployments without ffmpeg have no ladder — stay native (one notice
      // per page load)
      if (!tcCapRef.current) {
        if (opts.auto !== true && !tcNoticeRef.current) {
          tcNoticeRef.current = true;
          showToast(t('player.dsUnavailableToast'));
        }
        return;
      }
      const h0 = (DATA_SAVER_HEIGHTS as readonly number[]).includes(height) ? height : 360;
      setShowQualityMenu(false);
      // segment ladder (serverless): tops at 480 — refuse >480 asks (stale
      // persisted preferences), reset to Auto, stay native.
      const useSegLadder = cur.kind === 'daddylive' && tcSegRef.current && !tcRelayRef.current;
      if (useSegLadder && h0 > 480) {
        showToast(t('player.segRefuse', { h: h0 }));
        updatePrefs({ quality: -1, autoPicked: false });
        return;
      }
      const h = h0;
      // never encode UP: a rung STRICTLY above the native feed's height can
      // only lose quality and burn CPU.
      // ⚠ exit data-saver BEFORE updatePrefs — the settings-sync effect
      // echoes quality picks back into this function; restoring the native
      // instance first lets the echo resolve there instead of re-entering.
      const nh = nativeHeightRef.current;
      if (opts.auto !== true && nh > 0 && h > nh + 60) {
        if (tcHeightRef.current !== null) {
          showToast(t('player.nativeIsHp', { h: nh }));
          void exitDataSaverRef.current?.();
        } else {
          showToast(t('player.topsAt', { h: nh }));
        }
        updatePrefs({ quality: h, autoPicked: false });
        return;
      }
      // ⚠ set the ref BEFORE updatePrefs — savePrefs dispatches the prefs
      // event SYNCHRONOUSLY, and the settings-sync effect re-enters
      // selectDataSaver unless it can see the rung is already active.
      setTcHeight(h);
      tcHeightRef.current = h; // synchronous for cross-callback checks
      setCurrentQuality(-2); // marks the data-saver selection in the chip
      if (opts.auto) {
        updatePrefs({ autoPicked: true });
        setAutoDs(true);
      } else {
        updatePrefs({ quality: h, autoPicked: false });
        setAutoDs(false);
      }
      const base =
        cur.kind === 'daddylive'
          ? useSegLadder
            ? `/api/turbo?channel=${encodeURIComponent(cur.ref)}&h=${h}`
            : `/api/transcode?channel=${encodeURIComponent(cur.ref)}`
          : tcSrcRef.current
            ? `/api/transcode?src=${encodeURIComponent(tcSrcRef.current.src)}&r=${encodeURIComponent(tcSrcRef.current.r)}&s=${encodeURIComponent(tcSrcRef.current.s)}`
            : null;
      if (!base) {
        showToast(t('player.dsUnavailableChannel'));
        return;
      }
      showToast(t('player.dsEngaged', { h }));
      setPhase('loading');
      attachSource(`${base}${useSegLadder ? '' : `&height=${h}`}&mode=m3u8`);

      // learn the source's real height in the background (single-rendition
      // media playlists don't declare it — the server ffprobes a segment).
      const gen = loadGenRef.current;
      if (!useSegLadder) {
        void fetch(`${base}&height=${h}&mode=probe`)
          .then((r) => (r.ok ? (r.json() as Promise<{ sourceHeight?: number }>) : null))
          .then((d) => {
            if (gen !== loadGenRef.current) return; // channel changed meanwhile
            const sh = d?.sourceHeight || 0;
            if (sh <= 0) return;
            nativeHeightRef.current = Math.max(nativeHeightRef.current, sh);
            if (tcHeightRef.current !== null && tcHeightRef.current > sh + 60) {
              showToast(t('player.topsAtBack', { h: sh }));
              void exitDataSaverRef.current?.();
            }
          })
          .catch(() => {});
      }
    },
    [attachSource, showToast, t, warmBandSwitch]
  );
  useEffect(() => {
    selectDataSaverRef.current = selectDataSaver;
  }, [selectDataSaver]);

  /** leave data saver — restore the native (non-transcoded) feed */
  const exitDataSaver = useCallback(() => {
    setShowQualityMenu(false);
    setTcHeight(null);
    tcHeightRef.current = null; // synchronous — attachSource's error guard reads it
    setAutoDs(false);
    updatePrefs({ autoPicked: false });
    const src = nativeSrcRef.current;
    if (src) {
      setPhase('loading');
      attachSource(src);
    }
  }, [attachSource]);
  useEffect(() => {
    exitDataSaverRef.current = exitDataSaver;
  }, [exitDataSaver]);

  /* ── Local Turbo (Tier 3): browser-side low-latency pipeline ─────── */

  /** capability probe — cheap + memoized in the engine module */
  useEffect(() => {
    setTurboCapable(probeLocalTurbo());
  }, []);

  /** leave Turbo — restore the standard hls.js engine on the native source */
  const exitTurbo = useCallback(
    (restore = true) => {
      setShowQualityMenu(false);
      turboRef.current?.stop();
      turboRef.current = null;
      turboHeightRef.current = null;
      turboPausedRef.current = false;
      setTurboHeight(null);
      setBuffering(false);
      const src = nativeSrcRef.current;
      if (restore && src) {
        setPhase('loading');
        attachSource(src);
      }
    },
    [attachSource]
  );
  const exitTurboRef = useRef(exitTurbo);
  exitTurboRef.current = exitTurbo;

  /** switch playback to the local pipeline at a render-height rung
   *  (0 = Source/native size — pure live-edge boost) */
  const enterTurbo = useCallback(
    async (height: number) => {
      setShowQualityMenu(false);
      const src = nativeSrcRef.current;
      const canvas = turboCanvasRef.current;
      if (!src || !canvas || isDlIframeSrc(src)) return;
      if (tcHeightRef.current !== null) return; // not from data-saver mode
      // hand over from hls.js — the canvas takes over the surface
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      turboHeightRef.current = height;
      setTurboHeight(height);
      turboPausedRef.current = false;
      setPhase('loading');
      setBuffering(true);
      const prefs = loadPrefs();
      try {
        turboRef.current = await startLocalTurbo({
          url: src,
          canvas,
          height: height || null,
          volume: prefs.volume,
          muted: prefs.muted,
          onPhase: (p) => {
            if (p === 'playing') {
              setPhase('playing');
              setBuffering(false);
            } else if (p === 'stalled') {
              setBuffering(true);
            } else if (p === 'error') {
              showToast(t('player.localTurboFail'));
              exitTurboRef.current(true);
            }
          },
          onStats: (st) => {
            if (typeof window !== 'undefined') {
              (window as unknown as { __maxtvTurbo?: unknown }).__maxtvTurbo = st;
            }
          },
        });
        showToast(t('player.localTurboOn', { height: height || t('player.sourceRung') }));
      } catch {
        turboRef.current = null;
        turboHeightRef.current = null;
        setTurboHeight(null);
        showToast(t('player.localTurboFail'));
        const s = nativeSrcRef.current;
        if (s) {
          setPhase('loading');
          attachSource(s);
        } else {
          setPhase('error');
        }
      }
    },
    [showToast, t, attachSource]
  );

  const setLevel = useCallback(
    (level: number) => {
      setShowQualityMenu(false);
      // leaving Turbo for a native/alt rung — drop the engine first; the
      // restore paths below re-attach hls.js themselves
      if (turboRef.current) {
        const wasTurbo = true;
        turboRef.current.stop();
        turboRef.current = null;
        turboHeightRef.current = null;
        turboPausedRef.current = false;
        setTurboHeight(null);
        setBuffering(false);
        if (wasTurbo && nativeSrcRef.current) {
          setPhase('loading');
          attachSource(nativeSrcRef.current, level >= 0 ? level : undefined);
          setCurrentQuality(level);
          showToast(level === -1 ? t('player.qualityAutoToast') : t('player.qualityToast', { label: quality.find((q) => q.level === level)?.label ?? '' }));
          return;
        }
      }
      // persist the preference so every future stream opens at this quality.
      // The ladder's Source rung persists as quality 0 (the documented
      // "source/native" preference) — identified by LEVEL INDEX, not label
      // (the entry relabels to its native "720p"/"1080p" once probed, and a
      // relabeled pick must still persist as the native preference).
      const label = level === -1 ? t('player.auto') : quality.find((q) => q.level === level)?.label ?? '';
      const isSourceRung = level >= 0 && level === srcLevelRef.current;
      const height = level === -1 ? -1 : isSourceRung ? 0 : parseInt(label, 10) || -1;
      updatePrefs({ quality: height, autoPicked: false });
      if (tcHeight !== null) {
        // leaving the data-saver ladder — restore the native feed, pin level
        setTcHeight(null);
        setAutoDs(false);
        setCurrentQuality(level);
        const src = nativeSrcRef.current;
        if (src) {
          setPhase('loading');
          attachSource(src, level >= 0 ? level : undefined);
        }
        showToast(level === -1 ? t('player.qualityAutoToast') : t('player.qualityToast', { label }));
        return;
      }
      const hls = hlsRef.current;
      if (!hls) return;
      // edge-aligned rung switch on ladder masters (see warmBandSwitch):
      // deep runway → live-edge seek + flush; shallow → boundary ride.
      // Non-ladder sources keep the classic buffer-aware behavior.
      const lvlUrls = level >= 0 && hls.levels?.[level] ? (hls.levels[level].url || []).join('') : '';
      const ladderRung =
        ladderMasterRef.current &&
        level >= 0 &&
        ((hls.levels?.[level]?.height || 0) > 0 || /raw=1/.test(lvlUrls));
      if (level >= 0 && ladderRung) {
        warmBandSwitch(hls, level);
      } else {
        const vid = videoRef.current;
        const ahead =
          vid && vid.buffered.length ? vid.buffered.end(vid.buffered.length - 1) - vid.currentTime : 0;
        if (level >= 0 && ahead > 20) hls.currentLevel = level;
        else hls.nextLevel = level;
      }
      setCurrentQuality(level);
      showToast(level === -1 ? t('player.qualityAutoToast') : t('player.qualityToast', { label }));
    },
    [quality, showToast, tcHeight, attachSource, t, warmBandSwitch]
  );

  /* ── per-stream server switching (original-repo feature) ───────────── */
  const retryStream = useCallback(() => {
    const cur = playerRef.current;
    if (!cur) return;
    // fresh attempt: forget which servers/alternates already burned out
    triedRef.current = { chId: cur.id, tried: new Set(), pass: 0 };
    void loadRef.current(cur);
  }, []);

  const switchServer = useCallback(
    (serverId: string) => {
      const cur = playerRef.current;
      if (!cur || cur.kind !== 'daddylive') return;
      setShowServersMenu(false);
      const srv = serversRef.current.find((s) => s.id === serverId);
      if (srv) showToast(t('player.switchingServer', { label: srv.label, host: srv.host }));
      void loadRef.current(cur, { server: serverId });
    },
    [showToast, t]
  );

  const switchAlternate = useCallback(
    (alt: AltServer) => {
      const cur = playerRef.current;
      if (!cur) return;
      setShowServersMenu(false);
      setAltUrl(alt.url);
      if (cur.kind === 'daddylive') setActiveServer('');
      showToast(t('player.switchingTo', { name: alt.sourceName }));
      void loadRef.current(altPlayable(cur, alt), { isAlternate: true });
    },
    [showToast, t]
  );

  /** the HEVC panel's "play the HEVC feed anyway" */
  const playHevcAnyway = useCallback(() => {
    forceHevcRef.current = true;
    setHevcBlock(null);
    const cur = playerRef.current;
    if (cur) void loadRef.current(cur);
  }, []);

  /** quality-menu pick of an alternate-source rung ("1080p · via beIN XTRA") */
  const pickAltRung = useCallback(
    (alt: AltServer, h: number) => {
      const cur = playerRef.current;
      if (!cur) return;
      setShowQualityMenu(false);
      updatePrefs({ quality: h, autoPicked: false });
      pinHeightRef.current = h;
      setAltUrl(alt.url);
      if (cur.kind === 'daddylive') setActiveServer('');
      showToast(t('player.altRungToast', { source: alt.sourceName, h }));
      void loadRef.current(altPlayable(cur, alt), { isAlternate: true });
    },
    [showToast, t]
  );

  /** leave an alternate source — back to the channel's live servers */
  const backToLiveServers = useCallback(() => {
    const cur = playerRef.current;
    if (!cur || cur.kind !== 'daddylive') return;
    setShowServersMenu(false);
    setAltUrl(null);
    // fresh walk of the transport ladder, starting at the default server
    triedRef.current = { chId: cur.id, tried: new Set(), pass: 0 };
    void loadRef.current(cur);
  }, []);

  const share = useCallback(async () => {
    if (!player) return;
    const url = `${location.origin}/?ch=${encodeURIComponent(encodePlayable(player))}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast(t('player.linkCopied'));
    } catch {
      location.href = url.replace(location.origin, '');
      showToast(t('player.shareOpened'));
    }
  }, [player, showToast, t]);

  /* ── keyboard shortcuts (Pluto TV remote-style) ─────────────────────────── */
  useEffect(() => {
    if (!playerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'Escape':
          if (showStats) setShowStats(false);
          else if (surfOpen) setSurfOpen(false);
          else if (showQualityMenu) setShowQualityMenu(false);
          else if (showServersMenu) setShowServersMenu(false);
          else closePlayer();
          break;
        case ' ':
        case 'k':
        case 'K':
          e.preventDefault();
          togglePlay();
          break;
        case 'm':
        case 'M':
          toggleMute();
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        case 'p':
        case 'P':
          void togglePip();
          break;
        case 'i':
        case 'I':
          setShowStats((v) => !v);
          break;
        case 's':
        case 'S':
          setShowServersMenu((v) => !v);
          setShowQualityMenu(false);
          setSurfOpen(false);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          zapPrev();
          break;
        case 'ArrowRight':
          e.preventDefault();
          zapNext();
          break;
        case 'ArrowUp': {
          e.preventDefault();
          if (turboRef.current) {
            const nv = Math.min(1, Math.max(0.1, volume + 0.1));
            turboRef.current.setVolume(nv);
            turboRef.current.setMuted(false);
            setVolume(nv);
            setMuted(false);
            break;
          }
          const v = videoRef.current;
          if (v) {
            const nv = Math.min(1, Math.max(0.1, v.volume + 0.1));
            v.volume = nv;
            v.muted = false;
            setVolume(nv);
            setMuted(false);
          }
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
          if (turboRef.current) {
            const nv = Math.max(0, volume - 0.1);
            turboRef.current.setVolume(nv);
            setVolume(nv);
            break;
          }
          const v = videoRef.current;
          if (v) {
            const nv = Math.max(0, v.volume - 0.1);
            v.volume = nv;
            setVolume(nv);
          }
          break;
        }
        default:
          // channel-number entry: type digits to jump (e.g. "12")
          if (/^[0-9]$/.test(e.key)) {
            setDigits((d) => {
              const nd = (d + e.key).slice(-3);
              if (digitTimer.current) clearTimeout(digitTimer.current);
              digitTimer.current = setTimeout(() => {
                const n = parseInt(nd, 10);
                // read the live list from the ref — calling openPlayer inside
                // a state updater would update other components during render
                const list = surfRef.current;
                if (n >= 1 && n <= list.length) {
                  const target = list[n - 1];
                  if (target && target.id !== player?.id) openPlayer(target);
                }
                setDigits('');
              }, 1300);
              return nd;
            });
          }
      }
      poke();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playerOpen, surfOpen, showQualityMenu, showServersMenu, showStats, closePlayer, togglePlay, toggleMute, toggleFullscreen, togglePip, zapPrev, zapNext, poke, player, openPlayer]);

  /** best multi-quality alternate (tallest probed ladder) — its rungs render
   *  directly in the quality menu as "via <source>" entries. ⚠ must live
   *  BEFORE the playerOpen early-return — hooks may not sit behind it.
   *  ⚠ SAME-CHANNEL only: a brand-family sibling must never masquerade as a
   *  quality — picking 1080p would change the channel. */
  const ladderAlt = useMemo(() => {
    const withL = alternates.filter((a) => a.sameChannel !== false && a.ladder && a.ladder.length);
    if (!withL.length) return null;
    return withL.reduce((best, a) =>
      (a.ladder![a.ladder!.length - 1] || 0) > (best.ladder![best.ladder!.length - 1] || 0) ? a : best
    );
  }, [alternates]);
  const ladderRungs: number[] = ladderAlt?.ladder || [];

  if (!playerOpen || !player) return null;

  /* ── derived view state ─────────────────────────────────────────────────── */
  const qualityLabel =
    turboHeight !== null
      ? `${turboHeight ? `${turboHeight}p` : t('player.sourceRung')} · ${t('player.turboChip')}`
      : tcHeight !== null
      ? `${autoDs ? `${t('player.auto')} · ` : ''}${tcHeight}p · ${t('player.dsChip')}`
      : currentQuality === -1
        ? `${t('player.auto')}${activeHeight ? ` · ${activeHeight}p` : ''}`
        : quality.find((q) => q.level === currentQuality)?.label || (activeHeight ? `${activeHeight}p` : t('player.auto'));
  const singleQuality = quality.length <= 1 && tcHeight === null;
  const serverOptions: ServerOption[] =
    player.kind === 'daddylive' ? (servers.length ? servers : ([...DL_SERVERS] as ServerOption[])) : [];
  const hasServerChoices = player.kind === 'daddylive' ? serverOptions.length > 0 : alternates.length > 0;
  const canDataSaver =
    // v1.3 ladder masters list the rungs as NATIVE levels — the data-saver
    // section would duplicate them (and its entries used to re-attach the
    // source: the quality-jump bug). Hide it; the level list is the menu.
    !ladderMaster &&
    ((player.kind === 'daddylive' && (tcCap || tcSeg)) ||
      (player.kind !== 'daddylive' && !!tcSrcRef.current && tcCap));
  /** heights offered on the data-saver ladder. Serverless segment ladder:
   *  144–480 ONLY — encoding 720/1080 runs slower than realtime on a
   *  1-vCPU isolate, so those rungs became constant-loading traps. Full
   *  720p/1080p still reach the menu the SMOOTH ways: as native hls levels
   *  when the source manifest carries them, and via the "More qualities"
   *  alternate sources. */
  const segLadder = player.kind === 'daddylive' && tcSeg && !tcRelayRef.current;
  const dsHeights: readonly number[] = segLadder ? [144, 244, 360, 480] : DATA_SAVER_HEIGHTS;
  /* Local Turbo section — only for HLS sources the engine can read (no DL
   *  iframes), outside data-saver mode, on WebCodecs-capable browsers. Rungs
   *  below the native height + Source (pure live-edge boost). */
  const turboSrc = nativeSrcRef.current;
  const nativeH = activeHeight || nativeHeightRef.current;
  const canLocalTurbo =
    turboCapable &&
    tcHeight === null &&
    !!turboSrc &&
    !isDlIframeSrc(turboSrc);
  const turboHeights: number[] = LOCAL_TURBO_RUNGS.filter(
    (h) => h === 0 || !nativeH || h < nativeH - 60
  );
  const familyAlt =
    alternates.find((a) => a.sameChannel === false && a.ladder?.length) ||
    alternates.find((a) => a.sameChannel === false);
  /** transport line for the stats overlay — sampled live (refs, not state) */
  const getTransportLabel = (): string => {
    if (tcHeightRef.current !== null) return t('stats.dataSaver', { h: tcHeightRef.current });
    if (player.kind === 'daddylive') {
      const srv = serversRef.current.find((s) => s.id === activeServer) || DL_SERVERS.find((s) => s.id === activeServer);
      return srv ? `${srv.label} · ${srv.host}` : 'DaddyLive';
    }
    return directPlayRef.current ? t('stats.directCdn') : t('stats.proxied');
  };
  const surfFmtAgo = (ts: number) => fmtAgo(ts, t);

  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={t('player.playerFor', { name: player.name })}
      onMouseMove={poke}
      onTouchStart={poke}
    >
      <div
        ref={shellRef}
        className={cn(
          'relative h-full w-full bg-black',
          !controlsVisible && phase === 'playing' && 'cursor-none'
        )}
      >
        {/* ── DaddyLive iframe embed ──────────────────────────────────────── */}
        {isDlIframeSrc(nativeSrcRef.current) ? (
          <iframe
            src={nativeSrcRef.current ?? ''}
            className="absolute inset-0 h-full w-full border-0"
            allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
            allowFullScreen
            sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
            title="DaddyLive Stream"
          />
        ) : (
          <>
            <video
              ref={videoRef}
              className={cn(
                'absolute inset-0 h-full w-full object-contain',
                turboHeight !== null && 'invisible'
              )}
              playsInline
              autoPlay
              onClick={() => (controlsVisible ? togglePlay() : poke())}
              onDoubleClick={toggleFullscreen}
              onPlaying={() => setPhase('playing')}
              onPause={() => {
                if (phase === 'playing') setPhase('paused');
              }}
              onWaiting={() => setBuffering(true)}
              onPlayingCapture={() => setBuffering(false)}
              onCanPlay={() => setBuffering(false)}
            />
            {/* Local Turbo render surface — mounted always, shown only while
                the engine owns playback (keeps handover flicker-free) */}
            <canvas
              ref={turboCanvasRef}
              className={cn(
                'absolute inset-0 h-full w-full bg-black object-contain',
                turboHeight === null && 'hidden'
              )}
              onClick={() => (controlsVisible ? togglePlay() : poke())}
              onDoubleClick={toggleFullscreen}
            />
          </>
        )}

        {/* buffering ring */}
        {buffering && phase === 'playing' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-white/20 border-t-zilla-yellow" />
          </div>
        )}

        {/* digit entry chip (Pluto-style channel numbers) */}
        {digits && (
          <div className="absolute start-4 top-16 flex h-12 w-16 items-center justify-center rounded-xl border border-zilla-yellow/60 bg-black/80 text-2xl font-black text-zilla-yellow">
            {digits}
          </div>
        )}

        {/* toast */}
        {toast && (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full bg-black/85 px-5 py-2.5 text-xs font-bold text-zilla-text shadow-2xl">
            {toast}
          </div>
        )}

        {/* ── stats overlay ("stats for nerds") ─────────────────────────── */}
        <StatsOverlay
          t={t}
          open={showStats && controlsVisible}
          isDaddyLive={player.kind === 'daddylive'}
          getTransportLabel={getTransportLabel}
          hlsRef={hlsRef}
          videoRef={videoRef}
          onClose={() => setShowStats(false)}
        />

        {/* ── top gradient bar ──────────────────────────────────────────────────── */}
        <div
          className={cn(
            'absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-black/85 to-transparent px-3 pb-10 pt-3 transition-opacity duration-300 sm:px-5 sm:pt-4',
            controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-zilla-red px-2 py-1 text-[11px] font-black uppercase tracking-wide text-white">
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" /> {t('common.live')}
              </span>
              <div className="min-w-0">
                <h2 className="truncate text-base font-extrabold text-white drop-shadow sm:text-lg">
                  {player.name}
                </h2>
                <p className="truncate text-[11px] font-semibold text-white/60">
                  {player.source || player.meta || 'MaxTV'}
                  {startedAgo ? ` · ${startedAgo}` : ''}
                  {quality.length > 0 ? ` · ${qualityLabel}` : ''}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {/* feed cycler — hop between this event's feeds (content guard) */}
              {altFeeds.length > 1 && (
                <button
                  onClick={cycleFeed}
                  className="flex h-9 items-center gap-1.5 rounded-full border border-white/15 bg-black/50 px-3 text-[11px] font-black uppercase text-white/85 backdrop-blur transition-colors hover:text-white"
                  title={t('player.switchFeedTitle', { n: altFeeds.length })}
                  aria-label={t('player.switchFeed')}
                >
                  <span className="h-3.5 w-3.5">{Icon.swap}</span>
                  <span className="hidden sm:inline">
                    {t('player.feed', { i: altFeeds.findIndex((f) => f.id === player.id) + 1, n: altFeeds.length })}
                  </span>
                </button>
              )}
              <button
                onClick={() => player && toggleFavorite(player)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 backdrop-blur transition-colors',
                  isFav ? 'text-zilla-yellow' : 'text-white/70 hover:text-white'
                )}
                title={t('player.favorite')}
                aria-label={t('player.favorite')}
              >
                <span className="h-4 w-4">{Icon.star}</span>
              </button>
              <button
                onClick={() => void share()}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/70 backdrop-blur transition-colors hover:text-white"
                title={t('player.share')}
                aria-label={t('player.share')}
              >
                <span className="h-4 w-4">{Icon.share}</span>
              </button>
              <div className="relative">
                <button
                  onClick={() => {
                    setShowQualityMenu((s) => !s);
                    setSurfOpen(false);
                    setShowServersMenu(false);
                  }}
                  className="flex h-9 items-center gap-1 rounded-full border border-white/15 bg-black/50 px-3 text-[11px] font-black uppercase text-white/85 backdrop-blur transition-colors hover:text-white"
                  title={t('player.quality')}
                  aria-label={t('player.quality')}
                >
                  {qualityLabel}
                </button>
                {showQualityMenu && (
                  <QualityMenu
                    t={t}
                    quality={quality}
                    currentQuality={currentQuality}
                    tcHeight={tcHeight}
                    canDataSaver={canDataSaver}
                    dsHeights={dsHeights}
                    ladderAlt={ladderAlt}
                    ladderRungs={ladderRungs}
                    singleQuality={singleQuality}
                    segLadder={segLadder}
                    canLadderTranscode={player.kind === 'daddylive' || !!tcSrcRef.current}
                    canLocalTurbo={canLocalTurbo}
                    localTurboHeights={turboHeights}
                    localTurboHeight={turboHeight}
                    onPickLocalTurbo={(h) => void enterTurbo(h)}
                    onExitLocalTurbo={() => exitTurbo(true)}
                    onSetLevel={setLevel}
                    onSelectDataSaver={(h) => selectDataSaver(h)}
                    onPickAltRung={pickAltRung}
                  />
                )}
              </div>
              <button
                onClick={() => setShowStats((v) => !v)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 backdrop-blur transition-colors',
                  showStats ? 'text-zilla-yellow' : 'text-white/70 hover:text-white'
                )}
                title={t('stats.open')}
                aria-label={t('stats.open')}
              >
                <span className="h-4 w-4">{Icon.stats}</span>
              </button>
              <button
                onClick={() => void togglePip()}
                className="hidden h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/70 backdrop-blur transition-colors hover:text-white sm:flex"
                title={t('player.pipLabel')}
                aria-label={t('player.pipLabel')}
              >
                <span className="h-4 w-4">{Icon.pip}</span>
              </button>
              <button
                onClick={closePlayer}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-zilla-yellow text-black transition-transform hover:scale-105"
                title={t('player.closePlayer')}
                aria-label={t('player.closePlayer')}
              >
                <span className="h-4.5 w-4.5">{Icon.close}</span>
              </button>
            </div>
          </div>
        </div>

        {/* ── state overlays (resolving / loading / off-air / error / HEVC) ── */}
        <StateOverlays
          t={t}
          phase={phase}
          errorMsg={errorMsg}
          autoAdvSecs={autoAdvSecs}
          nextName={nextChannel()?.name}
          hasServerChoices={hasServerChoices}
          altFeedsCount={altFeeds.length}
          familyAlt={familyAlt}
          hevcBlock={hevcBlock}
          canSegLadder={player.kind === 'daddylive' && tcSeg}
          mismatch={mismatch}
          onCancelAutoAdv={() => cancelAutoAdvRef.current?.()}
          onRetry={retryStream}
          onOpenServers={() => {
            setShowServersMenu(true);
            setSurfOpen(false);
            setShowQualityMenu(false);
          }}
          onBrowse={() => setSurfOpen(true)}
          onClose={closePlayer}
          onSelectDataSaver480={() => selectDataSaver(480)}
          onSwitchAlternate={switchAlternate}
          onPlayHevcAnyway={playHevcAnyway}
          onSwitchFeed={cycleFeed}
          onDismissMismatch={() => setMismatch(null)}
        />

        {/* tap for sound — z-30 above the bottom bar; bottom-32 clears the bar */}
        {phase === 'playing' && muted && controlsVisible && (
          <button
            onClick={() => {
              const v = videoRef.current;
              if (v) {
                soundOn(v);
                v.play().catch(() => {});
              }
            }}
            className="absolute bottom-32 left-1/2 z-30 -translate-x-1/2 rounded-full bg-zilla-yellow px-6 py-3 text-xs font-black uppercase tracking-wide text-black shadow-2xl transition-transform hover:scale-105 hover:bg-zilla-yellow-soft"
          >
            {t('player.tapSound')}
          </button>
        )}

        {/* go-live chip (behind the live edge) */}
        {phase === 'playing' && liveBehind && (
          <button
            onClick={goLive}
            className="absolute end-4 top-20 z-30 flex items-center gap-1.5 rounded-full bg-zilla-red px-3.5 py-2 text-[11px] font-black uppercase tracking-wide text-white shadow-xl"
          >
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" /> {t('player.goLive')}
          </button>
        )}

        {/* ── bottom control bar ────────────────────────────────────────────── */}
        <div
          className={cn(
            'absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 to-transparent px-3 pb-4 pt-12 transition-opacity duration-300 sm:px-5',
            controlsVisible ? 'opacity-100' : 'pointer-events-none opacity-0'
          )}
        >
          {/* live progress line */}
          <div className="mb-3 flex items-center gap-3">
            <div className="relative h-1 flex-1 overflow-hidden rounded-full bg-white/15">
              <div className="absolute inset-y-0 start-0 w-full bg-gradient-to-r from-zilla-red to-zilla-yellow" />
            </div>
            <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-zilla-red">
              ● {t('common.live')}
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                onClick={togglePlay}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                title={t('player.playPause')}
                aria-label={t('player.playPause')}
              >
                <span className="h-4.5 w-4.5">{phase === 'playing' ? Icon.pause : Icon.play}</span>
              </button>
              <button
                onClick={zapPrev}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                title={t('player.prevChannel')}
                aria-label={t('player.prevChannel')}
              >
                <span className="h-4.5 w-4.5">{Icon.prev}</span>
              </button>
              <button
                onClick={zapNext}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                title={t('player.nextChannel')}
                aria-label={t('player.nextChannel')}
              >
                <span className="h-4.5 w-4.5">{Icon.next}</span>
              </button>

              {/* volume */}
              <div className="group flex items-center">
                <button
                  onClick={toggleMute}
                  className="flex h-10 w-10 items-center justify-center rounded-full text-white/85 transition-colors hover:text-white"
                  title={t('player.toggleMute')}
                  aria-label={t('player.toggleMute')}
                >
                  <span className="h-5 w-5">{muted || volume === 0 ? Icon.volumeOff : Icon.volumeHi}</span>
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={muted ? 0 : volume}
                  onChange={(e) => {
                    const nv = parseFloat(e.target.value);
                    setVolume(nv);
                    if (turboRef.current) {
                      turboRef.current.setVolume(nv);
                      if (nv > 0) {
                        turboRef.current.setMuted(false);
                        setMuted(false);
                      } else {
                        turboRef.current.setMuted(true);
                        setMuted(true);
                      }
                      return;
                    }
                    const v = videoRef.current;
                    if (v) {
                      v.volume = nv;
                      if (nv > 0 && v.muted) {
                        v.muted = false;
                        setMuted(false);
                      }
                      if (nv === 0) {
                        v.muted = true;
                        setMuted(true);
                      }
                    }
                  }}
                  onPointerUp={() => {
                    // a second tap slightly right of a 0-volume tap must
                    // audibly unmute (a drag back from 0 lifts the mute live)
                    const v = videoRef.current;
                    if (v && v.volume > 0 && v.muted) {
                      v.muted = false;
                      setMuted(false);
                    }
                  }}
                  style={{ ['--fill' as string]: `${(muted ? 0 : volume) * 100}%` }}
                  className="slider-zilla w-0 opacity-0 transition-all duration-300 group-hover:w-24 group-hover:opacity-100 sm:w-16 sm:opacity-100"
                  aria-label={t('player.volume')}
                />
              </div>
            </div>

            <div className="flex items-center gap-1.5 sm:gap-2">
              {/* per-stream server switching (original-repo feature) */}
              <div className="relative">
                <button
                  onClick={() => {
                    setShowServersMenu((s) => !s);
                    setShowQualityMenu(false);
                    setSurfOpen(false);
                  }}
                  className={cn(
                    'flex h-10 items-center gap-2 rounded-full px-4 text-[11px] font-black uppercase tracking-wide transition-colors',
                    showServersMenu ? 'bg-zilla-yellow text-black' : 'bg-white/10 text-white hover:bg-white/20'
                  )}
                  title={t('player.switchServerTitle')}
                  aria-label={t('player.switchServerTitle')}
                >
                  <span className="h-4 w-4">{Icon.server}</span>
                  {t('player.servers')}
                </button>
                {showServersMenu && (
                  <ServersMenu
                    t={t}
                    isDaddylive={player.kind === 'daddylive'}
                    serverOptions={serverOptions}
                    alternates={alternates}
                    activeServer={activeServer}
                    altUrl={altUrl}
                    channelName={player.name}
                    channelSource={player.source}
                    onSwitchServer={switchServer}
                    onSwitchAlternate={switchAlternate}
                    onBackToLiveServers={backToLiveServers}
                  />
                )}
              </div>

              {/* channel surf */}
              <button
                onClick={() => {
                  setSurfOpen((s) => !s);
                  setShowQualityMenu(false);
                  setShowServersMenu(false);
                }}
                className={cn(
                  'flex h-10 items-center gap-2 rounded-full px-4 text-[11px] font-black uppercase tracking-wide transition-colors',
                  surfOpen ? 'bg-zilla-yellow text-black' : 'bg-white/10 text-white hover:bg-white/20'
                )}
                title={t('player.guideTitle')}
                aria-label={t('player.guide')}
              >
                <span className="h-4 w-4">{Icon.tv}</span>
                {t('player.channelsGroup').replace('٢٤/٧', '24/7')}
              </button>
              <button
                onClick={toggleFullscreen}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                title={t('player.toggleFullscreen')}
                aria-label={t('player.toggleFullscreen')}
              >
                <span className="h-5 w-5">{isFullscreen ? Icon.fullscreenExit : Icon.fullscreen}</span>
              </button>
            </div>
          </div>

          <p className="mt-2 hidden text-center text-[10px] font-medium text-white/40 sm:block">
            {t('player.keysHint')}
          </p>
        </div>

        {/* ── channel-surf sidebar (Pluto TV guide) ──────────────────────────── */}
        <SurfSidebar
          t={t}
          open={surfOpen}
          surf={surf}
          activeId={player?.id}
          altFeeds={altFeeds}
          fmtAgo={surfFmtAgo}
          onSwitchTo={(item, feeds) => switchTo(item, feeds)}
          onAddToGrid={(item) => {
            const ok = addPane(item);
            showToast(ok ? t('player.addedToGrid') : t('player.gridFull'));
          }}
          onClose={() => setSurfOpen(false)}
        />
      </div>
    </div>
  );
}
