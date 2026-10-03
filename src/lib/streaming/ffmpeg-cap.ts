// ─── ffmpeg capability probe (shared, cycle-free) ────────────────────────────
// turbo.ts needs to know "is a transcoder available" to decide what to do with
// browser-unsafe codecs (HEVC feeds), but transcode.ts already imports turbo.ts
// (shared input cache) — importing it back would create a cycle. This tiny
// module is the cycle-free home for the probe; results are cached on globalThis
// so every caller shares ONE probe per process.
//
// Two DISTINCT capabilities (2026-10-03 — the serverless quality-ladder work):
//
//   CONTINUOUS RELAY   ffmpeg + a long-lived process — only on self-hosted
//                      (dev / docker). Vercel isolates freeze between requests,
//                      so the /api/live relay can never work there, binary or
//                      not. relayCapable() === false on serverless, always.
//
//   SEGMENT LADDER     one-shot per-segment transcodes through the turbo
//                      pipeline (&h=480 → real x264 re-encode, cached per sn).
//                      Powered by the build-time static binary
//                      (third_party/ffmpeg/ffmpeg — BtbN n8.1, glibc ≥ 2.28,
//                      handles the premium CDN's HEVC phases). Works on
//                      serverless: each invocation fetches + converts one
//                      bounded segment and returns. segmentLadder() answers
//                      whether the binary is present and executable.
//
// Semantics of the executable probe (shared by both):
//   ffmpegAbsent() === true  → definitely no executable (ENOENT everywhere)
//   ffmpegAbsent() === false → the executable answered -version
//   ffmpegAbsent() === null  → probe in flight; callers treat as ABSENT
//                              (the serverless-safe default)

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

/** serverless host? (isolates freeze between requests — no long-lived relay) */
export const SERVERLESS = process.env.VERCEL === '1' || !!process.env.VERCEL_ENV;

const g = globalThis as {
  __maxtvFfmpegCap?: boolean | null;
  __maxtvFfmpegProbe?: Promise<boolean>;
  __maxtvBundledPath?: string | null;
  __maxtvSegCap?: boolean;
};

/** the build-time static binary (third_party/ffmpeg/ffmpeg), traced into the
 *  /api/turbo function bundle. null when absent (failed download / dev). */
export function bundledFfmpegPath(): string | null {
  if (typeof g.__maxtvBundledPath !== 'undefined') return g.__maxtvBundledPath;
  let p: string | null = null;
  const cands = [
    process.env.FFMPEG_PATH,
    path.join(process.cwd(), 'third_party', 'ffmpeg', 'ffmpeg'),
  ].filter(Boolean) as string[];
  for (const c of cands) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      p = c;
      break;
    } catch {
      /* keep looking */
    }
  }
  g.__maxtvBundledPath = p;
  return p;
}

/** the executable to run: the bundled static binary when present (works on
 *  serverless), else PATH ffmpeg (self-hosted). */
export function ffmpegExecutable(): string {
  return bundledFfmpegPath() || 'ffmpeg';
}

/** can the per-segment ladder run HERE? Sync fs check on the bundled binary +
 *  the (cached) PATH probe as fallback — true on Vercel after the build script
 *  fetched the binary, and on self-hosted boxes with PATH ffmpeg. */
export function segmentLadderCapableSync(): boolean {
  if (bundledFfmpegPath()) return true;
  return typeof g.__maxtvFfmpegCap === 'boolean' ? g.__maxtvFfmpegCap : false;
}

/** Kick (once) and await the executable probe — use in async routes. */
export function ffmpegCapable(): Promise<boolean> {
  if (typeof g.__maxtvFfmpegCap === 'boolean') return Promise.resolve(g.__maxtvFfmpegCap);
  if (!g.__maxtvFfmpegProbe) {
    g.__maxtvFfmpegProbe = new Promise<boolean>((res) => {
      let settled = false;
      const done = (ok: boolean) => {
        if (settled) return;
        settled = true;
        g.__maxtvFfmpegCap = ok;
        res(ok);
      };
      try {
        const p = spawn(ffmpegExecutable(), ['-version'], { stdio: 'ignore' });
        p.on('error', () => done(false)); // ENOENT — no binary on this host
        p.on('close', (code) => done(code === 0));
        // hard bound — a hung spawn must not wedge the first request
        setTimeout(() => done(false), 2_500).unref?.();
      } catch {
        done(false);
      }
    });
  }
  return g.__maxtvFfmpegProbe;
}

/** Synchronous view for getters/window builders (null = assume absent). */
export function ffmpegAbsent(): boolean | null {
  if (typeof g.__maxtvFfmpegCap === 'boolean') return !g.__maxtvFfmpegCap;
  void ffmpegCapable(); // kick the probe for next time
  return true; // unresolved → serverless-safe default
}

/** can the CONTINUOUS (/api/live) relay run here? Self-hosted only — a
 *  serverless isolate can't keep an ffmpeg child alive between requests. */
export function continuousRelayCapableSync(): boolean | null {
  if (SERVERLESS) return false;
  return ffmpegAbsent() === false ? true : null;
}
