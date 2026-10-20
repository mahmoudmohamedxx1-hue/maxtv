// ─── Player module: the connectivity engine ──────────────────────────────────
// Extracted verbatim from the old PlayerOverlay monolith (only the toast
// strings now route through i18n). Auto keeps following the measured
// bandwidth on EVERY attachment — the native ladder AND the data-saver
// transcodes.
//
// 2026-10-03 field report ("auto quality isn't working well — I want the
// most STABLE stream for my connection") hardened this into three rules:
//   1. sticky ABR cap — autoLevelCapping only moves on SUSTAINED evidence
//      (6 good frags to raise, 3 bad to lower), so the CDN's latency flaps
//      can't thrash the rung up/down every 10s. Raising is also rate-limited.
//   2. stall downshift — a bufferStalledError drops the cap one rung below
//      whatever is playing RIGHT NOW (rate-limited 12s). Stability first.
//   3. starvation rung hop — on single-rendition feeds (most DaddyLive
//      channels: one 408p variant, nothing for ABR to choose), 8
//      consecutive frags (~40s+) measured BELOW 85% of the stream's own
//      bitrate means the link truly can't hold the native feed → hop to
//      the transcoded rung that fits the measured estimate.

import Hls from 'hls.js';
import { loadPrefs, updatePrefs } from '@/lib/player-settings';
import type { Playable } from '@/lib/store';
import type { Translator } from '@/lib/locale';

export interface NetWatcherDeps {
  /** live bandwidth samples (low/high streaks) */
  netRef: React.RefObject<{ lows: number; highs: number }>;
  /** active data-saver height (null = native feed) */
  tcHeightRef: React.RefObject<number | null>;
  /** best known height of the native feed (the ladder never encodes up) */
  nativeHeightRef: React.RefObject<number>;
  /** can this deployment transcode at all */
  tcCapRef: React.RefObject<boolean>;
  /** signed source params for data-saver transcodes of the current stream */
  tcSrcRef: React.RefObject<{ src: string; r: string; s: string } | null>;
  /** the currently playing channel */
  playerRef: React.RefObject<Playable | null>;
  /** localized toast */
  showToast: (msg: string) => void;
  t: Translator['t'];
  /** stable callbacks into the player (ref-indirected to avoid cycles) */
  selectDataSaverRef: React.RefObject<((h: number, opts?: { auto?: boolean }) => void) | null>;
  exitDataSaverRef: React.RefObject<(() => void) | null>;
}

