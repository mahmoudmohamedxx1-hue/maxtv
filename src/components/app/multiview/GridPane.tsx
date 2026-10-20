'use client';

// ─── Multi-view: one grid pane ────────────────────────────────────────────────
// A deliberately LIGHT player: resolve → attach hls → muted autoplay. No
// data-saver ladder, no connectivity engine, no server walk — panes are for
// keeping an eye on several streams at once; the full PlayerOverlay (with its
// entire failover/quality engine) is one double-tap away via expand.
//
// Bandwidth guardrails for 4 simultaneous live streams on one link:
//   • panes cap their ladder at 480p (autoLevelCapping)
//   • panes keep a SHALLOW buffer (15s) — the main player owns deep buffering
//   • exactly ONE pane is audible (the active pane); the rest stay muted
//   • while the main player overlay is open, every pane pauses

import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { cn } from '@/lib/utils';
import { logoSrc } from '../ChannelCard';
import type { Playable } from '@/lib/store';
import { RESILIENT_LOAD_POLICIES, isDlIframeSrc } from '../player/constants';
import { Icon } from '../player/icons';

type PanePhase = 'resolving' | 'playing' | 'offair' | 'error';

/** pane-tuned hls config — shallow buffer, 480p cap, never catch-up speed */
function paneHlsConfig(): Partial<Hls['config']> {
  return {
    lowLatencyMode: false,
    enableWorker: true,
    maxBufferLength: 15,
    maxMaxBufferLength: 30,
    backBufferLength: 15,
    liveSyncDurationCount: 2,
    maxLiveSyncPlaybackRate: 1,
    ...RESILIENT_LOAD_POLICIES,
  };
}

export interface GridPaneProps {
  ch: Playable;
  active: boolean;
  /** the main player overlay is open — pause (bandwidth + focus) */
  covered: boolean;
  onActivate: () => void;
  onRemove: () => void;
  onExpand: () => void;
  labels: {
    expand: string;
    remove: string;
    offair: string;
    error: string;
    retry: string;
    live: string;
    soundOn: string;
  };
}

