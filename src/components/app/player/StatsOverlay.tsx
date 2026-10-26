'use client';

// ─── Player module: the stats overlay ("stats for nerds") ────────────────────
// YouTube-style diagnostics: resolution, level/bitrate, bandwidth estimate,
// buffer health, dropped frames, live-edge latency, transport — plus the
// DaddyLive edge telemetry (host, rotation alert, manifest micro-cache
// effectiveness) pulled from /api/diagnostics every 15s.

import { useEffect, useState } from 'react';
import type Hls from 'hls.js';
import { cn } from '@/lib/utils';
import type { Translator } from '@/lib/locale';
import { Icon } from './icons';
import { hostHealthSnapshot } from './host-health';

export interface StatsSnapshot {
  resolution: string;
  fps: number;
  levelLabel: string;
  bitrate: number; // bps of the current level (0 unknown)
  bandwidthEstimate: number; // bps
  bufferAhead: number; // seconds
  backBuffer: number; // seconds
  droppedFrames: number;
  totalFrames: number;
  liveLatency: number; // seconds behind the live edge
  transport: string;
}

interface EdgeInfo {
  host: string;
  rotating: boolean;
  rotations: { from: string; to: string; at: string }[];
  cache: { hitRate: string; savedPairs: number; size: number };
}

export interface StatsOverlayProps {
  t: Translator['t'];
  open: boolean;
  isDaddyLive: boolean;
  /** live transport label — sampled from refs every tick (not reactive state) */
  getTransportLabel: () => string;
  hlsRef: React.RefObject<Hls | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  onClose: () => void;
}

