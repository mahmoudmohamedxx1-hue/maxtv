'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import { useTV, type Playable } from '@/lib/store';
import { logoSrc } from './ChannelCard';
import { cn } from '@/lib/utils';
import {
  loadPrefs,
  updatePrefs,
  onPrefsChange,
  connectionBudget,
  dataSaverForBudget,
  hlsPerfConfig,
} from '@/lib/player-settings';

type Phase = 'resolving' | 'loading' | 'playing' | 'paused' | 'error' | 'offair';

/** one entry in the channel-surf sidebar */
interface SurfItem extends Playable {
  group: 'feeds' | 'live' | 'channels';
  sub?: string;
  startedAt?: number;
}

/** DaddyLive servers (kept in sync with src/lib/sports/daddylive.ts) —
 *  TRANSPORT-based, BENCHMARK-ORDERED (2026-09-28 bench: edge manifest p95
 *  343ms, cdn route 665ms+, mirror watch pages slowest). Array order =
 *  failover walk order. LABELS ARE STABLE PER ID so the user's "Server N"
 *  mental model never breaks. Direct CDN ("Server 2") is the DEFAULT —
 *  user-verified best of the bunch (no ffmpeg warmup, no extra hop, the
 *  browser reads the CDN manifest straight through /api/hls). */
const DL_SERVERS = [
  { id: 'direct', label: 'Server 2', host: 'Direct CDN · default (most reliable)' },
  { id: 'edge', label: 'Server 9', host: 'Edge direct · lowest latency' },
  { id: 'turbo', label: 'Server 1', host: 'Turbo cache · fastest start' },
  { id: 'direct-cdn', label: 'Server 5', host: 'Direct via daddyliveplayer.st' },
  { id: 'direct-dlive', label: 'Server 3', host: 'Direct via dlive.sx' },
  { id: 'direct-dlstreams', label: 'Server 4', host: 'Direct via dlstreams.st' },
  { id: 'direct-dlive-player', label: 'Server 10', host: 'Direct via dlive.sx player' },
  { id: 'direct-dlstreams-player', label: 'Server 11', host: 'Direct via dlstreams.st player' },
  { id: 'relay', label: 'Server 6', host: 'Stable relay · bulletproof' },
  { id: 'relay-dlive', label: 'Server 7', host: 'Relay via dlive.sx' },
  { id: 'relay-dlstreams', label: 'Server 8', host: 'Relay via dlstreams.st' },
];

/** Deep retry budgets — the DaddyLive CDN edge flaps in 10-20s windows
 *  (playlist 404s / resets, then recovers). Default hls.js policies give up
 *  far too early and surface a fatal "off air" during those windows. */
const RESILIENT_LOAD_POLICIES = {
  manifestLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15_000,
      maxLoadTimeMs: 30_000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 6, retryDelayMs: 500, maxRetryDelayMs: 4_000 },
    },
  },
  fragLoadPolicy: {
    default: {
      maxTimeToFirstByteMs: 15_000,
      maxLoadTimeMs: 60_000,
      timeoutRetry: { maxNumRetry: 4, retryDelayMs: 0, maxRetryDelayMs: 0 },
      errorRetry: { maxNumRetry: 10, retryDelayMs: 1_000, maxRetryDelayMs: 8_000 },
    },
  },
};

/** transcode ladder — every height re-encoded in real time for streams whose
 *  provider ships a single rendition (DaddyLive + most free IPTV CDNs) */
const DATA_SAVER_HEIGHTS = [144, 244, 360, 480, 720, 1080] as const;
/** quality-chip hints for the ladder rungs */
const RUNG_HINTS: Record<number, string> = {
  144: 'ultra low',
  720: 'HD',
  1080: 'Full HD',
};

/** alternate source for an IPTV channel (same channel, different provider) */
interface AltServer {
  id: string;
  name: string;
  source: string;
  sourceName: string;
  url: string;
  logo?: string;
  health?: string;
}

/** encode/decode a playable as a shareable ?ch= deep link */
function encodePlayable(p: Playable): string {
  try {
    return btoa(unescape(encodeURIComponent(JSON.stringify(p))));
  } catch {
    return '';
  }
}
function decodePlayable(s: string): Playable | null {
  try {
    const p = JSON.parse(decodeURIComponent(escape(atob(s)))) as Playable;
    return p && p.kind && p.ref ? p : null;
  } catch {
    return null;
  }
}

function fmtAgo(ts: number): string {
  const m = Math.max(0, Math.floor((Date.now() - ts) / 60_000));
  if (m < 1) return 'just started';
  if (m < 60) return `started ${m} min ago`;
  const h = Math.floor(m / 60);
  return `started ${h}h ${m % 60}m ago`;
}

/** Does THIS deployment have the data-saver (transcode) ladder? Serverless
 *  hosts (Vercel…) ship no ffmpeg → false. Cached for the page lifetime;
 *  fail-open so a network hiccup can't needlessly hide the ladder. */
let tcCapPromise: Promise<boolean> | null = null;
function probeTcCap(): Promise<boolean> {
  if (!tcCapPromise) {
    tcCapPromise = fetch('/api/transcode?height=480&mode=cap')
      .then((r) => r.json())
      .then((d: { cap?: boolean }) => d.cap === true)
      .catch(() => true);
  }
  return tcCapPromise;
}

/* ─── tiny icon set ────────────────────────────────────────────────────────── */
const Icon = {
  play: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M8 5v14l11-7z" />
    </svg>
  ),
  pause: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M6 5h4v14H6zm8 0h4v14h-4z" />
    </svg>
  ),
  volumeHi: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M3 10v4h4l5 4V6L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zM14 3.8v2.1a6.5 6.5 0 0 1 0 12.2v2.1a8.5 8.5 0 0 0 0-16.4z" />
    </svg>
  ),
  volumeOff: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M3 10v4h4l5 4V6L7 10H3zm13.6 2 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7z" />
    </svg>
  ),
  fullscreen: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M5 5h5v2H7v3H5V5zm9 0h5v5h-2V7h-3V5zM5 14h2v3h3v2H5v-5zm12 0h2v5h-5v-2h3v-3z" />
    </svg>
  ),
  fullscreenExit: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M7 5h2v5H5V8h2V5zm8 0h2v3h2v2h-4V5zM5 14h4v5H7v-3H5v-2zm10 0h4v2h-2v3h-2v-5z" />
    </svg>
  ),
  pip: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M19 11h-8v6h8v-6zm4 8V5a2 2 0 0 0-2-2H3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h18a2 2 0 0 0 2-2zM3 5h18v14H3V5z" />
    </svg>
  ),
  star: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M12 17.3 6.2 21l1.6-6.6L2.7 9.9l6.7-.6L12 3l2.6 6.3 6.7.6-5.1 4.5L17.8 21 12 17.3z" />
    </svg>
  ),
  share: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M18 16.1c-.8 0-1.5.3-2 .8l-7.1-4.2c0-.2.1-.5.1-.7s0-.5-.1-.7L16 7.2c.5.5 1.2.8 2 .8a3 3 0 1 0-3-3c0 .2 0 .5.1.7L8 9.8a3 3 0 1 0 0 4.4l7.1 4.2c0 .2-.1.4-.1.6a3 3 0 1 0 3-2.9z" />
    </svg>
  ),
  close: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3 1.4 1.4z" transform="translate(1.4 -1.4)" />
    </svg>
  ),
  next: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
    </svg>
  ),
  prev: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M18 6l-8.5 6L18 18V6zM8 6v12H6V6h2z" />
    </svg>
  ),
  tv: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M21 3H3a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5v2h8v-2h5a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 14H3V5h18v12z" />
    </svg>
  ),
  server: (
    <svg viewBox="0 0 24 24" className="h-full w-full fill-current" aria-hidden>
      <path d="M4 3h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm0 11h16a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1zm2 2v3h2v-3H6zm0-11v3h2V5H6z" />
    </svg>
  ),
};