export function GridPane({ ch, active, covered, onActivate, onRemove, onExpand, labels }: GridPaneProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [phase, setPhase] = useState<PanePhase>('resolving');
  const [attempt, setAttempt] = useState(0); // manual retry bumps this
  const chKey = `${ch.kind}:${ch.ref}`;
  /** LIVE active flag — the load effect's hls callbacks fire seconds after
   *  mount (MANIFEST_PARSED) and MUST NOT un-mute from a stale closure: the
   * audio state at that moment belongs to the [active] effect, which uses
   * this ref. (Bug found in E2E: the slow pane un-muted itself late.) */
  const activeRef = useRef(active);
  activeRef.current = active;

  // resolve + attach (re-runs on channel change or manual retry)
  useEffect(() => {
    let alive = true;
    const video = videoRef.current;
    if (!video) return;
    setPhase('resolving');

    (async () => {
      try {
        const endpoint =
          ch.kind === 'daddylive'
            ? `/api/sports/stream?channel=${encodeURIComponent(ch.ref)}${ch.name ? `&name=${encodeURIComponent(ch.name.slice(0, 80))}` : ''}`
            : `/api/iptv/stream?url=${encodeURIComponent(ch.ref)}${ch.name ? `&name=${encodeURIComponent(ch.name)}` : ''}`;
        const ctrl = new AbortController();
        const cap = setTimeout(() => ctrl.abort(), 20_000);
        let res: Response;
        try {
          res = await fetch(endpoint, { signal: ctrl.signal });
        } finally {
          clearTimeout(cap);
        }
        if (!alive) return;
        const data = (await res.json().catch(() => ({}))) as { url?: string; hevc?: boolean };
        if (!alive) return;
        if (!res.ok || !data.url) {
          setPhase('offair');
          return;
        }
        // the iframe chain can't render inside a pane (it needs the whole
        // player) — send it to the full player instead of pretending
        if (isDlIframeSrc(data.url)) {
          setPhase('error');
          return;
        }
        if (data.hevc) {
          setPhase('error'); // HEVC feeds belong in the full player (choice panel)
          return;
        }
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
        if (Hls.isSupported()) {
          const hls = new Hls(paneHlsConfig());
          hlsRef.current = hls;
          hls.loadSource(data.url);
          hls.attachMedia(video);
          hls.on(Hls.Events.MANIFEST_PARSED, () => {
            // cap the pane at 480p — bandwidth guardrail for 4 streams
            if (hls.levels?.length) {
              let cap = -1;
              let bestH = 0;
              hls.levels.forEach((l, i) => {
                const h = l.height || 0;
                if (h > 0 && h <= 480 && h > bestH) {
                  bestH = h;
                  cap = i;
                }
              });
              if (cap >= 0 && hls.levels.length > 1) hls.autoLevelCapping = cap;
            }
            video.muted = !activeRef.current;
            video.play().catch(() => {
              video.muted = true;
              video.play().catch(() => {});
            });
          });
          hls.on(Hls.Events.ERROR, (_e, d) => {
            if (!d.fatal) return;
            if (!alive) return;
            // 503 x-offair from our relay → honest off-air, no retry storm
            if ((d as { response?: { code?: number } }).response?.code === 503) {
              setPhase('offair');
              return;
            }
            setPhase('error');
          });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = data.url;
          video.muted = !activeRef.current;
          video.play().catch(() => {});
        }
      } catch {
        if (alive) setPhase('error');
      }
    })();

    return () => {
      alive = false;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
    };
  }, [chKey, attempt]);

  // audio follows the active pane; everything else stays muted
  useEffect(() => {
    const v = videoRef.current;
    if (v && !covered) v.muted = !active;
  }, [active, covered]);

  // pause while the main player overlay covers the grid
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    if (covered) v.pause();
    else v.play().catch(() => {});
  }, [covered]);

  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border bg-black transition-colors',
        active ? 'border-zilla-yellow/80 shadow-[0_0_18px_rgba(255,210,0,0.15)]' : 'border-zilla-line'
      )}
    >
      <video
        ref={videoRef}
        className="absolute inset-0 h-full w-full cursor-pointer object-contain"
        playsInline
        autoPlay
        muted={!active}
        onClick={onActivate}
        onDoubleClick={onExpand}
        onPlaying={() => setPhase('playing')}
      />

      {/* header — name + actions */}
      <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-2 bg-gradient-to-b from-black/80 to-transparent p-2.5">
        <div className="flex min-w-0 items-center gap-2">
          {ch.logo ? (
            <img src={logoSrc(ch.logo, ch.name)} alt="" className="h-6 w-9 shrink-0 rounded object-contain" />
          ) : null}
          <div className="min-w-0">
            <p className="truncate text-xs font-extrabold text-white">{ch.name}</p>
            <p className="truncate text-[10px] font-semibold text-white/50">{ch.source || ''}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {phase === 'playing' && (
            <span className="flex items-center gap-1 rounded-md bg-zilla-red px-1.5 py-0.5 text-[9px] font-black uppercase text-white">
              <span className="live-dot h-1 w-1 rounded-full bg-white" /> {labels.live}
            </span>
          )}
          {active && phase === 'playing' && (
            <span className="rounded-md bg-zilla-yellow px-1.5 py-0.5 text-[9px] font-black uppercase text-black">
              {labels.soundOn}
            </span>
          )}
          <button
            onClick={onExpand}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white/80 backdrop-blur transition-colors hover:text-white"
            title={labels.expand}
            aria-label={labels.expand}
          >
            <span className="h-3.5 w-3.5">{Icon.expand}</span>
          </button>
          <button
            onClick={onRemove}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-black/60 text-white/80 backdrop-blur transition-colors hover:text-zilla-red"
            title={labels.remove}
            aria-label={labels.remove}
          >
            <span className="h-3.5 w-3.5">{Icon.close}</span>
          </button>
        </div>
      </div>

      {/* state overlays */}
      {phase === 'resolving' && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/60">
          <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-zilla-yellow" />
        </div>
      )}
      {(phase === 'offair' || phase === 'error') && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/85 px-4 text-center">
          <p className="text-xs font-extrabold text-white/80">
            {phase === 'offair' ? labels.offair : labels.error}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setAttempt((a) => a + 1)}
              className="rounded-full bg-zilla-yellow px-4 py-1.5 text-[10px] font-black uppercase tracking-wide text-black"
            >
              {labels.retry}
            </button>
            <button
              onClick={onExpand}
              className="rounded-full border border-white/25 bg-white/10 px-4 py-1.5 text-[10px] font-black uppercase tracking-wide text-white"
            >
              {labels.expand}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