/** attach the connectivity engine to a fresh hls instance */
export function createNetWatcher(deps: NetWatcherDeps) {
  const { netRef, tcHeightRef, nativeHeightRef, tcCapRef, tcSrcRef, playerRef, showToast, t, selectDataSaverRef, exitDataSaverRef } = deps;

  return function attachNetWatcher(hls: Hls): void {
    let seen = 0; // per-instance fragment count — skip the EWMA warm-up window
    // sticky-cap state (per hls instance)
    let capIdx = -1; // current autoLevelCapping (-1 = uncapped)
    let lastCapChange = 0;
    let aboveRun = 0; // consecutive frags whose sustainable target exceeds the cap
    let belowRun = 0; // … falls short of the cap
    let streamBr = 0; // EWMA of the stream's OWN bitrate (segment bytes/duration)
    let starveRun = 0; // consecutive frags with est < 85% of streamBr

    /** levels sorted by bitrate → {index, bitrate}; empty when unknown */
    const levelsByRate = () =>
      (hls.levels || [])
        .map((l, i) => ({ i, b: l.bitrate || 0 }))
        .filter((x) => x.b > 0)
        .sort((a, b) => a.b - b.b);

    const applyCap = (idx: number) => {
      if (idx === capIdx) return;
      // raising is rate-limited (12s) — stability over eagerness; lowering is instant
      if (idx > capIdx && Date.now() - lastCapChange < 12_000) return;
      capIdx = idx;
      lastCapChange = Date.now();
      hls.autoLevelCapping = idx;
    };

    hls.on(Hls.Events.FRAG_BUFFERED, (_e, d) => {
      seen++;
      // the stream's own bitrate from real segment payloads (bps)
      const bytes = (d.frag?.stats?.total as number) || 0;
      const dur = (d.frag?.duration as number) || 0;
      if (bytes > 0 && dur > 0) {
        const br = (bytes * 8) / dur;
        streamBr = streamBr ? streamBr * 0.7 + br * 0.3 : br;
      }
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
          showToast(t('player.improved'));
          net.highs = 0;
          updatePrefs({ autoPicked: false });
          void exitDataSaverRef.current?.();
        } else if (net.lows >= 6) {
          const cur2 = tcHeightRef.current;
          const next = cur2 > 360 ? 360 : cur2 > 244 ? 244 : 144;
          if (next < cur2) {
            showToast(t('player.slowConnDs', { h: next }));
            net.lows = 0;
            void selectDataSaverRef.current?.(next, { auto: true });
          }
        }
        return;
      }

      // native mode, single rendition (most DaddyLive channels): nothing for
      // ABR to pick between — the only stable option is the transcode rung
      // that fits the measured link. Sustained starvation only (8 frags ≈
      // 40s+; CDN flaps are 10-20s and never qualify).
      if ((hls.levels || []).length < 2 && streamBr > 0) {
        starveRun = est < streamBr * 0.85 ? starveRun + 1 : 0;
        if (starveRun >= 8 && canTc) {
          const rung = est < 350_000 ? 144 : est < 700_000 ? 244 : est < 1_200_000 ? 360 : 480;
          const nativeH = nativeHeightRef.current || 0;
          // a rung at/above the native height gains nothing (never encode up)
          if (nativeH === 0 || rung < nativeH - 30) {
            showToast(t('player.slowConn', { h: rung }));
            starveRun = 0;
            net.lows = 0;
            void selectDataSaverRef.current?.(rung, { auto: true });
            return;
          }
        }
      }

      // native mode, real ladder: the sticky ABR cap. Target = the highest
      // rung the measured link holds with ~30% headroom.
      if ((hls.levels || []).length > 1 && hls.autoLevelEnabled) {
        const sorted = levelsByRate();
        if (sorted.length > 1) {
          let target = sorted[0].i;
          for (const s of sorted) if (s.b <= est * 0.7) target = s.i;
          const curCap = capIdx === -1 ? Number.MAX_SAFE_INTEGER : capIdx;
          if (target > curCap) {
            aboveRun++;
            belowRun = 0;
            if (aboveRun >= 6) {
              applyCap(target);
              aboveRun = 0;
            }
          } else if (target < curCap) {
            belowRun++;
            aboveRun = 0;
            if (belowRun >= 3) {
              applyCap(target);
              belowRun = 0;
            }
          } else {
            aboveRun = 0;
            belowRun = 0;
          }
        }
      }

      // native mode: only a SUSTAINED, genuinely starved link hops down to a
      // transcoded rung (6 consecutive low estimates ≈ 30s+ of real slowness —
      // CDN flaps never qualify)
      const lowestNative = (hls.levels || []).reduce((m, l) => Math.min(m, l.height || 9999), 9999);
      if (net.lows >= 6 && canTc && lowestNative > 360) {
        const rung = est < 320_000 ? 144 : 244;
        showToast(t('player.slowConnDs', { h: rung }));
        net.lows = 0;
        void selectDataSaverRef.current?.(rung, { auto: true });
      }
    });

    // stability rule 2: a stall drops the cap one rung below what's playing.
    // Repeated stalls keep stepping down (applyCap dedupes) — stability first;
    // recovery up is the sticky-cap raise rule's job once the link measures good.
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (d.details !== 'bufferStalledError') return;
      if (loadPrefs().quality !== -1) return; // manual mode — user is in charge
      if (tcHeightRef.current !== null) return; // data-saver rung already active
      if ((hls.levels || []).length > 1 && hls.autoLevelEnabled) {
        const sorted = levelsByRate();
        const playing = hls.currentLevel >= 0 ? hls.currentLevel : hls.loadLevel;
        const pos = sorted.findIndex((s) => s.i === playing);
        if (pos > 0) applyCap(sorted[pos - 1].i);
      }
    });
  };
}