export function PlayerOverlay() {
  const { player, playerOpen, closePlayer, toggleFavorite, favorites, altFeeds, openPlayer } = useTV();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const digitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const surfCache = useRef<SurfItem[] | null>(null);
  /** latest surf list for the digit-jump timer (never setState inside an updater) */
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
  /** the data-saver rung was picked by the connectivity engine (not the user) */
  const [autoDs, setAutoDs] = useState(false);
  const [servers, setServers] = useState<{ id: string; label: string; host: string; active?: boolean }[]>([]);
  const [alternates, setAlternates] = useState<AltServer[]>([]);
  const [activeServer, setActiveServer] = useState('');
  const [showServersMenu, setShowServersMenu] = useState(false);
  const [surfOpen, setSurfOpen] = useState(false);
  const [surf, setSurf] = useState<SurfItem[]>([]);
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
  /** one "data saver unavailable" notice per page load — not per channel */
  const tcNoticeRef = useRef(false);

  /* ── refs for cross-callback access (hls error handler → failover) ─────── */
  const playerRef = useRef<Playable | null>(null);
  const serversRef = useRef<{ id: string; label: string; host: string }[]>(DL_SERVERS);
  const alternatesRef = useRef<AltServer[]>([]);
  /** signed source params for data-saver transcodes of the current stream */
  const tcSrcRef = useRef<{ src: string; r: string; s: string } | null>(null);
  /** the native (non-transcoded) source URL — restored when leaving data saver */
  const nativeSrcRef = useRef<string | null>(null);
  /** the NATIVE feed's real height (0 unknown) — the transcode ladder never
   *  encodes UP: a request at/above it stays on the untouched native feed */
  const nativeHeightRef = useRef(0);
  const loadRef = useRef<(ch: Playable, opts?: { server?: string }) => Promise<void>>(async () => {});
  /** servers/alternate urls already tried for the current channel */
  const triedRef = useRef<{ chId: string; tried: Set<string> }>({ chId: '', tried: new Set() });
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
    void probeTcCap().then((ok) => {
      if (!alive) return;
      tcCapRef.current = ok;
      setTcCap(ok);
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
          live?: (MatchLike)[];
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
      setStartedAgo(cur?.startedAt ? fmtAgo(cur.startedAt) : 'Live channel');
    };
    update();
    const t = setInterval(update, 30_000);
    return () => clearInterval(t);
  }, [surf, player, playerOpen]);

  /* ── off-air watchdog (placeholder segments that never decode) ─────────── */
  useEffect(() => {
    if ((phase !== 'loading' && phase !== 'resolving') || !playerOpen) return;
    const t = setTimeout(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) setPhase('offair');
    }, 20000);
    return () => clearTimeout(t);
  }, [phase, playerOpen]);

  /* ── connectivity engine ───────────────────────────────────────────────
   * Auto keeps following the measured bandwidth on EVERY attachment — the
   * native ladder AND the data-saver transcodes. (It used to live only on
   * the native hls instance, which attachSource destroys when data-saver
   * engages — so the "connection improved → back to native" recovery could
   * never fire while transcoding.) */
  const attachNetWatcher = (hls: Hls) => {
    let seen = 0; // per-instance fragment count — skip the EWMA warm-up window
    hls.on(Hls.Events.FRAG_BUFFERED, () => {
      seen++;
      if (seen <= 3) return; // fresh instance: bandwidthEstimate is still seeding
      const p = loadPrefs();
      if (p.quality !== -1) return; // manual mode — user is in charge
      const est = hls.bandwidthEstimate || 0;
      if (est <= 0) return;
      const net = netRef.current;
      // ⚠ 450k floor: the CDN's LATENCY (not throughput) collapses the ABR
      // estimate on every flap — that must NOT hop the player onto the
      // transcoded ladder (its input is the same CDN, plus a warmup stall).
      // Only a genuinely starved link (sustained <450kbps) benefits.
      if (est < 450_000) {
        net.lows++;
        net.highs = 0;
      } else if (est > 1_600_000) {
        net.highs++;
        net.lows = 0;
      } else {
        net.lows = 0;
        net.highs = 0;
      }
      const cur = playerRef.current;
      const canTc = !!cur && (cur.kind === 'daddylive' || !!tcSrcRef.current) && tcCapRef.current;

      if (tcHeightRef.current !== null) {
        // inside the data-saver ladder: recover up, or drop a rung further down
        if (net.highs >= 8 && loadPrefs().autoPicked) {
          showToast('Connection improved — back to the native feed');
          net.highs = 0;
          updatePrefs({ autoPicked: false });
          void exitDataSaverRef.current?.();
        } else if (net.lows >= 6) {
          const cur2 = tcHeightRef.current;
          const next = cur2 > 360 ? 360 : cur2 > 244 ? 244 : 144;
          if (next < cur2) {
            showToast(`Slow connection — dropping to ${next}p data saver`);
            net.lows = 0;
            void selectDataSaverRef.current?.(next, { auto: true });
          }
        }
        return;
      }

      // native mode: only a SUSTAINED, genuinely starved link hops down to a
      // transcoded rung (6 consecutive low estimates ≈ 30s+ of real slowness —
      // CDN flaps never qualify)
      const lowestNative = (hls.levels || []).reduce((m, l) => Math.min(m, l.height || 9999), 9999);
      if (net.lows >= 6 && canTc && lowestNative > 360) {
        const rung = est < 320_000 ? 144 : 244;
        showToast(`Slow connection — switching to ${rung}p data saver`);
        net.lows = 0;
        void selectDataSaverRef.current?.(rung, { auto: true });
      }
    });
  };

  /* ── resolve → attach hls → play ───────────────────────────────────────── */
  const load = useCallback(
    async (ch: Playable, opts: { server?: string } = {}) => {
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

      // fresh channel → reset the per-channel server-switching state
      if (triedRef.current.chId !== ch.id) {
        triedRef.current = { chId: ch.id, tried: new Set() };
        setServers([]);
        setAlternates([]);
        setActiveServer('');
        serversRef.current = DL_SERVERS;
        alternatesRef.current = [];
        tcSrcRef.current = null;
      }
      if (opts.server) triedRef.current.tried.add(opts.server);
      if (ch.kind === 'iptv') triedRef.current.tried.add(ch.ref);

      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }

      try {
        const endpoint =
          ch.kind === 'daddylive'
            ? `/api/sports/stream?channel=${encodeURIComponent(ch.ref)}${opts.server ? `&server=${encodeURIComponent(opts.server)}` : ''}`
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

        if (!res.ok || !data.url) {
          // a failed resolve already burned through every mirror server-side —
          // mark them tried so failover hops to alternates instead of retrying
          if (ch.kind === 'daddylive') {
            for (const s of serversRef.current) triedRef.current.tried.add(s.id);
          }
          // per-stream failover before giving up (original-repo mirror hopping)
          const cur = playerRef.current || ch;
          if (cur.kind === 'daddylive') {
            const next = serversRef.current.find((s) => !triedRef.current.tried.has(s.id));
            if (next) {
              showToast(`Switching to ${next.label} (${next.host})…`);
              await loadRef.current(cur, { server: next.id });
              return;
            }
          } else if (alternatesRef.current.length) {
            const next = alternatesRef.current.find((a) => !triedRef.current.tried.has(a.url));
            if (next) {
              showToast(`Trying ${next.sourceName}…`);
              await loadRef.current({ ...cur, ref: next.url, source: next.sourceName, logo: next.logo || cur.logo });
              return;
            }
          }
          throw new Error(data.message || 'Stream is offline or geo-blocked right now.');
        }

        const src = data.url as string;
        nativeSrcRef.current = src;
        setPhase('loading');
        const video = videoRef.current;
        if (!video) return;

        const prefs = loadPrefs();
        video.volume = prefs.volume;
        video.muted = prefs.muted;

        if (Hls.isSupported()) {
          // seed ABR with the browser's connection estimate so Auto starts on a
          // rung the link can actually sustain (instead of overshoot + stall)
          const budget = connectionBudget();
          const hls = new Hls({
            // ⚠ lowLatencyMode MUST be false: with it on, hls.js's
            // latency-controller ramps playbackRate toward 2× to "catch up"
            // to the live edge after every CDN stall — the "plays like 2x"
            // bug. These CDNs are not LL-HLS anyway.
            lowLatencyMode: false,
            enableWorker: true,
            ...hlsPerfConfig(loadPrefs().perfMode),
            ...RESILIENT_LOAD_POLICIES,
            ...(budget > 0 ? { abrEwmaDefaultEstimate: budget } : {}),
          });
          hlsRef.current = hls;
          // TEMP DEBUG — expose the live hls instance for E2E inspection
          if (typeof window !== 'undefined') {
            (window as unknown as { __maxtvHls?: Hls }).__maxtvHls = hls;
          }
          hls.loadSource(src);
          hls.attachMedia(video);

          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            const buildLevels = () =>
              (hls.levels || []).map((l, i) => {
                const resH = Number(String(l.attrs?.RESOLUTION ?? '').split('x')[1]) || 0;
                const h = l.height || resH || video.videoHeight;
                const k = Math.round((l.bitrate || 0) / 1000);
                return { label: h ? `${h}p` : k > 0 ? `${k}k` : 'Source', level: i, height: h };
              });
            const seen = new Set<string>();
            const levels = buildLevels().filter((l) => (seen.has(l.label) ? false : seen.add(l.label)));
            setQuality(levels.map(({ label, level }) => ({ label, level })));
            // remember the native feed's best height — the ladder never encodes up
            const knownH = levels.map((l) => l.height).filter((h) => h > 0);
            if (knownH.length) nativeHeightRef.current = Math.max(...knownH);

            const prefH = loadPrefs().quality;
            const canTc = (ch.kind === 'daddylive' || !!tcSrcRef.current) && tcCapRef.current;

            if (prefH === -1) {
              // AUTO — connectivity-chosen: start at the best rung the measured
              // link can hold, then let hls.js ABR adapt up/down on its own
              setCurrentQuality(-1);
              if (budget > 0 && hls.levels?.length) {
                const cap = budget < 500_000 ? 244 : budget < 900_000 ? 360 : budget < 1_800_000 ? 480 : budget < 3_500_000 ? 720 : 1080;
                let target = 0;
                for (let i = 0; i < hls.levels.length; i++) {
                  const lh = hls.levels[i].height || 0;
                  if (lh && lh <= cap) target = i;
                }
                hls.startLevel = target;
              }
              // the link is too slow for the native ladder → open transcoded.
              // ONLY when ladder heights are actually KNOWN (master playlists).
              // Relay/media playlists report height 0 until fragments decode —
              // downshifting there detoured every relay stream through the slow
              // transcode warmup. Real FRAG_BUFFERED measurements decide instead.
              const ds = dataSaverForBudget(budget);
              const ladderKnown = levels.some((l) => l.height > 0);
              if (ds && canTc && ladderKnown && !levels.some((l) => l.height > 0 && l.height <= ds + 60)) {
                void selectDataSaverRef.current?.(ds, { auto: true });
                return;
              }
            } else if (prefH > 0 && levels.length > 1) {
              let idx = levels.find((l) => l.height === prefH)?.level ?? -1;
              if (idx === -1) {
                const below = levels.filter((l) => l.height > 0 && l.height <= prefH).sort((a, b) => b.height - a.height)[0];
                idx = below?.level ?? -1;
              }
              if (idx >= 0) {
                hls.currentLevel = idx;
                setCurrentQuality(idx);
              } else {
                setCurrentQuality(-1);
              }
            } else {
              setCurrentQuality(-1);
            }

            // persisted data-saver preference the provider cannot satisfy
            // natively (single rendition above the preferred height) → switch
            // to the real-time transcode ladder. Skipped on deployments
            // without ffmpeg — there we stay native (closest level or the
            // single rendition) instead of hanging on a 503.
            if (prefH > 0 && (DATA_SAVER_HEIGHTS as readonly number[]).includes(prefH)) {
              const hasNative = levels.some((l) => l.height > 0 && l.height <= prefH + 60);
              if (!hasNative && tcCapRef.current) {
                void selectDataSaverRef.current?.(prefH);
                return;
              }
              if (!hasNative && !tcCapRef.current && !tcNoticeRef.current) {
                tcNoticeRef.current = true;
                showToast('Data saver is unavailable on this server — playing the native feed');
              }
            }

            video.muted = prefs.muted;
            video.play().catch(() => {
              /* autoplay may need a gesture — show tap-to-unmute */
            });
          });

          // connectivity engine — Auto keeps following the measured bandwidth
          // (shared with data-saver attachments — see attachNetWatcher)
          attachNetWatcher(hls);
          hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => {
            // refresh labels — some CDNs only report resolution once fragments load
            const lvl = hls.levels?.[d.level];
            const resH = Number(String(lvl?.attrs?.RESOLUTION ?? '').split('x')[1]) || 0;
            const h = lvl?.height || resH || video.videoHeight;
            if (h) {
              setActiveHeight(h);
              if (tcHeightRef.current === null) nativeHeightRef.current = Math.max(nativeHeightRef.current, h);
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
          hls.on(Hls.Events.ERROR, (_e, d) => {
            if (!d.fatal) {
              // our relay/turbo endpoints mark off-air channels with 503 +
              // x-offair. hls.js retries 5xx responses internally, which used
              // to burn ~45s of "Buffering…" on a channel we already KNOW is
              // dead — bail out to the honest off-air state immediately.
              if (
                d.type === Hls.ErrorTypes.NETWORK_ERROR &&
                (d as { response?: { code?: number } }).response?.code === 503
              ) {
                setPhase('offair');
                return;
              }
              // transient CDN flap — hls.js is retrying under the deep retry
              // budget; tell the user instead of showing a naked spinner
              if (
                d.type === Hls.ErrorTypes.NETWORK_ERROR &&
                Date.now() - lastReconnectToastRef.current > 6000
              ) {
                lastReconnectToastRef.current = Date.now();
                showToast('Reconnecting…');
              }
              return;
            }
            if (d.type === Hls.ErrorTypes.NETWORK_ERROR && d.details === 'manifestLoadError') {
              // our relay marks off-air channels with 503 x-offair — honest
              // off-air, don't waste 6 server hops on a dead channel
              if ((d as { response?: { code?: number } }).response?.code === 503) {
                setPhase('offair');
                return;
              }
              // per-stream server failover before declaring the stream dead
              const cur = playerRef.current || ch;
              if (cur.kind === 'daddylive') {
                const next = serversRef.current.find((s) => !triedRef.current.tried.has(s.id));
                if (next) {
                  showToast(`Switching to ${next.label} (${next.host})…`);
                  void loadRef.current(cur, { server: next.id });
                  return;
                }
              } else if (alternatesRef.current.length) {
                const next = alternatesRef.current.find((a) => !triedRef.current.tried.has(a.url));
                if (next) {
                  showToast(`Trying ${next.sourceName}…`);
                  void loadRef.current({ ...cur, ref: next.url, source: next.sourceName, logo: next.logo || cur.logo });
                  return;
                }
              }
              setPhase('error');
              setErrorMsg('Stream manifest is unreachable — the channel may be offline or region-blocked.');
            } else if (
              d.type === Hls.ErrorTypes.NETWORK_ERROR &&
              (d.details === 'fragLoadError' || d.details === 'fragLoadTimeOut') &&
              (d as { response?: { code?: number } }).response?.code === 503
            ) {
              // our proxy returns 503 for off-air placeholder segments
              setPhase('offair');
            } else if (d.type === Hls.ErrorTypes.NETWORK_ERROR) {
              // transient network trouble — one reconnect attempt, then failover
              const cur = playerRef.current || ch;
              const recon = (hlsRef.current as unknown as { _zillaRecon?: boolean }) || null;
              if (recon && !recon._zillaRecon) {
                recon._zillaRecon = true;
                hls.startLoad();
                return;
              }
              if (cur.kind === 'daddylive') {
                const next = serversRef.current.find((s) => !triedRef.current.tried.has(s.id));
                if (next) {
                  showToast(`Switching to ${next.label} (${next.host})…`);
                  void loadRef.current(cur, { server: next.id });
                  return;
                }
              } else if (alternatesRef.current.length) {
                const next = alternatesRef.current.find((a) => !triedRef.current.tried.has(a.url));
                if (next) {
                  showToast(`Trying ${next.sourceName}…`);
                  void loadRef.current({ ...cur, ref: next.url, source: next.sourceName, logo: next.logo || cur.logo });
                  return;
                }
              }
              setPhase('error');
              setErrorMsg(`Network error (${d.details}).`);
            } else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) {
              // append/codec buffer errors mean the SourceBuffer state itself
              // is corrupted (holes from discontinuity flushes racing in-flight
              // appends) — recoverMediaError cannot clear it. Reload the whole
              // channel: fresh relay session + fresh MSE = clean slate.
              const h = hlsRef.current as unknown as { _zillaAppendRecov?: boolean; _zillaMediaRecov?: number } | null;
              const appendBroken =
                d.details === 'bufferAppendError' ||
                d.details === 'bufferAddCodecError' ||
                d.details === 'bufferAppendingError' && d.fatal;
              if (appendBroken) {
                const cur = playerRef.current;
                if (cur && h && !h._zillaAppendRecov) {
                  h._zillaAppendRecov = true;
                  showToast('Stream hiccup — reconnecting');
                  triedRef.current = { chId: cur.id, tried: new Set() };
                  void loadRef.current(cur);
                  return;
                }
                setPhase('error');
                setErrorMsg('Media decode error.');
                return;
              }
              // recovery ladder for other media errors:
              // recoverMediaError → swapAudioCodec+recover → fresh reload → error
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
                  showToast('Stream hiccup — reconnecting');
                  triedRef.current = { chId: cur.id, tried: new Set() };
                  void loadRef.current(cur);
                  return;
                }
              }
              setPhase('error');
              setErrorMsg('Media decode error.');
            } else {
              setPhase('error');
              setErrorMsg(`Playback error (${d.details}).`);
            }
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          // Safari native HLS
          video.src = src;
          video.muted = prefs.muted;
          video.play().catch(() => {});
        }
      } catch (e) {
        if (gen !== loadGenRef.current) return; // closed/superseded — stay quiet
        setPhase('error');
        setErrorMsg((e as Error).message || 'Failed to resolve stream.');
      }
    },
    [showToast]
  );

  loadRef.current = load;

  // keep the player ref in sync for the hls error handler / failover engine
  // (in an effect — never update other components during render)
  useEffect(() => {
    playerRef.current = player;
  }, [player]);

  // reload the stream only when the channel changes (load is stable enough)
  useEffect(() => {
    if (playerOpen && player) void load(player);
  }, [playerOpen, player]);

  // cleanup on close — destroy hls AND invalidate any in-flight resolve so
  // closing during "Resolving stream…" is instant (the stale load can never
  // write player state afterwards)
  useEffect(() => {
    if (!playerOpen) {
      loadGenRef.current++;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
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
      // Only react to actual QUALITY changes. Incidental patches (volume,
      // autoPicked, perfMode…) used to re-enter selectDataSaver/exitDataSaver
      // and could mutually recurse with the player's own pref writes.
      if (patch && patch.quality === undefined) return;
      const hls = hlsRef.current;
      if (p.quality === -1) {
        // back to Auto: unpin and leave any auto data-saver rung
        if (hls && hls.levels?.length && tcHeightRef.current === null) hls.currentLevel = -1;
        setCurrentQuality(-1);
        // an EXPLICIT Auto pick exits data-saver; an autoPicked rung stays
        // (the connectivity engine keeps its low-bandwidth choice)
        if (tcHeightRef.current !== null && !p.autoPicked) void exitDataSaverRef.current?.();
        return;
      }
      if (!hls || !hls.levels?.length) return;
      const levels = hls.levels.map((l, i) => ({ i, h: l.height || 0 }));
      let idx = levels.find((l) => l.h === p.quality)?.i ?? -1;
      if (idx === -1) {
        const below = levels.filter((l) => l.h > 0 && l.h <= p.quality).sort((a, b) => b.h - a.h)[0];
        idx = below?.i ?? -1;
      }
      if (idx >= 0 && tcHeightRef.current === null) {
        hls.currentLevel = idx;
        setCurrentQuality(idx);
      } else if ((DATA_SAVER_HEIGHTS as readonly number[]).includes(p.quality)) {
        // guard: never re-enter for a rung that is ALREADY active (the player
        // itself just set it — selectDataSaver persists quality before this
        // event lands; without the guard the two mutual-call forever)
        if (tcHeightRef.current !== p.quality) {
          void selectDataSaverRef.current?.(p.quality);
        }
      }
    });
  }, []);

  /* ── content-mismatch guard (the football→F1 fix, layer 3) ─────────────
   * DaddyLive events list *network* channels and a network can preempt
   * (DAZN Spain → F1 on grand-prix weekends). After a few seconds of play
   * we grab a frame and let the vision model check the sport; on mismatch
   * we offer a one-click hop to the event's next feed. */
  useEffect(() => {
    if (phase !== 'playing' || !player || player.kind !== 'daddylive') return;
    if (!player.category || player.category === 'other') return;
    if (mismatchChecked.current === player.id) return;

    const t = setTimeout(async () => {
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

    return () => clearTimeout(t);
  }, [phase, player]);

  /** hop to the event's next feed (mismatch banner + feed cycler) */
  const cycleFeed = useCallback(() => {
    if (altFeeds.length < 2 || !player) return;
    const idx = altFeeds.findIndex((f) => f.id === player.id);
    const next = altFeeds[(idx + 1) % altFeeds.length] || altFeeds[0];
    if (next && next.id !== player.id) {
      setMismatch(null);
      showToast(`Switching to ${next.name.split(' — ')[1] || 'next feed'}…`);
      openPlayer(next, altFeeds);
    }
  }, [altFeeds, player, openPlayer, showToast]);

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
      if (phase === 'playing' && !surfOpen && !showQualityMenu && !showServersMenu) setControlsVisible(false);
    }, 3200);
  }, [phase, surfOpen, showQualityMenu, showServersMenu]);

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
  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) {
      v.muted = false;
      setMuted(false);
      v.play().catch(() => {});
    } else {
      v.pause();
      setPhase('paused');
    }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  }, []);

  const goLive = useCallback(() => {
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
    const v = videoRef.current;
    if (!v) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (document.pictureInPictureEnabled) {
        await v.requestPictureInPicture();
      } else {
        showToast('Picture-in-picture is not supported here');
      }
    } catch {
      showToast('Picture-in-picture unavailable for this stream');
    }
  }, [showToast]);

  /* ── data-saver ladder (real-time transcode) ────────────────────────── */

  /** attach a fresh hls instance to a source URL without re-resolving.
   *  `level` pins a native quality once the manifest parses. */
  const attachSource = useCallback((src: string, level?: number) => {
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
      const hls = new Hls({
        // see the main load() — LL mode off or hls.js plays 2× catch-up
        lowLatencyMode: false,
        enableWorker: true,
        ...hlsPerfConfig(loadPrefs().perfMode),
        ...RESILIENT_LOAD_POLICIES,
      });
      hlsRef.current = hls;
      // TEMP DEBUG — expose the live hls instance for E2E inspection
      if (typeof window !== 'undefined') {
        (window as unknown as { __maxtvHls?: Hls }).__maxtvHls = hls;
      }
      hls.loadSource(src);
      hls.attachMedia(video);
      // connectivity engine on data-saver attachments too — this is the only
      // place recovery ("back to native") and rung-hopping can fire from while
      // transcoding
      attachNetWatcher(hls);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (typeof level === 'number' && level >= 0 && hls.levels?.[level]) {
          hls.currentLevel = level;
        }
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (!d.fatal) return;
        if (d.details === 'manifestLoadError' || (d.type === Hls.ErrorTypes.NETWORK_ERROR && (d as { response?: { code?: number } }).response?.code === 503)) {
          // only bounce back to native when we're actually IN data-saver mode —
          // calling exitDataSaver from a failing NATIVE restore would recurse
          if (tcHeightRef.current !== null) {
            showToast('Data-saver stream unavailable — back to the native feed');
            void exitDataSaverRef.current?.();
          }
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {});
    }
  }, [showToast]);

  /** switch to a transcoded rendition (144p → 1080p) of the current stream.
   *  opts.auto marks a connectivity-engine pick — keeps the user's Auto choice. */
  const selectDataSaver = useCallback(
    (height: number, opts: { auto?: boolean } = {}) => {
      const cur = playerRef.current;
      if (!cur) return;
      // deployments without ffmpeg have no ladder — stay native (the settings
      // menu / connectivity engine can still ask; one notice per page load)
      if (!tcCapRef.current) {
        if (opts.auto !== true && !tcNoticeRef.current) {
          tcNoticeRef.current = true;
          showToast('Data saver is unavailable on this server — playing the native feed');
        }
        return;
      }
      const h = (DATA_SAVER_HEIGHTS as readonly number[]).includes(height) ? height : 360;
      setShowQualityMenu(false);
      // never encode UP: a rung STRICTLY above the native feed's height can
      // only lose quality and burn CPU (1080p ask on a 720p-only source).
      // ⚠ exit data-saver BEFORE updatePrefs — the settings-sync effect echoes
      // quality picks back into this function whenever the live hls instance
      // can't satisfy them natively; restoring the native instance first (or
      // pinning its level) lets the echo resolve there instead of re-entering.
      const nh = nativeHeightRef.current;
      if (opts.auto !== true && nh > 0 && h > nh + 60) {
        if (tcHeightRef.current !== null) {
          showToast(`Native feed is already ${nh}p — switching back to it`);
          void exitDataSaverRef.current?.();
        } else {
          showToast(`This channel tops out at ${nh}p — playing it natively`);
        }
        updatePrefs({ quality: h, autoPicked: false });
        return;
      }
      // ⚠ set the ref BEFORE updatePrefs — savePrefs dispatches the prefs
      // event SYNCHRONOUSLY, and the settings-sync effect re-enters
      // selectDataSaver for data-saver heights unless it can see the rung is
      // already active. Setting it after the update caused infinite mutual
      // recursion (RangeError: Maximum call stack size exceeded).
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
          ? `/api/transcode?channel=${encodeURIComponent(cur.ref)}`
          : tcSrcRef.current
            ? `/api/transcode?src=${encodeURIComponent(tcSrcRef.current.src)}&r=${encodeURIComponent(tcSrcRef.current.r)}&s=${encodeURIComponent(tcSrcRef.current.s)}`
            : null;
      if (!base) {
        showToast('Data saver is unavailable for this channel');
        return;
      }
      showToast(`Data saver: ${h}p — lighter stream, less bandwidth`);
      setPhase('loading');
      attachSource(`${base}&height=${h}&mode=m3u8`);

      // learn the source's real height in the background (single-rendition
      // media playlists don't declare it — the server ffprobes a segment).
      // With it: later rung picks hit the no-upscale guard above, and a rung
      // that is ALREADY strictly above the source self-heals back to native.
      const gen = loadGenRef.current;
      void fetch(`${base}&height=${h}&mode=probe`)
        .then((r) => (r.ok ? (r.json() as Promise<{ sourceHeight?: number }>) : null))
        .then((d) => {
          if (gen !== loadGenRef.current) return; // channel changed meanwhile
          const sh = d?.sourceHeight || 0;
          if (sh <= 0) return;
          nativeHeightRef.current = Math.max(nativeHeightRef.current, sh);
          if (tcHeightRef.current !== null && tcHeightRef.current > sh + 60) {
            showToast(`This channel tops out at ${sh}p — back to the native feed`);
            void exitDataSaverRef.current?.();
          }
        })
        .catch(() => {});
    },
    [attachSource, showToast]
  );
  const selectDataSaverRef = useRef<((h: number, opts?: { auto?: boolean }) => void) | null>(null);
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
  const exitDataSaverRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    exitDataSaverRef.current = exitDataSaver;
  }, [exitDataSaver]);

  /** ref mirror of tcHeight for hls event closures */
  const tcHeightRef = useRef<number | null>(null);
  useEffect(() => {
    tcHeightRef.current = tcHeight;
  }, [tcHeight]);

  const setLevel = useCallback(
    (level: number) => {
      setShowQualityMenu(false);
      // persist the preference so every future stream opens at this quality
      const label = level === -1 ? 'Auto' : quality.find((q) => q.level === level)?.label ?? '';
      const height = level === -1 ? -1 : parseInt(label, 10) || -1;
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
        showToast(level === -1 ? 'Quality: Auto (network-adaptive)' : `Quality: ${label} — saved as your default`);
        return;
      }
      const hls = hlsRef.current;
      if (!hls) return;
      hls.currentLevel = level;
      setCurrentQuality(level);
      showToast(level === -1 ? 'Quality: Auto (network-adaptive)' : `Quality: ${label} — saved as your default`);
    },
    [quality, showToast, tcHeight, attachSource]
  );

  /* ── per-stream server switching (original-repo feature) ───────────── */
  const retryStream = useCallback(() => {
    const cur = playerRef.current;
    if (!cur) return;
    // fresh attempt: forget which servers/alternates already burned out
    triedRef.current = { chId: cur.id, tried: new Set() };
    void loadRef.current(cur);
  }, []);

  const switchServer = useCallback(
    (serverId: string) => {
      const cur = playerRef.current;
      if (!cur || cur.kind !== 'daddylive') return;
      setShowServersMenu(false);
      const srv = serversRef.current.find((s) => s.id === serverId);
      if (srv) showToast(`Switching to ${srv.label} (${srv.host})…`);
      void loadRef.current(cur, { server: serverId });
    },
    [showToast]
  );

  const switchAlternate = useCallback(
    (alt: AltServer) => {
      const cur = playerRef.current;
      if (!cur) return;
      setShowServersMenu(false);
      showToast(`Switching to ${alt.sourceName}…`);
      void loadRef.current({ ...cur, ref: alt.url, source: alt.sourceName, logo: alt.logo || cur.logo });
    },
    [showToast]
  );

  const share = useCallback(async () => {
    if (!player) return;
    const url = `${location.origin}/?ch=${encodeURIComponent(encodePlayable(player))}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied — open it anywhere to resume this channel');
    } catch {
      location.href = url.replace(location.origin, '');
      showToast('Share link opened');
    }
  }, [player, showToast]);

  /* ── keyboard shortcuts (Pluto TV remote-style) ─────────────────────────── */
  useEffect(() => {
    if (!playerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      switch (e.key) {
        case 'Escape':
          if (surfOpen) setSurfOpen(false);
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
          const v = videoRef.current;
          if (v) {
            const nv = Math.min(1, v.volume + 0.1);
            v.volume = nv;
            v.muted = false;
            setVolume(nv);
            setMuted(false);
          }
          break;
        }
        case 'ArrowDown': {
          e.preventDefault();
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
                // read the live list from the ref — calling openPlayer inside a
                // state updater would update other components during render
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
  }, [playerOpen, surfOpen, showQualityMenu, showServersMenu, closePlayer, togglePlay, toggleMute, toggleFullscreen, togglePip, zapPrev, zapNext, poke, player, openPlayer]);

  if (!playerOpen || !player) return null;

  const qualityLabel =
    tcHeight !== null
      ? `${autoDs ? 'Auto · ' : ''}${tcHeight}p · Data saver`
      : currentQuality === -1
        ? `Auto${activeHeight ? ` · ${activeHeight}p` : ''}`
        : quality.find((q) => q.level === currentQuality)?.label || (activeHeight ? `${activeHeight}p` : 'Auto');
  const singleQuality = quality.length <= 1 && tcHeight === null;
  const serverOptions = player.kind === 'daddylive' ? servers.length ? servers : DL_SERVERS : [];
  const hasServerChoices =
    player.kind === 'daddylive' ? serverOptions.length > 0 : alternates.length > 0;
  const canDataSaver = (player.kind === 'daddylive' || !!tcSrcRef.current) && tcCap;

  return (
    <div
      className="fixed inset-0 z-50 bg-black"
      role="dialog"
      aria-modal="true"
      aria-label={`Player — ${player.name}`}
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
        {/* ── video ─────────────────────────────────────────────────────────── */}
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-contain"
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

        {/* buffering ring */}
        {buffering && phase === 'playing' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-white/20 border-t-zilla-yellow" />
          </div>
        )}

        {/* digit entry chip (Pluto-style channel numbers) */}
        {digits && (
          <div className="absolute left-4 top-16 flex h-12 w-16 items-center justify-center rounded-xl border border-zilla-yellow/60 bg-black/80 text-2xl font-black text-zilla-yellow">
            {digits}
          </div>
        )}

        {/* toast */}
        {toast && (
          <div className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full bg-black/85 px-5 py-2.5 text-xs font-bold text-zilla-text shadow-2xl">
            {toast}
          </div>
        )}

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
                <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" /> Live
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
                  title={`Switch feed — ${altFeeds.length} feeds for this event`}
                  aria-label="Switch to the next feed for this event"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 fill-current" aria-hidden>
                    <path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z" />
                  </svg>
                  <span className="hidden sm:inline">
                    Feed {altFeeds.findIndex((f) => f.id === player.id) + 1}/{altFeeds.length}
                  </span>
                </button>
              )}
              <button
                onClick={() => player && toggleFavorite(player)}
                className={cn(
                  'flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 backdrop-blur transition-colors',
                  isFav ? 'text-zilla-yellow' : 'text-white/70 hover:text-white'
                )}
                title="Favorite (adds to Your favorites)"
                aria-label="Toggle favorite"
              >
                <span className="h-4 w-4">{Icon.star}</span>
              </button>
              <button
                onClick={() => void share()}
                className="flex h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/70 backdrop-blur transition-colors hover:text-white"
                title="Copy share link"
                aria-label="Share channel"
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
                  title="Video quality"
                  aria-label="Video quality"
                >
                  {qualityLabel}
                </button>
                {showQualityMenu && (
                  <div className="styled-scrollbar absolute right-0 top-11 max-h-[70vh] w-48 overflow-y-auto rounded-xl border border-zilla-line bg-zilla-bg/95 shadow-2xl backdrop-blur">
                    <p className="border-b border-zilla-line/60 px-3.5 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                      Stream quality
                    </p>
                    <button
                      onClick={() => setLevel(-1)}
                      className={cn(
                        'flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-bold transition-colors hover:bg-white/10',
                        currentQuality === -1 && tcHeight === null ? 'text-zilla-yellow' : 'text-zilla-text'
                      )}
                    >
                      Auto {currentQuality === -1 && tcHeight === null && <span>✓</span>}
                    </button>
                    <p className="px-3.5 pb-1.5 text-[10px] font-medium leading-snug text-zilla-dim">
                      Network-adaptive — chosen from your connection, adjusts as it changes.
                    </p>
                    {quality.map((q) => (
                      <button
                        key={q.level}
                        onClick={() => setLevel(q.level)}
                        className={cn(
                          'flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-bold transition-colors hover:bg-white/10',
                          currentQuality === q.level && tcHeight === null ? 'text-zilla-yellow' : 'text-zilla-text'
                        )}
                      >
                        {q.label} {currentQuality === q.level && tcHeight === null && <span>✓</span>}
                      </button>
                    ))}
                    {singleQuality && (
                      <p className="px-3.5 py-1.5 text-[10px] font-medium leading-snug text-zilla-dim">
                        This channel serves a single quality from its provider.
                      </p>
                    )}

                    {(player.kind === 'daddylive' || !!tcSrcRef.current) && !tcCap && (
                      <>
                        <p className="border-t border-zilla-line/60 px-3.5 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                          Quality ladder · Data saver
                        </p>
                        <p className="px-3.5 pb-2 pt-1 text-[10px] font-medium leading-snug text-zilla-dim">
                          Not available on this deployment — the server can't re-encode streams. The native feed is playing instead.
                        </p>
                      </>
                    )}

                    {canDataSaver && (
                      <>
                        <p className="border-t border-zilla-line/60 px-3.5 py-2 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                          Quality ladder · Data saver
                        </p>
                        {DATA_SAVER_HEIGHTS.map((h) => (
                          <button
                            key={h}
                            onClick={() => selectDataSaver(h)}
                            className={cn(
                              'flex w-full items-center justify-between px-3.5 py-2.5 text-xs font-bold transition-colors hover:bg-white/10',
                              tcHeight === h ? 'text-zilla-yellow' : 'text-zilla-text'
                            )}
                          >
                            <span>
                              {h}p
                              {RUNG_HINTS[h] && (
                                <span className="ml-1.5 text-[9px] font-bold text-zilla-dim">{RUNG_HINTS[h]}</span>
                              )}
                              {h === 480 && <span className="ml-1.5 text-[9px] font-bold text-zilla-dim">default</span>}
                            </span>
                            {tcHeight === h && <span>✓</span>}
                          </button>
                        ))}
                        {tcHeight !== null && (
                          <button
                            onClick={() => setLevel(-1)}
                            className="w-full px-3.5 py-2 text-left text-[10px] font-bold text-zilla-yellow/80 transition-colors hover:text-zilla-yellow"
                          >
                            ← back to the native feed
                          </button>
                        )}
                        <p className="px-3.5 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
                          Any height, re-encoded in real time to save bandwidth — perfect for slow connections or capping quality.
                        </p>
                      </>
                    )}

                    <p className="border-t border-zilla-line/60 px-3.5 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
                      Your choice is saved and applied to every channel.
                    </p>
                  </div>
                )}
              </div>
              <button
                onClick={() => void togglePip()}
                className="hidden h-9 w-9 items-center justify-center rounded-full border border-white/15 bg-black/50 text-white/70 backdrop-blur transition-colors hover:text-white sm:flex"
                title="Picture-in-picture (P)"
                aria-label="Picture in picture"
              >
                <span className="h-4 w-4">{Icon.pip}</span>
              </button>
              <button
                onClick={closePlayer}
                className="flex h-9 w-9 items-center justify-center rounded-full bg-zilla-yellow text-black transition-transform hover:scale-105"
                title="Close (Esc)"
                aria-label="Close player"
              >
                <span className="h-4.5 w-4.5">{Icon.close}</span>
              </button>
            </div>
          </div>
        </div>

        {/* ── state overlays (resolving / loading) ─────────────────────────────── */}
        {(phase === 'resolving' || phase === 'loading') && (
          <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-black/60">
            <div className="h-12 w-12 animate-spin rounded-full border-[3px] border-white/15 border-t-zilla-yellow" />
            <p className="text-sm font-bold text-white/70">
              {phase === 'resolving' ? 'Resolving stream…' : 'Buffering…'}
            </p>
            <button
              onClick={closePlayer}
              className="pointer-events-auto mt-1 rounded-full border border-white/25 bg-white/10 px-5 py-2 text-[11px] font-black uppercase tracking-wide text-white transition-colors hover:bg-white/20"
            >
              Cancel
            </button>
          </div>
        )}

        {(phase === 'offair' || phase === 'error') && (
          <div
            className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-black/85 px-6 text-center"
            onPointerDown={() => cancelAutoAdvRef.current?.()}
          >
            <div
              className={cn(
                'flex h-14 w-14 items-center justify-center rounded-full',
                phase === 'offair' ? 'bg-zilla-yellow/15 text-zilla-yellow' : 'bg-zilla-red/20 text-zilla-red'
              )}
            >
              {phase === 'offair' ? (
                <svg viewBox="0 0 24 24" className="h-7 w-7 fill-current" aria-hidden>
                  <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5h-2v6h2V7zm0 8h-2v2h2v-2z" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="h-7 w-7 fill-current" aria-hidden>
                  <path d="M12 2 1 21h22L12 2zm1 14h-2v2h2v-2zm0-7h-2v5h2V9z" />
                </svg>
              )}
            </div>
            <div>
              <p className="text-base font-extrabold text-white">
                {phase === 'offair' ? 'This channel is off-air right now' : 'Stream unavailable'}
              </p>
              <p className="mx-auto mt-1 max-w-md text-sm font-medium text-white/60">
                {phase === 'offair'
                  ? '24/7 feeds activate when their live event starts. Surf to another channel —'
                  : errorMsg || 'The channel may be geo-blocked from your region.'}
              </p>
              {autoAdvSecs !== null && (
                <p className="mt-2 text-sm font-black text-zilla-yellow">
                  Up next in {autoAdvSecs}s — {nextChannel()?.name}
                </p>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={retryStream}
                className="rounded-full bg-zilla-yellow px-5 py-2.5 text-xs font-black uppercase tracking-wide text-black hover:bg-zilla-yellow-soft"
              >
                Retry
              </button>
              {hasServerChoices && (
                <button
                  onClick={() => {
                    setShowServersMenu(true);
                    setSurfOpen(false);
                    setShowQualityMenu(false);
                  }}
                  className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
                >
                  Switch server
                </button>
              )}
              {autoAdvSecs !== null && (
                <button
                  onClick={() => cancelAutoAdvRef.current?.()}
                  className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
                >
                  Cancel auto-switch
                </button>
              )}
              <button
                onClick={() => setSurfOpen(true)}
                className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
              >
                Browse channels
              </button>
              {altFeeds.length > 1 && (
                <button
                  onClick={() => setSurfOpen(true)}
                  className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
                >
                  Try another feed ({altFeeds.length})
                </button>
              )}
              <button
                onClick={closePlayer}
                className="rounded-full border border-white/25 bg-white/10 px-5 py-2.5 text-xs font-black uppercase tracking-wide text-white hover:bg-white/20"
              >
                Close
              </button>
            </div>
          </div>
        )}

        {/* tap for sound */}
        {phase === 'playing' && muted && controlsVisible && (
          <button
            onClick={() => {
              const v = videoRef.current;
              if (v) {
                v.muted = false;
                setMuted(false);
                v.play().catch(() => {});
              }
            }}
            className="absolute bottom-24 left-1/2 -translate-x-1/2 rounded-full bg-zilla-yellow px-5 py-2.5 text-xs font-black uppercase tracking-wide text-black shadow-2xl hover:bg-zilla-yellow-soft"
          >
            Tap for sound
          </button>
        )}

        {/* content-mismatch banner — "this feed is showing motorsport" */}
        {mismatch && phase === 'playing' && (
          <div className="absolute left-1/2 top-16 w-[92vw] max-w-lg -translate-x-1/2 rounded-xl border border-zilla-yellow/40 bg-black/90 p-3.5 shadow-2xl backdrop-blur">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-zilla-yellow/15 text-zilla-yellow">
                <svg viewBox="0 0 24 24" className="h-4 w-4 fill-current" aria-hidden>
                  <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5h-2v6h2V7zm0 8h-2v2h2v-2z" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-xs font-extrabold text-zilla-text">
                  This feed is showing {mismatch.sport.replace(/_/g, ' ')} right now
                </p>
                <p className="mt-0.5 text-[11px] font-medium text-zilla-dim">
                  Network channels sometimes preempt matches. Hop to another feed for this event.
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {altFeeds.length > 1 ? (
                    <button
                      onClick={cycleFeed}
                      className="rounded-full bg-zilla-yellow px-4 py-1.5 text-[11px] font-black uppercase tracking-wide text-black hover:bg-zilla-yellow-soft"
                    >
                      Switch feed
                    </button>
                  ) : (
                    <button
                      onClick={() => {
                        setMismatch(null);
                        setSurfOpen(true);
                      }}
                      className="rounded-full bg-zilla-yellow px-4 py-1.5 text-[11px] font-black uppercase tracking-wide text-black hover:bg-zilla-yellow-soft"
                    >
                      Browse channels
                    </button>
                  )}
                  <button
                    onClick={() => setMismatch(null)}
                    className="rounded-full border border-white/20 bg-white/10 px-4 py-1.5 text-[11px] font-black uppercase tracking-wide text-white/80 hover:bg-white/20"
                  >
                    Keep watching
                  </button>
                </div>
              </div>
              <button
                onClick={() => setMismatch(null)}
                className="shrink-0 rounded-full p-1 text-zilla-dim hover:text-zilla-text"
                aria-label="Dismiss"
              >
                <span className="h-3.5 w-3.5">{Icon.close}</span>
              </button>
            </div>
          </div>
        )}

        {/* go-live chip (behind the live edge) */}
        {phase === 'playing' && liveBehind && (
          <button
            onClick={goLive}
            className="absolute right-4 top-20 flex items-center gap-1.5 rounded-full bg-zilla-red px-3.5 py-2 text-[11px] font-black uppercase tracking-wide text-white shadow-xl"
          >
            <span className="live-dot h-1.5 w-1.5 rounded-full bg-white" /> Go live
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
              <div className="absolute inset-y-0 left-0 w-full bg-gradient-to-r from-zilla-red to-zilla-yellow" />
            </div>
            <span className="shrink-0 text-[10px] font-black uppercase tracking-widest text-zilla-red">
              ● live
            </span>
          </div>

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 sm:gap-2">
              <button
                onClick={togglePlay}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                title="Play / pause (Space)"
                aria-label="Play or pause"
              >
                <span className="h-4.5 w-4.5">{phase === 'playing' ? Icon.pause : Icon.play}</span>
              </button>
              <button
                onClick={zapPrev}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                title="Previous channel (←)"
                aria-label="Previous channel"
              >
                <span className="h-4.5 w-4.5">{Icon.prev}</span>
              </button>
              <button
                onClick={zapNext}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                title="Next channel (→)"
                aria-label="Next channel"
              >
                <span className="h-4.5 w-4.5">{Icon.next}</span>
              </button>

              {/* volume */}
              <div className="group flex items-center">
                <button
                  onClick={toggleMute}
                  className="flex h-10 w-10 items-center justify-center rounded-full text-white/85 transition-colors hover:text-white"
                  title="Mute (M)"
                  aria-label="Toggle mute"
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
                    const v = videoRef.current;
                    const nv = parseFloat(e.target.value);
                    setVolume(nv);
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
                  style={{ ['--fill' as string]: `${(muted ? 0 : volume) * 100}%` }}
                  className="slider-zilla w-0 opacity-0 transition-all duration-300 group-hover:w-24 group-hover:opacity-100 sm:w-16 sm:opacity-100"
                  aria-label="Volume"
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
                  title="Switch streaming server (S)"
                  aria-label="Switch streaming server"
                >
                  <span className="h-4 w-4">{Icon.server}</span>
                  Servers
                </button>
                {showServersMenu && (
                  <div className="absolute bottom-12 right-0 w-72 max-w-[86vw] overflow-hidden rounded-xl border border-zilla-line bg-zilla-bg/97 shadow-2xl backdrop-blur">
                    <p className="border-b border-zilla-line/60 px-4 py-2.5 text-[9px] font-black uppercase tracking-widest text-zilla-dim">
                      Streaming servers
                      {player.kind === 'daddylive'
                        ? ` · ${serverOptions.length + Math.max(0, alternates.length)} available`
                        : ` · ${1 + alternates.length} available`}
                    </p>
                    <div className="styled-scrollbar max-h-72 overflow-y-auto">
                      {player.kind === 'daddylive' ? (
                        <>
                          {serverOptions.map((s) => {
                            const isActive = activeServer === s.id || (!s.id && activeServer === s.host);
                            return (
                              <button
                                key={s.id}
                                onClick={() => switchServer(s.id)}
                                className={cn(
                                  'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5',
                                  isActive && 'bg-zilla-yellow/10'
                                )}
                              >
                                <span
                                  className={cn(
                                    'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[10px] font-black',
                                    isActive ? 'bg-zilla-yellow text-black' : 'bg-white/10 text-zilla-dim'
                                  )}
                                >
                                  {s.label.replace(/\D/g, '') || '•'}
                                </span>
                                <span className="min-w-0 flex-1">
                                  <span
                                    className={cn(
                                      'block truncate text-xs font-bold',
                                      isActive ? 'text-zilla-yellow' : 'text-zilla-text'
                                    )}
                                  >
                                    {s.label}
                                  </span>
                                  <span className="block truncate text-[10px] font-medium text-zilla-dim">{s.host}</span>
                                </span>
                                {isActive && (
                                  <span className="shrink-0 rounded-full bg-zilla-yellow/20 px-2 py-0.5 text-[9px] font-black uppercase text-zilla-yellow">
                                    active
                                  </span>
                                )}
                              </button>
                            );
                          })}
                          <p className="px-4 py-2 text-[10px] font-medium leading-snug text-zilla-dim">
                            Direct CDN (Server 2) is the default — straight from the CDN, no middle layer.
                            Edge direct skips mirror parsing for the lowest latency. Turbo and Relay are
                            pre-buffered through MaxTV to ride out CDN hiccups. If one acts up, hop to another.
                          </p>
                        </>
                      ) : (
                        <>
                          <div className="flex w-full items-center gap-3 px-4 py-2.5">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-zilla-yellow text-[10px] font-black text-black">
                              ●
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-xs font-bold text-zilla-yellow">
                                {player.source || 'Current source'}
                              </span>
                              <span className="block truncate text-[10px] font-medium text-zilla-dim">Playing now</span>
                            </span>
                          </div>
                          {alternates.map((alt, ai) => {
                            const sameSource = alt.sourceName === (player.source || '');
                            return (
                              <button
                                key={alt.id}
                                onClick={() => switchAlternate(alt)}
                                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-white/5"
                              >
                                {alt.logo ? (
                                  <img
                                    src={logoSrc(alt.logo, alt.name)}
                                    alt=""
                                    loading="lazy"
                                    className="h-7 w-11 shrink-0 rounded object-contain"
                                  />
                                ) : (
                                  <span className="flex h-7 w-11 shrink-0 items-center justify-center rounded bg-white/5 text-[10px] font-black text-zilla-dim">
                                    TV
                                  </span>
                                )}
                                <span className="min-w-0 flex-1">
                                  <span className="block truncate text-xs font-bold text-zilla-text">
                                    {sameSource ? `Alternate stream ${ai + 2}` : alt.sourceName}
                                  </span>
                                  <span className="block truncate text-[10px] font-medium text-zilla-dim">
                                    {sameSource ? 'Same channel, different stream URL' : alt.name}
                                    {alt.health === 'ok' ? ' · healthy' : alt.health === 'geo' ? ' · may be geo-blocked' : ''}
                                  </span>
                                </span>
                              </button>
                            );
                          })}
                          {alternates.length === 0 && (
                            <p className="px-4 py-3 text-[10px] font-medium leading-snug text-zilla-dim">
                              No other source carries this channel right now.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  </div>
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
                title="Browse channels — type a channel number anytime"
                aria-label="Open channel guide"
              >
                <span className="h-4 w-4">{Icon.tv}</span>
                Channels
              </button>
              <button
                onClick={toggleFullscreen}
                className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
                title="Fullscreen (F)"
                aria-label="Toggle fullscreen"
              >
                <span className="h-5 w-5">{isFullscreen ? Icon.fullscreenExit : Icon.fullscreen}</span>
              </button>
            </div>
          </div>

          <p className="mt-2 hidden text-center text-[10px] font-medium text-white/40 sm:block">
            Space play · M mute · F fullscreen · P pip · S servers · ←/→ change channel · type a number to jump · Esc close
          </p>
        </div>

        {/* ── channel-surf sidebar (Pluto TV guide) ──────────────────────────── */}
        <div
          className={cn(
            'styled-scrollbar absolute inset-y-0 right-0 z-10 w-80 max-w-[86vw] overflow-y-auto border-l border-zilla-line bg-zilla-bg/97 backdrop-blur-xl transition-transform duration-300',
            surfOpen ? 'translate-x-0' : 'translate-x-full'
          )}
        >
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zilla-line bg-zilla-bg/95 px-4 py-3 backdrop-blur">
            <p className="text-xs font-black uppercase tracking-wider text-zilla-text">Channel guide</p>
            <button
              onClick={() => setSurfOpen(false)}
              className="flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-zilla-dim hover:text-zilla-text"
              aria-label="Close guide"
            >
              <span className="h-3.5 w-3.5">{Icon.close}</span>
            </button>
          </div>

          {[
            { key: 'feeds', label: 'Feeds for this event', items: surf.filter((s) => s.group === 'feeds') },
            { key: 'live', label: 'Live now', items: surf.filter((s) => s.group === 'live') },
            { key: 'channels', label: '24/7 channels', items: surf.filter((s) => s.group === 'channels') },
          ]
            .filter((g) => g.items.length > 0)
            .map((g, gi) => (
              <div key={g.key} className="pb-2">
                <p className="px-4 pb-1.5 pt-3 text-[10px] font-black uppercase tracking-widest text-zilla-dim">
                  {g.label} · {g.items.length}
                </p>
                {g.items.map((item, i) => {
                  const num = gi === 0 ? i + 1 : surf.indexOf(item) + 1;
                  const active = item.id === player?.id;
                  return (
                    <button
                      key={`${item.kind}-${item.ref}-${i}`}
                      onClick={() => {
                        switchTo(item, g.key === 'feeds' ? altFeeds : undefined);
                        setSurfOpen(false);
                      }}
                      className={cn(
                        'flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors',
                        active ? 'bg-zilla-yellow/15' : 'hover:bg-white/5'
                      )}
                    >
                      <span className="w-6 shrink-0 text-center text-[10px] font-black text-zilla-dim">
                        {num}
                      </span>
                      {item.logo ? (
                        <img
                          src={logoSrc(item.logo, item.name)}
                          alt=""
                          loading="lazy"
                          className="h-8 w-12 shrink-0 rounded object-contain"
                        />
                      ) : (
                        <span className="flex h-8 w-12 shrink-0 items-center justify-center rounded bg-white/5 text-[10px] font-black text-zilla-dim">
                          {item.group === 'live' ? '●' : 'TV'}
                        </span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate text-xs font-bold',
                            active ? 'text-zilla-yellow' : 'text-zilla-text'
                          )}
                        >
                          {item.name}
                        </span>
                        <span className="block truncate text-[10px] font-medium text-zilla-dim">
                          {item.group === 'live'
                            ? `${item.sub || ''} ${item.startedAt ? '· ' + fmtAgo(item.startedAt) : ''}`
                            : item.source || 'Always on'}
                        </span>
                      </span>
                      {item.group === 'live' && (
                        <span className="shrink-0 rounded bg-zilla-red px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
                          live
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))}

          {surf.length === 0 && (
            <div className="flex flex-col items-center gap-3 px-4 py-10">
              <div className="h-8 w-8 animate-spin rounded-full border-[3px] border-zilla-line border-t-zilla-yellow" />
              <p className="text-xs font-bold text-zilla-dim">Loading the guide…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface MatchLike {
  id: string;
  title: string;
  league: string;
  startTime: number;
  channels: { id: string; name: string; logo?: string }[];
  team1Logo?: string;
  team2Logo?: string;
  leagueLogo?: string;
  channelLogo?: string;
}
