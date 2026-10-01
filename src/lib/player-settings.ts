// ─── Shared player settings ──────────────────────────────────────────────────
// One source of truth for player preferences, readable/writable from BOTH the
// player overlay and the site-wide Settings menu in the top nav. Changes are
// broadcast through a window event so an open player reacts immediately.

export const PLAYER_PREFS_KEY = 'zilla-player-prefs';

export interface PlayerPrefs {
  volume: number;
  muted: boolean;
  /** -1 = Auto (network-adaptive) · 0 = 'source/native' · else a target height (144/244/360/480/720/1080) */
  quality: number;
  /** auto-advance to the next channel when a stream dies */
  autoAdvance: boolean;
  /** streaming performance profile — 'fast' = minimal buffer + closest live
   *  edge (quickest start, lowest latency) · 'steady' = deeper buffer for
   *  unstable connections. Applies to every channel; takes effect on the next
   *  stream switch. */
  perfMode: 'fast' | 'steady';
  /** chosen by the connectivity engine (not the user) — shows in the UI */
  autoPicked?: boolean;
  /** prefs schema version — bumped when a migration resets stored choices */
  v?: number;
}

/** current schema version. v2: 480p becomes the blessed default quality —
 *  stored prefs from v1 are reset to it ONCE so every existing visitor lands
 *  on the “works perfectly” rung; explicit picks made afterwards persist. */
const PREFS_VERSION = 2;

const DEFAULTS: PlayerPrefs = { volume: 0.9, muted: true, quality: 480, autoAdvance: true, perfMode: 'fast', v: PREFS_VERSION };

const EVT = 'maxtv-prefs';

export function loadPrefs(): PlayerPrefs {
  if (typeof window === 'undefined') return { ...DEFAULTS };
  try {
    const raw = window.localStorage.getItem(PLAYER_PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<PlayerPrefs>;
      let q = typeof p.quality === 'number' ? p.quality : 480;
      // legacy 240p data-saver pref → the new 244p rung
      if (q === 240) q = 244;
      const migrated =
        typeof p.v === 'number' && p.v >= PREFS_VERSION
          ? { ...DEFAULTS, ...p, quality: q, v: PREFS_VERSION }
          : { ...DEFAULTS, ...p, quality: 480, v: PREFS_VERSION }; // v1 → v2: 480p is the new default
      const needsMigration = typeof p.v !== 'number' || p.v < PREFS_VERSION;
      if (needsMigration) {
        // persist the migration immediately (plain setItem — no prefs event:
        // nothing has actually changed for the user to react to)
        try {
          window.localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(migrated));
        } catch { /* ignore */ }
      }
      return migrated;
    }
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

export function savePrefs(p: PlayerPrefs, patch?: Partial<PlayerPrefs>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(PLAYER_PREFS_KEY, JSON.stringify(p));
  } catch { /* ignore */ }
  // the detail carries BOTH the full prefs and the patch that caused it —
  // listeners can tell a real quality change from an incidental flag update
  // (volume, autoPicked, …) instead of guessing and re-entering each other
  window.dispatchEvent(new CustomEvent(EVT, { detail: { prefs: p, patch: patch ?? p } }));
}

/** merge a patch into the stored prefs and notify listeners */
export function updatePrefs(patch: Partial<PlayerPrefs>): void {
  savePrefs({ ...loadPrefs(), ...patch }, patch);
}

/** subscribe to pref changes (player reacts to the Settings menu) */
export function onPrefsChange(cb: (p: PlayerPrefs, patch?: Partial<PlayerPrefs>) => void): () => void {
  const handler = (e: Event) => {
    const d = (e as CustomEvent).detail as
      | { prefs: PlayerPrefs; patch?: Partial<PlayerPrefs> }
      | PlayerPrefs;
    if (d && typeof d === 'object' && 'prefs' in d) {
      cb(d.prefs, d.patch);
    } else {
      cb(d as PlayerPrefs); // legacy detail shape — no patch info
    }
  };
  // cross-tab sync (no patch info available from the storage event)
  const storageHandler = (ev: StorageEvent) => {
    if (ev.key === PLAYER_PREFS_KEY) cb(loadPrefs());
  };
  window.addEventListener(EVT, handler);
  window.addEventListener('storage', storageHandler);
  return () => {
    window.removeEventListener(EVT, handler);
    window.removeEventListener('storage', storageHandler);
  };
}

// ─── connectivity estimation ─────────────────────────────────────────────────

export interface ConnectionInfo {
  /** estimated downlink in Mbps (0 when unknown) */
  downlink: number;
  effectiveType: string;
  saveData: boolean;
}

export function readConnection(): ConnectionInfo {
  const c = (typeof navigator !== 'undefined' &&
    (navigator as Navigator & { connection?: { downlink?: number; effectiveType?: string; saveData?: boolean } })
      .connection) || undefined;
  return {
    downlink: c?.downlink ?? 0,
    effectiveType: c?.effectiveType || 'unknown',
    saveData: !!c?.saveData,
  };
}

/** conservative bitrate budget (bps) from whatever the browser tells us */
export function connectionBudget(): number {
  const { downlink, effectiveType, saveData } = readConnection();
  if (saveData) return 400_000;
  if (downlink > 0) return Math.min(downlink * 1e6 * 0.8, 8_000_000);
  switch (effectiveType) {
    case 'slow-2g':
      return 250_000;
    case '2g':
      return 500_000;
    case '3g':
      return 1_200_000;
    case '4g':
      return 4_000_000;
    default:
      return 0; // unknown — let hls.js ABR decide
  }
}

/** the data-saver ladder height that fits a bitrate budget */
export function dataSaverForBudget(bps: number): number | null {
  if (bps <= 0) return null;
  if (bps < 240_000) return 144;
  if (bps < 420_000) return 244;
  if (bps < 750_000) return 360;
  if (bps < 1_300_000) return 480;
  return null;
}

/** hls.js tuning per performance profile — the stream-loading-speed dial.
 *  ⚠ maxLiveSyncPlaybackRate is PINNED TO 1 in both profiles: hls.js's
 *  latency-controller ramps playbackRate up to 2× whenever the playhead
 *  falls behind the live-sync target ("when it loads it plays like 2x").
 *  These CDNs flap constantly, so that speed-up fired after every stall —
 *  playback MUST always run at natural 1× speed.
 *  fast:   join 2 segments behind live, keep ~48s buffered → quick start.
 *          (sync 2 — the direct-transport CDN window is only 4 segments
 *          deep; joining 3 back left a single segment of runway and every
 *          CDN flap drained it straight into a stall. 2 keeps the window's
 *          tail as absorb room instead.)
 *  steady: join 3 segments behind, buffer ~60s → rides out flaky links */
export function hlsPerfConfig(perf: 'fast' | 'steady'): {
  liveSyncDurationCount: number;
  maxBufferLength: number;
  maxMaxBufferLength: number;
  maxLiveSyncPlaybackRate: number;
  backBufferLength: number;
} {
  if (perf === 'steady') {
    return {
      liveSyncDurationCount: 3,
      maxBufferLength: 60,
      maxMaxBufferLength: 120,
      maxLiveSyncPlaybackRate: 1,
      backBufferLength: 120,
    };
  }
  return {
    liveSyncDurationCount: 2,
    maxBufferLength: 48,
    maxMaxBufferLength: 90,
    maxLiveSyncPlaybackRate: 1,
    backBufferLength: 90,
  };
}