function mbps(bps: number): string {
  if (!bps || bps <= 0) return '—';
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(2)} Mbps`;
  return `${Math.round(bps / 1000)} kbps`;
}

function secs(s: number): string {
  return Number.isFinite(s) && s >= 0 ? `${s.toFixed(1)}s` : '—';
}

export function StatsOverlay({ t, open, isDaddyLive, getTransportLabel, hlsRef, videoRef, onClose }: StatsOverlayProps) {
  const [snap, setSnap] = useState<StatsSnapshot | null>(null);
  const [edge, setEdge] = useState<EdgeInfo | null>(null);
  const [hosts, setHosts] = useState<ReturnType<typeof hostHealthSnapshot>>({});

  // sample the player once a second while open
  useEffect(() => {
    if (!open) return;
    const tick = () => {
      const transport = getTransportLabel();
      const v = videoRef.current;
      const hls = hlsRef.current;
      const q = v && typeof v.getVideoPlaybackQuality === 'function' ? v.getVideoPlaybackQuality() : null;
      let bufferAhead = 0;
      let backBuffer = 0;
      let liveLatency = 0;
      if (v) {
        for (let i = 0; i < v.buffered.length; i++) {
          if (v.buffered.start(i) <= v.currentTime && v.currentTime <= v.buffered.end(i)) {
            bufferAhead = Math.max(0, v.buffered.end(i) - v.currentTime);
            backBuffer = Math.max(0, v.currentTime - v.buffered.start(i));
          }
        }
        if (v.seekable.length) liveLatency = Math.max(0, v.seekable.end(v.seekable.length - 1) - v.currentTime);
      }
      let levelLabel = t('stats.auto');
      let bitrate = 0;
      if (hls && hls.levels?.length) {
        const idx = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
        const lvl = hls.levels[idx];
        if (lvl) {
          const h = lvl.height || Number(String(lvl.attrs?.RESOLUTION ?? '').split('x')[1]) || 0;
          levelLabel = h ? `${h}p` : `lvl ${idx}`;
          bitrate = lvl.bitrate || 0;
        }
      }
      setSnap({
        resolution: v && v.videoWidth ? `${v.videoWidth}×${v.videoHeight}` : '—',
        fps: q?.creationTime && v ? Math.round(q.totalVideoFrames / Math.max(1, v.currentTime)) || 0 : 0,
        levelLabel,
        bitrate,
        bandwidthEstimate: hls?.bandwidthEstimate || 0,
        bufferAhead,
        backBuffer,
        droppedFrames: q?.droppedVideoFrames ?? 0,
        totalFrames: q?.totalVideoFrames ?? 0,
        liveLatency,
        transport,
      });
      // 2026-10-26 stability engine — per-CDN-shard fetch health (EWMA)
      setHosts(hostHealthSnapshot());
    };
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [open, hlsRef, videoRef, t, getTransportLabel]);

  // edge telemetry every 15s (DaddyLive transports only)
  useEffect(() => {
    if (!open || !isDaddyLive) return;
    let alive = true;
    const load = () => {
      fetch('/api/diagnostics')
        .then((r) => (r.ok ? r.json() : null))
        .then((d: { edge?: EdgeInfo } | null) => {
          // ⚠ d.edge — the response envelope, NOT the whole response (storing
          // the envelope made edge.rotations undefined and crashed the render
          // — caught in E2E)
          if (alive && d?.edge) setEdge(d.edge);
        })
        .catch(() => {});
    };
    load();
    const iv = setInterval(load, 15_000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [open, isDaddyLive]);

  if (!open) return null;

  const rows: Array<[string, string]> = snap
    ? [
        [t('stats.resolution'), `${snap.resolution}${snap.fps > 0 ? ` @ ${snap.fps} ${t('stats.fps')}` : ''}`],
        [t('stats.level'), snap.levelLabel],
        [t('stats.bitrate'), mbps(snap.bitrate)],
        [t('stats.bandwidth'), mbps(snap.bandwidthEstimate)],
        [t('stats.buffer'), secs(snap.bufferAhead)],
        [t('stats.backBuffer'), secs(snap.backBuffer)],
        [
          t('stats.dropped'),
          `${snap.droppedFrames} / ${snap.totalFrames}${snap.totalFrames > 0 ? ` (${((snap.droppedFrames / snap.totalFrames) * 100).toFixed(1)}%)` : ''}`,
        ],
        [t('stats.latency'), secs(snap.liveLatency)],
        [t('stats.transport'), snap.transport],
      ]
    : [];

  return (
    <div
      role="dialog"
      aria-label={t('stats.title')}
      className="absolute start-3 top-16 z-30 w-64 max-w-[80vw] rounded-xl border border-zilla-line bg-black/92 p-3 font-mono text-[10px] leading-relaxed text-zilla-text shadow-2xl backdrop-blur"
    >
      <div className="mb-2 flex items-center justify-between border-b border-zilla-line/70 pb-1.5">
        <p className="text-[9px] font-black uppercase tracking-widest text-zilla-yellow">{t('stats.title')}</p>
        <button
          onClick={onClose}
          className="flex h-5 w-5 items-center justify-center rounded-full text-zilla-dim hover:text-zilla-text"
          aria-label={t('stats.close')}
        >
          <span className="h-3 w-3">{Icon.close}</span>
        </button>
      </div>
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-3">
          <span className="shrink-0 text-zilla-dim">{k}</span>
          <span className="truncate text-end font-bold">{v}</span>
        </div>
      ))}
      {isDaddyLive && (
        <div className="mt-2 border-t border-zilla-line/70 pt-1.5">
          {Object.keys(hosts).length > 0 && (
            <div className="mb-1.5">
              <span className="text-zilla-dim">{t('stats.shardHealth')}</span>
              {Object.entries(hosts).map(([h, s]) => (
                <div key={h} className="flex items-baseline justify-between gap-3">
                  <span className="shrink-0 truncate text-zilla-dim">
                    {h.replace('-common-sign.tiktokcdn-us.com', '')}
                  </span>
                  <span className={cn('text-end font-bold', s.slow ? 'text-zilla-yellow' : '')}>
                    {(s.ewmaMs / 1000).toFixed(1)}s ×{s.samples}
                    {s.slow ? ' ⚠' : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-baseline justify-between gap-3">
            <span className="shrink-0 text-zilla-dim">{t('stats.edgeHost')}</span>
            <span className="truncate text-end font-bold">{edge?.host || t('stats.unknown')}</span>
          </div>
          {edge && (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <span className="shrink-0 text-zilla-dim">{t('stats.edgeRotations')}</span>
                <span className={cn('text-end font-bold', edge.rotating ? 'text-zilla-yellow' : '')}>
                  {edge.rotations?.length ?? 0}
                  {edge.rotating && edge.rotations?.[0] && (
                    <span className="ms-1">
                      ·{' '}
                      {t('stats.edgeRotating', {
                        n: Math.max(1, Math.round((Date.now() - new Date(edge.rotations[0].at).getTime()) / 60000)),
                      })}
                    </span>
                  )}
                </span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="shrink-0 text-zilla-dim">{t('stats.cache')}</span>
                <span className="text-end font-bold">
                  {edge.cache?.hitRate ?? '—'} · {t('stats.cacheSaved', { n: edge.cache?.savedPairs ?? 0 })}
                </span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
