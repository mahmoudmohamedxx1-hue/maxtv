// ─── node:fs shim (in-memory) for the thin Cloudflare Worker bundle ─────────
// The only fs consumers in the API layer are:
//   • ffmpeg-cap.ts / turbo.ts — bundled-binary probes + transcode temp
//     files. Unreachable on Workers (no processes, no disk); every call is
//     wrapped in try/catch by the app, and accessSync throwing ENOENT makes
//     ffmpegCapable() resolve false — exactly the serverless-safe default.
//   • iptv/sources.ts — playlist snapshot reads + runtime refreshes. Reads
//     miss (-> null, source skipped), and GitHub refreshes that "write" land
//     in this in-memory map so a same-isolate rebuild can pick them up.
//     (The Workers fast-path serves the catalog from the build-time compact
//     snapshot instead — see src/lib/iptv/catalog.ts.)

interface MemEntry {
  text: string;
  mtimeMs: number;
}

const mem = new Map<string, MemEntry>();

function enoent(p: string): never {
  throw new Error(`ENOENT: no such file or directory, open '${p}'`);
}

export default {
  constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 },

  accessSync(p: string): void {
    if (!mem.has(String(p))) enoent(p);
  },

  readFileSync(p: string, _encoding?: string): string {
    const hit = mem.get(String(p));
    if (!hit) enoent(p);
    return hit.text;
  },

  writeFileSync(p: string, text: string): void {
    mem.set(String(p), { text: String(text), mtimeMs: Date.now() });
  },

  statSync(p: string): { mtimeMs: number; size: number } {
    const hit = mem.get(String(p));
    if (!hit) enoent(p);
    return { mtimeMs: hit.mtimeMs, size: hit.text.length };
  },

  mkdirSync(_p: string): void {
    /* in-memory filesystem — directories materialize implicitly */
  },

  mkdtempSync(prefix: string): string {
    return `/tmp/${String(prefix).replace(/[^a-z0-9-]/gi, '')}-${Date.now()}`;
  },

  rmSync(_p: string): void {
    /* best-effort no-op — cleanup of paths that were never real */
  },
};
