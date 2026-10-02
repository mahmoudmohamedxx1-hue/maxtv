// ─── ffmpeg capability probe (shared, cycle-free) ────────────────────────────
// turbo.ts needs to know "is a transcoder available" to decide what to do with
// browser-unsafe codecs (HEVC feeds), but transcode.ts already imports turbo.ts
// (shared input cache) — importing it back would create a cycle. This tiny
// module is the cycle-free home for the probe; result is cached on globalThis
// so every caller shares ONE probe per process.
//
// Semantics:
//   ffmpegAbsent() === true  → definitely no ffmpeg (serverless / not installed)
//   ffmpegAbsent() === false → ffmpeg answered -version (transcode relay works)
//   ffmpegAbsent() === null  → probe still in flight; callers treat as ABSENT
//                              (the serverless-safe default — Vercel resolves
//                              ENOENT within milliseconds anyway)

import { spawn } from 'child_process';

const g = globalThis as {
  __maxtvFfmpegCap?: boolean | null;
  __maxtvFfmpegProbe?: Promise<boolean>;
};

/** Kick (once) and await the probe — use in async routes before deciding. */
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
        const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
        p.on('error', () => done(false)); // ENOENT — no binary on this host
        p.on('close', (code) => done(code === 0));
        // hard bound — a hung spawn must not wedge the first request
        setTimeout(() => done(false), 2_000).unref?.();
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
